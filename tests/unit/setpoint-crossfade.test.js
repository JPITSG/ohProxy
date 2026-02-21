'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('Setpoint Crossfade', () => {
	it('captures button-initiated setpoint changes before command send', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function createSetpointButton\(text, isDisabled, computeNext, itemName, onBeforeSend\)/);
		assert.match(app, /if \(typeof onBeforeSend === 'function'\) onBeforeSend\(\);/);
	});

	it('crossfades setpoint center value with a 0.4s old\/new transition', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function crossfadeTextOverlap\(element, oldText, newText, durationMs = 400\)/);
		assert.match(app, /card\.__setpointCrossfadePending = \{\s*fromText: safeText\(currentDisplay\.textContent\),\s*startedAt: Date\.now\(\),\s*\};/);
		assert.match(app, /crossfadeTextOverlap\(display, oldSetpointText, setpointDisplayText, 400\);/);
	});

	it('bounds pending transition scope to setpoint renders', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /if \(!isSetpoint\) card\.__setpointCrossfadePending = null;/);
		assert.match(app, /if \(pendingSetpointCrossfade && \(Date\.now\(\) - pendingStartedAt\) > 5000\) \{\s*card\.__setpointCrossfadePending = null;\s*\}/);
	});
});
