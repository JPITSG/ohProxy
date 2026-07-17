'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');

describe('Asset Reload Countdown', () => {
	it('supports a countdown auto-action on alert buttons', () => {
		assert.match(app, /if \(options\.countdown && options\.buttons && options\.buttons\.length > 0\) \{/);
		assert.match(app, /let remaining = Math\.max\(1, Math\.floor\(options\.countdown\.seconds\) \|\| 10\);/);
		assert.match(app, /target\.textContent = `\$\{baseText\} \(\$\{remaining\}s\)`;/);
		assert.match(app, /alertCountdownTimer = setInterval\(/);
		// Auto-action presses the button through the normal click path
		assert.match(app, /clearInterval\(alertCountdownTimer\);\s*alertCountdownTimer = null;\s*target\.click\(\);/);
	});

	it('closing the alert in any way aborts the countdown', () => {
		assert.match(app, /function closeAlert\(\) \{\s*if \(!alertModal \|\| alertModal\.classList\.contains\('hidden'\)\) return;\s*if \(alertCountdownTimer\) \{\s*clearInterval\(alertCountdownTimer\);\s*alertCountdownTimer = null;\s*\}/);
	});

	it('the update prompt auto-reloads after 10 seconds', () => {
		assert.match(app, /function promptAssetReload\(\) \{[\s\S]*?countdown: \{ seconds: 10, buttonIndex: 1 \},\s*\}\);\s*\}/);
	});
});
