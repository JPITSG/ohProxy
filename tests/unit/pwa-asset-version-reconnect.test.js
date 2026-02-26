'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('PWA reconnect asset version handling', () => {
	it('normalizes asset versions with defensive length and pattern guards', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function normalizeAssetVersion\(value\) \{\s*const normalized = safeText\(value\)\.trim\(\);\s*if \(!normalized\) return '';\s*if \(normalized\.length > 100\) return '';\s*if \(!\/\^v\[\\w\.-\]\+\$\/\.test\(normalized\)\) return '';\s*return normalized;\s*\}/);
	});

	it('persists known asset version and falls back to stored baseline', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const ASSET_VERSION_STORAGE_KEY = 'ohAssetVersion';/);
		assert.match(app, /function readStoredAssetVersion\(\) \{\s*try \{\s*return normalizeAssetVersion\(localStorage\.getItem\(ASSET_VERSION_STORAGE_KEY\)\);/);
		assert.match(app, /function writeStoredAssetVersion\(version\) \{\s*const normalized = normalizeAssetVersion\(version\);\s*if \(!normalized\) return;\s*try \{\s*localStorage\.setItem\(ASSET_VERSION_STORAGE_KEY, normalized\);/);
		assert.match(app, /let effectiveAssetVersion = normalizeAssetVersion\(OH_CONFIG\.assetVersion\);\s*if \(effectiveAssetVersion\) \{\s*writeStoredAssetVersion\(effectiveAssetVersion\);\s*\} else \{\s*effectiveAssetVersion = readStoredAssetVersion\(\);\s*\}/);
	});

	it('uses stored baseline on reconnect and avoids false prompt when baseline is unknown', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /if \(msg\.event === 'connected'\) \{\s*const serverAssetVersion = normalizeAssetVersion\(msg\.data\?\.assetVersion\);\s*if \(!serverAssetVersion\) return;\s*if \(!effectiveAssetVersion\) \{\s*effectiveAssetVersion = serverAssetVersion;\s*writeStoredAssetVersion\(serverAssetVersion\);\s*return;\s*\}\s*if \(serverAssetVersion !== effectiveAssetVersion\) \{\s*console\.log\('Asset version mismatch on reconnect, reloading\.\.\.'\);\s*promptAssetReload\(\);/);
		assert.doesNotMatch(app, /msg\.data\.assetVersion !== OH_CONFIG\.assetVersion/);
	});

	it('still prompts reload on explicit assetVersionChanged event', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /if \(msg\.event === 'assetVersionChanged'\) \{\s*\/\/ Server assets updated - reload to get new version\s*console\.log\('Asset version changed, reloading\.\.\.'\);\s*promptAssetReload\(\);/);
	});
});
