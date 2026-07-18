'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('Search scroll reset wiring', () => {
	it('resets scroll once when a non-empty search is rendered', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /searchScrollResetPending: false,/);
		assert.match(app, /function queueSearchScrollReset\(\) \{\s*state\.searchScrollResetPending = true;\s*\}/);
		assert.match(app, /function clearSearchScrollReset\(\) \{\s*state\.searchScrollResetPending = false;\s*\}/);
		assert.match(app, /const shouldResetSearchScroll = !!q && state\.searchScrollResetPending;\s*if \(shouldResetSearchScroll\) \{\s*clearSearchScrollReset\(\);\s*scrollToTop\(\);\s*\}/);
		assert.match(app, /if \(state\.filter\.trim\(\)\) \{\s*queueSearchScrollReset\(\);\s*\} else \{\s*clearSearchScrollReset\(\);\s*\}/);
		assert.match(app, /recalculateStretchCards\(\);\s*if \(shouldResetSearchScroll\) finishSearchScrollReset\(\);/);
		assert.match(app, /if \(els\.search\) els\.search\.value = '';\s*syncSearchClearButton\(els\.search\);\s*clearSearchScrollReset\(\);/);
	});
});
