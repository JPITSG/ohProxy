'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { widgetConfigLookupKeys } = require('../../lib/widget-normalizer');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

function read(filePath) {
	return fs.readFileSync(filePath, 'utf8');
}

describe('Iframe Height First Render', () => {
	it('uses contextless widget config keys for iframe widgets with cached navigation path context', () => {
		const keys = widgetConfigLookupKeys({
			type: 'Webview',
			url: 'https://example.invalid/weather',
			widgetId: '020100',
			__sitemapName: 'default',
			__path: ['Weather', 'Cloudy'],
			__frame: '',
		});

		assert.ok(keys.includes('widget:default|label:|type:Webview|path:Weather>Cloudy|frame:'));
		assert.ok(keys.includes('020100'));
		assert.ok(keys.includes('widget:default|label:|type:Webview|path:|frame:'));
		assert.ok(!keys.some((key) => key.includes('https://example.invalid/weather')));
	});

	it('annotates server-embedded sitemap pages with resolved iframe heights', () => {
		const server = read(SERVER_FILE);
		assert.match(server, /function annotatePageIframeHeights\(page, ctx, iframeHeightMap\) \{/);
		assert.match(server, /annotatePageIframeHeights\(page, \{ path: pagePath, sitemapName \}, iframeHeightMap\);/);
		assert.match(server, /annotateWidgetIframeHeights\(widgets, buildWidgetIframeHeightMap\(\)\);/);
	});

	it('client render uses live iframe config first and bootstrapped widget height as fallback', () => {
		const app = read(APP_FILE);
		assert.match(app, /function getWidgetIframeHeightOverride\(widget\) \{/);
		assert.match(app, /const configuredHeight = normalizeIframeHeightValue\(getWidgetIframeConfig\(widget\)\?\.height\);/);
		assert.match(app, /return normalizeIframeHeightValue\(widget\?\.__iframeHeight\);/);
		assert.match(app, /const iframeHeightOverride = getWidgetIframeHeightOverride\(w\);/);
	});
});
