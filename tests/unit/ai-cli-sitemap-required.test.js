'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const AI_CLI_FILE = path.join(PROJECT_ROOT, 'ai-cli.js');

describe('AI CLI Sitemap Requirement', () => {
	it('documents and enforces explicit sitemap selection for generation and testvoice', () => {
		const cli = fs.readFileSync(AI_CLI_FILE, 'utf8');
		assert.match(cli, /--sitemap <name>\s+Sitemap name \(required\)/);
		assert.match(cli, /function getRequiredSitemapArg\(usageLine, defaultValue = ''\) \{/);
		assert.match(cli, /console\.error\('Error: Missing required --sitemap <name>'\);/);
		assert.match(cli, /getRequiredSitemapArg\('node ai-cli\.js genstructuremap --sitemap <name>'/);
		assert.match(cli, /getRequiredSitemapArg\('node ai-cli\.js testvoice "turn on the kitchen lights" --sitemap <name>'\)/);
		assert.match(cli, /Usage: node ai-cli\.js testvoice "turn on the kitchen lights" --sitemap <name>/);
		assert.match(cli, /function structureMapScopedPath\(sitemapName, type = 'writable'\) \{/);
		assert.match(cli, /const scopedAllPath = structureMapScopedPath\(result\.sitemapName, 'all'\);/);
		assert.match(cli, /const scopedWritablePath = structureMapScopedPath\(result\.sitemapName, 'writable'\);/);
			assert.match(cli, /const scopedReadablePath = structureMapScopedPath\(result\.sitemapName, 'readable'\);/);
			assert.match(cli, /const writableMapPath = structureMapScopedPath\(sitemapName, 'writable'\);/);
			assert.match(cli, /Error: Writable structure map not found for sitemap "\$\{sitemapName\}"\./);
			assert.match(cli, /Saved sitemap-scoped structure maps for "\$\{result\.sitemapName\}":/);
			assert.match(cli, /testVoice\(getTestVoiceCommand\(\)\);/);
			assert.doesNotMatch(cli, /const structureMap = JSON\.parse\(fs\.readFileSync\(STRUCTURE_MAP_WRITABLE, 'utf8'\)\);/);
			assert.doesNotMatch(cli, /const STRUCTURE_MAP_ALL = path\.join\(AI_CACHE_DIR, 'structuremap-all\.json'\);/);
			assert.doesNotMatch(cli, /const STRUCTURE_MAP_WRITABLE = path\.join\(AI_CACHE_DIR, 'structuremap-writable\.json'\);/);
			assert.doesNotMatch(cli, /const STRUCTURE_MAP_READABLE = path\.join\(AI_CACHE_DIR, 'structuremap-readable\.json'\);/);
			assert.doesNotMatch(cli, /Legacy compatibility aliases:/);
			assert.doesNotMatch(cli, /fs\.writeFileSync\(STRUCTURE_MAP_/);
		});
	});
