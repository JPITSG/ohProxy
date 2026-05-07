'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const loginHtml = fs.readFileSync(path.join(root, 'public', 'login.html'), 'utf8');

describe('login theme default', () => {
	it('renders the login page in light mode by default', () => {
		assert.match(loginHtml, /<html lang="en" class="theme-light">/);
		assert.match(loginHtml, /<meta name="theme-color" content="#f5f6fa" \/>/);
		assert.match(loginHtml, /document\.documentElement\.classList\.add\('theme-light'\);/);
		assert.match(loginHtml, /metaTheme\.setAttribute\('content', '#f5f6fa'\);/);
	});

	it('does not inherit the saved app theme on the login page', () => {
		assert.doesNotMatch(loginHtml, /localStorage\.getItem\('ohTheme'\)/);
		assert.doesNotMatch(loginHtml, /matchMedia\('\(prefers-color-scheme: dark\)'\)/);
		assert.doesNotMatch(loginHtml, /localStorage\.setItem\('ohTheme'/);
	});
});
