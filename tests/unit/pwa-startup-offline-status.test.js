'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('PWA startup offline status handling', () => {
	it('starts in a conservative disconnected state', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /connectionOk:\s*false,/);
		assert.match(app, /resumeHeldStatusOk:\s*false,/);
	});

	it('marks startup offline immediately when launched without network', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(
			app,
			/state\.initialStatusText = safeText\(els\.statusText \? els\.statusText\.textContent : ''\);\s*if \(navigator\.onLine === false\) \{\s*setConnectionStatus\(false, 'Network offline'\);\s*\} else \{\s*scheduleConnectionPending\(\);\s*updateStatusBar\(\);\s*\}/
		);
	});

	it('does not force connected state from embedded startup data', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.doesNotMatch(app, /syncHistory\(true\);\s*setConnectionStatus\(true\);\s*render\(\);/);
		assert.match(app, /if \(canUseEmbeddedHome\) \{[\s\S]*?syncHistory\(true\);\s*render\(\);[\s\S]*?void refresh\(false\)\.catch\(\(\) => \{\}\);/);
	});

	it('requires readiness before showing touch status notifications', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(
			app,
			/function shouldShowStatusNotification\(\) \{\s*return CLIENT_CONFIG\.statusNotification !== false[\s\S]*?&& state\.connectionReady[\s\S]*?&& state\.connectionOk/
		);
	});
});
