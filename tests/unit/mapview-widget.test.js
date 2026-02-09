'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('Mapview Widget Rendering', () => {
	it('detects Mapview widgets and uses iframe height override parity with webview', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const isMapview = t === 'mapview';/);
		assert.match(app, /const mapviewHeight = isMapview \? \(iframeHeightOverride \|\| parseInt\(w\?\.height, 10\) \|\| 0\) : 0;/);
	});

	it('parses location state and builds /presence map URL with lat/lon params', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function parseMapviewCoordinates\(stateValue\) \{/);
		assert.match(app, /POINT\\s\*\\\(\\s\*\(-\?\\d\+\(\?:\\\.\\d\+\)\?\)\\s\+\(-\?\\d\+\(\?:\\\.\\d\+\)\?\)\\s\*\\\)\$\/i/);
		assert.match(app, /return `\/presence\?lat=\$\{encodeURIComponent\(normalizedLat\)\}&lon=\$\{encodeURIComponent\(normalizedLon\)\}`;/);
	});

	it('renders mapview as media card with iframe and no data fallback', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /if \(isMapview\) \{\s*card\.classList\.add\('mapview-card'\);/);
		assert.match(app, /if \(!mapviewUrl\) \{\s*row\.classList\.remove\('hidden'\);\s*controls\.classList\.add\('mt-3'\);\s*controls\.innerHTML = `<div class="text-sm text-slate-400">Map location not available<\/div>`;/);
		assert.match(app, /card\.classList\.toggle\('sm:col-span-2', isImage \|\| isChart \|\| isMapview \|\| isWebview \|\| isVideo \|\| cardWidthFull\);/);
	});

	it('includes mapview in admin card config iframe/media classification', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const isIframeWidget = wType === 'video' \|\| wType\.includes\('webview'\) \|\| wType === 'chart' \|\| wType === 'mapview';/);
		assert.match(app, /const isMediaWidget = wType\.includes\('image'\) \|\| wType === 'chart' \|\| wType\.includes\('webview'\) \|\| wType === 'video' \|\| wType === 'mapview';/);
	});
});
