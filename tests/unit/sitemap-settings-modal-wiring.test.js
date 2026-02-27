'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const LANG_FILE = path.join(PROJECT_ROOT, 'public', 'lang.js');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');

describe('Sitemap Settings Modal Wiring', () => {
	it('defines sitemap settings localization keys', () => {
		const lang = fs.readFileSync(LANG_FILE, 'utf8');
		assert.match(lang, /sitemapSettings:\s*\{/);
		assert.match(lang, /title:\s*'Sitemap Settings'/);
		assert.match(lang, /titleTemplate:\s*'Sitemap \{TITLE\} \(\{NAME\}\) Settings'/);
		assert.match(lang, /visibilityHeader:\s*'Visibility'/);
		assert.match(lang, /visAll:\s*'All'/);
		assert.match(lang, /visNormal:\s*'Normal'/);
		assert.match(lang, /visAdmin:\s*'Admin'/);
	});

	it('creates sitemap settings modal and persists visibility through sitemap-config API', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function ensureSitemapSettingsModal\(\) \{/);
		assert.match(app, /function sitemapSettingsModalTitle\(option\) \{/);
		assert.match(app, /template\.includes\('\{TITLE\}'\) && template\.includes\('\{NAME\}'\)/);
		assert.match(app, /return `Sitemap \$\{title\} \(\$\{name\}\) Settings`;/);
		assert.match(app, /titleEl\.textContent = sitemapSettingsModalTitle\(option\);/);
		assert.match(app, /input type="radio" name="sitemapVisibility" value="all" checked/);
		assert.match(app, /input type="radio" name="sitemapVisibility" value="normal"/);
		assert.match(app, /input type="radio" name="sitemapVisibility" value="admin"/);
		assert.match(app, /fetch\('\/api\/sitemap-config\/' \+ encodeURIComponent\(sitemapName\)\)/);
		assert.match(app, /fetch\('\/api\/sitemap-config', \{/);
		assert.doesNotMatch(app, /class="sitemap-settings-target"/);
	});

	it('gates settings modal entry points to admins and opens from ctrl\/meta-click or context menu', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /async function openSitemapSettingsModal\(option\) \{\s*if \(!isAdminUser\(\)\) return;/s);
		assert.match(app, /button\.addEventListener\('click', \(e\) => \{\s*if \(isAdminUser\(\) && \(e\.ctrlKey \|\| e\.metaKey\)\)/s);
		assert.match(app, /button\.addEventListener\('contextmenu', \(e\) => \{\s*if \(!isAdminUser\(\)\) return;/s);
	});

	it('keeps selector launch disabled when only one visible sitemap remains', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function isSitemapSelectionEnabled\(\) \{\s*return isAuthenticatedSession\(\) && Array\.isArray\(state\.sitemapOptions\) && state\.sitemapOptions\.length > 1;\s*\}/s);
	});

	it('includes sitemap settings modal body lock styling', () => {
		const styles = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(styles, /\.sitemap-settings-modal \.oh-modal-frame \{ max-width: 520px; \}/);
		assert.match(styles, /body\.sitemap-settings-open/);
	});
});
