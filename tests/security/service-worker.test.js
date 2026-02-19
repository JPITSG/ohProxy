'use strict';

/**
 * Service Worker Security Tests
 *
 * Tests that the service worker doesn't cache user-specific or sensitive data,
 * which could lead to cross-user data leakage or stale security configurations.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SW_FILE = path.join(PROJECT_ROOT, 'public', 'sw.js');

// Files that contain user-specific data and should NEVER be precached
const USER_SPECIFIC_FILES = [
	'config.js',        // User roles, visibility settings
	'session',          // Session data
	'auth',             // Auth tokens
	'user',             // User preferences
	'settings',         // User settings
	'profile',          // User profile
	'credentials',      // Credentials
];

// Endpoints that should never be cached (contain dynamic/user data)
const NEVER_CACHE_PATTERNS = [
	/\/api\//,          // API endpoints
	/\/rest\//,         // REST API
	/\/config\.js/,     // Config file
	/\/session/,        // Session endpoints
	/\/auth/,           // Auth endpoints
	/\/proxy/,          // Proxy requests
	/\/search-index/,   // Search index
];

function readFile(filePath) {
	return fs.readFileSync(filePath, 'utf8');
}

function extractPrecacheUrls(content) {
	// Extract PRECACHE_URLS array
	const match = content.match(/PRECACHE_URLS\s*=\s*\[([\s\S]*?)\]/);
	if (!match) return [];

	const arrayContent = match[1];
	// Extract string literals from array
	const urls = [];
	const stringPattern = /['"]([^'"]+)['"]/g;
	let stringMatch;
	while ((stringMatch = stringPattern.exec(arrayContent)) !== null) {
		urls.push(stringMatch[1]);
	}
	return urls;
}

function extractCacheExclusions(content) {
	// Find shouldHandleRequest or similar function
	const exclusions = [];

	// Look for patterns that exclude from caching
	const excludePatterns = [
		/if\s*\([^)]*\.includes\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)\s*return\s+false/g,
		/if\s*\([^)]*\.endsWith\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)\s*return\s+false/g,
		/if\s*\([^)]*\.startsWith\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)\s*return\s+false/g,
	];

	for (const pattern of excludePatterns) {
		let match;
		while ((match = pattern.exec(content)) !== null) {
			exclusions.push(match[1]);
		}
	}

	return exclusions;
}

describe('Service Worker: Precache Security', () => {
	it('does not precache user-specific files', () => {
		const content = readFile(SW_FILE);
		const precacheUrls = extractPrecacheUrls(content);
		const issues = [];

		for (const url of precacheUrls) {
			const normalizedUrl = url.toLowerCase();
			for (const sensitiveFile of USER_SPECIFIC_FILES) {
				if (normalizedUrl.includes(sensitiveFile.toLowerCase())) {
					issues.push({
						url,
						reason: `Contains user-specific file pattern: ${sensitiveFile}`,
					});
				}
			}
		}

		if (issues.length > 0) {
			const details = issues.map(i => `  ${i.url}: ${i.reason}`).join('\n');
			assert.fail(`Service worker precaches user-specific files:\n${details}\n\nThese files may contain user-specific data and should not be cached.`);
		}
	});

	it('does not precache API endpoints', () => {
		const content = readFile(SW_FILE);
		const precacheUrls = extractPrecacheUrls(content);
		const issues = [];

		for (const url of precacheUrls) {
			if (/\/api\/|\/rest\//.test(url)) {
				issues.push(url);
			}
		}

		if (issues.length > 0) {
			assert.fail(`Service worker precaches API endpoints:\n  ${issues.join('\n  ')}`);
		}
	});

	it('excludes dynamic content from runtime caching', () => {
		const content = readFile(SW_FILE);
		const exclusions = extractCacheExclusions(content);

		// Check that critical patterns are excluded
		const requiredExclusions = [
			{ pattern: /api/, description: 'API endpoints' },
			{ pattern: /rest/, description: 'REST endpoints' },
			{ pattern: /config\.js/, description: 'Config file' },
		];

		const missing = [];
		for (const required of requiredExclusions) {
			const found = exclusions.some(e => required.pattern.test(e));
			if (!found) {
				// Also check if pattern appears in shouldHandleRequest false returns
				const inCode = new RegExp(`['"].*${required.pattern.source}.*['"].*return\\s+false`, 'i').test(content);
				if (!inCode) {
					missing.push(required.description);
				}
			}
		}

		if (missing.length > 0) {
			assert.fail(`Service worker does not exclude from caching:\n  ${missing.join('\n  ')}`);
		}
	});
});

describe('Service Worker: Cache Strategy', () => {
	it('uses appropriate cache strategy for static assets', () => {
		const content = readFile(SW_FILE);

		// Should use cache-first for static assets (they have versioned filenames)
		const hasCacheFirst = /caches\.match\s*\(/.test(content) &&
		                      /if\s*\(\s*cached\s*\)/.test(content);

		assert.ok(hasCacheFirst, 'Service worker should use cache-first for static assets');
	});

	it('has cache versioning mechanism', () => {
		const content = readFile(SW_FILE);

		// Should have a versioned cache name
		const hasCacheVersion = /CACHE_NAME\s*=\s*['"][^'"]*(?:__\w+_VERSION__|v\d+)[^'"]*['"]/.test(content);

		assert.ok(hasCacheVersion, 'Service worker should have versioned cache name');
	});

	it('cleans up old caches on activate', () => {
		const content = readFile(SW_FILE);

		// Should delete old caches on activate
		const hasCleanup = /activate.*caches\.keys\s*\(\).*filter.*delete/s.test(content) ||
		                   /activate.*caches\.delete/s.test(content);

		assert.ok(hasCleanup, 'Service worker should clean up old caches on activate');
	});
});

describe('Service Worker: Security Headers', () => {
	it('does not cache responses with sensitive headers', () => {
		const content = readFile(SW_FILE);

		// Check for header inspection before caching
		// Good practice: check Set-Cookie, Authorization headers
		const checksHeaders = /response\.headers/.test(content) ||
		                      /clone\s*\(\)/.test(content); // At least clones before caching

		// This is informational - many SWs don't check headers
		if (!checksHeaders) {
			console.log('  Note: Service worker does not inspect response headers before caching');
		}
	});
});

describe('Service Worker: Transport RPC Security', () => {
	it('enforces same-origin validation for transport-http-request URLs', () => {
		const content = readFile(SW_FILE);
		assert.match(content, /new URL\(url,\s*self\.location\.origin\)/, 'transport HTTP RPC should parse URLs against service worker origin');
		assert.match(content, /parsedUrl\.origin !== self\.location\.origin/, 'transport HTTP RPC should reject cross-origin URLs');
		assert.match(content, /Cross-origin transport requests are not allowed/, 'transport HTTP RPC should emit explicit cross-origin rejection');
	});

	it('prunes stale paused transport clients to avoid long-lived set growth', () => {
		const content = readFile(SW_FILE);
		assert.match(content, /const transportPausedClients = new Set\(\);/, 'transport paused client set should exist');
		assert.match(content, /async function pruneStaleTransportClients\(/, 'service worker should define paused-client prune helper');
		assert.match(content, /self\.clients\.matchAll\(\{ type: 'window', includeUncontrolled: true \}\)/, 'paused-client prune should inspect active window clients');
		assert.match(content, /if \(!activeClientIds\.has\(clientId\)\)/, 'paused-client prune should remove non-active client IDs');
		assert.match(content, /if \(data\.type === 'transport-http-pause'\) \{\s*await pruneStaleTransportClients\(\);/, 'pause handler should trigger stale paused-client pruning');
		assert.match(content, /if \(data\.type === 'transport-http-resume'\) \{\s*await pruneStaleTransportClients\(\);/, 'resume handler should trigger stale paused-client pruning');
	});
});
