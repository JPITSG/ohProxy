#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const sessions = require('./sessions');
const { buildOpenhabClient } = require('./lib/openhab-client');
const { safeText, splitLabelState, widgetKey } = require('./lib/widget-normalizer');

const config = require('./config');
const serverConfig = config.server || {};

// Supported glow colors in ohProxy
const SUPPORTED_COLORS = new Set(['green', 'orange', 'red']);

const args = process.argv.slice(2);

function usage() {
	console.log(`
Glow Rules Migration CLI

Parses an openHAB .sitemap DSL file, extracts valuecolor rules,
and converts them to ohProxy glow rules.

Usage:
  node glowrules-cli.js <sitemap-file> [--process]

Arguments:
  <sitemap-file>    Path to the openHAB .sitemap DSL file
  --process         Insert rules into the database (default: dry-run preview)

Examples:
  node glowrules-cli.js /etc/openhab/sitemaps/default.sitemap
  node glowrules-cli.js /etc/openhab/sitemaps/default.sitemap --process
`);
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

// ============================================
// Compute a widget key from DSL-parsed data (fallback when REST API doesn't have the widget)
function computeKeyFromDsl(itemName, dslLabel, dslType) {
	const { title } = splitLabelState(dslLabel);
	const label = title || dslLabel;
	const type = dslType || '';
	return `widget:${itemName}|${label}|${type}|`;
}

// ============================================
// REST API widget extraction
// ============================================

function extractAllWidgets(widget, result = []) {
	if (!widget) return result;

	if (widget.item?.name) {
		result.push(widget);
	}

	const children = widget.widgets || widget.widget;
	if (children) {
		const childArray = Array.isArray(children) ? children : [children];
		for (const child of childArray) {
			extractAllWidgets(child, result);
		}
	}

	if (widget.linkedPage) {
		const linkedChildren = widget.linkedPage.widgets || widget.linkedPage.widget;
		if (linkedChildren) {
			const linkedArray = Array.isArray(linkedChildren) ? linkedChildren : [linkedChildren];
			for (const child of linkedArray) {
				extractAllWidgets(child, result);
			}
		}
	}

	return result;
}

// ============================================
// Sitemap DSL parser
// ============================================

function parseSitemapDsl(content) {
	const entries = [];
	const lines = content.split('\n');

	// Extract sitemap name from first meaningful line
	let sitemapName = null;
	for (const line of lines) {
		const nameMatch = line.match(/^\s*sitemap\s+(\w+)/);
		if (nameMatch) {
			sitemapName = nameMatch[1];
			break;
		}
	}

	for (const line of lines) {
		// Only process lines that contain valuecolor=
		if (!line.includes('valuecolor=')) continue;

		// Extract widget type (first word)
		const typeMatch = line.match(/^\s*(\w+)\s+/);
		const widgetType = typeMatch ? typeMatch[1] : '';

		// Extract item name
		const itemMatch = line.match(/item=(\w+)/);
		if (!itemMatch) continue;
		const itemName = itemMatch[1];

		// Extract label (the part in quotes after label=)
		let rawLabel = '';
		const labelMatch = line.match(/label="([^"]*)"/);
		if (labelMatch) rawLabel = labelMatch[1];

		// Extract valuecolor content
		const vcMatch = line.match(/valuecolor=\[([^\]]*)\]/);
		if (!vcMatch) continue;
		const valuecolorContent = vcMatch[1];

		// Parse individual rules from valuecolor content
		const rawRules = splitValuecolorRules(valuecolorContent);
		const rules = [];
		const warnings = [];

		for (const raw of rawRules) {
			const parsed = parseValuecolorRule(raw.trim(), itemName);
			if (!parsed) {
				warnings.push(`Unparseable rule: ${raw.trim()}`);
				continue;
			}
			if (parsed.skip) {
				warnings.push(parsed.reason);
				continue;
			}
			rules.push(parsed);
		}

		entries.push({
			itemName,
			widgetType,
			rawLabel,
			rules,
			warnings,
		});
	}

	return { sitemapName, entries };
}

