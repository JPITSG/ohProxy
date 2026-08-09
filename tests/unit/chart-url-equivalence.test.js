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
const chartUrlsEquivalent = Function(
	'window', 'logJsError',
	`return (${extractFunction(app, 'chartUrlsEquivalent')});`
)({ location: { origin: 'http://oh.test' } }, (msg) => errors.push(msg));

describe('chartUrlsEquivalent', () => {
	it('card render uses equivalence, not raw string compare, for urlChanged', () => {
		assert.match(app, /const urlChanged = !chartUrlsEquivalent\(iframeEl\.dataset\.chartUrl, fullUrl\);/);
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
