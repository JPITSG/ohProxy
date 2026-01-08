'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// Widget snapshot helpers replicated from server.js

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function widgetType(widget) {
	return safeText(widget?.type || widget?.widgetType || widget?.item?.type || '');
}

function widgetLink(widget) {
	return safeText(widget?.linkedPage?.link || widget?.link || '');
}

function widgetPageLink(widget) {
	const link = widget?.linkedPage?.link || widget?.link;
	if (typeof link !== 'string') return null;
	if (!link.includes('/rest/sitemaps/')) return null;
	return link;
}

function splitLabelState(label) {
	const raw = safeText(label);
	const match = raw.match(/^(.*)\s*\[(.+)\]\s*$/);
	if (!match) return { title: raw, state: '' };
	return { title: match[1].trim(), state: match[2].trim() };
}

function deltaKey(widget) {
	const id = safeText(widget?.widgetId || widget?.id || '');
	if (id) return `id:${id}`;
	const itemName = safeText(widget?.item?.name || widget?.itemName || '');
	const type = widgetType(widget);
	const link = widgetLink(widget);
	if (itemName) return `item:${itemName}|${type}|${link}`;
	const label = safeText(widget?.label || widget?.item?.label || widget?.item?.name || '');
	return `label:${label}|${type}|${link}`;
}

function serverWidgetKey(widget) {
	if (widget?.__section) return `section:${safeText(widget.label)}`;
	const item = safeText(widget?.item?.name || '');
	const fullLabel = safeText(widget?.label || '');
	const { title } = splitLabelState(fullLabel);
	const label = title || fullLabel;
	const type = widgetType(widget);
	const link = safeText(widgetPageLink(widget) || '');
	return `widget:${item}|${label}|${type}|${link}`;
}

function widgetSnapshot(widget) {
	return {
		key: deltaKey(widget),
		id: safeText(widget?.widgetId || widget?.id || ''),
		itemName: safeText(widget?.item?.name || widget?.itemName || ''),
		label: safeText(widget?.label || widget?.item?.label || widget?.item?.name || ''),
		state: safeText(widget?.item?.state ?? widget?.state ?? ''),
		valuecolor: safeText(
			widget?.valuecolor ||
			widget?.valueColor ||
			widget?.item?.valuecolor ||
			widget?.item?.valueColor ||
			''
		),
		icon: safeText(widget?.icon || widget?.item?.icon || widget?.item?.category || ''),
	};
}

function normalizeWidgets(page) {
	let w = page?.widget;
	if (!w) return [];
	if (!Array.isArray(w)) {
		if (w && Array.isArray(w.item)) w = w.item;
		else w = [w];
	}

	const out = [];
	const walk = (list) => {
		for (const item of list) {
			if (item?.type === 'Frame') {
				const label = safeText(item?.label || item?.item?.label || item?.item?.name || '');
				out.push({ __frame: true, label });
				let kids = item.widget;
				if (kids) {
					if (!Array.isArray(kids)) {
						if (Array.isArray(kids.item)) kids = kids.item;
						else kids = [kids];
					}
					walk(kids);
				}
				continue;
			}
			out.push(item);
		}
	};

	walk(w);
	return out;
}

function hashString(value) {
	return crypto.createHash('sha1').update(value).digest('hex');
}

function buildSnapshot(page) {
	const list = normalizeWidgets(page);
	const entryMap = new Map();
	const entryOrder = [];
	const structureParts = [];

	for (const w of list) {
		if (w && w.__frame) {
			structureParts.push(`frame:${safeText(w.label)}`);
			continue;
		}
		if (!w) continue;
		const snap = widgetSnapshot(w);
		if (!snap.key) continue;
		structureParts.push(snap.key);
		entryOrder.push(snap);
		entryMap.set(snap.key, snap);
	}

	const structureHash = hashString(structureParts.join('|'));
	const hash = hashString(JSON.stringify({
		title: safeText(page?.title || ''),
		entries: entryOrder.map((e) => ({
			key: e.key,
			label: e.label,
			state: e.state,
			valuecolor: e.valuecolor,
			icon: e.icon,
		})),
	}));

	return {
		hash,
		structureHash,
		entryMap,
		title: safeText(page?.title || ''),
	};
}

