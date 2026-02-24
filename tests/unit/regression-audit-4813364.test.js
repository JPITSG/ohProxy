'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const CHART_FILE = path.join(PROJECT_ROOT, 'public', 'chart.js');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function widgetType(widget) {
	return safeText(widget?.type || widget?.widgetType || widget?.item?.type || '');
}

function updateWidgetState(widget, nextState) {
	if (!widget || typeof widget !== 'object') return;
	if (widget.item && typeof widget.item === 'object') {
		widget.item.state = nextState;
	}
	if ('state' in widget) {
		widget.state = nextState;
	}
}

// Replicated from public/app.js.
function applyDeltaChanges(state, changes) {
	if (!Array.isArray(changes) || !changes.length) return false;
	let updated = false;
	const lists = [state.rawWidgets];
	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		const keyIndex = new Map();
		for (const w of list) {
			if (!w) continue;
			const key = safeText(w?.key || '');
			if (!key) continue;
			if (!keyIndex.has(key)) keyIndex.set(key, []);
			keyIndex.get(key).push(w);
		}
		for (const change of changes) {
			const changeKey = safeText(change?.key || '');
			const targets = changeKey ? keyIndex.get(changeKey) : null;
			if (!targets) continue;
			for (const w of targets) {
				const wType = widgetType(w).toLowerCase();
				if (change.state !== undefined) updateWidgetState(w, change.state);
				if (change.mapping !== undefined && wType !== 'buttongrid') {
					if (w.mappings) w.mappings = change.mapping;
					else w.mapping = change.mapping;
				}
				if (change.buttons !== undefined && wType === 'buttongrid') {
					w.buttons = Array.isArray(change.buttons) ? change.buttons : [];
				}
				updated = true;
			}
		}
	}
	return updated;
}

