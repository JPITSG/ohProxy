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
		assert.match(app, /function beginResumeTransition\(\) \{\s*state\.resumeHeldStatusText = 'Disconnected';\s*state\.resumeHeldStatusOk = false;/);
		assert.match(app, /if \(isResumeUiLocked\(\)\) \{\s*const label = state\.resumeHeldStatusText \|\| state\.initialStatusText \|\| connectionStatusInfo\(\)\.label \|\| 'Connected';/);
		assert.match(app, /if \(isResumeUiLocked\(\)\) \{\s*document\.documentElement\.classList\.remove\('error-state'\);/);
	});

	it('suppresses websocket on-open refresh during resume lock', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const skipOpenRefresh = wsSkipNextOpenRefresh === true;/);
		assert.match(app, /setConnectionStatus\(true\);\s*if \(!isResumeUiLocked\(\) && !skipOpenRefresh\) \{\s*refresh\(false\);/);
		assert.match(app, /if \(!wsConnected && CLIENT_CONFIG\.websocketDisabled !== true\) \{\s*wsSkipNextOpenRefresh = true;/);
		assert.match(app, /resumeVideoStreamsFromVisibility\(\);\s*noteActivity\(\);\s*startPolling\(\);\s*if \(!wsConnected && CLIENT_CONFIG\.websocketDisabled !== true\)/);
	});

	it('completes soft reset through a settle window and hard timeout', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /markResumeSettling\(\);/);
		assert.match(app, /await waitForResumeSettleWindow\(\);/);
		assert.match(app, /const hardDeadline = Date\.now\(\) \+ RESUME_HARD_TIMEOUT_MS;/);
		assert.match(app, /throw new Error\('Resume timeout'\);/);
		assert.doesNotMatch(app, /state\.pageUrl = state\.rootPageUrl;\s*setConnectionStatus\(true\);\s*const refreshed = await refresh\(true\);/);
		assert.doesNotMatch(app, /applySitemapOption\(selected\);\s*\/\/ Success - now refresh to get widgets\s*setConnectionStatus\(true\);\s*const refreshed = await refresh\(true\);/);
	});
});
