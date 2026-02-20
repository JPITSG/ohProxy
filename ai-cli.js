#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { generateStructureMap } = require('./lib/structure-map');
const { buildOpenhabClient } = require('./lib/openhab-client');

const CACHE_DIR = path.join(__dirname, 'cache');
const AI_CACHE_DIR = path.join(CACHE_DIR, 'ai');

const config = require('./config');
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
  --sitemap <name>             Sitemap name (required)
  --dry-run                    Show what would be sent without calling API

Examples:
  node ai-cli.js genstructuremap --sitemap home
  node ai-cli.js testvoice "turn on the kitchen lights" --sitemap home
  node ai-cli.js testvoice "set bedroom temperature to 22" --sitemap home
`);
}

function getSitemapArg(defaultValue = '') {
	let sitemapName = defaultValue;
	const sitemapIdx = args.indexOf('--sitemap');
	if (sitemapIdx !== -1 && args[sitemapIdx + 1]) {
		sitemapName = args[sitemapIdx + 1];
	}
	return String(sitemapName || '').trim();
}

function getRequiredSitemapArg(usageLine, defaultValue = '') {
	const sitemapName = getSitemapArg(defaultValue);
	if (sitemapName) return sitemapName;
	console.error('Error: Missing required --sitemap <name>');
	console.error(`Usage: ${usageLine}`);
	process.exit(1);
}

function structureMapScopedPath(sitemapName, type = 'writable') {
	const normalizedName = String(sitemapName || '').trim();
	const normalizedType = String(type || '').trim().toLowerCase();
	if (!normalizedName || !normalizedType) return '';
	const token = encodeURIComponent(normalizedName);
	return path.join(AI_CACHE_DIR, `structuremap-${token}-${normalizedType}.json`);
}

function getTestVoiceCommand() {
	const parts = [];
	for (let i = 1; i < args.length; i++) {
		const token = args[i];
		if (token === '--sitemap') {
			i += 1;
			continue;
		}
		if (token === '--dry-run') continue;
		if (typeof token === 'string' && token.startsWith('--')) continue;
		parts.push(token);
	}
	return parts.join(' ').trim();
}

const openhabClient = buildOpenhabClient({
	target: serverConfig.openhab?.target || 'http://localhost:8080',
	user: serverConfig.openhab?.user || '',
	pass: serverConfig.openhab?.pass || '',
	apiToken: serverConfig.openhab?.apiToken || '',
	userAgent: serverConfig.userAgent || 'ohProxy/1.0',
	timeoutMs: 10000,
});

async function fetchOpenhabJson(pathname) {
	const res = await openhabClient.get(pathname, {
		parseJson: true,
		throwOnHttpError: true,
		timeoutLabel: 'Request',
	});
	return res.json;
}

async function getSitemapList() {
	const result = await fetchOpenhabJson('/rest/sitemaps?type=json');
	// Handle both array and single object formats
	if (Array.isArray(result)) return result;
	if (result?.sitemap) return [result.sitemap];
	if (result?.name) return [result];
	return [];
}

async function getSitemapFull(sitemapName) {
	return await fetchOpenhabJson(`/rest/sitemaps/${sitemapName}?type=json&includeHidden=true`);
}

async function genStructureMap(options = {}) {
	const sitemapName = getRequiredSitemapArg('node ai-cli.js genstructuremap --sitemap <name>', options.sitemap);

	console.log('Fetching sitemap from openHAB...');

	try {
		const fetchList = async () => {
			const sitemaps = await getSitemapList();
			if (sitemaps.length === 0) {
				throw new Error('No sitemaps found in openHAB');
			}
			return sitemaps;
		};

		const fetchFull = async (name) => {
			return await getSitemapFull(name);
		};

		const result = await generateStructureMap(fetchList, fetchFull, { sitemapName });

		console.log(`Using sitemap: ${result.sitemapName}`);
		console.log(`Found ${result.stats.total} items with items`);
		console.log(`  - Writable (has commands): ${result.stats.writable}`);
		console.log(`  - Readable (no commands): ${result.stats.readable}`);
		console.log('');

		console.log('='.repeat(80));
		console.log('ANTHROPIC API REQUEST - ALL ITEMS');
		console.log('='.repeat(80));
		console.log('');
		console.log(`Endpoint: POST https://api.anthropic.com/v1/messages`);
		console.log(`Model: ${result.all.request.model}`);
		console.log(`Max Tokens: ${result.all.request.max_tokens}`);
		console.log('');
		console.log('--- SYSTEM PROMPT ---');
		console.log(result.all.request.system);
		console.log('');
		console.log('--- USER MESSAGE ---');
		console.log(result.all.request.messages[0].content);
		console.log('');
		console.log('='.repeat(80));

		// Save to cache
		try {
			if (!fs.existsSync(AI_CACHE_DIR)) {
				fs.mkdirSync(AI_CACHE_DIR, { recursive: true });
			}
			const generatedAt = new Date().toISOString();
			const scopedAllPath = structureMapScopedPath(result.sitemapName, 'all');
			const scopedWritablePath = structureMapScopedPath(result.sitemapName, 'writable');
			const scopedReadablePath = structureMapScopedPath(result.sitemapName, 'readable');

			// Save all items (scoped)
			fs.writeFileSync(scopedAllPath, JSON.stringify({
				generatedAt,
				sitemap: result.sitemapName,
				type: 'all',
				itemCount: result.all.itemCount,
				request: result.all.request,
			}, null, 2));

			// Save writable items (scoped)
			fs.writeFileSync(scopedWritablePath, JSON.stringify({
				generatedAt,
				sitemap: result.sitemapName,
				type: 'writable',
				itemCount: result.writable.itemCount,
				request: result.writable.request,
			}, null, 2));

			// Save readable items (scoped)
			fs.writeFileSync(scopedReadablePath, JSON.stringify({
				generatedAt,
				sitemap: result.sitemapName,
				type: 'readable',
				itemCount: result.readable.itemCount,
				request: result.readable.request,
			}, null, 2));

			console.log('');
			console.log(`Saved sitemap-scoped structure maps for "${result.sitemapName}":`);
			console.log(`  - All:      ${scopedAllPath}`);
			console.log(`  - Writable: ${scopedWritablePath}`);
			console.log(`  - Readable: ${scopedReadablePath}`);
		} catch (saveErr) {
			console.error(`Warning: Failed to save cache: ${saveErr.message}`);
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
		console.error('Usage: node ai-cli.js testvoice "turn on the kitchen lights" --sitemap <name>');
		process.exit(1);
	}

	const sitemapName = getRequiredSitemapArg('node ai-cli.js testvoice "turn on the kitchen lights" --sitemap <name>');
	const writableMapPath = structureMapScopedPath(sitemapName, 'writable');
	if (!fs.existsSync(writableMapPath)) {
		console.error(`Error: Writable structure map not found for sitemap "${sitemapName}".`);
		console.error(`Run: node ai-cli.js genstructuremap --sitemap ${sitemapName}`);
		process.exit(1);
	}

	const structureMap = JSON.parse(fs.readFileSync(writableMapPath, 'utf8'));
	const itemList = structureMap.request.messages[0].content;

	console.log(`Voice command: "${voiceCommand}"`);
	console.log(`Sitemap: "${sitemapName}"`);
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
		testVoice(getTestVoiceCommand());
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
