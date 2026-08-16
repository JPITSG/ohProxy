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

function makeCheckChartHashes({ iframe, responseHash = 'latest-hash' }) {
	const fetched = [];
	const swaps = [];
	const chartHashes = new Map();
	let hashReads = 0;
	const checkSource = extractFunction(app, 'checkChartHashes').replace(/^function /, 'async function ');
	const checkChartHashes = Function(
		'document', 'setupChartInteractionTracking', 'CHART_HASH_CHECK_MS', 'getThemeMode',
		'OH_CONFIG', 'normalizeChartRuntimeUrl', 'window', 'normalizeChartPeriodOffset',
		'chartLatestPeriodUrl', 'normalizeChartLegendMode', 'normalizeChartForceAsItem',
		'chartHashes', 'fetch', 'MAX_CHART_HASHES', 'setBoundedCache', 'readIframeChartHash',
		'isChartBeingInteracted', 'buildChartReloadUrl', 'swapChartIframe', 'logJsError',
		`let chartHashCheckInProgress = false; return (${checkSource});`
	)(
		{ querySelectorAll: () => [iframe] },
		() => {},
		30000,
		() => 'dark',
		{ assetVersion: 'test-assets' },
		(url) => url.replace(/([?&])_t=[^&]*&?/, '$1').replace(/[?&]$/, ''),
		{ location: { origin: 'http://oh.test' } },
		(value) => {
			const parsed = Number.parseInt(String(value || ''), 10);
			return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
		},
		(url) => {
			const parsed = new URL(url, 'http://oh.test');
			parsed.searchParams.delete('_t');
			parsed.searchParams.delete('offset');
			return parsed.pathname + parsed.search;
		},
		(value) => value || 'auto',
		(value) => value || '',
		chartHashes,
		async (url, options) => {
			fetched.push({ url, options });
			return { ok: true, json: async () => ({ hash: responseHash }) };
		},
		20,
		(cache, key, value) => cache.set(key, value),
		() => {
			hashReads += 1;
			return 'visible-hash';
		},
		() => false,
		(url, hash) => `${url}&_t=${hash}`,
		(target, newUrl, baseUrl) => swaps.push({ target, newUrl, baseUrl }),
		() => {}
	);
	return { checkChartHashes, fetched, swaps, chartHashes, get hashReads() { return hashReads; } };
}

describe('historical chart refresh behavior', () => {
	it('refreshes offset-zero data without reading or swapping the historical iframe', async () => {
		const iframe = {
			dataset: {
				chartUrl: '/chart?item=Power&period=D&mode=dark&title=Power+Use&offset=2',
				chartBaseUrl: '/chart?item=Power&period=D&mode=dark&title=Power%20Use',
				refresh: '1',
				lastHashCheck: '0',
			},
		};
		const run = makeCheckChartHashes({ iframe });

		await run.checkChartHashes();

		assert.strictEqual(run.fetched.length, 1, 'the latest-period hash endpoint should still be polled');
		assert.match(run.fetched[0].url, /^\/api\/chart-hash\?/);
		assert.ok(!run.fetched[0].url.includes('offset='), 'background refresh must target offset zero');
		assert.strictEqual(run.fetched[0].options.cache, 'no-store');
		assert.strictEqual(run.hashReads, 0, 'historical iframe hash should not participate in latest-period refresh');
		assert.deepStrictEqual(run.swaps, [], 'historical iframe must remain visible and untouched');
		assert.ok([...run.chartHashes.values()].includes('latest-hash'), 'latest hash should be remembered');
		assert.match(iframe.dataset.chartUrl, /offset=2/, 'runtime period selection must remain historical');
	});

	it('continues to swap a current-period iframe when its appearance hash changes', async () => {
		const iframe = {
			dataset: {
				chartUrl: '/chart?item=Power&period=D&mode=dark',
				chartBaseUrl: '/chart?item=Power&period=D&mode=dark',
				refresh: '1',
				lastHashCheck: '0',
			},
		};
		const run = makeCheckChartHashes({ iframe, responseHash: 'changed-hash' });

		await run.checkChartHashes();

		assert.strictEqual(run.hashReads, 1);
		assert.strictEqual(run.swaps.length, 1);
		assert.strictEqual(run.swaps[0].target, iframe);
		assert.match(run.swaps[0].newUrl, /changed-hash/);
	});
});
