'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('Card Config History Wheel Navigation', () => {
	it('maps wheel direction on history entries to the existing history nav buttons', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /let historyWheelNavUntil = 0;/);
		assert.match(app, /function triggerHistoryNavFromWheel\(section, deltaY\) \{[\s\S]*?const btn = section\?\.querySelector\(deltaY > 0 \? '\.history-older' : '\.history-newer'\);[\s\S]*?if \(!btn\) return false;[\s\S]*?if \(now < historyWheelNavUntil\) return true;[\s\S]*?historyWheelNavUntil = now \+ 180;[\s\S]*?btn\.click\(\);[\s\S]*?return true;[\s\S]*?\}/);
		assert.match(app, /historyEntries\.addEventListener\('wheel', e => \{[\s\S]*?if \(!e\.deltaY \|\| Math\.abs\(e\.deltaY\) <= Math\.abs\(e\.deltaX\)\) return;[\s\S]*?if \(triggerHistoryNavFromWheel\(section, e\.deltaY\)\) e\.preventDefault\(\);[\s\S]*?\}, \{ passive: false \}\);/);
	});
});
