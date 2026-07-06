'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('Bounce touchmove wiring', () => {
	it('never registers a permanent scroll-blocking touchmove listener on window', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		// The only non-passive touchmove registration must live inside
		// attachBounceMoveListener (attached per gesture, at page edges only).
		const nonPassiveMoves = app.match(/addEventListener\('touchmove'[^)]*passive:\s*false/g) || [];
		assert.strictEqual(nonPassiveMoves.length, 1);
		assert.match(app, /function attachBounceMoveListener\(\) \{\s*if \(bounceTouch\.moveAttached\) return;\s*bounceTouch\.moveAttached = true;\s*window\.addEventListener\('touchmove', handleBounceTouchMove, \{ passive: false \}\);/);
		// The init block must not register handleBounceTouchMove directly.
		const initStart = app.indexOf("window.addEventListener('touchstart', handleBounceTouchStart");
		assert.ok(initStart > -1);
		const initSlice = app.slice(initStart, initStart + 1200);
		assert.doesNotMatch(initSlice, /addEventListener\('touchmove', handleBounceTouchMove/);
	});

	it('attaches the bounce listener at gesture start only when at a page edge', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function handleBounceTouchStart\(e\) \{[\s\S]*?const \{ top, max, atTop, atBottom \} = getScrollState\(\);[\s\S]*?bounceTouch\.startScrollY = top;\s*bounceTouch\.maxScroll = max;\s*if \(atTop \|\| atBottom\) \{\s*attachBounceMoveListener\(\);\s*\} else \{\s*attachBounceEdgeWatch\(\);\s*\}\s*\}/);
	});

	it('detaches the bounce listeners when the gesture ends', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /async function handleBounceTouchEnd\(\) \{\s*if \(state\.isSlim\) return;\s*if \(!bounceTouch\.active\) return;\s*detachBounceMoveListener\(\);\s*detachBounceEdgeWatch\(\);/);
	});

	it('keeps the passive edge watcher free of layout reads', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		const start = app.indexOf('function watchBounceEdgeProximity(e)');
		const end = app.indexOf('function handleBounceTouchStart(e)');
		assert.ok(start > -1 && end > start);
		const body = app.slice(start, end);
		assert.doesNotMatch(body, /scrollHeight|clientHeight|scrollTop|getBoundingClientRect|getScrollState|preventDefault/);
		assert.match(app, /window\.addEventListener\('touchmove', watchBounceEdgeProximity, \{ passive: true \}\);/);
	});

	it('still prevents native scroll for edge bounces and pull-to-refresh', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		const start = app.indexOf('function handleBounceTouchMove(e)');
		const end = app.indexOf('async function handleBounceTouchEnd()');
		assert.ok(start > -1 && end > start);
		const body = app.slice(start, end);
		assert.match(body, /if \(delta > 0 && atTop\) \{\s*e\.preventDefault\(\);/);
		assert.match(body, /if \(delta < 0 && atBottom\) \{\s*e\.preventDefault\(\);/);
		assert.match(body, /bounceTouch\.hitMaxAtTop = true;/);
		// Per-move reads are limited to scrollTop; full metrics only re-read to
		// confirm a bottom-edge hit against mid-gesture content growth.
		assert.match(body, /if \(delta < 0 && atBottom && !atTop\) \{[\s\S]*?getScrollState\(\);/);
	});
});
