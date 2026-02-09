'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP_FILE = path.join(__dirname, '..', '..', 'public', 'app.js');

describe('Buttongrid Card Reuse Reset', () => {
	it('clears buttongrid inline display overrides before rendering reused cards', () => {
		const appSource = fs.readFileSync(APP_FILE, 'utf8');
		const anchor = appSource.indexOf("row.classList.remove('items-center', 'hidden');");
		assert.ok(anchor >= 0, 'updateCard layout reset anchor must exist');
		const window = appSource.slice(anchor, anchor + 1200);
		assert.match(window, /labelStack\.style\.display = '';/);
		assert.match(window, /navHint\.style\.display = '';/);
		assert.match(window, /metaEl\.style\.display = '';/);
	});
});
