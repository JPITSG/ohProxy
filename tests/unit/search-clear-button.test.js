'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'styles.css'), 'utf8');

describe('Search Clear Button', () => {
	it('defines a shared attach helper that wraps the input and syncs on input', () => {
		assert.match(app, /function attachSearchClearButton\(input\) \{/);
		assert.match(app, /wrap\.className = 'search-clear-wrap';/);
		assert.match(app, /btn\.className = 'search-clear-btn';/);
		assert.match(app, /btn\.classList\.toggle\('visible', input\.value\.length > 0\);/);
		assert.match(app, /input\.addEventListener\('input', sync\);/);
	});

	it('clearing refires the input pipeline and keeps focus in the box', () => {
		assert.match(app, /input\.value = '';\s*input\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\);\s*input\.focus\(\);/);
		assert.match(app, /btn\.addEventListener\('mousedown', \(e\) => e\.preventDefault\(\)\);/);
	});

	it('is attached to both search boxes', () => {
		assert.match(app, /attachSearchClearButton\(els\.search\);/);
		assert.match(app, /attachSearchClearButton\(searchInput\);/);
	});

	it('stays in sync after programmatic clears', () => {
		assert.match(app, /function syncSearchClearButton\(input\) \{/);
		// Header search: home snapshot restore, soft reset, and back-button filter clear
		assert.equal((app.match(/syncSearchClearButton\(els\.search\);/g) || []).length, 3);
		// Settings modal search: Escape key and modal reopen reset
		assert.equal((app.match(/syncSearchClearButton\(searchInput\);/g) || []).length, 2);
	});

	it('hides the native cancel X and styles the replacement red in both themes', () => {
		assert.match(styles, /input\[type="search"\]::-webkit-search-cancel-button \{[^}]*display: none;/);
		assert.match(styles, /\.search-clear-btn \{[^}]*color: rgba\(248, 113, 113, 0\.9\);/);
		assert.match(styles, /body\.theme-light \.search-clear-btn \{[^}]*color: rgba\(220, 38, 38, 0\.9\);/);
		// Room for the X so text does not run underneath it
		assert.match(styles, /\.search-clear-wrap input\[type="search"\] \{\s*padding-right: 34px;/);
	});
});
