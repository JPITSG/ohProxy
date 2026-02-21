'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');

describe('Sitemap Title Clickable Styling', () => {
	it('keeps sitemap title clickable in app wiring when sitemap selection is enabled', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /siteSpan\.classList\.add\('sitemap-title-selectable'\);/);
		assert.match(app, /siteSpan\.addEventListener\('click', \(\) => openSitemapSelectModal\(\)\);/);
		assert.match(app, /siteSpan\.addEventListener\('keydown', \(e\) => \{/);
	});

	it('does not force underline on clickable sitemap title in header', () => {
		const styles = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(styles, /#pageTitle \.sitemap-title-selectable \{\s*cursor: pointer;\s*\}/);
		assert.doesNotMatch(styles, /#pageTitle \.sitemap-title-selectable \{[\s\S]*text-decoration:/);
	});
});
