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
		assert.match(app, /const RESUME_FAST_SETTLE_WINDOW_MS = 250;/);
		assert.match(app, /const RESUME_FAST_FETCH_THRESHOLD_MS = 750;/);
		assert.match(app, /const RESUME_HARD_TIMEOUT_MS = 8000;/);
		assert.match(app, /const RESUME_TRIGGER_DEBOUNCE_MS = 2000;/);
		assert.match(app, /let _lastSoftResetAt = 0;/);
		assert.match(app, /if \(Date\.now\(\) - _lastSoftResetAt < RESUME_TRIGGER_DEBOUNCE_MS\) return;/);
		assert.match(app, /function resumeSettleWindowForRefresh\(elapsedMs\) \{\s*return Number\.isFinite\(elapsedMs\) && elapsedMs <= RESUME_FAST_FETCH_THRESHOLD_MS\s*\? RESUME_FAST_SETTLE_WINDOW_MS\s*: RESUME_SETTLE_WINDOW_MS;\s*\}/);
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

	it('uses one idempotent lifecycle recovery path for mobile foreground signals', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.equal((app.match(/function markPageHidden\(/g) || []).length, 1);
		assert.equal((app.match(/function handlePageVisible\(/g) || []).length, 1);

		const hiddenStart = app.indexOf('function markPageHidden(source)');
		const visibleStart = app.indexOf('function handlePageVisible(source)');
		const reconcileStart = app.indexOf('function reconcilePageLifecycle(source)');
		assert.ok(hiddenStart >= 0 && visibleStart > hiddenStart && reconcileStart > visibleStart);
		const hidden = app.slice(hiddenStart, visibleStart);
		const visible = app.slice(visibleStart, reconcileStart);

		assert.match(hidden, /if \(resumeReloadArmed\) return false;/);
		assert.match(hidden, /stopPolling\(\);\s*stopPing\(\);\s*stopWs\(\);/);
		assert.ok(
			visible.indexOf('reconcileForegroundTransport(source);')
				< visible.indexOf('if (!resumeReloadArmed) return false;'),
			'transport must resume before foreground network work is gated',
		);
		assert.match(visible, /clearInflightFetches\(\);\s*wsFailCount = 0;\s*wsTimedOutToken = 0;/);
		assert.match(visible, /void softReset\(\);/);
		assert.match(visible, /void refresh\(false\);/);

		assert.match(app, /document\.addEventListener\('visibilitychange', \(\) => \{\s*reconcilePageLifecycle\('visibilitychange'\);/);
		assert.match(app, /document\.addEventListener\('freeze', \(\) => \{\s*markPageHidden\('freeze'\);/);
		assert.match(app, /document\.addEventListener\('resume', \(\) => \{\s*reconcilePageLifecycle\('resume'\);/);
		assert.match(app, /window\.addEventListener\('pagehide', \(\) => \{\s*markPageHidden\('pagehide'\);/);
		assert.match(app, /window\.addEventListener\('pageshow', \(\) => \{\s*reconcilePageLifecycle\('pageshow'\);/);
		assert.match(app, /window\.addEventListener\('focus', \(\) => \{\s*reconcilePageLifecycle\('focus'\);/);
		assert.match(app, /resumeReloadArmed \|\| window\.__OH_TRANSPORT__\?\.transportPaused === true/);
	});

	it('ignores events from a websocket replaced during foreground recovery', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		const connectStart = app.indexOf('function connectWs()');
		const closeStart = app.indexOf('function closeWs()', connectStart);
		assert.ok(connectStart >= 0 && closeStart > connectStart);
		const connect = app.slice(connectStart, closeStart);

		assert.match(connect, /const socket = new WebSocket\(getWsUrl\(\)\);\s*wsConnection = socket;/);
		assert.match(connect, /socket\.onopen = \(\) => \{\s*if \(wsConnection !== socket\)/);
		assert.match(connect, /socket\.onmessage = \(event\) => \{\s*if \(wsConnection !== socket\) return;/);
		assert.match(connect, /socket\.onclose = \(event\) => \{\s*if \(wsConnection !== socket\) return;/);
		assert.match(connect, /socket\.onerror = \(err\) => \{\s*if \(wsConnection !== socket\) return;/);
	});

	it('completes soft reset through a settle window and hard timeout', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /markResumeSettling\(options\.settleMs\);/);
		assert.match(app, /await waitForResumeSettleWindow\(\);/);
		assert.match(app, /const hardDeadline = Date\.now\(\) \+ RESUME_HARD_TIMEOUT_MS;/);
		assert.match(app, /const refreshStartedAt = Date\.now\(\);\s*const refreshed = await refresh\(true\);\s*if \(refreshed && state\.connectionOk\) \{\s*await completeSoftResetSuccess\(\{\s*settleMs: resumeSettleWindowForRefresh\(Date\.now\(\) - refreshStartedAt\),\s*\}\);/);
		assert.match(app, /throw new Error\('Resume timeout'\);/);
		assert.doesNotMatch(app, /state\.pageUrl = state\.rootPageUrl;\s*setConnectionStatus\(true\);\s*const refreshed = await refresh\(true\);/);
		assert.doesNotMatch(app, /applySitemapOption\(selected\);\s*\/\/ Success - now refresh to get widgets\s*setConnectionStatus\(true\);\s*const refreshed = await refresh\(true\);/);
	});

	it('treats hidden transport aborts as lifecycle-neutral during refresh', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function isPageLifecycleHidden\(\) \{\s*return document\.visibilityState === 'hidden' \|\| document\.hidden === true;\s*\}/);
		assert.match(app, /function createHiddenLifecycleAbortError\(message\) \{\s*const err = new Error\(message \|\| 'Request aborted while page hidden'\);\s*err\.name = 'HiddenLifecycleAbort';\s*err\.lifecycleHiddenAbort = true;\s*return err;\s*\}/);
		assert.match(app, /function isTransportPausedAbort\(err\) \{\s*return err\?\.transportPaused === true\s*\|\| err\?\._ohReason === 'Transport paused'\s*\|\| err\?\.message === 'Transport paused';\s*\}/);
		assert.match(app, /return isTransportPausedAbort\(err\) \|\| \(isAbort && isPageLifecycleHidden\(\)\);/);
		assert.match(app, /if \(err\?\.name === 'AbortError'\) \{\s*if \(isPageLifecycleHidden\(\) \|\| isTransportPausedAbort\(err\)\) \{\s*throw createHiddenLifecycleAbortError\('XHR aborted while page hidden'\);\s*\}\s*throw new Error\('XHR delta timeout'\);\s*\}/);
		assert.match(app, /if \(isHiddenLifecycleAbort\(e\)\) \{\s*state\.isRefreshing = false;\s*if \(fade\) \{\s*await fade\.promise;\s*runPageFadeIn\(fade\.token\);\s*\}\s*return false;\s*\}/);
		assert.match(app, /if \(ok && !prevOk && !state\.sitemapCacheReady && !isResumeUiLocked\(\)\) \{\s*resetSitemapCacheRetry\(\);\s*fetchFullSitemap\(\);\s*\}/);
	});

	it('clears and defocuses the mobile search UI during soft reset', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function resetSearchUiForSoftReset\(\) \{\s*const hadSearchHistoryEntry = searchFocusHistoryPushed \|\| searchFilterHistoryPushed;\s*state\.filter = '';\s*if \(els\.search\) els\.search\.value = '';\s*syncSearchClearButton\(els\.search\);\s*clearSearchScrollReset\(\);\s*state\.searchStateToken \+= 1;\s*cancelSearchStateRequests\(\);[\s\S]*?document\.documentElement\.classList\.remove\('search-focus-expanded'\);\s*scheduleSearchPlaceholderUpdate\(\);\s*if \(els\.search && document\.activeElement === els\.search\) \{\s*els\.search\.blur\(\);\s*\}\s*if \(hadSearchHistoryEntry\) \{\s*searchBlurNavPending = true;\s*history\.back\(\);\s*\}\s*updateNavButtons\(\);\s*\}/);
		assert.match(app, /hideStatusTooltip\(\);\s*resetSearchUiForSoftReset\(\);\s*try \{/);
	});
});
