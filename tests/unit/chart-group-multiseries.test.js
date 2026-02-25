'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const CHART_FILE = path.join(PROJECT_ROOT, 'public', 'chart.js');

describe('Chart Group Multi-Series Wiring', () => {
	it('server parses forceasitem and wires group-series chart flow', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /function parseChartForceAsItem\(rawForceAsItem\) \{/);
		assert.match(server, /const rawForceAsItem = req\.query\?\.forceasitem \?\? req\.query\?\.forceAsItem;/);
		assert.match(server, /const forceAsItem = forceAsItemParsed === true;/);
		assert.match(server, /function fetchChartSeriesData\(item, periodWindow = 86400, service = '', forceAsItem = false\) \{/);
		assert.match(server, /const isGroupItem = !forceAsItem && isGroupItemType\(itemDefinition\?\.type\);/);
		assert.match(server, /const showLegend = !isMultiSeries && shouldShowChartLegend\(legend, seriesCount \|\| 1\);/);
		assert.match(server, /window\._chartSeries=\$\{inlineJson\(chartSeries\)\};/);
		assert.match(server, /window\._chartIsMultiSeries=\$\{inlineJson\(isMultiSeries\)\};/);
		assert.match(server, /getChartCachePath\([\s\S]*forceAsItem/);
	});

	it('client chart URL/hash cache includes forceasitem', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function normalizeChartForceAsItem\(value\) \{/);
		assert.match(app, /const forceAsItem = normalizeChartForceAsItem\(widget\?\.forceasitem \?\? widget\?\.forceAsItem\);/);
		assert.match(app, /if \(forceAsItem\) url \+= `&forceasitem=\$\{forceAsItem\}`;/);
		assert.match(app, /const forceAsItem = normalizeChartForceAsItem\(urlObj\.searchParams\.get\('forceasitem'\) \|\| urlObj\.searchParams\.get\('forceAsItem'\)\);/);
		assert.match(app, /const cacheKey = `\$\{item\}\|\$\{period\}\|\$\{mode\}\|\$\{assetVersion\}\|\$\{title\}\|\$\{legend\}\|\$\{forceAsItem\}\|\$\{yAxisDecimalPattern\}\|\$\{interpolation\}\|\$\{service\}`;/);
		assert.match(app, /\(forceAsItem \? `&forceasitem=\$\{forceAsItem\}` : ''\)/);
	});

	it('chart renderer supports multi-series palettes and line-only mode', () => {
		const chart = fs.readFileSync(CHART_FILE, 'utf8');
		assert.match(chart, /var CHART_SERIES = Array\.isArray\(window\._chartSeries\) \? window\._chartSeries : \[\];/);
		assert.match(chart, /var CHART_IS_MULTI_SERIES = window\._chartIsMultiSeries === true \|\| CHART_SERIES\.length > 1;/);
		assert.match(chart, /var SERIES_PALETTE_LIGHT = \[[^\]]+\];/);
		assert.match(chart, /var SERIES_PALETTE_DARK = \[[^\]]+\];/);
		assert.match(chart, /if \(!this\.isMultiSeries\) \{\s*var grad = \$\('linearGradient'/);
		assert.match(chart, /var lineClass = this\.isMultiSeries \? 'chart-line chart-line-series' : 'chart-line';/);
		assert.match(chart, /mainPath\.style\.stroke = series\.color;/);
		assert.match(chart, /if \(!sm && !this\.isMultiSeries && this\.points\.length > 0\) \{/);
		assert.match(chart, /return pt\.seriesLabel \+ ': ' \+ valueText;/);
	});
});
