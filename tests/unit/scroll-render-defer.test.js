'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');

describe('Scroll-gesture render deferral', () => {
	it('tracks scroll gestures with passive listeners only', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /window\.addEventListener\('scroll', noteScrollGestureActivity, \{ passive: true \}\);/);
		assert.match(app, /window\.addEventListener\('touchstart', noteScrollGestureTouchStart, \{ passive: true \}\);/);
		assert.match(app, /window\.addEventListener\('touchend', noteScrollGestureTouchEnd, \{ passive: true \}\);/);
		assert.match(app, /window\.addEventListener\('touchcancel', noteScrollGestureTouchEnd, \{ passive: true \}\);/);
		assert.match(app, /function isScrollGestureActive\(\) \{\s*return scrollGestureTouchDown \|\| \(Date\.now\(\) - lastScrollGestureAt < SCROLL_GESTURE_IDLE_MS\);\s*\}/);
	});

	it('defers WebSocket-driven renders while a gesture is active', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		const start = app.indexOf('function applyWsUpdate(data)');
		const end = app.indexOf('function handleWsPong');
		assert.ok(start > -1 && end > start);
		const body = app.slice(start, end);
		assert.match(body, /if \(isScrollGestureActive\(\)\) \{[\s\S]*?scrollDeferredWsRefreshPending = true;\s*renderWhenScrollIdle\(\);\s*return;\s*\}/);
		// Suppressed state (modals) must still take priority over deferral.
		assert.ok(body.indexOf('state.suppressRefreshCount > 0') < body.indexOf('isScrollGestureActive()'));
	});

	it('bounds the deferral so data can never lag indefinitely', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const SCROLL_RENDER_DEFER_MAX_MS = 1000;/);
		assert.match(app, /function scrollDeferralOverdue\(\) \{\s*return scrollDeferredSince > 0 && \(Date\.now\(\) - scrollDeferredSince >= SCROLL_RENDER_DEFER_MAX_MS\);\s*\}/);
		assert.match(app, /if \(isScrollGestureActive\(\) && !scrollDeferralOverdue\(\)\) \{\s*scheduleScrollDeferredFlush\(\);\s*return;\s*\}/);
	});

	it('flushes deferred work as one render plus one ws refresh', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function flushScrollDeferredWork\(\) \{[\s\S]*?if \(state\.suppressRefreshCount > 0\) \{\s*state\.pendingRefresh = true;\s*return;\s*\}\s*if \(doRender\) render\(\);\s*if \(doWsRefresh\) queueWsRefresh\(WS_REFRESH_DEBOUNCE_MS\);\s*\}/);
	});

	it('re-schedules background refreshes that land mid-gesture', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		const start = app.indexOf('async function refresh(showLoading)');
		assert.ok(start > -1);
		const body = app.slice(start, start + 1600);
		assert.match(body, /if \(!showLoading\) \{[\s\S]*?if \(isScrollGestureActive\(\) && !deferredTooLong\) \{[\s\S]*?bgRefreshRetryTimer = setTimeout\(\(\) => \{\s*bgRefreshRetryTimer = null;\s*refresh\(false\);\s*\}, SCROLL_DEFER_RETRY_MS\);\s*return false;\s*\}\s*bgRefreshDeferredSince = 0;\s*\}/);
	});

	it('defers search-state result renders to scroll idle', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /refreshSearchStates\(refreshTargets, \{ force: shouldForceMainSearchGlowStateRefresh\(searchQuery\) \}\)\.then\(\(updated\) => \{\s*if \(updated\) renderWhenScrollIdle\(\);\s*\}\);/);
	});
});

describe('Resume spinner idle animation', () => {
	it('pauses the ring animation while the spinner overlay is hidden', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(css, /\.resume-spinner-ring \{[^}]*animation: resume-spin 1s linear infinite;[^}]*animation-play-state: paused;[^}]*\}/);
		assert.match(css, /\.resume-spinner\.active \.resume-spinner-ring,\s*\.resume-spinner\.fading \.resume-spinner-ring \{\s*animation-play-state: running;\s*\}/);
		assert.match(css, /\.slim \.resume-spinner-ring \{\s*animation: resume-spin 1s linear infinite !important;\s*animation-play-state: paused !important;\s*\}/);
		assert.match(css, /\.slim \.resume-spinner\.active \.resume-spinner-ring,\s*\.slim \.resume-spinner\.fading \.resume-spinner-ring \{\s*animation-play-state: running !important;\s*\}/);
	});

	it('keeps the ring spinning through the fade-out without redundant hides cancelling cleanup', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /\/\/ Redundant hide calls must not cancel a pending fade cleanup\.\s*if \(!wasActive\) return;\s*els\.resumeSpinner\.classList\.add\('fading'\);\s*if \(resumeSpinnerFadeTimer\) clearTimeout\(resumeSpinnerFadeTimer\);\s*resumeSpinnerFadeTimer = setTimeout\(\(\) => \{\s*resumeSpinnerFadeTimer = null;\s*if \(els\.resumeSpinner\) els\.resumeSpinner\.classList\.remove\('fading'\);\s*\}, RESUME_SPINNER_FADE_MS\);/);
	});
});
