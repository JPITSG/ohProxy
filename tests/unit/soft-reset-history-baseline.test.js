'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('Soft Reset History Baseline', () => {
	it('tracks a navigation session id and soft-reset history guard state', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /navSessionId:\s*1,/);
		assert.match(app, /softResetHistoryArmed:\s*false,/);
		assert.match(app, /softResetAutoBackSteps:\s*0,/);
	});

	it('includes navSessionId in history payload snapshots and sync writes', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function snapshotHistoryState\(\)[\s\S]*?navSessionId:\s*state\.navSessionId,/);
		assert.match(app, /function syncHistory\(replace\)[\s\S]*?navSessionId:\s*state\.navSessionId,/);
	});

	it('installs a near-zero touch baseline after successful soft reset', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function installTouchSoftResetHistoryBaseline\(\)\s*\{/);
		assert.match(app, /state\.stack = \[\];/);
		assert.match(app, /searchFocusHistoryPushed = false;/);
		assert.match(app, /searchFilterHistoryPushed = false;/);
		assert.match(app, /searchBlurNavPending = false;/);
		assert.match(app, /state\.navSessionId = Math\.max\(1, Number\(state\.navSessionId\) \|\| 1\) \+ 1;/);
		assert.match(app, /syncHistory\(true\);/);

		const successCalls = app.match(/installTouchSoftResetHistoryBaseline\(\);\s*await completeSoftResetSuccess\(\);/g) || [];
		assert.strictEqual(successCalls.length, 2);
	});

	it('skips stale popstate history entries while soft-reset guard is armed', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /if \(state\.softResetHistoryArmed\) \{[\s\S]*?state\.softResetAutoBackSteps < 12[\s\S]*?history\.back\(\);[\s\S]*?return;/);
		assert.match(app, /const nextSessionId = Number\(next\?\.navSessionId\);[\s\S]*?const sameSession = Number\.isFinite\(nextSessionId\) && nextSessionId === currentSessionId;/);
	});
});
