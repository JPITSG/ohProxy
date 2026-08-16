'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

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

const errors = [];
const normalizeChartRuntimeUrl = Function(
	'window', 'normalizeChartPeriodOffset', 'logJsError',
	`return (${extractFunction(app, 'normalizeChartRuntimeUrl')});`
)(
	{ location: { origin: 'http://oh.test' } },
	(value) => {
		const parsed = Number.parseInt(String(value || ''), 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
	},
	(msg) => errors.push(msg)
);
const chartLatestPeriodUrl = Function(
	'window', 'normalizeChartRuntimeUrl', 'logJsError',
	`return (${extractFunction(app, 'chartLatestPeriodUrl')});`
)(
	{ location: { origin: 'http://oh.test' } },
	normalizeChartRuntimeUrl,
	(msg) => errors.push(msg)
);
const chartUrlsEquivalent = Function(
	'window', 'logJsError',
	`return (${extractFunction(app, 'chartUrlsEquivalent')});`
)({ location: { origin: 'http://oh.test' } }, (msg) => errors.push(msg));

describe('chartUrlsEquivalent', () => {
	it('card render compares the configured base URL independently of the runtime navigation URL', () => {
		assert.match(app, /const previousBaseUrl = iframeEl\.dataset\.chartBaseUrl \|\| chartLatestPeriodUrl\(iframeEl\.dataset\.chartUrl\);/);
		assert.match(app, /const urlChanged = !chartUrlsEquivalent\(previousBaseUrl, fullUrl\);/);
		assert.match(app, /iframeEl\.dataset\.chartBaseUrl = fullUrl;/);
	});

	it('treats + and %20 title encodings as the same URL', () => {
		assert.strictEqual(chartUrlsEquivalent(
			'/chart?item=Power&period=h&mode=light&title=Power+Consumption&legend=true',
			'/chart?item=Power&period=h&mode=light&title=Power%20Consumption&legend=true'
		), true);
	});

	it('accepts identical strings and differing param order', () => {
		assert.strictEqual(chartUrlsEquivalent('/chart?item=A&period=h', '/chart?item=A&period=h'), true);
		assert.strictEqual(chartUrlsEquivalent('/chart?period=h&item=A', '/chart?item=A&period=h'), true);
	});

	it('rejects genuinely different parameter values', () => {
		assert.strictEqual(chartUrlsEquivalent(
			'/chart?item=A&period=h&title=Power',
			'/chart?item=A&period=h&title=Water'
		), false);
		assert.strictEqual(chartUrlsEquivalent(
			'/chart?item=A&period=h',
			'/chart?item=A&period=D'
		), false);
	});

	it('rejects an added or removed parameter (offset navigation)', () => {
		assert.strictEqual(chartUrlsEquivalent(
			'/chart?item=A&period=h&offset=1',
			'/chart?item=A&period=h'
		), false);
	});

	it('rejects different paths and empty inputs', () => {
		assert.strictEqual(chartUrlsEquivalent('/chart?item=A', '/other?item=A'), false);
		assert.strictEqual(chartUrlsEquivalent('', '/chart?item=A'), false);
		assert.strictEqual(chartUrlsEquivalent(null, '/chart?item=A'), false);
		assert.strictEqual(chartUrlsEquivalent('', ''), true);
	});
});

describe('chartLatestPeriodUrl', () => {
	it('removes runtime offset and cache-bust state while preserving chart configuration', () => {
		assert.strictEqual(
			chartLatestPeriodUrl('/chart?item=Power&period=D&mode=dark&title=Power+Use&offset=3&_t=old-hash'),
			'/chart?item=Power&period=D&mode=dark&title=Power+Use'
		);
	});

	it('normalizes offset zero and rejects non-chart URLs', () => {
		assert.strictEqual(chartLatestPeriodUrl('/chart?item=A&period=h&offset=0'), '/chart?item=A&period=h');
		assert.strictEqual(chartLatestPeriodUrl('/other?item=A&period=h&offset=2'), '');
	});
});
