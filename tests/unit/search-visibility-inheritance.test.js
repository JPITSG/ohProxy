'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
	filterVisibleSearchEntries,
	widgetKey,
} = require('../../lib/widget-normalizer');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

function entryName(entry) {
	return entry?.label || entry?.item?.name || '';
}

describe('Search visibility inheritance', () => {
	it('removes entries below a hidden section while keeping visible siblings', () => {
		const hiddenSection = {
			__section: true,
			__sitemapName: 'default',
			__sectionPath: ['Device Information'],
			label: 'Device Information',
		};
		const entries = [
			{
				__section: true,
				__sitemapName: 'default',
				__sectionPath: ['Status'],
				label: 'Status',
			},
			{
				__sitemapName: 'default',
				__sectionPath: ['Status'],
				__frame: 'Status',
				item: { name: 'Visible_Status' },
			},
			hiddenSection,
			{
				__sitemapName: 'default',
				__sectionPath: ['Device Information'],
				__frame: 'Device Information',
				item: { name: 'Hidden_Serial' },
			},
			{
				__section: true,
				__sitemapName: 'default',
				__sectionPath: ['Device Information', 'Network'],
				label: 'Network',
			},
			{
				__sitemapName: 'default',
				__sectionPath: ['Device Information', 'Network'],
				__frame: 'Network',
				item: { name: 'Hidden_IP' },
			},
			{
				__section: true,
				__sitemapName: 'default',
				__sectionPath: ['Controls'],
				label: 'Controls',
			},
			{
				__sitemapName: 'default',
				__sectionPath: ['Controls'],
				__frame: 'Controls',
				item: { name: 'Visible_Control' },
			},
		];
		const hiddenKey = widgetKey(hiddenSection);

		const visible = filterVisibleSearchEntries(entries, (entry) => widgetKey(entry) !== hiddenKey);

		assert.deepStrictEqual(
			visible.map(entryName),
			['Status', 'Visible_Status', 'Controls', 'Visible_Control']
		);
	});

	it('removes hidden linked-page widgets so callers cannot enqueue their subpages', () => {
		const hiddenLink = {
			__sitemapName: 'default',
			label: 'Device Information',
			type: 'Text',
			link: '/rest/sitemaps/default/deviceinfo',
		};
		const visibleLink = {
			__sitemapName: 'default',
			label: 'Lighting',
			type: 'Text',
			link: '/rest/sitemaps/default/lighting',
		};

		const visible = filterVisibleSearchEntries([hiddenLink, visibleLink], (entry) => entry !== hiddenLink);

		assert.deepStrictEqual(visible, [visibleLink]);
	});

	it('keeps all entries when the visibility predicate allows them', () => {
		const entries = [
			{
				__section: true,
				__sitemapName: 'default',
				__sectionPath: ['Device Information'],
				label: 'Device Information',
			},
			{
				__sitemapName: 'default',
				__sectionPath: ['Device Information'],
				__frame: 'Device Information',
				item: { name: 'Device_Uptime' },
			},
		];

		assert.deepStrictEqual(filterVisibleSearchEntries(entries, () => true), entries);
	});

	it('filters server search and sitemap traversal before following linked pages', () => {
		const source = fs.readFileSync(SERVER_FILE, 'utf8');

		assert.match(source, /filterVisibleSearchEntries/);
		assert.match(source, /async function getFullSitemapData\(sitemapName, userRole = '', username = ''\) \{[\s\S]*const visibleEntries = visibleSearchEntriesForRole\([\s\S]*queueLinkedSearchPages\(visibleEntries, queue, seenPages, pagePath\);/);
		assert.match(source, /app\.get\('\/search-index', async \(req, res\) => \{[\s\S]*const visibilityMap = buildVisibilityMap\(\);[\s\S]*const visibleEntries = visibleSearchEntriesForRole\([\s\S]*queueLinkedSearchPages\(visibleEntries, queue, seenPages, pagePath\);[\s\S]*for \(const w of visibleEntries\)/);
		assert.match(source, /app\.get\('\/sitemap-full', async \(req, res\) => \{[\s\S]*const queue = \[\{ url: rootPath, path: \[\] \}\];[\s\S]*const visibleEntries = visibleSearchEntriesForRole\([\s\S]*queueLinkedSearchPages\(visibleEntries, queue, seenPages, pagePath\);/);
	});

	it('filters browser fallback search traversal before following linked pages', () => {
		const source = fs.readFileSync(APP_FILE, 'utf8');

		assert.match(source, /filterVisibleSearchEntries/);
		assert.match(source, /const visibleEntries = filterVisibleSearchEntries\(normalized, isWidgetVisible\);\s*for \(const f of visibleEntries\)[\s\S]*const widgets = visibleEntries\.filter\(w => !w\.__section\);/);
	});
});
