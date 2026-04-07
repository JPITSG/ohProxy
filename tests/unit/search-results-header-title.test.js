'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('Search results header title', () => {
	it('shows Search Results in the page header and document title while search mode is active', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const isSearchResultsView = !!searchText;/);
		assert.match(app, /const pageLabel = isSearchResultsView \? 'Search Results' : \(isRoot \? 'Home' : \(state\.pageTitle \|\| sitemapTitle \|\| siteName\)\);/);
		assert.match(app, /const pageText = pageParts\.title \|\| pageLabel;/);
		assert.match(app, /const pageTitleText = `\$\{siteName\}\$\{PAGE_TITLE_SEPARATOR\}\$\{pageText\}`;/);
		assert.match(app, /separatorSpan\.textContent = PAGE_TITLE_SEPARATOR\.trim\(\);/);
		assert.match(app, /pageSpan\.textContent = headerTitle\.pageText;/);
	});
});
