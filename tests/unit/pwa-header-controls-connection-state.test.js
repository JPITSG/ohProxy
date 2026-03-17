'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');

describe('PWA header controls connection-state wiring', () => {
	it('caches the settings button with the other header controls', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /adminConfig:\s*document\.getElementById\('adminConfigBtn'\),/);
	});

	it('disables voice, settings, and logout buttons while disconnected', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /if \(els\.voice\) els\.voice\.disabled = !state\.connectionOk;/);
		assert.match(app, /if \(els\.adminConfig\) els\.adminConfig\.disabled = !state\.connectionOk;/);
		assert.match(app, /if \(els\.logout\) els\.logout\.disabled = !state\.connectionOk;/);
	});

	it('styles disabled settings and logout buttons consistently with other nav controls', () => {
		const styles = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(styles, /#logoutBtn:disabled \{\s*opacity: \.4;\s*\}/);
		assert.match(styles, /#adminConfigBtn:disabled \{\s*opacity: \.4;\s*\}/);
	});
});
