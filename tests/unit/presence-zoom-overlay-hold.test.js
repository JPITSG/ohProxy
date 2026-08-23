'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');
const source = fs.readFileSync(SERVER_FILE, 'utf8');

function extractFunction(src, name) {
	const start = src.indexOf(`function ${name}(`);
	assert.ok(start >= 0, `${name} must exist`);
	const bodyStart = src.indexOf('{', start);
	let depth = 0;
	for (let i = bodyStart; i < src.length; i += 1) {
		if (src[i] === '{') depth += 1;
		else if (src[i] === '}') {
			depth -= 1;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	throw new Error(`Could not extract ${name}`);
}

const constsLine = source.match(/var ZOOM_HOLD_WATCHDOG_MS=\d+,ZOOM_HOLD_REVEAL_MS=\d+;/);
assert.ok(constsLine, 'zoom hold timing constants must exist');

// Builds an isolated instance of the hold state machine with recording fakes.
function makeHarness(opts = {}) {
	const log = [];
	const timers = [];
	let timerId = 0;
	const fakeSetTimeout = (fn, ms) => { const id = ++timerId; timers.push({ id, fn, ms, cleared: false }); return id; };
	const fakeClearTimeout = (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; };
	const fakeEl = (name) => ({
		classes: new Set(),
		classList: {
			add(c) { log.push(`${name}.add:${c}`); this.owner.classes.add(c); },
			remove(c) { log.push(`${name}.remove:${c}`); this.owner.classes.delete(c); },
		},
	});
	const root = fakeEl('root');
	root.classList.owner = root;
	const ctxMenu = fakeEl('ctx');
	ctxMenu.classList.owner = ctxMenu;
	const code = `
${constsLine[0]}
var zoomHoldActive=false,zoomHoldWatchdog=0,zoomHoldReveal=0;
${extractFunction(source, 'armZoomHoldWatchdog')}
${extractFunction(source, 'beginZoomOverlayHold')}
${extractFunction(source, 'endZoomOverlayHold')}
${extractFunction(source, 'scheduleZoomOverlayReveal')}
return { begin: beginZoomOverlayHold, end: endZoomOverlayHold, schedule: scheduleZoomOverlayReveal, isActive: function(){ return zoomHoldActive; } };
`;
	const factory = new Function(
		'singlePointMode', 'hidePreviewTooltip', 'hideTooltip', 'hoverTooltip', 'blueTooltipPinned',
		'ctxMenu', 'ctxDragging', 'ctxDragActive', 'zoomHoldRoot', 'updateAnchoredTooltips',
		'setTimeout', 'clearTimeout', code
	);
	const api = factory(
		opts.singlePointMode === true,
		() => log.push('dismiss:preview'),
		(el) => log.push('dismiss:' + (el === undefined ? 'undefined' : el)),
		'hover',
		opts.blueTooltipPinned === true,
		opts.noCtxMenu ? undefined : ctxMenu,
		opts.ctxDragging === true,
		opts.ctxDragActive === true,
		root,
		() => log.push('reposition'),
		fakeSetTimeout,
		fakeClearTimeout
	);
	const pendingOf = (ms) => timers.filter((t) => t.ms === ms && !t.cleared && !t.fired);
	const fire = (t) => { t.fired = true; t.fn(); };
	const WATCHDOG = Number(constsLine[0].match(/WATCHDOG_MS=(\d+)/)[1]);
	const REVEAL = Number(constsLine[0].match(/REVEAL_MS=(\d+)/)[1]);
	return { api, log, timers, pendingOf, fire, root, ctxMenu, WATCHDOG, REVEAL };
}

describe('Zoom overlay hold state machine', () => {
	it('begin hides anchored overlays, dismisses pointer tooltips, and arms the watchdog', () => {
		const h = makeHarness();
		h.api.begin();
		assert.ok(h.root.classes.has('map-zooming'));
		assert.ok(h.log.includes('dismiss:preview'));
		assert.ok(h.log.includes('dismiss:hover'), 'unpinned hover tooltip is dismissed');
		assert.strictEqual(h.pendingOf(h.WATCHDOG).length, 1);
		assert.strictEqual(h.api.isActive(), true);
	});

	it('a pinned blue tooltip is held, not dismissed', () => {
		const h = makeHarness({ blueTooltipPinned: true });
		h.api.begin();
		assert.ok(!h.log.includes('dismiss:hover'));
	});

	it('a ctx menu being dragged is exempt from the hold', () => {
		const h = makeHarness({ ctxDragActive: true });
		h.api.begin();
		assert.ok(h.ctxMenu.classes.has('zoom-hold-exempt'));
		h.api.end();
		assert.ok(!h.ctxMenu.classes.has('zoom-hold-exempt'));
	});

	it('end repositions overlays before revealing them', () => {
		const h = makeHarness();
		h.api.begin();
		h.api.end();
		const repositionAt = h.log.indexOf('reposition');
		const revealAt = h.log.indexOf('root.remove:map-zooming');
		assert.ok(repositionAt >= 0 && revealAt >= 0 && repositionAt < revealAt);
		assert.strictEqual(h.api.isActive(), false);
	});

	it('reveal is debounced and cancelled by a new zoom', () => {
		const h = makeHarness();
		h.api.begin();
		h.api.schedule();
		assert.strictEqual(h.pendingOf(h.REVEAL).length, 1);
		h.api.begin();
		assert.strictEqual(h.pendingOf(h.REVEAL).length, 0, 'chained zoom cancels the pending reveal');
		h.api.schedule();
		h.fire(h.pendingOf(h.REVEAL)[0]);
		assert.strictEqual(h.api.isActive(), false);
		assert.ok(!h.root.classes.has('map-zooming'));
	});

	it('the watchdog force-reveals if no settle event ever arrives', () => {
		const h = makeHarness();
		h.api.begin();
		h.fire(h.pendingOf(h.WATCHDOG)[0]);
		assert.strictEqual(h.api.isActive(), false);
		assert.ok(h.log.includes('reposition'));
	});

	it('repeat begins refresh the watchdog without re-hiding', () => {
		const h = makeHarness();
		h.api.begin();
		h.api.begin();
		assert.strictEqual(h.log.filter((l) => l === 'dismiss:preview').length, 1);
		assert.strictEqual(h.pendingOf(h.WATCHDOG).length, 1, 'stale watchdog is cleared');
	});

	it('schedule and end are no-ops while inactive', () => {
		const h = makeHarness();
		h.api.schedule();
		assert.strictEqual(h.pendingOf(h.REVEAL).length, 0);
		h.api.end();
		assert.ok(!h.log.includes('reposition'));
	});

	it('single-point mode never engages the hold', () => {
		const h = makeHarness({ singlePointMode: true });
		h.api.begin();
		assert.strictEqual(h.api.isActive(), false);
		assert.ok(!h.root.classes.has('map-zooming'));
	});
});

describe('Zoom overlay hold wiring', () => {
	it('all zoom entry points funnel into the hold', () => {
		assert.match(source, /var zoomToWithoutHold=map\.zoomTo;/);
		assert.match(source, /map\.zoomTo=function\(zoom\)\{\s*if\(map\.isValidZoomLevel\(zoom\)&&zoom!==map\.getZoom\(\)\)beginZoomOverlayHold\(\);\s*return zoomToWithoutHold\.apply\(map,arguments\);\s*\};/);
		assert.match(source, /mapEl\.addEventListener\('touchstart',function\(e\)\{\s*if\(e\.touches&&e\.touches\.length>=2\)beginZoomOverlayHold\(\);\s*\},\{passive:true,capture:true\}\);/);
		assert.match(source, /mapEl\.addEventListener\('touchmove',function\(e\)\{\s*if\(zoomHoldActive&&e\.touches&&e\.touches\.length>=2\)armZoomHoldWatchdog\(\);\s*\},\{passive:true,capture:true\}\);/);
	});

	it('settle events schedule the reveal', () => {
		assert.match(source, /map\.events\.register\('zoomend',map,scheduleZoomOverlayReveal\);/);
		assert.match(source, /map\.events\.register\('moveend',map,scheduleZoomOverlayReveal\);/);
	});

	it('the hold hides via visibility so tooltip display-state logic is untouched', () => {
		assert.match(source, /#presence-root\.map-zooming \.map-anchored\{visibility:hidden;opacity:0;transition:none\}/);
		assert.match(source, /\.map-anchored\{transition:opacity 120ms ease\}/);
		assert.match(source, /#presence-root\.map-zooming \.map-anchored\.zoom-hold-exempt\{visibility:visible;opacity:1\}/);
	});

	it('anchored overlays carry the map-anchored class; pointer tooltip does not', () => {
		assert.match(source, /<div id="red-tooltip" class="tooltip map-anchored"/);
		assert.match(source, /<div id="hover-tooltip" class="tooltip map-anchored"/);
		assert.match(source, /<div id="preview-tooltip" class="tooltip"/);
		assert.match(source, /<div id="ctx-menu" class="map-anchored">/);
	});
});
