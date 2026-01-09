#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'cache');
const AI_CACHE_DIR = path.join(CACHE_DIR, 'ai');
const STRUCTURE_MAP_ALL = path.join(AI_CACHE_DIR, 'structuremap-all.json');
const STRUCTURE_MAP_READABLE = path.join(AI_CACHE_DIR, 'structuremap-readable.json');
const STRUCTURE_MAP_WRITABLE = path.join(AI_CACHE_DIR, 'structuremap-writable.json');

// Load config (same pattern as server.js)
const configDefaults = require('./config.defaults.js');
const configLocal = (() => {
	try { return require('./config.local.js'); } catch { return {}; }
})();

function deepMerge(target, source) {
	const result = { ...target };
	for (const key of Object.keys(source)) {
		if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
			result[key] = deepMerge(result[key] || {}, source[key]);
		} else {
			result[key] = source[key];
		}
	}
	return result;
}

const config = deepMerge(configDefaults, configLocal);
const serverConfig = config.server || {};

const args = process.argv.slice(2);
const command = args[0];

function usage() {
	console.log(`
AI CLI Tool

Usage:
  node ai-cli.js <command> [options]

Commands:
  genstructuremap              Generate structure map from sitemap for AI context
  testvoice "<command>"        Test a voice command against the structure map

Options:
  --sitemap <name>             Sitemap name (default: auto-detect first available)
  --dry-run                    Show what would be sent without calling API

Examples:
  node ai-cli.js genstructuremap
  node ai-cli.js genstructuremap --sitemap home
  node ai-cli.js testvoice "turn on the kitchen lights"
  node ai-cli.js testvoice "set bedroom temperature to 22"
`);
}

function fetchOpenhab(pathname) {
	return new Promise((resolve, reject) => {
		const target = new URL(serverConfig.openhab?.target || 'http://localhost:8080');
		const isHttps = target.protocol === 'https:';
		const basePath = target.pathname && target.pathname !== '/' ? target.pathname.replace(/\/$/, '') : '';
		const reqPath = `${basePath}${pathname}`;

		const options = {
			hostname: target.hostname,
			port: target.port || (isHttps ? 443 : 80),
			path: reqPath,
			method: 'GET',
			headers: {
				'Accept': 'application/json',
				'User-Agent': serverConfig.userAgent || 'ohProxy/1.0',
			},
		};

		// Add basic auth if configured
		if (serverConfig.openhab?.user && serverConfig.openhab?.pass) {
			const auth = Buffer.from(`${serverConfig.openhab.user}:${serverConfig.openhab.pass}`).toString('base64');
			options.headers.Authorization = `Basic ${auth}`;
		}

		const transport = isHttps ? https : http;
		const req = transport.request(options, (res) => {
			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', () => {
				if (res.statusCode >= 200 && res.statusCode < 300) {
					try {
						resolve(JSON.parse(data));
					} catch {
						resolve(data);
					}
				} else {
					reject(new Error(`HTTP ${res.statusCode}: ${data}`));
				}
			});
		});

		req.on('error', reject);
		req.setTimeout(10000, () => {
			req.destroy();
			reject(new Error('Request timeout'));
		});
		req.end();
	});
}

async function getSitemapList() {
	const result = await fetchOpenhab('/rest/sitemaps?type=json');
	// Handle both array and single object formats
	if (Array.isArray(result)) return result;
	if (result?.sitemap) return [result.sitemap];
	if (result?.name) return [result];
	return [];
}

async function getSitemapFull(sitemapName) {
	return await fetchOpenhab(`/rest/sitemaps/${sitemapName}?type=json&includeHidden=true`);
}

function extractWidgets(widget, result = [], path = []) {
	if (!widget) return result;

	// Determine current section name from Frame label or linkedPage title
	let currentPath = path;
	if (widget.type === 'Frame' && widget.label) {
		// Clean label - remove [%s] style placeholders
		const cleanLabel = widget.label.replace(/\s*\[.*?\]\s*$/, '').trim();
		if (cleanLabel) {
			currentPath = [...path, cleanLabel];
		}
	}

	// Extract relevant info from this widget
	if (widget.item || widget.type) {
		const entry = {
			type: widget.type,
			label: widget.label || '',
			section: currentPath.length > 0 ? currentPath.join(' / ') : null,
		};
		if (widget.item) {
			entry.item = widget.item.name;
			entry.itemType = widget.item.type?.replace('Item', '') || widget.item.type;
			entry.state = widget.item.state;
			if (widget.item.stateDescription?.options) {
				// Include both value and label for options
				entry.options = widget.item.stateDescription.options.map(o => ({
					value: o.value,
					label: o.label || o.value
				}));
			}
		}
		// Handle both 'mapping' and 'mappings'
		const mappings = widget.mappings || widget.mapping;
		if (mappings && mappings.length > 0) {
			entry.mappings = mappings.map(m => ({ cmd: m.command, label: m.label }));
		}
		result.push(entry);
	}

	// Recurse into children - handle both 'widget' and 'widgets' (singular and plural)
	const children = widget.widgets || widget.widget;
	if (children) {
		const childArray = Array.isArray(children) ? children : [children];
		for (const child of childArray) {
			extractWidgets(child, result, currentPath);
		}
	}

	// Recurse into linked pages - use linkedPage title as section
	if (widget.linkedPage) {
		const linkedTitle = widget.linkedPage.title || widget.label;
		const cleanLinkedTitle = linkedTitle ? linkedTitle.replace(/\s*\[.*?\]\s*$/, '').trim() : null;
		const linkedPath = cleanLinkedTitle ? [...path, cleanLinkedTitle] : path;

		const linkedChildren = widget.linkedPage.widgets || widget.linkedPage.widget;
		if (linkedChildren) {
			const linkedArray = Array.isArray(linkedChildren) ? linkedChildren : [linkedChildren];
			for (const child of linkedArray) {
				extractWidgets(child, result, linkedPath);
			}
		}
	}

	return result;
}

