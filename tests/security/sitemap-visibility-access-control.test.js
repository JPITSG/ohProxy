'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

function readServer() {
	return fs.readFileSync(SERVER_FILE, 'utf8');
}

describe('Sitemap visibility access-control wiring', () => {
	it('defines shared role/visibility helpers for widgets and sitemaps', () => {
		const source = readServer();
		assert.match(source, /function getRequestUserRole\(req\) \{/);
		assert.match(source, /function getRequestUsername\(req\) \{/);
		assert.match(source, /function isVisibilityAllowedForUser\(visibilityRule, userRole, username\) \{/);
		assert.match(source, /function buildSitemapVisibilityMap\(\) \{/);
		assert.match(source, /function isSitemapVisibleForRole\(sitemapName, userRole, username = '', sitemapVisibilityMap = null\) \{/);
		assert.match(source, /function filterSitemapPayloadForRole\(payload, userRole, username = '', sitemapVisibilityMap = null\) \{/);
	});

	it('keeps sitemap-config endpoints admin-only', () => {
		const source = readServer();
		assert.match(source, /app\.get\('\/api\/sitemap-config\/:sitemapName', requireAdmin, \(req, res\) => \{/);
		assert.match(source, /app\.post\('\/api\/sitemap-config', jsonParserMedium, requireAdmin, \(req, res\) => \{/);
	});

	it('rejects persisted selected sitemap writes when role cannot access target sitemap', () => {
		const source = readServer();
		assert.match(source, /if \(key === 'selectedSitemap'\) \{[\s\S]*if \(!isSitemapVisibleForRole\(selected, getRequestUserRole\(req\), getRequestUsername\(req\)\)\) \{[\s\S]*res\.status\(403\)\.json\(\{ error: 'Selected sitemap is not accessible' \}\);/s);
	});

	it('enforces sitemap visibility across search, full sitemap, proxy, and rest routes', () => {
		const source = readServer();
		assert.match(source, /app\.get\('\/search-index', async \(req, res\) => \{[\s\S]*if \(!isSitemapVisibleForRole\(searchSitemapName, userRole, username\)\) \{[\s\S]*403/s);
		assert.match(source, /app\.get\('\/sitemap-full', async \(req, res\) => \{[\s\S]*if \(!isSitemapVisibleForRole\(targetSitemapName, userRole, username\)\) \{[\s\S]*403/s);
		assert.match(source, /app\.get\('\/proxy', async \(req, res, next\) => \{[\s\S]*if \(proxySitemapName && !isSitemapVisibleForRole\(proxySitemapName, getRequestUserRole\(req\), getRequestUsername\(req\)\)\) \{[\s\S]*403/s);
		assert.match(source, /app\.use\('\/rest', async \(req, res, next\) => \{[\s\S]*rawQuerySitemap[\s\S]*isSitemapVisibleForRole\(querySitemapName, userRole, username, sitemapVisibilityMap\)[\s\S]*req\.path === '\/sitemaps'[\s\S]*filterSitemapPayloadForRole/s);
		assert.match(source, /const sitemapName = sitemapNameFromRestSitemapPath\(`\/rest\$\{req\.path\}`\);[\s\S]*isSitemapVisibleForRole\(sitemapName, userRole, username, sitemapVisibilityMap\)/s);
	});
});
