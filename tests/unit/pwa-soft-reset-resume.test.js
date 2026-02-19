'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('PWA Soft Reset Resume', () => {
	it('defines resume settle and debounce controls', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const RESUME_SETTLE_WINDOW_MS = 1200;/);
		assert.match(app, /const RESUME_HARD_TIMEOUT_MS = 8000;/);
		assert.match(app, /const RESUME_TRIGGER_DEBOUNCE_MS = 2000;/);
		assert.match(app, /let _lastSoftResetAt = 0;/);
		assert.match(app, /if \(Date\.now\(\) - _lastSoftResetAt < RESUME_TRIGGER_DEBOUNCE_MS\) return;/);
	});

	it('holds status rendering while resume UI is locked', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function isResumeUiLocked\(\)\s*\{\s*return state\.resumeInProgress === true;\s*\}/);
		assert.match(app, /if \(isResumeUiLocked\(\)\) \{\s*const label = state\.resumeHeldStatusText \|\| state\.initialStatusText \|\| connectionStatusInfo\(\)\.label \|\| 'Connected';/);
		assert.match(app, /if \(isResumeUiLocked\(\)\) \{\s*document\.documentElement\.classList\.remove\('error-state'\);/);
	});

	it('suppresses websocket on-open refresh during resume lock', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /setConnectionStatus\(true\);\s*if \(!isResumeUiLocked\(\)\) \{\s*refresh\(false\);/);
	});

	it('completes soft reset through a settle window and hard timeout', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /markResumeSettling\(\);/);
		assert.match(app, /await waitForResumeSettleWindow\(\);/);
		assert.match(app, /const hardDeadline = Date\.now\(\) \+ RESUME_HARD_TIMEOUT_MS;/);
		assert.match(app, /throw new Error\('Resume timeout'\);/);
	});
});
