'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
	buildHistoryStateFormatter,
	extractNumericStateSuffix,
	formatDateStateLikeDisplay,
	formatStateWithPattern,
} = require('../../lib/widget-normalizer');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('Card Config History State Formatting', () => {
	it('formats numeric history values with the unit suffix from the displayed card state', () => {
		const formatter = buildHistoryStateFormatter(
			{ label: 'Temperature [25.3 \u00B0C]' },
			[],
			String
		);

		assert.strictEqual(formatter('25.2'), '25.2 \u00B0C');
		assert.strictEqual(formatter('25'), '25 \u00B0C');
	});

	it('formats numeric history values from openHAB stateDescription patterns when available', () => {
		const formatter = buildHistoryStateFormatter(
			{ item: { stateDescription: { pattern: '%.1f \u00B0C' } } },
			[],
			String
		);

		assert.strictEqual(formatter('25.24'), '25.2 \u00B0C');
		assert.strictEqual(formatter('25'), '25.0 \u00B0C');
		assert.strictEqual(formatStateWithPattern('42', '%d %%'), '42 %');
	});

	it('keeps the displayed card unit when the item pattern only controls precision', () => {
		const formatter = buildHistoryStateFormatter(
			{
				label: 'Current Watts [123.4 W]',
				item: { stateDescription: { pattern: '%.1f' } },
			},
			[],
			String
		);

		assert.strictEqual(formatter('123.44'), '123.4 W');
		assert.strictEqual(formatter('5'), '5.0 W');
	});

	it('formats DateTime history values from openHAB time patterns', () => {
		const raw = 'Thu May 07 2026 20:11:29 GMT+0200 (Central European Summer Time)';
		const formatter = buildHistoryStateFormatter(
			{ item: { stateDescription: { pattern: '%1$tH:%1$tM' } } },
			[],
			String
		);

		assert.strictEqual(formatter(raw), '20:11');
		assert.strictEqual(formatStateWithPattern(raw, '%1$tH:%1$tM:%1$tS'), '20:11:29');
	});

	it('formats DateTime history values like the displayed card time', () => {
		const raw = 'Thu May 07 2026 20:11:29 GMT+0200 (Central European Summer Time)';
		const formatter = buildHistoryStateFormatter(
			{ label: 'Sunset [20:11]' },
			[],
			String
		);

		assert.strictEqual(formatter(raw), '20:11');
		assert.strictEqual(formatDateStateLikeDisplay(raw, '20:11:29'), '20:11:29');
	});

	it('keeps explicit sitemap mappings ahead of numeric unit formatting', () => {
		const formatter = buildHistoryStateFormatter(
			{ label: 'Temperature [25.3 \u00B0C]' },
			[{ command: '0', label: 'Off' }],
			String
		);

		assert.strictEqual(formatter('0'), 'Off');
		assert.strictEqual(formatter('21.5'), '21.5 \u00B0C');
	});

	it('falls back to the caller formatter when no display format applies', () => {
		const formatter = buildHistoryStateFormatter(
			{ label: 'Door [Closed]' },
			[],
			(raw) => raw.toLowerCase()
		);

		assert.strictEqual(formatter('OPEN'), 'open');
		assert.strictEqual(extractNumericStateSuffix('25.3 \u00B0C'), ' \u00B0C');
	});

	it('wires item history rows through the shared formatter in the client', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');

		assert.match(app, /buildHistoryStateFormatter,/);
		assert.match(app, /let historyStateFormatter = null;/);
		assert.match(app, /historyStateFormatter = buildHistoryStateFormatter\(widget, historyMappings, formatRawState\);/);
		assert.match(app, /return historyStateFormatter \? historyStateFormatter\(raw\) : formatRawState\(raw\);/);
	});
});
