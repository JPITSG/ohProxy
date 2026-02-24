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
		assert.match(app, /const mapviewUrl = isMapview \? resolveMapviewUrl\(w, st\) : '';/);
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
		assert.match(app, /renderIframeWidget\(card, mapviewUrl, mapviewHeight,\s*'mapview-frame-container', 'mapview-frame'/);
		assert.match(app, /if \(!url\) \{\s*row\.classList\.remove\('hidden'\);\s*showUnavailableMessage\(controls, errorMessage\);/);
		assert.match(app, /card\.classList\.toggle\('sm:col-span-2', isImage \|\| isChart \|\| isMapview \|\| isWebview \|\| isVideo \|\| cardWidthFull\);/);
	});

	it('supports openHAB mapview rendering mode via direct OpenStreetMap embed URL', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function normalizeMapviewRenderingMode\(value\) \{/);
		assert.match(app, /return mode === 'openhab' \? 'openhab' : 'ohproxy';/);
		assert.match(app, /function buildOpenhabMapviewUrl\(coords\) \{/);
		assert.match(app, /return `https:\/\/www\.openstreetmap\.org\/export\/embed\.html\?bbox=\$\{bboxLonMin\},\$\{bboxLatMin\},\$\{bboxLonMax\},\$\{bboxLatMax\}&marker=\$\{normalizedLat\},\$\{normalizedLon\}`;/);
		assert.match(app, /function resolveMapviewUrl\(widget, stateValue\) \{/);
		assert.match(app, /const coords = parseMapviewCoordinates\(stateValue\);/);
		assert.match(app, /if \(mode === 'openhab'\) \{\s*return buildOpenhabMapviewUrl\(coords\);\s*\}/);
	});

	it('includes mapview in admin card config iframe/media classification', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const isIframeWidget = wType === 'video' \|\| wType\.includes\('webview'\) \|\| wType === 'chart' \|\| wType === 'mapview';/);
		assert.match(app, /const isMediaWidget = wType\.includes\('image'\) \|\| wType === 'chart' \|\| wType\.includes\('webview'\) \|\| wType === 'video' \|\| wType === 'mapview';/);
	});
});
