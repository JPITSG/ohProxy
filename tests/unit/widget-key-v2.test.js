'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { widgetKey } = require('../../lib/widget-normalizer');

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

	it('falls back to default sitemap when sitemap metadata is absent', () => {
		const key = widgetKey({ item: { name: 'AnyItem' } });
		assert.strictEqual(key, 'widget:default|item:AnyItem');
	});
});
