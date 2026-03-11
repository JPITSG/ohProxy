'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Video preview cache versioning', () => {
	it('serves a preview version and only enables immutable caching for matching versioned requests', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const rawVersion = req\.query\?\.v;/);
		assert.match(server, /const requestedVersion = rawVersion === undefined \? '' : normalizeVideoPreviewVersionToken\(rawVersion\);/);
		assert.match(server, /const previewVersion = String\(Math\.trunc\(stats\.mtimeMs\)\);/);
		assert.match(server, /res\.set\('X-Preview-Version', previewVersion\);/);
		assert.match(server, /if \(requestedVersion && requestedVersion === previewVersion\) \{\s*res\.set\('Cache-Control', `public, max-age=\$\{VIDEO_PREVIEW_CACHE_MAX_AGE_SEC\}, immutable`\);\s*\} else \{\s*res\.set\('Cache-Control', 'no-store'\);/s);
	});

	it('resolves preview versions with HEAD before using versioned preview image URLs in the client', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function buildVideoPreviewUrl\(rawVideoUrl, version\)/);
		assert.match(app, /fetch\(previewBaseUrl, \{\s*method: 'HEAD',\s*cache: 'no-store',\s*credentials: 'same-origin',\s*\}\)/s);
		assert.match(app, /const previewUrl = version \? buildVideoPreviewUrl\(trimmed, version\) : '';/);
		assert.match(app, /setVideoPreviewBackground\(previewDiv, rawVideoUrl\);/);
	});
});
