'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

function normalizeChartUnitSymbol(rawUnitSymbol) {
	const text = (rawUnitSymbol === null || rawUnitSymbol === undefined ? '' : String(rawUnitSymbol))
		.replace(/\s+/g, ' ')
		.trim();
	return text || '';
}

function extractUnitFromPattern(pattern) {
	if (!pattern || typeof pattern !== 'string') return '';
	const spaceIdx = pattern.indexOf(' ');
	if (spaceIdx === -1) return '';
	return normalizeChartUnitSymbol(pattern.slice(spaceIdx + 1).replace(/%%/g, '%'));
}

function resolveDisplayedSeriesUnitSymbol(seriesList) {
	const list = Array.isArray(seriesList) ? seriesList : [];
	const uniqueUnits = new Set();
	for (const series of list) {
		const unit = normalizeChartUnitSymbol(series?.unitSymbol);
		if (!unit) continue;
		uniqueUnits.add(unit);
		if (uniqueUnits.size > 1) return '';
	}
	if (uniqueUnits.size === 1) return Array.from(uniqueUnits)[0];
	return '';
}

describe('Chart Unit Resolution Hardening', () => {
	it('server cache key and data hash include unit signature', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /function chartCacheKey\(item, period, mode, title, legend, yAxisDecimalPattern, interpolation, service, forceAsItem = false, unitSignature = ''\) \{/);
		assert.match(server, /\|\$\{normalizeChartUnitSymbol\(unitSignature\)\}`\)/);
		assert.match(server, /const cacheUnitSignature = deriveChartUnitSignatureFromItemDefinition\(preloadedItemDefinition, item, forceAsItem\);/);
		assert.match(server, /const \{ series: rawSeriesList, unitSymbol, cacheUnitSignature \} = await fetchChartSeriesData\(item, periodWindow, service, forceAsItem\);/);
		assert.match(server, /function computeChartSeriesDataHash\(rawSeriesList, periodWindow, unitSymbol = ''\) \{/);
		assert.match(server, /const unitSig = normalizeChartUnitSymbol\(unitSymbol\);/);
		assert.match(server, /update\(`\$\{baseHash\}\|u:\$\{unitSig\}`\)/);
	});

	it('server fetches metadata regardless of forceAsItem and resolves unit via item metadata', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /if \(!itemDefinition\) \{\s*try \{\s*itemDefinition = await fetchOpenhabItemDefinition\(item\);/);
		assert.doesNotMatch(server, /if \(!forceAsItem\) \{\s*try \{\s*itemDefinition = await fetchOpenhabItemDefinition\(item\);/);
		assert.match(server, /const unitSymbol = resolveItemDefinitionUnitSymbol\(itemDefinition\);/);
	});

	it('server keeps unit on group fallback and derives multi-series unit from rendered members', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const unitSymbol = resolveDisplayedSeriesUnitSymbol\(memberSeries\);/);
		assert.match(server, /if \(memberSeries\.length\) \{\s*const unitSymbol = resolveDisplayedSeriesUnitSymbol\(memberSeries\);\s*return \{ series: memberSeries, unitSymbol, cacheUnitSignature \};\s*\}/);
		assert.match(server, /const unitSymbol = resolveItemDefinitionUnitSymbol\(itemDefinition\);\s*return \{ series: \[\{ item, label: primaryLabel \|\| fallbackLabel, data: primaryData \}\], unitSymbol, cacheUnitSignature \};/);
	});

	it('server keeps current space-split pattern fallback and normalizes output', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const spaceIdx = pattern\.indexOf\(' '\);/);
		assert.match(server, /return normalizeChartUnitSymbol\(pattern\.slice\(spaceIdx \+ 1\)\.replace\(\/%%\/g, '%'\)\);/);
	});
});

describe('Chart Unit Policy (Replicated)', () => {
	it('normalizes and trims unit symbols', () => {
		assert.strictEqual(normalizeChartUnitSymbol('  °C  '), '°C');
		assert.strictEqual(normalizeChartUnitSymbol('  kWh   /  d  '), 'kWh / d');
		assert.strictEqual(normalizeChartUnitSymbol('   '), '');
	});

	it('pattern fallback uses first-space split and converts %% to %', () => {
		assert.strictEqual(extractUnitFromPattern('%.1f %%'), '%');
		assert.strictEqual(extractUnitFromPattern('%.1f °C'), '°C');
		assert.strictEqual(extractUnitFromPattern('%.1f°C'), '');
	});

	it('multi-series mixed units resolve to blank', () => {
		assert.strictEqual(resolveDisplayedSeriesUnitSymbol([
			{ unitSymbol: '°C' },
			{ unitSymbol: '°C' },
		]), '°C');
		assert.strictEqual(resolveDisplayedSeriesUnitSymbol([
			{ unitSymbol: '°C' },
			{ unitSymbol: '°F' },
		]), '');
		assert.strictEqual(resolveDisplayedSeriesUnitSymbol([
			{ unitSymbol: '' },
			{ unitSymbol: ' ' },
		]), '');
	});
});
