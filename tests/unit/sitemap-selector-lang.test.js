'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const LANG_FILE = path.join(PROJECT_ROOT, 'public', 'lang.js');

describe('Sitemap Selector Localization Wiring', () => {
	it('defines sitemap selector strings in language dictionary', () => {
		const lang = fs.readFileSync(LANG_FILE, 'utf8');
		assert.match(lang, /sitemapSelect:\s*\{/);
		assert.match(lang, /title:\s*'Select Sitemap'/);
		assert.match(lang, /closeBtn:\s*'Close'/);
		assert.match(lang, /currentBadge:\s*'Current Sitemap'/);
		assert.match(lang, /switchingStatus:\s*'Switching sitemap'/);
		assert.match(lang, /switchFailedStatus:\s*'Failed to switch sitemap'/);
		assert.match(lang, /refreshFailedStatus:\s*'Could not refresh sitemap list, showing cached options'/);
		assert.match(lang, /unnamedFallback:\s*'Unnamed sitemap'/);
		assert.match(lang, /triggerAriaLabel:\s*'Select sitemap'/);
	});

	it('uses localized sitemap selector strings in app modal and status flow', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /ohLang\?\.sitemapSelect\?\.unnamedFallback/);
		assert.match(app, /ohLang\?\.sitemapSelect\?\.currentBadge/);
		assert.match(app, /ohLang\?\.sitemapSelect\?\.title/);
		assert.match(app, /ohLang\?\.sitemapSelect\?\.closeBtn/);
		assert.match(app, /ohLang\?\.sitemapSelect\?\.switchingStatus/);
		assert.match(app, /ohLang\?\.sitemapSelect\?\.switchFailedStatus/);
		assert.match(app, /ohLang\?\.sitemapSelect\?\.refreshFailedStatus/);
		assert.match(app, /ohLang\?\.sitemapSelect\?\.triggerAriaLabel/);
	});
});
