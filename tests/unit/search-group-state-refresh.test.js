'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('Search group state refresh', () => {
	it('does not fetch raw openHAB state for configured group count items', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function isConfiguredGroupItemName\(itemName\) \{\s*const name = safeText\(itemName\)\.trim\(\);\s*return !!name && GROUP_ITEMS_SET\.has\(name\);\s*\}/);
		assert.match(app, /const name = safeText\(w\?\.item\?\.name \|\| w\?\.itemName \|\| ''\);\s*if \(name && !isConfiguredGroupItemName\(name\)\) names\.add\(name\);/);
	});
});