// Split valuecolor content on ", " while respecting quoted values
function splitValuecolorRules(content) {
	const rules = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < content.length; i++) {
		const ch = content[i];
		if (ch === '"') {
			inQuotes = !inQuotes;
			current += ch;
		} else if (ch === ',' && !inQuotes) {
			rules.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	if (current.trim()) rules.push(current.trim());

	return rules;
}

function parseValuecolorRule(rule, selfItemName) {
	// Pattern 1: Unconditional — just "color"
	const unconditionalMatch = rule.match(/^"(\w+)"$/);
	if (unconditionalMatch) {
		const color = unconditionalMatch[1].toLowerCase();
		if (!SUPPORTED_COLORS.has(color)) {
			return { skip: true, reason: `Unsupported color: ${color}` };
		}
		return { operator: '*', value: '', color };
	}

	// Pattern 2: condition="color"
	const condColorMatch = rule.match(/^(.+)="(\w+)"$/);
	if (!condColorMatch) return null;

	const conditionPart = condColorMatch[1];
	const color = condColorMatch[2].toLowerCase();

	if (!SUPPORTED_COLORS.has(color)) {
		return { skip: true, reason: `Unsupported color: ${color}` };
	}

	// Parse the condition
	// Try cross-item reference: ItemName<op>value
	const crossItemMatch = conditionPart.match(/^(\w+)(==|!=|>=|<=|>|<)(.+)$/);
	if (crossItemMatch) {
		const refItem = crossItemMatch[1];
		const op = crossItemMatch[2];
		const value = crossItemMatch[3].replace(/^"|"$/g, '');

		if (refItem !== selfItemName) {
			return { skip: true, reason: `Cross-item ref: ${refItem} (widget item: ${selfItemName})` };
		}
		// Self-reference — treat as normal rule
		return { operator: op === '==' ? '=' : op, value, color };
	}

	// Try self-reference with operator: <op>value
	const selfOpMatch = conditionPart.match(/^(==|!=|>=|<=|>|<)(.+)$/);
	if (selfOpMatch) {
		const op = selfOpMatch[1];
		const value = selfOpMatch[2].replace(/^"|"$/g, '');
		return { operator: op === '==' ? '=' : op, value, color };
	}

	// Try quoted string value (implicit ==)
	const quotedMatch = conditionPart.match(/^"([^"]*)"$/);
	if (quotedMatch) {
		return { operator: '=', value: quotedMatch[1], color };
	}

	// Bare value (implicit ==)
	return { operator: '=', value: conditionPart.replace(/^"|"$/g, ''), color };
}

// ============================================
// Main
// ============================================

