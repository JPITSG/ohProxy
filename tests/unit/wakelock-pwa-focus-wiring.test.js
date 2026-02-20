'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('Wake Lock PWA Focus Wiring', () => {
	it('defines touch + PWA eligibility guards and screen request', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function isPwaDisplayMode\(\)\s*\{/);
		assert.match(app, /navigator\.standalone/);
		assert.match(app, /matchMedia\(`\(display-mode: \$\{mode\}\)`\)\.matches/);
		assert.match(app, /if \(!isTouchDevice\(\)\) return false;/);
		assert.match(app, /if \(!isPwaDisplayMode\(\)\) return false;/);
		assert.match(app, /await navigator\.wakeLock\.request\('screen'\);/);
	});

	it('keeps wake lock tied to focus/visibility lifecycle', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /if \(document\.visibilityState !== 'visible'\) return false;/);
		assert.match(app, /if \(!isClientFocused\(\)\) return false;/);
		assert.match(app, /if \(focused !== lastFocusState\) \{/);
		assert.match(app, /syncWakeLock\(\);/);
		assert.match(app, /document\.addEventListener\('visibilitychange', syncWakeLock\);/);
		assert.match(app, /window\.addEventListener\('focus', syncWakeLock, \{ passive: true \}\);/);
		assert.match(app, /window\.addEventListener\('blur', syncWakeLock, \{ passive: true \}\);/);
		assert.match(app, /window\.addEventListener\('pagehide', \(\) => \{ void releaseWakeLockIfHeld\(\); \}, \{ passive: true \}\);/);
	});

	it('is silent and best-effort on unsupported or denied wake lock', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /wakeLockSupported = !!\(navigator\.wakeLock && typeof navigator\.wakeLock\.request === 'function'\);/);
		assert.match(app, /if \(!wakeLockSupported \|\| !isTouchDevice\(\)\) return;/);
		assert.match(app, /Best effort only: unsupported\/denied\/revoked should stay silent\./);
		assert.match(app, /Best effort only: keep silent on release failures\./);
	});
});
