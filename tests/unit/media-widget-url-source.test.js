'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Media widget URL source', () => {
	it('uses widget.url for Image/Webview/Video URL building in the client', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function mediaWidgetSourceUrl\(widget\) \{\s*return safeText\(widget\?\.url \|\| ''\)\.trim\(\);\s*\}/s);
		assert.match(app, /function imageWidgetUrl\(widget\) \{[\s\S]*const url = mediaWidgetSourceUrl\(widget\);[\s\S]*return `proxy\?url=\$\{encodeURIComponent\(url\)\}`;/);
		assert.match(app, /const rawWebviewUrl = isWebview \? mediaWidgetSourceUrl\(w\) : '';/);
		assert.match(app, /const rawVideoUrl = isVideo \? mediaWidgetSourceUrl\(w\) : '';/);
		assert.doesNotMatch(app, /const rawWebviewUrl = isWebview \? safeText\(w\?\.label \|\| ''\) : '';/);
		assert.doesNotMatch(app, /const rawVideoUrl = isVideo \? safeText\(w\?\.label \|\| ''\) : '';/);
	});

	it('uses Video.url for background preview extraction on the server', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const url = safeText\(data\.url\)\.trim\(\);/);
		assert.doesNotMatch(server, /const url = \(data\.label \|\| ''\)\.trim\(\);/);
	});
});
