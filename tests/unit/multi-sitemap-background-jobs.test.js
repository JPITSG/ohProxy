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

	it('writes sitemap-scoped structure-map files and legacy compatibility aliases', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /function structureMapPathForSitemap\(sitemapName, type = 'writable'\) \{/);
		assert.match(server, /return path\.join\(AI_CACHE_DIR, `structuremap-\$\{token\}-\$\{normalizedType\}\.json`\);/);
		assert.match(server, /if \(options\.writeLegacy === true\) \{/);
		assert.match(server, /const legacyPath = STRUCTURE_MAP_LEGACY_PATHS\[type\];/);
	});

	it('refreshes structure maps across all available sitemaps and keeps legacy files on primary', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const sitemapNames = await fetchStructureMapSitemapNames\(\);/);
		assert.match(server, /for \(const sitemapName of sitemapNames\) \{/);
		assert.match(server, /const result = await generateStructureMapForSitemap\(sitemapName, sitemapNames\);/);
		assert.match(server, /if \(primaryResult\) \{\s*writeStructureMapResultFiles\(primaryResult, generatedAt, \{ writeLegacy: true \}\);/s);
	});

	it('voice requests resolve selected sitemap and attempt on-demand structure-map generation', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const requestSitemapName = resolveRequestSitemapName\(req\);/);
		assert.match(server, /const structureMapResult = await getOrGenerateAiStructureMapForSitemap\(requestSitemapName\);/);
		assert.match(server, /const cooldownMs = Math\.max\(0, Number\(structureMapResult\.cooldownMs\) \|\| 0\);/);
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
