'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('Search scroll blur wiring', () => {
	it('blurs the focused search input on touch or wheel scroll intent without blocking scroll', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		const touchMoveStart = app.indexOf('function handleSearchFocusScrollTouchMove(e)');
		const touchMoveEnd = app.indexOf('function clearSearchFocusScrollTouch()');
		const touchMoveBody = app.slice(touchMoveStart, touchMoveEnd);
		assert.match(app, /const SEARCH_SCROLL_BLUR_MOVE_THRESHOLD_PX = 8;/);
		assert.match(app, /function isSearchInputFocused\(\) \{\s*return !!els\.search && document\.activeElement === els\.search;\s*\}/);
		assert.match(app, /function blurSearchForScrollIntent\(\) \{\s*if \(!isSearchInputFocused\(\)\) return false;\s*els\.search\.blur\(\);\s*searchFocusTouchStart = null;\s*return true;\s*\}/);
		assert.match(app, /function handleSearchFocusScrollTouchMove\(e\) \{[\s\S]*?const dx = Math\.abs\(touch\.clientX - searchFocusTouchStart\.x\);[\s\S]*?const dy = Math\.abs\(touch\.clientY - searchFocusTouchStart\.y\);[\s\S]*?if \(dy >= SEARCH_SCROLL_BLUR_MOVE_THRESHOLD_PX && dy >= dx\) \{\s*blurSearchForScrollIntent\(\);[\s\S]*?\}/);
		assert.match(app, /function handleSearchFocusScrollWheel\(e\) \{\s*if \(!isSearchInputFocused\(\)\) return;\s*if \(Math\.abs\(e\.deltaY \|\| 0\) < 1 && Math\.abs\(e\.deltaX \|\| 0\) < 1\) return;\s*blurSearchForScrollIntent\(\);\s*\}/);
		assert.match(app, /window\.addEventListener\('touchstart', handleSearchFocusScrollTouchStart, \{ passive: true, capture: true \}\);/);
		assert.match(app, /window\.addEventListener\('touchmove', handleSearchFocusScrollTouchMove, \{ passive: true, capture: true \}\);/);
		assert.match(app, /window\.addEventListener\('wheel', handleSearchFocusScrollWheel, \{ passive: true, capture: true \}\);/);
		assert.match(app, /els\.search\.addEventListener\('blur', \(\) => \{\s*clearSearchFocusScrollTouch\(\);\s*syncSearchFocusedLayout\(\);/);
		assert.ok(touchMoveStart > -1);
		assert.ok(touchMoveEnd > touchMoveStart);
		assert.doesNotMatch(touchMoveBody, /preventDefault/);
	});
});
