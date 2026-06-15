'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('Navigation page loading', () => {
	it('uses XHR directly for forced page loads instead of waiting on WS delta fallback', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const allowWsDelta = opts\.forceFull !== true;/);
		assert.match(app, /if \(allowWsDelta && wsConnected && wsConnection && wsConnection\.readyState === WebSocket\.OPEN\) \{/);
		assert.match(app, /fetchPage\(state\.pageUrl, \{ forceFull: showLoading \|\| isPageChange \}\)/);
	});

	it('renders cached pages first on every page change and delays fade until data is available', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const shouldAnimatePageChange = !state\.isSlim && isPageChange;\s*let fade = null;\s*const startPageFade = \(\) => \{/);
		assert.match(app, /if \(isPageChange && state\.sitemapCacheReady\) \{\s*const cachedPage = getPageFromCache\(state\.pageUrl\);/);
		assert.doesNotMatch(app, /isPageChange && state\.sitemapCacheReady && !isFastConnection\(\)/);
		assert.match(app, /await applyPageData\(cachedPage, startPageFade\(\), shouldScroll\);/);
		assert.match(app, /await applyPageData\(page, startPageFade\(\), shouldScroll\);/);
	});
});
