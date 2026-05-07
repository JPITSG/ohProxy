'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
	buildHistoryStateFormatter,
	extractNumericStateSuffix,
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