function isWritableWidget(w) {
	// A widget is writable if it has commands available
	if (w.mappings && w.mappings.length > 0) return true;
	if (w.options && w.options.length > 0) return true;
	if (['Switch', 'Dimmer', 'Rollershutter', 'Color', 'Player'].includes(w.itemType)) return true;
	return false;
}

function buildStructureMapPrompt(sitemap, widgets, type = 'all') {
	// Group widgets by section
	const itemWidgets = widgets.filter(w => w.item);
	const sections = new Map();

	for (const w of itemWidgets) {
		const section = w.section || 'Home';
		if (!sections.has(section)) {
			sections.set(section, []);
		}
		sections.get(section).push(w);
	}

	// Build output grouped by section
	const lines = [];
	for (const [section, items] of sections) {
		lines.push(`## ${section}`);
		for (const w of items) {
			// Clean label - remove [%s] style state placeholders
			const cleanLabel = (w.label || '').replace(/\s*\[.*?\]\s*$/, '').trim();
			let line = `- ${w.item} (${w.itemType || 'Unknown'}): "${cleanLabel}"`;
			if (w.mappings) {
				// Include both command and label: "2=2 Minutes, 1=1 Minute"
				line += ` [commands: ${w.mappings.map(m => m.label ? `${m.cmd}="${m.label}"` : m.cmd).join(', ')}]`;
			} else if (w.options) {
				// Include both value and label for options
				line += ` [options: ${w.options.map(o => o.label && o.label !== o.value ? `${o.value}="${o.label}"` : o.value).join(', ')}]`;
			} else if (w.itemType === 'Switch') {
				line += ` [commands: ON, OFF]`;
			} else if (w.itemType === 'Dimmer') {
				line += ` [commands: ON, OFF, 0-100]`;
			} else if (w.itemType === 'Rollershutter') {
				line += ` [commands: UP, DOWN, STOP, 0-100]`;
			}
			lines.push(line);
		}
		lines.push(''); // Empty line between sections
	}
	const itemSummary = lines.join('\n').trim();

	return {
		model: 'claude-3-haiku-20240307',
		max_tokens: 4096,
		system: `You are an assistant that creates structured mappings for home automation voice commands.
Your task is to analyze the provided openHAB items and create a concise structure map that can be used to match voice commands to item actions.

Output a JSON object with the following structure:
{
  "items": [
    {
      "name": "ItemName",
      "aliases": ["living room light", "main light", "living room"],
      "actions": {
        "on": "ON",
        "off": "OFF",
        "toggle": "TOGGLE"
      }
    }
  ],
  "rooms": ["living room", "kitchen", "bedroom"],
  "capabilities": ["lights", "temperature", "locks", "blinds"]
}

Be concise. Extract room names and device types from labels. Create natural language aliases people would use in voice commands.`,
		messages: [
			{
				role: 'user',
				content: `Here is the sitemap "${sitemap.name}" (${sitemap.label || 'Home'}) with its ${type === 'readable' ? 'read-only' : type === 'writable' ? 'controllable' : ''} items:

${itemSummary}

Create a structure map JSON for voice command matching.`
			}
		]
	};
}

