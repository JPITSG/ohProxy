'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Multi-Sitemap Background Jobs and Voice Wiring', () => {
	it('parses structure-map sitemap lists with the shared sitemap extractor', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /async function fetchStructureMapSitemapNames\(\) \{/);
		assert.match(server, /const sitemaps = extractSitemaps\(data\);/);
		assert.match(server, /const normalized = normalizeSitemapEntry\(entry, now\);/);
	});

	it('writes sitemap-scoped structure-map files only', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /function structureMapPathForSitemap\(sitemapName, type = 'writable'\) \{/);
		assert.match(server, /return path\.join\(AI_CACHE_DIR, `structuremap-\$\{token\}-\$\{normalizedType\}\.json`\);/);
		assert.doesNotMatch(server, /STRUCTURE_MAP_LEGACY_PATHS/);
		assert.doesNotMatch(server, /if \(options\.writeLegacy === true\) \{/);
	});

	it('refreshes structure maps across all available sitemaps without legacy alias writes', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const sitemapNames = await fetchStructureMapSitemapNames\(\);/);
		assert.match(server, /for \(const sitemapName of sitemapNames\) \{/);
		assert.match(server, /const result = await generateStructureMapForSitemap\(sitemapName, sitemapNames\);/);
		assert.match(server, /writeStructureMapResultFiles\(result, generatedAt\);/);
		assert.doesNotMatch(server, /writeStructureMapResultFiles\(primaryResult, generatedAt, \{ writeLegacy: true \}\);/);
	});

	it('voice requests resolve selected sitemap and attempt on-demand structure-map generation', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /let requestSitemapName = resolveRequestSitemapName\(req\);/);
		assert.match(server, /if \(!requestSitemapName\) \{\s*await refreshSitemapCache\(\{ skipAtmosphereResubscribe: true \}\);\s*requestSitemapName = resolveRequestSitemapName\(req\);\s*\}/s);
		assert.match(server, /if \(!requestSitemapName\) \{\s*logMessage\(`\[Voice\] \[\$\{username\}\] "\$\{trimmed\}" - sitemap not resolved`\);/);
		assert.match(server, /const structureMapResult = await getOrGenerateAiStructureMapForSitemap\(requestSitemapName\);/);
		assert.match(server, /const cooldownMs = Math\.max\(0, Number\(structureMapResult\.cooldownMs\) \|\| 0\);/);
	});

	it('uses strict sitemap-scoped structure-map lookup', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(
			server,
			/if \(!targetSitemap\) \{\s*return \{ map: null, generated: false, cooldownMs: 0, error: new Error\('Sitemap not resolved'\) \};\s*\}/s
		);
		assert.match(server, /function getAiStructureMap\(sitemapName = ''\) \{/);
		assert.match(server, /if \(!normalizedName\) return null;/);
		assert.doesNotMatch(server, /allowLegacyFallback/);
	});

	it('video preview capture scans every cached sitemap before taking screenshots', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const sitemaps = getBackgroundSitemaps\(\);/);
		assert.match(server, /for \(const entry of sitemaps\) \{/);
		assert.match(server, /fetchOpenhab\(`\/rest\/sitemaps\/\$\{encodeURIComponent\(sitemapName\)\}\?type=json`\)/);
		assert.match(server, /const sitemapVideoUrls = extractVideoUrls\(sitemapData\);/);
		assert.match(server, /if \(videoUrls\.has\(url\)\) continue;/);
	});
});
