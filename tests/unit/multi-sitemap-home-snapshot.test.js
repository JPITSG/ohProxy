'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('Multi-Sitemap Home Snapshot Wiring', () => {
	it('uses sitemap-scoped home snapshot storage keys', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const HOME_CACHE_KEY_BASE = 'ohProxyHomeSnapshot';/);
		assert.match(app, /const HOME_CACHE_KEY_PREFIX = `\$\{HOME_CACHE_KEY_BASE\}:`;/);
		assert.match(app, /function getHomeSnapshotKey\(sitemapName\) \{/);
		assert.match(app, /return normalized \? `\$\{HOME_CACHE_KEY_PREFIX\}\$\{normalized\}` : '';/);
		assert.doesNotMatch(app, /HOME_CACHE_KEY_LEGACY/);
	});

	it('saves snapshot payload with sitemap identity and icon caches', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const sitemapName = getPreferredSnapshotSitemapName\(\);/);
		assert.match(app, /sitemapName,/);
		assert.match(app, /sitemapTitle: state\.sitemapTitle \|\| state\.rootPageTitle \|\| state\.pageTitle \|\| sitemapName,/);
		assert.match(app, /iconCache: Object\.fromEntries\(iconCache\),/);
		assert.match(app, /inlineIcons: Object\.fromEntries\(homeInlineIcons\),/);
		assert.match(app, /localStorage\.setItem\(getHomeSnapshotKey\(sitemapName\), JSON\.stringify\(snapshot\)\);/);
	});

	it('loads snapshots with sitemap-aware lookup and mismatch protection', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function loadHomeSnapshot\(options = \{\}\) \{/);
		assert.match(app, /const requestedSitemap = normalizeSnapshotSitemapName\(opts\.sitemapName\);/);
		assert.match(app, /const candidates = getHomeSnapshotLookupOrder\(requestedSitemap\);/);
		assert.match(app, /const snapshotSitemap = normalizeSnapshotSitemapName\(snapshot\.sitemapName \|\| candidate\.sitemapName\);/);
		assert.match(app, /if \(requestedSitemap && snapshotSitemap && snapshotSitemap !== requestedSitemap\) \{/);
		assert.doesNotMatch(app, /allowLegacyFallback/);
	});

	it('restores sitemap identity and sitemap-associated icon caches from snapshot', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const snapshotSitemapName = normalizeSnapshotSitemapName\(snapshot\.sitemapName\);/);
		assert.match(app, /state\.sitemapName = snapshotSitemapName;/);
		assert.match(app, /state\.sitemapTitle = safeText\(snapshot\.sitemapTitle \|\| snapshot\.rootPageTitle \|\| snapshot\.pageTitle \|\| snapshotSitemapName\);/);
		assert.match(app, /iconCache\.clear\(\);/);
		assert.match(app, /setBoundedCache\(iconCache, key, url, MAX_ICON_CACHE\);/);
		assert.match(app, /replaceHomeInlineIcons\(snapshot\.inlineIcons && typeof snapshot\.inlineIcons === 'object' \? snapshot\.inlineIcons : \{\}\);/);
	});

	it('passes sitemap context when attempting snapshot restores', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /loadHomeSnapshot\(\{ sitemapName: getPreferredSnapshotSitemapName\(\) \}\)/);
	});
});
