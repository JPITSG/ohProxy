'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { widgetKey } = require('../../lib/widget-normalizer');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function extractFunction(source, name) {
	const start = source.indexOf(`function ${name}(`);
	assert.ok(start >= 0, `${name} must exist`);
	const bodyStart = source.indexOf('{', start);
	let depth = 0;
	for (let i = bodyStart; i < source.length; i += 1) {
		if (source[i] === '{') depth += 1;
		else if (source[i] === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error(`Could not extract ${name}`);
}

function buildFunction(source, name, dependencies = {}) {
	const names = Object.keys(dependencies);
	const values = Object.values(dependencies);
	return Function(...names, `return (${extractFunction(source, name)});`)(...values);
}

const safeText = (v) => ((v === null || v === undefined) ? '' : String(v));
const sectionLabel = (w) => safeText(w?.label || w?.item?.label || w?.item?.name || '');
const frameSectionIcon = () => '';

function buildFlattenWidgets() {
	return buildFunction(app, 'flattenWidgets', { safeText, sectionLabel, frameSectionIcon });
}

function buildStripCrawlPathAnnotations() {
	return buildFunction(server, 'stripCrawlPathAnnotations');
}

// A Weather sub-page shaped like the real one: a Webview and an Image (neither has
// an item, so both are keyed by label/type/path/frame) plus an item-backed Text.
function weatherPage() {
	return {
		title: 'Weather [Few clouds]',
		widgets: [
			{ type: 'Webview', label: '', url: 'https://example.invalid/weather', widgetId: '020100' },
			{ type: 'Text', label: 'Temperature [21.0 °C]', item: { name: 'WeatherTemperature' } },
			{ type: 'Image', label: '', url: 'https://example.invalid/mgram', widgetId: '020114' },
		],
	};
}

describe('Sitemap cache path annotations', () => {
	it('server strips crawl __path from cached pages but keeps the other annotations', () => {
		const stripCrawlPathAnnotations = buildStripCrawlPathAnnotations();
		const page = {
			widgets: [
				{
					type: 'Frame',
					label: 'Climate',
					__path: ['Weather', 'Few clouds'],
					widgets: [
						{
							type: 'Webview',
							url: 'https://example.invalid/weather',
							__path: ['Weather', 'Few clouds'],
							__frame: 'Climate',
							__sectionPath: ['Climate'],
							__sitemapName: 'default',
							__iframeHeight: 250,
						},
					],
				},
			],
		};

		stripCrawlPathAnnotations(page);

		const frame = page.widgets[0];
		const webview = frame.widgets[0];
		assert.strictEqual('__path' in frame, false);
		assert.strictEqual('__path' in webview, false);
		// Everything the client also derives on a live page render must survive.
		assert.strictEqual(webview.__frame, 'Climate');
		assert.deepStrictEqual(webview.__sectionPath, ['Climate']);
		assert.strictEqual(webview.__sitemapName, 'default');
		assert.strictEqual(webview.__iframeHeight, 250);
	});

	it('server strips crawl __path from the XML-to-JSON widget shapes', () => {
		const stripCrawlPathAnnotations = buildStripCrawlPathAnnotations();

		const arrayShape = { widget: { item: [{ type: 'Webview', __path: ['A'] }] } };
		stripCrawlPathAnnotations(arrayShape);
		assert.strictEqual('__path' in arrayShape.widget.item[0], false);

		const singleShape = { widget: { item: { type: 'Webview', __path: ['A'] } } };
		stripCrawlPathAnnotations(singleShape);
		assert.strictEqual('__path' in singleShape.widget.item, false);

		const bareShape = { widget: { type: 'Webview', __path: ['A'] } };
		stripCrawlPathAnnotations(bareShape);
		assert.strictEqual('__path' in bareShape.widget, false);
	});

	it('both sitemap crawl sites strip the annotation before handing the page on', () => {
		assert.match(server, /function stripCrawlPathAnnotations\(page\) \{/);
		const callSites = server.match(/^\t+stripCrawlPathAnnotations\(page\);$/gm) || [];
		assert.strictEqual(callSites.length, 2, 'getFullSitemapData and /sitemap-full must both strip');
	});

	it('client drops a leftover __path when rendering a single page', () => {
		const flattenWidgets = buildFlattenWidgets();
		const widgets = weatherPage().widgets.map((w) => ({ ...w, __path: ['Weather', 'Few clouds'] }));
		const out = [];

		// applyPageData normalizes with no path context.
		flattenWidgets(widgets, out, { sitemapName: 'default', pageUrl: '/rest/sitemaps/default/0201?type=json' });

		assert.strictEqual(out.length, 3);
		for (const w of out) assert.strictEqual('__path' in w, false);
	});

	it('client keeps __path when a search crawl supplies one', () => {
		const flattenWidgets = buildFlattenWidgets();
		const out = [];

		flattenWidgets(weatherPage().widgets, out, { path: ['Weather', 'Few clouds'], sitemapName: 'default' });

		assert.deepStrictEqual(out[0].__path, ['Weather', 'Few clouds']);
	});

	it('cached and freshly fetched copies of a page produce identical widget keys', () => {
		const flattenWidgets = buildFlattenWidgets();
		const ctx = { sitemapName: 'default', pageUrl: '/rest/sitemaps/default/0201?type=json' };

		// Cached copy: crawled by the server, so it arrives carrying a breadcrumb.
		const cached = [];
		flattenWidgets(
			weatherPage().widgets.map((w) => ({ ...w, __path: ['Weather', 'Few clouds'] })),
			cached,
			ctx
		);

		// Fresh copy: straight from openHAB via the delta endpoint, no breadcrumb.
		const fresh = [];
		flattenWidgets(weatherPage().widgets, fresh, ctx);

		assert.deepStrictEqual(cached.map(widgetKey), fresh.map(widgetKey));
		// A mismatch here fails the patch check in render(), which rebuilds the whole
		// grid and reloads every iframe on the page.
		assert.strictEqual(widgetKey(cached[0]), 'widget:default|label:|type:Webview|path:|frame:');
	});
});