async function main() {
	// Parse arguments
	const sitemapFile = args.find(a => !a.startsWith('--'));
	const processMode = args.includes('--process');

	if (!sitemapFile) {
		console.error('Error: Sitemap file path required.');
		usage();
		process.exit(1);
	}

	if (!fs.existsSync(sitemapFile)) {
		console.error(`Error: File not found: ${sitemapFile}`);
		process.exit(1);
	}

	// Step 1: Parse the DSL file
	console.log(`Parsing ${sitemapFile}...`);
	const content = fs.readFileSync(sitemapFile, 'utf8');
	const { sitemapName, entries } = parseSitemapDsl(content);

	if (!sitemapName) {
		console.error('Error: Could not extract sitemap name from DSL file.');
		process.exit(1);
	}

	if (entries.length === 0) {
		console.log('No valuecolor rules found in the sitemap file.');
		process.exit(0);
	}

	console.log(`Found ${entries.length} widgets with valuecolor rules.`);

	// Step 2: Detect duplicate items (same item= name on multiple valuecolor lines)
	const itemCounts = new Map();
	for (const entry of entries) {
		itemCounts.set(entry.itemName, (itemCounts.get(entry.itemName) || 0) + 1);
	}
	const duplicateItems = new Map();
	for (const [name, count] of itemCounts) {
		if (count > 1) duplicateItems.set(name, count);
	}

	// Separate entries: unique vs duplicate
	const uniqueEntries = entries.filter(e => !duplicateItems.has(e.itemName));
	const duplicateEntries = entries.filter(e => duplicateItems.has(e.itemName));

	// Step 3: Fetch REST API sitemap for widget key resolution
	let restWidgetMap = new Map(); // itemName → [{widget, key}]
	let restMatched = 0;
	let dslFallback = 0;
	let restApiFailed = false;

	console.log(`Fetching sitemap "${sitemapName}" from openHAB REST API...`);
	try {
		const sitemap = await fetchOpenhabJson(`/rest/sitemaps/${sitemapName}?type=json&includeHidden=true`);
		const allWidgets = [];
		const homepageWidgets = sitemap.homepage?.widgets || sitemap.homepage?.widget;
		if (homepageWidgets) {
			const widgetArray = Array.isArray(homepageWidgets) ? homepageWidgets : [homepageWidgets];
			for (const widget of widgetArray) {
				extractAllWidgets(widget, allWidgets);
			}
		}

		// Build map: itemName → list of {widget object, computed key}
		for (const widget of allWidgets) {
			const name = widget.item?.name;
			if (!name) continue;
			const key = widgetKey(widget);
			if (!restWidgetMap.has(name)) restWidgetMap.set(name, []);
			restWidgetMap.get(name).push({ widget, key });
		}
	} catch (err) {
		console.warn(`Warning: REST API unavailable (${err.message}). Using DSL-only key computation.`);
		restApiFailed = true;
	}

	// Step 4: Resolve widget keys and convert rules
	const converted = []; // {widgetKey, itemName, rules, warnings, source}

	for (const entry of uniqueEntries) {
		if (entry.rules.length === 0 && entry.warnings.length === 0) continue;

		let widgetKey = null;
		let source = 'dsl';

		if (!restApiFailed && restWidgetMap.has(entry.itemName)) {
			const matches = restWidgetMap.get(entry.itemName);
			// Use first match (for unique items there should be one primary match)
			widgetKey = matches[0].key;
			source = 'rest';
			restMatched++;
		} else {
			widgetKey = computeKeyFromDsl(entry.itemName, entry.rawLabel, entry.widgetType);
			dslFallback++;
		}

		converted.push({
			widgetKey,
			itemName: entry.itemName,
			rules: entry.rules,
			warnings: entry.warnings,
			source,
		});
	}

	if (!restApiFailed) {
		console.log(`Matched ${restMatched} widgets via REST API, ${dslFallback} computed from DSL.`);
	}

	// Step 5: Check existing rules in database
	sessions.initDb();
	const existingRules = sessions.getAllGlowRules();
	const existingKeys = new Set(existingRules.map(r => r.widgetId));

	// Categorize
	const newEntries = [];
	const existingEntries = [];

	for (const entry of converted) {
		if (existingKeys.has(entry.widgetKey)) {
			existingEntries.push(entry);
		} else {
			newEntries.push(entry);
		}
	}

	// Step 6: Output
	const COL_ITEM = 40;
	const COL_RULES = 35;
	const COL_STATUS = 20;
	const TABLE_WIDTH = COL_ITEM + COL_RULES + COL_STATUS;

	console.log('');
	console.log(processMode ? 'MIGRATION RESULT' : 'MIGRATION PREVIEW');
	console.log('\u2500'.repeat(TABLE_WIDTH));
	console.log(
		'Item'.padEnd(COL_ITEM) +
		'Rules'.padEnd(COL_RULES) +
		'Status'
	);
	console.log('\u2500'.repeat(TABLE_WIDTH));

	let insertedCount = 0;
	let warningCount = 0;

	// Combine all for display, new first then existing
	const allDisplay = [...newEntries.map(e => ({ ...e, isNew: true })), ...existingEntries.map(e => ({ ...e, isNew: false }))];

	for (const entry of allDisplay) {
		const rulesStr = formatRulesShort(entry.rules);
		const truncatedRules = rulesStr.length > COL_RULES - 2 ? rulesStr.substring(0, COL_RULES - 5) + '...' : rulesStr;

		let status;
		const skippedWarnings = entry.warnings.filter(w => w.startsWith('Unsupported color:'));

		if (!entry.isNew) {
			status = 'EXISTS';
		} else if (processMode) {
			// Actually insert
			if (entry.rules.length > 0) {
				try {
					sessions.setGlowRules(entry.widgetKey, entry.rules);
					status = 'INSERTED';
					insertedCount++;
				} catch (err) {
					status = `ERROR: ${err.message}`;
				}
			} else {
				status = 'SKIP (no valid rules)';
			}
		} else {
			status = 'NEW';
			if (entry.rules.length > 0) insertedCount++;
		}

		if (skippedWarnings.length > 0) {
			status += ` (${skippedWarnings.length} rule${skippedWarnings.length > 1 ? 's' : ''} skipped)`;
			warningCount += skippedWarnings.length;
		}

		// Count non-color warnings
		const otherWarnings = entry.warnings.filter(w => !w.startsWith('Unsupported color:'));
		warningCount += otherWarnings.length;

		console.log(
			entry.itemName.substring(0, COL_ITEM - 2).padEnd(COL_ITEM) +
			truncatedRules.padEnd(COL_RULES) +
			status
		);
	}

	console.log('\u2500'.repeat(TABLE_WIDTH));

	// Show duplicates
	if (duplicateItems.size > 0) {
		console.log('');
		console.log('SKIPPED (duplicate items \u2014 configure manually):');
		// Group by item name, show count; note if ohProxy rules already exist
		const seen = new Set();
		for (const entry of duplicateEntries) {
			if (seen.has(entry.itemName)) continue;
			seen.add(entry.itemName);
			const count = duplicateItems.get(entry.itemName);

			// Resolve widget keys for all entries of this item and check the DB
			const entriesForItem = duplicateEntries.filter(e => e.itemName === entry.itemName);
			const hasExistingRules = entriesForItem.some(e => {
				// Check all possible widget keys (REST matches + DSL fallback)
				const keysToCheck = [];
				if (!restApiFailed && restWidgetMap.has(e.itemName)) {
					for (const match of restWidgetMap.get(e.itemName)) {
						keysToCheck.push(match.key);
					}
				}
				keysToCheck.push(computeKeyFromDsl(e.itemName, e.rawLabel, e.widgetType));
				return keysToCheck.some(k => existingKeys.has(k));
			});

			const note = hasExistingRules ? ' \u2714 has ohProxy rules' : '';
			console.log(`  ${entry.itemName.padEnd(38)} (${count} entries in sitemap)${note}`);
		}
	}

	// Summary
	console.log('');
	const parts = [];
	parts.push(`${insertedCount} ${processMode ? 'inserted' : 'new'}`);
	parts.push(`${existingEntries.length} existing (skip)`);
	if (warningCount > 0) parts.push(`${warningCount} warnings`);
	if (duplicateItems.size > 0) parts.push(`${duplicateItems.size} duplicates skipped`);
	console.log(`Summary: ${parts.join(', ')}`);

	if (processMode && insertedCount > 0) {
		console.log('');
		console.log(`Done. Inserted glow rules for ${insertedCount} widgets.`);
		console.log('Restart ohProxy to apply: supervisorctl restart ohProxy');
	} else if (!processMode) {
		console.log('Run with --process to apply.');
	}

	sessions.closeDb();
}

function formatRulesShort(rules) {
	if (!rules || rules.length === 0) return '(none)';
	return rules.map(r => {
		if (r.operator === '*') return `* \u2192 ${r.color}`;
		return `${r.operator} ${r.value} \u2192 ${r.color}`;
	}).join(', ');
}

// Run
main().catch(err => {
	console.error(`Fatal error: ${err.message}`);
	process.exit(1);
});