async function genStructureMap(options = {}) {
	const dryRun = options.dryRun || args.includes('--dry-run');
	let sitemapName = options.sitemap;

	// Find --sitemap argument
	const sitemapIdx = args.indexOf('--sitemap');
	if (sitemapIdx !== -1 && args[sitemapIdx + 1]) {
		sitemapName = args[sitemapIdx + 1];
	}

	console.log('Fetching sitemap list from openHAB...');

	try {
		const sitemaps = await getSitemapList();
		if (sitemaps.length === 0) {
			console.error('Error: No sitemaps found in openHAB');
			process.exit(1);
		}

		// Auto-detect or validate sitemap name
		if (!sitemapName) {
			sitemapName = sitemaps[0].name;
			console.log(`Auto-detected sitemap: ${sitemapName}`);
		} else {
			const found = sitemaps.find(s => s.name === sitemapName);
			if (!found) {
				console.error(`Error: Sitemap "${sitemapName}" not found`);
				console.error(`Available sitemaps: ${sitemaps.map(s => s.name).join(', ')}`);
				process.exit(1);
			}
		}

		console.log(`Fetching full sitemap: ${sitemapName}...`);
		const sitemap = await getSitemapFull(sitemapName);

		// Extract all widgets recursively
		const widgets = [];
		const homepageWidgets = sitemap.homepage?.widgets || sitemap.homepage?.widget;
		if (homepageWidgets) {
			const widgetArray = Array.isArray(homepageWidgets) ? homepageWidgets : [homepageWidgets];
			for (const widget of widgetArray) {
				extractWidgets(widget, widgets);
			}
		}

		// Split widgets into readable and writable
		const itemWidgets = widgets.filter(w => w.item);
		const writableWidgets = itemWidgets.filter(isWritableWidget);
		const readableWidgets = itemWidgets.filter(w => !isWritableWidget(w));

		console.log(`Found ${widgets.length} widgets, ${itemWidgets.length} with items`);
		console.log(`  - Writable (has commands): ${writableWidgets.length}`);
		console.log(`  - Readable (no commands): ${readableWidgets.length}`);
		console.log('');

		// Build prompts for each type
		const requestAll = buildStructureMapPrompt(sitemap, itemWidgets, 'all');
		const requestWritable = buildStructureMapPrompt(sitemap, writableWidgets, 'writable');
		const requestReadable = buildStructureMapPrompt(sitemap, readableWidgets, 'readable');

		console.log('='.repeat(80));
		console.log('ANTHROPIC API REQUEST - ALL ITEMS');
		console.log('='.repeat(80));
		console.log('');
		console.log(`Endpoint: POST https://api.anthropic.com/v1/messages`);
		console.log(`Model: ${requestAll.model}`);
		console.log(`Max Tokens: ${requestAll.max_tokens}`);
		console.log('');
		console.log('--- SYSTEM PROMPT ---');
		console.log(requestAll.system);
		console.log('');
		console.log('--- USER MESSAGE ---');
		console.log(requestAll.messages[0].content);
		console.log('');
		console.log('='.repeat(80));

		// Save to cache
		try {
			if (!fs.existsSync(AI_CACHE_DIR)) {
				fs.mkdirSync(AI_CACHE_DIR, { recursive: true });
			}
			const generatedAt = new Date().toISOString();

			// Save all items
			fs.writeFileSync(STRUCTURE_MAP_ALL, JSON.stringify({
				generatedAt,
				sitemap: sitemapName,
				type: 'all',
				itemCount: itemWidgets.length,
				request: requestAll,
			}, null, 2));

			// Save writable items
			fs.writeFileSync(STRUCTURE_MAP_WRITABLE, JSON.stringify({
				generatedAt,
				sitemap: sitemapName,
				type: 'writable',
				itemCount: writableWidgets.length,
				request: requestWritable,
			}, null, 2));

			// Save readable items
			fs.writeFileSync(STRUCTURE_MAP_READABLE, JSON.stringify({
				generatedAt,
				sitemap: sitemapName,
				type: 'readable',
				itemCount: readableWidgets.length,
				request: requestReadable,
			}, null, 2));

			console.log('');
			console.log('Saved structure maps:');
			console.log(`  - All:      ${STRUCTURE_MAP_ALL}`);
			console.log(`  - Writable: ${STRUCTURE_MAP_WRITABLE}`);
			console.log(`  - Readable: ${STRUCTURE_MAP_READABLE}`);
		} catch (saveErr) {
			console.error(`Warning: Failed to save cache: ${saveErr.message}`);
		}

		if (!dryRun) {
			console.log('');
			console.log('Note: Use --dry-run flag to preview without API call');
			console.log('      Full API integration coming soon...');
		}

	} catch (err) {
		console.error(`Error: ${err.message}`);
		process.exit(1);
	}
}

function callAnthropic(requestBody) {
	return new Promise((resolve, reject) => {
		const apiKey = serverConfig.apiKeys?.anthropic;
		if (!apiKey) {
			reject(new Error('Anthropic API key not configured in config.local.js'));
			return;
		}

		const postData = JSON.stringify(requestBody);

		const options = {
			hostname: 'api.anthropic.com',
			port: 443,
			path: '/v1/messages',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
				'Content-Length': Buffer.byteLength(postData),
			},
		};

		const req = https.request(options, (res) => {
			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', () => {
				if (res.statusCode >= 200 && res.statusCode < 300) {
					try {
						resolve(JSON.parse(data));
					} catch {
						reject(new Error(`Invalid JSON response: ${data}`));
					}
				} else {
					reject(new Error(`API error ${res.statusCode}: ${data}`));
				}
			});
		});

		req.on('error', reject);
		req.setTimeout(30000, () => {
			req.destroy();
			reject(new Error('API request timeout'));
		});
		req.write(postData);
		req.end();
	});
}

