'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { widgetKey, cardWidthKey } = require('../../lib/widget-normalizer');

describe('Widget Key Strategy', () => {
	it('keys item-backed widgets by sitemap + item name', () => {
		const a = widgetKey({
			__sitemapName: 'default',
			item: { name: 'KitchenLight' },
			label: 'Kitchen Light [OFF]',
			type: 'Switch',
			link: '/rest/sitemaps/default/anything',
		});
		const b = widgetKey({
			__sitemapName: 'default',
			item: { name: 'KitchenLight' },
			label: 'Kitchen',
			type: 'Switch',
			link: '/rest/sitemaps/default/something-else',
		});

		assert.strictEqual(a, 'widget:default|item:KitchenLight');
		assert.strictEqual(b, 'widget:default|item:KitchenLight');
	});

	it('keys sections by sitemap + section path + label', () => {
		const key = widgetKey({
			__section: true,
			__sitemapName: 'default',
			label: 'Lights',
			__sectionPath: ['Ground Floor', 'Living Room', 'Lights'],
		});
		assert.strictEqual(
			key,
			'section:default|path:Ground Floor>Living Room>Lights|label:Lights'
		);
	});

	it('keys non-item widgets with fallback label/type/path/frame identity', () => {
		const key = widgetKey({
			__sitemapName: 'default',
			label: 'Front Door Camera',
			type: 'Webview',
			__path: ['Security', 'Cameras'],
			__frame: 'Outside',
		});
		assert.strictEqual(
			key,
			'widget:default|label:Front Door Camera|type:Webview|path:Security>Cameras|frame:Outside'
		);
	});

	it('uses a missing-sitemap sentinel when sitemap metadata is absent', () => {
		const key = widgetKey({ item: { name: 'AnyItem' } });
		assert.strictEqual(key, 'widget:__missing_sitemap__|item:AnyItem');
	});

	it('keys card width by sitemap, page, and widget occurrence', () => {
		const a = cardWidthKey({
			__sitemapName: 'default',
			__pageUrl: '/rest/sitemaps/default/0201?type=json',
			widgetId: '020102',
			item: { name: 'KitchenLight' },
		});
		const b = cardWidthKey({
			__sitemapName: 'default',
			__pageUrl: '/rest/sitemaps/default/0301?type=json',
			widgetId: '030104',
			item: { name: 'KitchenLight' },
		});

		assert.strictEqual(a, 'cardwidth:default|page:rest/sitemaps/default/0201?type=json|widget:020102');
		assert.strictEqual(b, 'cardwidth:default|page:rest/sitemaps/default/0301?type=json|widget:030104');
		assert.notStrictEqual(a, b);
	});

	it('normalizes card width page URLs before keying', () => {
		const key = cardWidthKey({
			__sitemapName: 'default',
			__pageUrl: 'https://example.test/rest/sitemaps/default/0201',
			widgetId: '020102',
		});

		assert.strictEqual(key, 'cardwidth:default|page:rest/sitemaps/default/0201?type=json|widget:020102');
	});
});
