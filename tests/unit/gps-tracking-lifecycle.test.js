'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('GPS tracking lifecycle wiring', () => {
	it('uses watch-based GPS tracking with an immediate send and 30 second cadence', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const GPS_REPORT_INTERVAL_MS = 30000;/);
		assert.match(app, /navigator\.geolocation\.watchPosition\(/);
		assert.match(app, /\{ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 \}/);
		assert.match(app, /function armGpsSendTimer\(sessionToken\) \{\s*clearGpsSendTimer\(\);\s*gpsSendTimer = setInterval\(\(\) => \{[\s\S]*?void sendGpsPosition\(sessionToken\);[\s\S]*?\}, GPS_REPORT_INTERVAL_MS\);\s*\}/);
		assert.match(app, /function handleGpsPosition\(position, sessionToken\) \{\s*if \(sessionToken !== gpsSessionToken\) return;\s*gpsLatestPosition = position;\s*const hadLock = gpsHasLock;\s*gpsHasLock = true;\s*if \(hadLock\) return;\s*armGpsSendTimer\(sessionToken\);\s*void sendGpsPosition\(sessionToken\);\s*\}/);
	});

	it('tears down GPS timers and watches when hidden or lock is lost', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function clearGpsWatch\(\) \{\s*if \(gpsWatchId === null\) return;\s*try \{\s*if \(navigator\.geolocation && typeof navigator\.geolocation\.clearWatch === 'function'\) \{\s*navigator\.geolocation\.clearWatch\(gpsWatchId\);/);
		assert.match(app, /function handleGpsPositionError\(error, sessionToken\) \{\s*if \(sessionToken !== gpsSessionToken\) return;\s*clearGpsSendTimer\(\);\s*clearGpsLock\(\);\s*if \(error && error\.code === 1\) \{\s*stopGpsTracking\(\);\s*\}\s*\}/);
		assert.match(app, /function stopGpsTracking\(\) \{\s*gpsSessionToken \+= 1;\s*clearGpsSendTimer\(\);\s*clearGpsWatch\(\);\s*clearGpsLock\(\);\s*\}/);
		assert.match(app, /\(error\) => handleGpsPositionError\(error, sessionToken\)/);
		assert.match(app, /function markPageHidden\(\) \{\s*stopGpsTracking\(\);/);
		assert.match(app, /window\.addEventListener\('pagehide', \(\) => markPageHidden\(\)\);/);
	});

	it('restarts GPS only after the visible session is ready again', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function isGpsTrackingEligible\(\) \{[\s\S]*?if \(_softResetRunning\) return false;[\s\S]*?if \(!isClientFocused\(\)\) return false;/);
		assert.match(app, /async function softReset\(\) \{[\s\S]*?_softResetRunning = true;[\s\S]*?stopGpsTracking\(\);[\s\S]*?hideStatusTooltip\(\);[\s\S]*?try \{/);
		assert.match(app, /endResumeTransition\(\);\s*_softResetRunning = false;\s*syncGpsTracking\(\);/);
		assert.match(app, /function handlePageVisible\(\) \{[\s\S]*?startPingDelayed\(\);\s*syncGpsTracking\(\);[\s\S]*?\}/);
		assert.match(app, /window\.addEventListener\('pageshow', \(event\) => \{\s*if \(event\.persisted && isTouchDevice\(\)\) \{[\s\S]*?if \(hiddenDuration >= minHiddenMs\) \{\s*softReset\(\);\s*\} else \{\s*syncGpsTracking\(\);\s*\}/);
		assert.match(app, /function sendFocusState\(\) \{[\s\S]*?syncWakeLock\(\);\s*syncGpsTracking\(\);\s*\}/);
		assert.match(app, /\}\s*syncGpsTracking\(\);\s*\}\)\(\);/);
		assert.doesNotMatch(app, /reportGps\(/);
	});
});