async function testVoice(voiceCommand) {
	if (!voiceCommand) {
		console.error('Error: Please provide a voice command');
		console.error('Usage: node ai-cli.js testvoice "turn on the kitchen lights"');
		process.exit(1);
	}

	// Load the writable structure map
	if (!fs.existsSync(STRUCTURE_MAP_WRITABLE)) {
		console.error('Error: Structure map not found. Run "genstructuremap" first.');
		process.exit(1);
	}

	const structureMap = JSON.parse(fs.readFileSync(STRUCTURE_MAP_WRITABLE, 'utf8'));
	const itemList = structureMap.request.messages[0].content;

	console.log(`Voice command: "${voiceCommand}"`);
	console.log(`Structure map: ${structureMap.itemCount} writable items`);
	console.log('');
	console.log('Calling Haiku...');
	console.log('');

	const requestBody = {
		model: 'claude-3-haiku-20240307',
		max_tokens: 1024,
		system: `You are a home automation voice command interpreter. Your job is to match voice commands to the available smart home items and determine what actions to take.

You will receive a list of controllable items organized by room/section (## headers). Each item shows:
- Item name (technical ID to use in commands)
- Item type
- Label (human-readable name)
- Available commands

Respond with a JSON object:
{
  "understood": true,
  "actions": [
    { "item": "ItemName", "command": "ON", "description": "Turn on kitchen light" }
  ],
  "response": "Turning on the kitchen lights"
}

If the command is unclear or no matching items found:
{
  "understood": false,
  "actions": [],
  "response": "I couldn't find any lights in the kitchen"
}

Rules:
- CRITICAL: When user specifies a room/location, ONLY match items under that room's ## section header. The section hierarchy (e.g. "## Floors / Upstairs / Office") tells you exactly where each item is located. Never pick items from other rooms.
- Match by label first, then item name. Labels are what users call things.
- "all lights" means all Switch/Dimmer items with "light" or "lamp" in label within the specified room
- "turn on" = ON, "turn off" = OFF for switches
- For dimmers, "dim" = 30, "bright" = 100
- For items with numeric commands like [commands: 0="Off", 1="On"], use the number (0, 1) not the label
- Be helpful but only control items that clearly match the request
- Response should be natural, conversational
- ONLY output valid JSON, no markdown or extra text`,
		messages: [
			{
				role: 'user',
				content: `Available items:\n\n${itemList}\n\n---\n\nVoice command: "${voiceCommand}"`
			}
		]
	};

	try {
		const response = await callAnthropic(requestBody);

		console.log('='.repeat(60));
		console.log('HAIKU RESPONSE');
		console.log('='.repeat(60));
		console.log('');

		// Extract text content from response
		const textContent = response.content?.find(c => c.type === 'text');
		if (textContent) {
			console.log(textContent.text);

			// Try to parse as JSON for prettier output
			try {
				const parsed = JSON.parse(textContent.text);
				console.log('');
				console.log('='.repeat(60));
				console.log('PARSED');
				console.log('='.repeat(60));
				console.log(JSON.stringify(parsed, null, 2));
			} catch {
				// Not JSON, already printed raw
			}
		} else {
			console.log('No text content in response');
			console.log(JSON.stringify(response, null, 2));
		}

		console.log('');
		console.log('='.repeat(60));
		console.log('USAGE');
		console.log('='.repeat(60));
		console.log(`Input tokens: ${response.usage?.input_tokens || 'N/A'}`);
		console.log(`Output tokens: ${response.usage?.output_tokens || 'N/A'}`);

		const inputCost = ((response.usage?.input_tokens || 0) / 1000000) * 0.25;
		const outputCost = ((response.usage?.output_tokens || 0) / 1000000) * 1.25;
		console.log(`Estimated cost: $${(inputCost + outputCost).toFixed(6)}`);

	} catch (err) {
		console.error(`Error: ${err.message}`);
		process.exit(1);
	}
}

// Route commands
switch (command) {
	case 'genstructuremap':
		genStructureMap();
		break;
	case 'testvoice':
		testVoice(args.slice(1).join(' '));
		break;
	case 'help':
	case '--help':
	case '-h':
		usage();
		break;
	default:
		if (command) {
			console.error(`Unknown command: ${command}`);
		}
		usage();
		process.exit(command ? 1 : 0);
}