describe('Regression Guards for 4813364..HEAD', () => {
	it('chart HTML uses inlineJson for yAxis pattern to prevent script-breakout XSS', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /window\._chartYAxisPattern=\$\{inlineJson\(yAxisDecimalPattern \|\| null\)\};/);
		assert.doesNotMatch(server, /window\._chartYAxisPattern=\$\{JSON\.stringify\(yAxisDecimalPattern \|\| null\)\};/);
	});

	it('chart hash polling includes interpolation in request URL and cache key', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const interpolation = \(urlObj\.searchParams\.get\('interpolation'\) \|\| 'linear'\)\.toLowerCase\(\);/);
		assert.match(app, /const service = urlObj\.searchParams\.get\('service'\) \|\| '';/);
		assert.match(app, /const cacheKey = `\$\{item\}\|\$\{period\}\|\$\{mode\}\|\$\{assetVersion\}\|\$\{title\}\|\$\{legend\}\|\$\{yAxisDecimalPattern\}\|\$\{interpolation\}\|\$\{service\}`;/);
		assert.match(app, /\(interpolation === 'step' \? '&interpolation=step' : ''\)/);
		assert.match(app, /\(service \? `&service=\$\{encodeURIComponent\(service\)\}` : ''\)/);
		assert.match(app, /period=\$\{encodeURIComponent\(period\)\}/);
	});

	it('chart hash first-check compares iframe hash directly (including null mismatch)', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /if \(iframeHash !== data\.hash\) \{/);
		assert.doesNotMatch(app, /if \(iframeHash && iframeHash !== data\.hash\) \{/);
	});

	it('chart refresh interaction suppression uses press/touch engagement instead of hover', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const chartMouseDownActive = new WeakSet\(\);/);
		assert.match(app, /iframe\.addEventListener\('mousedown', \(\) => chartMouseDownActive\.add\(iframe\), \{ passive: true \}\);/);
		assert.match(app, /return chartTouchActive\.has\(iframe\) \|\| chartMouseDownActive\.has\(iframe\);/);
		assert.doesNotMatch(app, /iframe\.matches\(':hover'\)/);
	});

	it('chart iframe swaps preserve fullscreen ownership and state', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const preserveFullscreen = iframeFsActive && iframeFsIframe === iframe;/);
		assert.match(app, /if \(preserveFullscreen && iframeFsActive\) \{/);
		assert.match(app, /iframeFsIframe = newIframe;/);
		assert.match(app, /newIframe\.contentWindow\.postMessage\(\{ type: 'ohproxy-fullscreen-state', active: true \}, '\*'\);/);
	});

	it('buttongrid allows button-level item binding when parent item is missing', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const hasButtongridButtonItem = isButtongrid && Array\.isArray\(buttons\) && buttons\.some\(\(b\) => safeText\(b\?\.itemName\)\.trim\(\)\);/);
		assert.match(app, /if \(!itemName && !hasButtongridButtonItem\) \{/);
	});

	it('buttongrid disables buttons with missing target item or press command', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /if \(!btnItemName \|\| !pressCommand\) \{/);
		assert.match(app, /btn\.disabled = true;/);
	});

	it('delta updates preserve buttongrid mapping structure and apply buttons payload', () => {
		const widget = {
			key: 'id:bg1',
			type: 'Buttongrid',
			item: { state: 'NULL' },
			mappings: [{ row: 1, column: 1, command: 'POWER', label: 'Power' }],
		};
		const state = { rawWidgets: [widget] };
		const updated = applyDeltaChanges(state, [{
			key: 'id:bg1',
			mapping: [{ command: 'POWER', releaseCommand: '', label: 'Power', icon: '' }],
			buttons: [{ row: 1, column: 1, command: 'MUTE', label: 'Mute' }],
		}]);

		assert.strictEqual(updated, true);
		assert.deepStrictEqual(widget.mappings, [{ row: 1, column: 1, command: 'POWER', label: 'Power' }]);
		assert.deepStrictEqual(widget.buttons, [{ row: 1, column: 1, command: 'MUTE', label: 'Mute' }]);
	});

	it('websocket handlers for pong and chartHashResponse are defined', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function handleWsPong\(_data\) \{/);
		assert.match(app, /function handleWsChartHashResponse\(data\) \{/);
	});

	it('chart renderer handles single-point paths and non-finite decimal formatting safely', () => {
		const chart = fs.readFileSync(CHART_FILE, 'utf8');
		assert.match(chart, /if \(typeof number !== 'number' \|\| !Number\.isFinite\(number\)\) \{/);
		assert.match(chart, /if \(pts\.length === 1\) return 'M ' \+ pts\[0\]\.x \+ ' ' \+ pts\[0\]\.y;/);
	});

	it('step interpolation hover uses rendered line Y instead of nearest point Y', () => {
		const chart = fs.readFileSync(CHART_FILE, 'utf8');
		assert.match(chart, /getLineYAtX\(plotX, cursorY\)/);
		assert.match(chart, /var lineY = this\.getLineYAtX\(cursorX, cursorY\);/);
		assert.doesNotMatch(chart, /var lineY = closest\.y;/);
	});

	it('decimal formatter supports percent in prefix or suffix and safe scientific parsing', () => {
		const chart = fs.readFileSync(CHART_FILE, 'utf8');
		assert.match(chart, /if \(hasUnquotedPercent\(prefixRaw\) \|\| hasUnquotedPercent\(suffixRaw\)\) \{/);
		assert.match(chart, /var expParts = absNum\.toExponential\(\)\.split\('e'\);/);
	});

	it('chart cache pruning includes hard size and count caps', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const CHART_CACHE_MAX_FILES = \d+;/);
		assert.match(server, /const CHART_CACHE_MAX_BYTES = \d+ \* 1024 \* 1024;/);
		assert.match(server, /entries\.length > CHART_CACHE_MAX_FILES \|\| totalBytes > CHART_CACHE_MAX_BYTES/);
		assert.match(server, /maybePruneChartCache\(\);/);
	});

	it('buttongrid render signature includes per-button state, colors, and visibility', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /\$\{b\.row\}:\$\{b\.column\}:\$\{b\.command\}:\$\{b\.releaseCommand\}:\$\{b\.label\}:\$\{b\.icon\}:\$\{b\.itemName\}:\$\{b\.state \|\| ''\}:\$\{b\.stateless\}:\$\{safeText\(b\?\.labelcolor \|\| ''\)\}:\$\{safeText\(b\?\.iconcolor \|\| ''\)\}:\$\{isButtongridButtonVisible\(b\) \? '1' : '0'\}/);
	});

	it('switch dual-command refresh suppression tracks overlapping press cycles', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /let refreshHoldCount = 0;/);
		assert.match(app, /let pendingReleases = 0;/);
		assert.match(app, /pendingReleases \+= 1;/);
		assert.match(app, /pendingReleases = Math\.max\(0, pendingReleases - 1\);/);
	});

	it('switch mappings with empty press commands render disabled controls', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const hasPressCommand = !!safeText\(parsed\.press\)\.trim\(\);/);
		assert.match(app, /if \(!hasPressCommand\) \{/);
		assert.match(app, /btn\.disabled = true;/);
	});

	it('chart hash websocket responses use bounded client cache updates', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /if \(MAX_CHART_HASHES > 0\) \{/);
		assert.match(app, /setBoundedCache\(chartHashes,\s*cacheKey,\s*hash,\s*MAX_CHART_HASHES\);/);
		assert.doesNotMatch(app, /chartHashes\.set\(cacheKey,\s*hash\);/);
	});

	it('server period validation uses CHART_PERIOD_MAX_LEN constant and /api/chart-hash prunes cache', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const CHART_PERIOD_MAX_LEN = \d+;/);
		assert.match(server, /period\.length > CHART_PERIOD_MAX_LEN/);
		assert.match(server, /fs\.writeFileSync\(cachePath,\s*html\);\s*[\r\n]+\s*maybePruneChartCache\(\);/);
	});
});