describe('Widget Snapshot Helpers', () => {
	describe('deltaKey', () => {
		it('uses widgetId when present', () => {
			assert.strictEqual(deltaKey({ widgetId: 'w1' }), 'id:w1');
		});

		it('uses id when widgetId missing', () => {
			assert.strictEqual(deltaKey({ id: 'x1' }), 'id:x1');
		});

		it('uses item name when available', () => {
			assert.strictEqual(deltaKey({ item: { name: 'Item1' } }), 'item:Item1||');
		});

		it('uses itemName field when available', () => {
			assert.strictEqual(deltaKey({ itemName: 'Item2' }), 'item:Item2||');
		});

		it('uses label when no item name', () => {
			assert.strictEqual(deltaKey({ label: 'My Label' }), 'label:My Label||');
		});

		it('uses item label when widget label missing', () => {
			assert.strictEqual(deltaKey({ item: { label: 'Label A' } }), 'label:Label A||');
		});

		it('includes widget type in key', () => {
			assert.strictEqual(deltaKey({ item: { name: 'Item1' }, type: 'Switch' }), 'item:Item1|Switch|');
		});

		it('uses widgetType field when type missing', () => {
			assert.strictEqual(deltaKey({ item: { name: 'Item1' }, widgetType: 'Dimmer' }), 'item:Item1|Dimmer|');
		});

		it('uses item.type when type missing', () => {
			assert.strictEqual(deltaKey({ item: { name: 'Item1', type: 'Number' } }), 'item:Item1|Number|');
		});

		it('includes link in key', () => {
			assert.strictEqual(deltaKey({ item: { name: 'Item1' }, link: '/rest/sitemaps/x' }), 'item:Item1||/rest/sitemaps/x');
		});

		it('keeps bracketed label text intact', () => {
			assert.strictEqual(deltaKey({ label: 'Temp [23]' }), 'label:Temp [23]||');
		});
	});

	describe('serverWidgetKey', () => {
		it('uses section key for section markers', () => {
			assert.strictEqual(serverWidgetKey({ __section: true, label: 'Section A' }), 'section:Section A');
		});

		it('includes item name', () => {
			assert.strictEqual(serverWidgetKey({ item: { name: 'Item1' }, label: 'Label' }), 'widget:Item1|Label||');
		});

		it('uses label title without state', () => {
			assert.strictEqual(serverWidgetKey({ item: { name: 'Item1' }, label: 'Temp [23]' }), 'widget:Item1|Temp||');
		});

		it('uses full label when no state', () => {
			assert.strictEqual(serverWidgetKey({ item: { name: 'Item1' }, label: 'Plain' }), 'widget:Item1|Plain||');
		});

		it('includes widget type', () => {
			assert.strictEqual(serverWidgetKey({ item: { name: 'Item1', type: 'Switch' }, label: 'X' }), 'widget:Item1|X|Switch|');
		});

		it('includes link for sitemap links', () => {
			const widget = { item: { name: 'Item1' }, label: 'X', link: '/rest/sitemaps/home' };
			assert.strictEqual(serverWidgetKey(widget), 'widget:Item1|X||/rest/sitemaps/home');
		});

		it('excludes link when not a sitemap link', () => {
			const widget = { item: { name: 'Item1' }, label: 'X', link: '/rest/items' };
			assert.strictEqual(serverWidgetKey(widget), 'widget:Item1|X||');
		});

		it('ignores item label when widget label missing', () => {
			assert.strictEqual(serverWidgetKey({ item: { name: 'Item1', label: 'Item Label' } }), 'widget:Item1|||');
		});

		it('trims label state spacing', () => {
			assert.strictEqual(serverWidgetKey({ item: { name: 'Item1' }, label: ' Temp  [ 23 ] ' }), 'widget:Item1|Temp||');
		});

		it('uses linkedPage link when present', () => {
			const widget = { item: { name: 'Item1' }, label: 'X', linkedPage: { link: '/rest/sitemaps/room' } };
			assert.strictEqual(serverWidgetKey(widget), 'widget:Item1|X||/rest/sitemaps/room');
		});

		it('ignores linkedPage when not a sitemap link', () => {
			const widget = { item: { name: 'Item1' }, label: 'X', linkedPage: { link: '/other' } };
			assert.strictEqual(serverWidgetKey(widget), 'widget:Item1|X||');
		});
	});

	describe('widgetSnapshot', () => {
		it('sets key from deltaKey', () => {
			const snap = widgetSnapshot({ item: { name: 'Item1' } });
			assert.strictEqual(snap.key, 'item:Item1||');
		});

		it('uses widgetId for id', () => {
			const snap = widgetSnapshot({ widgetId: 'w1' });
			assert.strictEqual(snap.id, 'w1');
		});

		it('uses id when widgetId missing', () => {
			const snap = widgetSnapshot({ id: 'x1' });
			assert.strictEqual(snap.id, 'x1');
		});

		it('uses item.name for itemName', () => {
			const snap = widgetSnapshot({ item: { name: 'Item1' } });
			assert.strictEqual(snap.itemName, 'Item1');
		});

		it('uses itemName field when item missing', () => {
			const snap = widgetSnapshot({ itemName: 'Item2' });
			assert.strictEqual(snap.itemName, 'Item2');
		});

		it('uses widget label when present', () => {
			const snap = widgetSnapshot({ label: 'Label' });
			assert.strictEqual(snap.label, 'Label');
		});

		it('falls back to item label', () => {
			const snap = widgetSnapshot({ item: { label: 'Item Label' } });
			assert.strictEqual(snap.label, 'Item Label');
		});

		it('uses item state before widget state', () => {
			const snap = widgetSnapshot({ item: { state: 'ON' }, state: 'OFF' });
			assert.strictEqual(snap.state, 'ON');
		});

		it('uses widget state when item missing', () => {
			const snap = widgetSnapshot({ state: 'OFF' });
			assert.strictEqual(snap.state, 'OFF');
		});

		it('uses valuecolor fallbacks', () => {
			const snap = widgetSnapshot({ item: { valueColor: 'red' } });
			assert.strictEqual(snap.valuecolor, 'red');
		});

		it('uses icon fallbacks', () => {
			const snap = widgetSnapshot({ item: { category: 'light' } });
			assert.strictEqual(snap.icon, 'light');
		});

		it('returns empty strings for missing values', () => {
			const snap = widgetSnapshot({});
			assert.strictEqual(snap.label, '');
			assert.strictEqual(snap.state, '');
			assert.strictEqual(snap.valuecolor, '');
			assert.strictEqual(snap.icon, '');
		});
	});

	describe('normalizeWidgets', () => {
		it('returns empty array when no widgets', () => {
			assert.deepStrictEqual(normalizeWidgets({}), []);
		});

		it('wraps single widget into array', () => {
			const widgets = normalizeWidgets({ widget: { type: 'Text', label: 'A' } });
			assert.strictEqual(widgets.length, 1);
			assert.strictEqual(widgets[0].label, 'A');
		});

		it('uses widget.item array when present', () => {
			const widgets = normalizeWidgets({ widget: { item: [{ label: 'A' }, { label: 'B' }] } });
			assert.strictEqual(widgets.length, 2);
			assert.strictEqual(widgets[1].label, 'B');
		});

		it('adds frame marker for Frame type', () => {
			const widgets = normalizeWidgets({ widget: { type: 'Frame', label: 'Section', widget: [] } });
			assert.strictEqual(widgets[0].__frame, true);
			assert.strictEqual(widgets[0].label, 'Section');
		});

		it('frame label uses item label fallback', () => {
			const widgets = normalizeWidgets({ widget: { type: 'Frame', item: { label: 'Item Label' }, widget: [] } });
			assert.strictEqual(widgets[0].label, 'Item Label');
		});

		it('flattens frame children', () => {
			const widgets = normalizeWidgets({
				widget: { type: 'Frame', label: 'Section', widget: [{ label: 'Child' }] },
			});
			assert.strictEqual(widgets.length, 2);
			assert.strictEqual(widgets[1].label, 'Child');
		});

		it('preserves order with mixed entries', () => {
			const widgets = normalizeWidgets({ widget: [{ label: 'A' }, { type: 'Frame', label: 'F', widget: [{ label: 'B' }] }, { label: 'C' }] });
			assert.strictEqual(widgets[0].label, 'A');
			assert.strictEqual(widgets[1].__frame, true);
			assert.strictEqual(widgets[2].label, 'B');
			assert.strictEqual(widgets[3].label, 'C');
		});

		it('handles frame with no children', () => {
			const widgets = normalizeWidgets({ widget: { type: 'Frame', label: 'Section' } });
			assert.strictEqual(widgets.length, 1);
			assert.strictEqual(widgets[0].__frame, true);
		});
	});

	describe('buildSnapshot', () => {
		it('produces stable hashes for same input', () => {
			const page = { title: 'Home', widget: [{ item: { name: 'Item1', state: 'ON' }, label: 'Label1' }] };
			const first = buildSnapshot(page);
			const second = buildSnapshot(page);
			assert.strictEqual(first.hash, second.hash);
			assert.strictEqual(first.structureHash, second.structureHash);
		});

		it('changes hash when state changes', () => {
			const page1 = { title: 'Home', widget: [{ item: { name: 'Item1', state: 'ON' }, label: 'Label1' }] };
			const page2 = { title: 'Home', widget: [{ item: { name: 'Item1', state: 'OFF' }, label: 'Label1' }] };
			const snap1 = buildSnapshot(page1);
			const snap2 = buildSnapshot(page2);
			assert.notStrictEqual(snap1.hash, snap2.hash);
			assert.strictEqual(snap1.structureHash, snap2.structureHash);
		});

		it('changes hash when label changes', () => {
			const page1 = { title: 'Home', widget: [{ item: { name: 'Item1', state: 'ON' }, label: 'Label1' }] };
			const page2 = { title: 'Home', widget: [{ item: { name: 'Item1', state: 'ON' }, label: 'Label2' }] };
			const snap1 = buildSnapshot(page1);
			const snap2 = buildSnapshot(page2);
			assert.notStrictEqual(snap1.hash, snap2.hash);
			assert.strictEqual(snap1.structureHash, snap2.structureHash);
		});

		it('changes structure hash when widget count changes', () => {
			const page1 = { title: 'Home', widget: [{ item: { name: 'Item1' } }] };
			const page2 = { title: 'Home', widget: [{ item: { name: 'Item1' } }, { item: { name: 'Item2' } }] };
			const snap1 = buildSnapshot(page1);
			const snap2 = buildSnapshot(page2);
			assert.notStrictEqual(snap1.structureHash, snap2.structureHash);
		});

		it('changes structure hash when frame labels change', () => {
			const page1 = { title: 'Home', widget: [{ type: 'Frame', label: 'A', widget: [{ item: { name: 'Item1' } }] }] };
			const page2 = { title: 'Home', widget: [{ type: 'Frame', label: 'B', widget: [{ item: { name: 'Item1' } }] }] };
			const snap1 = buildSnapshot(page1);
			const snap2 = buildSnapshot(page2);
			assert.notStrictEqual(snap1.structureHash, snap2.structureHash);
		});

		it('entryMap size matches non-frame widgets', () => {
			const page = { title: 'Home', widget: [{ type: 'Frame', label: 'A', widget: [{ item: { name: 'Item1' } }] }] };
			const snap = buildSnapshot(page);
			assert.strictEqual(snap.entryMap.size, 1);
		});

		it('deduplicates entries with identical keys', () => {
			const page = { title: 'Home', widget: [{}, { label: '' }] };
			const snap = buildSnapshot(page);
			assert.strictEqual(snap.entryMap.size, 1);
		});

		it('changes hash when title changes', () => {
			const page1 = { title: 'Home', widget: [{ item: { name: 'Item1', state: 'ON' } }] };
			const page2 = { title: 'Other', widget: [{ item: { name: 'Item1', state: 'ON' } }] };
			const snap1 = buildSnapshot(page1);
			const snap2 = buildSnapshot(page2);
			assert.notStrictEqual(snap1.hash, snap2.hash);
		});
	});
});
