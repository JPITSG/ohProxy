'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('Sitemap Selector Modal Refresh Wiring', () => {
	it('refreshes sitemap options from backend whenever selector modal is opened', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /async function refreshSitemapOptionsForModalOpen\(\) \{/);
		assert.match(app, /const options = await loadSitemapOptions\(\);/);
		assert.match(app, /async function openSitemapSelectModal\(\) \{/);
		assert.match(app, /const refreshed = await refreshSitemapOptionsForModalOpen\(\);/);
	});

	it('closes or avoids opening selector when refreshed options are no longer switchable', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const options = Array\.isArray\(refreshed\.options\) \? refreshed\.options : \[\];/);
		assert.match(app, /if \(options\.length <= 1\) \{/);
		assert.match(app, /if \(modalIsOpen\) closeSitemapSelectModal\(\);/);
	});

	it('shows localized non-blocking status when refresh fails and cached options are used', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /if \(!refreshed\.ok\) \{/);
		assert.match(app, /ohLang\?\.sitemapSelect\?\.refreshFailedStatus/);
	});
});
