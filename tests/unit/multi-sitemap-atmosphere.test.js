'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Multi-Sitemap Atmosphere and Bootstrap Wiring', () => {
	it('resolves request sitemap from session-selected value with first-sitemap fallback', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /function resolveRequestSitemapName\(req\) \{/);
		assert.match(server, /const selected = safeText\(req\?\.ohProxySession\?\.settings\?\.selectedSitemap\)\.trim\(\);/);
		assert.match(server, /const found = sitemaps\.find\(\(entry\) => entry\?\.name === selected\);/);
		assert.match(server, /return safeText\(sitemaps\[0\]\?\.name\)\.trim\(\);/);
	});

	it('uses sitemap-scoped Atmosphere page subscriptions with encoded sitemap and page id', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /function connectAtmospherePage\(sitemapName, pageId\) \{/);
		assert.match(server, /const key = atmospherePageKey\(sitemap, page\);/);
		assert.match(server, /const reqPath = `\$\{basePath\}\/rest\/sitemaps\/\$\{encodeURIComponent\(sitemap\)\}\/\$\{encodeURIComponent\(page\)\}\?type=json`;/);
		assert.match(server, /scheduleAtmospherePageReconnect\(sitemap, page, 100\);/);
	});

	it('discovers Atmosphere targets across all cached sitemaps', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /async function fetchAllPagesAcrossSitemaps\(\) \{/);
		assert.match(server, /for \(const entry of sitemaps\) \{/);
		assert.match(server, /targets\.push\(\{ sitemapName, pageId: normalizedPageId \}\);/);
		assert.match(server, /targets\.push\(\{ sitemapName, pageId: sitemapName \}\);/);
	});

	it('connectAtmosphere subscribes with sitemap-aware targets and logs per-sitemap counts', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const \{ targets, needsSitemapRefresh \} = await fetchAllPagesAcrossSitemaps\(\);/);
		assert.match(server, /const perSitemapCounts = new Map\(\);/);
		assert.match(server, /connectAtmospherePage\(target\.sitemapName, target\.pageId\);/);
	});

	it('refreshSitemapCache stores a sitemap catalog and keeps first sitemap alias for compatibility', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const oldSignature = sitemapCatalogSignature\(getBackgroundSitemaps\(\)\);/);
		assert.match(server, /backgroundState\.sitemaps = nextCatalog;/);
		assert.match(server, /backgroundState\.sitemap = \{ \.\.\.nextCatalog\[0\] \};/);
		assert.match(server, /const catalogChanged = !!oldSignature && !!newSignature && oldSignature !== newSignature;/);
	});

	it('sendIndex resolves selected sitemap and bootstraps homepage/cache for that sitemap', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const sitemapName = resolveRequestSitemapName\(req\);/);
		assert.match(server, /getHomepageData\(req, sitemapName\),/);
		assert.match(server, /getFullSitemapData\(sitemapName\),/);
	});
});
