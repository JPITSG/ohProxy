'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('Sitemap selector pending reload override', () => {
	it('stores a one-shot pending sitemap name before reloading after a successful switch', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const PENDING_SELECTED_SITEMAP_STORAGE_KEY = 'ohPendingSelectedSitemap';/);
		assert.match(app, /function setPendingSelectedSitemapName\(name\) \{\s*const trimmed = safeText\(name\)\.trim\(\);[\s\S]*sessionStorage\.setItem\(PENDING_SELECTED_SITEMAP_STORAGE_KEY, trimmed\);/);
		assert.match(app, /const saved = await persistSelectedSitemapName\(target, \{ throwOnError: true \}\);\s*if \(!saved\) throw new Error\('Failed to save selected sitemap'\);\s*setPendingSelectedSitemapName\(target\);\s*const reloadUrl = `\$\{window\.location\.pathname\}\$\{window\.location\.search\}\$\{window\.location\.hash\}`;/);
	});

	it('prefers and clears the pending sitemap override during boot resolution', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function clearPendingSelectedSitemapName\(\) \{\s*try \{\s*sessionStorage\.removeItem\(PENDING_SELECTED_SITEMAP_STORAGE_KEY\);/);
		assert.match(app, /const pending = getPendingSelectedSitemapName\(\);\s*const pendingSelected = pending \? options\.find\(\(entry\) => entry\.name === pending\) : null;\s*if \(pendingSelected\) \{\s*setStoredSelectedSitemapName\(pendingSelected\.name\);\s*clearPendingSelectedSitemapName\(\);\s*return pendingSelected;\s*\}\s*if \(pending\) clearPendingSelectedSitemapName\(\);/);
	});

	it('lets snapshot fallback prefer the pending sitemap until boot resolves it', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function getPreferredSnapshotSitemapName\(\) \{\s*const active = normalizeSnapshotSitemapName\(state\.sitemapName\);\s*if \(active\) return active;\s*const pending = normalizeSnapshotSitemapName\(getPendingSelectedSitemapName\(\)\);\s*if \(pending\) return pending;/);
	});
});
