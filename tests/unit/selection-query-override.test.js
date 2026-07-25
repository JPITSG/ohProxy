'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const app = fs.readFileSync(APP_FILE, 'utf8');

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

// Run the real shouldUseNativeSelect against injected state, so the assertion is
// about behaviour rather than the shape of the source (an earlier version pinned
// the exact inline ternary and broke when it was extracted into this helper).
function buildShouldUseNativeSelect(state, isTouchDevice) {
	const source = extractFunction(app, 'shouldUseNativeSelect');
	return Function('state', 'isTouchDevice', `return (${source});`)(state, isTouchDevice);
}

function decide({ override = null, isSlim = false, headerMode = 'full', touch = false }) {
	const state = { selectionModeOverride: override, isSlim, headerMode };
	return buildShouldUseNativeSelect(state, () => touch)();
}

describe('selection query override', () => {
	it('tracks a selection mode override in client state and parses it from the query string', () => {
		assert.match(app, /selectionModeOverride: null,/);
		assert.match(app, /const selectionParam = \(params\.get\('selection'\) \|\| ''\)\.toLowerCase\(\);/);
		assert.match(app, /state\.selectionModeOverride = \(selectionParam === 'native' \|\| selectionParam === 'custom'\) \? selectionParam : null;/);
	});

	it('treats selection=native as a hard override, whatever the heuristic would say', () => {
		assert.strictEqual(decide({ override: 'native' }), true);
		// Every input the heuristic reads points the other way, and it still wins.
		assert.strictEqual(decide({ override: 'native', isSlim: false, headerMode: 'full', touch: false }), true);
	});

	it('treats selection=custom as a hard override, whatever the heuristic would say', () => {
		assert.strictEqual(decide({ override: 'custom' }), false);
		// Each heuristic input on its own would otherwise force the native overlay.
		assert.strictEqual(decide({ override: 'custom', isSlim: true }), false);
		assert.strictEqual(decide({ override: 'custom', headerMode: 'small' }), false);
		assert.strictEqual(decide({ override: 'custom', touch: true }), false);
	});

	it('falls back to the slim / small-header / touch heuristic with no override', () => {
		assert.strictEqual(decide({}), false);
		assert.strictEqual(decide({ isSlim: true }), true);
		assert.strictEqual(decide({ headerMode: 'small' }), true);
		assert.strictEqual(decide({ touch: true }), true);
		// An unrecognised ?selection= value is normalised to null upstream, so it
		// must not be treated as an override here either.
		assert.strictEqual(decide({ override: 'nonsense', isSlim: true }), true);
		assert.strictEqual(decide({ override: 'nonsense' }), false);
	});

	it('shares one decision between the grid Selection widgets and the config-modal selects', () => {
		// The point of the helper is that the two call sites cannot diverge.
		const callSites = app.match(/shouldUseNativeSelect\(\)/g) || [];
		assert.ok(callSites.length >= 3, `expected the definition plus both call sites, found ${callSites.length}`);
	});
});
