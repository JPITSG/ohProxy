'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('selection query override', () => {
	it('tracks a selection mode override in client state and parses it from the query string', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');

		assert.match(app, /selectionModeOverride: null,/);
		assert.match(app, /const selectionParam = \(params\.get\('selection'\) \|\| ''\)\.toLowerCase\(\);/);
		assert.match(app, /state\.selectionModeOverride = \(selectionParam === 'native' \|\| selectionParam === 'custom'\) \? selectionParam : null;/);
	});

	it('treats selection=native|custom as a hard override over the default selection dropdown heuristic', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');

		assert.match(app, /const useOverlay = state\.selectionModeOverride === 'native'\s*\?\s*true\s*:\s*state\.selectionModeOverride === 'custom'\s*\?\s*false\s*:\s*state\.isSlim \|\| state\.headerMode === 'small' \|\| isTouchDevice\(\);/s);
		assert.match(app, /selection=native\|custom query param is a hard override; otherwise preserve the existing heuristic/);
	});
});
