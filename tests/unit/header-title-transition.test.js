'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');

describe('Header title transition wiring', () => {
	it('runs the page-title fade on the same navigation lifecycle as the grid', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const PAGE_TITLE_SEPARATOR = ' · ';/);
		assert.match(app, /function beginPageFadeOut\(\) \{[\s\S]*?beginPageTitleFadeOut\(token\);[\s\S]*?els\.grid\.classList\.add\('page-fade-out'\);[\s\S]*?\}/);
		assert.match(app, /function runPageFadeIn\(token\) \{[\s\S]*?runPageTitleFadeIn\(token\);[\s\S]*?els\.grid\.classList\.add\('page-fade-in'\);[\s\S]*?\}/);
		assert.match(app, /pageSpan\.style\.transition = `opacity \$\{PAGE_FADE_OUT_MS\}ms ease`;/);
		assert.match(app, /pageSpan\.classList\.add\('page-title-fade-out'\);/);
		assert.match(app, /pageSpan\.classList\.add\('page-title-fade-pending'\);/);
		assert.match(app, /pageSpan\.style\.transition = `opacity \$\{PAGE_FADE_IN_MS\}ms ease`;/);
		assert.match(app, /render\(\{ animatePageLabel: !!fade, fadeToken: fade\?\.token \}\);/);
	});

	it('keeps the sitemap title fixed while the page label owns truncation and fade states', () => {
		const styles = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(styles, /#pageTitle \.page-title-site,\s*#pageTitle \.page-title-separator \{\s*flex: 0 0 auto;/);
		assert.match(styles, /#pageTitle \.page-title-label \{[\s\S]*?flex: 1 1 auto;[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;[\s\S]*?opacity: 1;/);
		assert.match(styles, /#pageTitle \.page-title-label\.page-title-fade-pending,\s*#pageTitle \.page-title-label\.page-title-fade-out \{\s*opacity: 0;/);
		assert.match(styles, /#pageTitle \.page-title-label\.page-title-fade-in \{\s*opacity: 1;/);
	});
});
