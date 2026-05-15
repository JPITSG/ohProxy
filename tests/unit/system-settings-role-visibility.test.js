'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function read(relPath) {
	return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

function loadSearchHelpers() {
	const app = read('public/app.js');
	const start = app.indexOf('function normalizeAdminConfigSearchText(value)');
	const end = app.indexOf('function getAdminConfigGroupLabel(group)');
	assert.ok(start !== -1 && end !== -1 && end > start, 'missing settings search helper block');
	const context = { safeText: value => (value === undefined || value === null ? '' : String(value)) };
	vm.createContext(context);
	vm.runInContext(app.slice(start, end), context);
	return context;
}

describe('System settings modal role visibility wiring', () => {
	it('uses neutral settings tooltip and aria label for the gear button', () => {
		const html = read('public/index.html');
		assert.match(html, /<button id="adminConfigBtn"[\s\S]*title="Settings"/, 'settings button should use neutral Settings title');
		assert.match(html, /<button id="adminConfigBtn"[\s\S]*aria-label="Settings"/, 'settings button should expose neutral Settings aria-label');
	});

	it('shows the settings gear for all authenticated roles', () => {
		const app = read('public/app.js');
		assert.match(app, /function updateAdminConfigBtnVisibility\(\)[\s\S]*const userRole = getUserRole\(\);[\s\S]*if \(userRole\) \{[\s\S]*btn\.classList\.remove\('hidden'\);/, 'settings button should be visible when user role exists');
		assert.doesNotMatch(app, /if \(getUserRole\(\) === 'admin'\)/, 'settings button should not be admin-only');
	});

	it('uses role-aware modal titles for admin and non-admin users', () => {
		const app = read('public/app.js');
		const lang = read('public/lang.js');
		assert.match(lang, /adminConfig:\s*\{[\s\S]*title:\s*'System Settings'/, 'missing system settings title');
		assert.match(lang, /adminConfig:\s*\{[\s\S]*userTitle:\s*'User Settings'/, 'missing user settings title');
		assert.match(app, /function getAdminConfigModalTitleForRole\(role\)/, 'missing role-aware modal title helper');
		assert.match(app, /if \(role === 'admin'\) return ohLang\.adminConfig\.title \|\| 'System Settings';/, 'admin should see System Settings title');
		assert.match(app, /return ohLang\.adminConfig\.userTitle \|\| 'User Settings';/, 'non-admin should see User Settings title');
		assert.match(app, /if \(titleEl\) titleEl\.textContent = getAdminConfigModalTitleForRole\(getUserRole\(\)\);/, 'modal open should refresh title from current role');
	});

	it('renders and collects user-only sections for non-admin roles', () => {
		const app = read('public/app.js');
		assert.match(app, /function getAdminConfigSchemaForRole\(role\)/, 'missing role-based settings schema helper');
		assert.match(app, /if \(role === 'admin'\) return ADMIN_CONFIG_SCHEMA;/, 'admin role should keep full schema');
		assert.match(app, /return ADMIN_CONFIG_SCHEMA\.filter\(section => section\.group === 'user'\);/, 'non-admin roles should only receive user group schema');
		assert.match(app, /const sectionGroups = Array\.from\(new Set\(schema\.map\(section => section\.group\)\.filter\(Boolean\)\)\);/, 'group list should be derived from rendered schema');
		assert.match(app, /const showGroupHeaders = sectionGroups\.length > 1;/, 'group headers should be shown only when multiple groups exist');
		assert.match(app, /if \(showGroupHeaders && section\.group && section\.group !== currentGroup\)/, 'single-group views should not render redundant group headers');
		assert.match(app, /const schema = getAdminConfigSchemaForRole\(getUserRole\(\)\);[\s\S]*for \(const section of schema\)/, 'settings modal should render from role-filtered schema');
		assert.match(app, /function collectAdminConfigValues\(\) \{[\s\S]*const schema = getAdminConfigSchemaForRole\(getUserRole\(\)\);/, 'settings payload should be collected from role-filtered schema');
	});

	it('uses a single divider above the footer for the last expanded settings section', () => {
		const app = read('public/app.js');
		const styles = read('public/styles.css');
		assert.match(styles, /\.admin-config-footer \{[\s\S]*border-top: 1px solid var\(--glass-border-color\);/, 'footer should keep its top divider');
		assert.match(app, /let lastVisibleSectionEl = null;[\s\S]*lastVisibleSectionEl = sectionEl;[\s\S]*if \(lastVisibleSectionEl\) lastVisibleSectionEl\.classList\.add\('last-visible-section'\);/, 'settings filter should mark the last visible section after search filtering');
		assert.match(app, /querySelectorAll\('\.admin-config-section\.last-visible-section'\)[\s\S]*classList\.remove\('last-visible-section'\);/, 'settings filter should clear the previous last visible marker before recalculating');
		assert.match(styles, /\.admin-config-section\.last-visible-section:not\(\.collapsed\) \.admin-config-section-body \{\s*border-bottom: none;/, 'last visible expanded section should drop its bottom border to prevent a double divider');
	});

	it('uses a single divider below the modal header for the first visible settings group', () => {
		const app = read('public/app.js');
		const styles = read('public/styles.css');
		assert.match(app, /let firstVisibleGroupHeaderEl = null;[\s\S]*firstVisibleGroupHeaderEl = groupHeader;[\s\S]*if \(firstVisibleGroupHeaderEl\) firstVisibleGroupHeaderEl\.classList\.add\('first-visible-group-header'\);/, 'settings filter should mark the first visible group header after search filtering');
		assert.match(app, /querySelectorAll\('\.admin-config-group-header\.first-visible-group-header'\)[\s\S]*classList\.remove\('first-visible-group-header'\);/, 'settings filter should clear the previous first visible group marker before recalculating');
		assert.match(styles, /\.admin-config-group-header\.first-visible-group-header \{\s*border-top: none;/, 'first visible group header should drop its top border to avoid a double modal header divider');
	});

	it('adds a compact client-side search box to the settings modal header', () => {
		const app = read('public/app.js');
		const styles = read('public/styles.css');
		const lang = read('public/lang.js');
		assert.match(app, /class="admin-config-header-actions"[\s\S]*class="admin-config-search-input"[\s\S]*class="admin-config-close oh-modal-close"/, 'search input should sit beside the close button in the header');
		assert.match(app, /function filterAdminConfigSections\(\)/, 'settings modal should filter sections client-side');
		assert.match(app, /function tokenizeAdminConfigSearchText\(value\)/, 'settings search should tokenize camelCase and dotted keys');
		assert.match(app, /adminConfigTokensContainPhrase\(haystackTokens, queryTokens, options\)/, 'multi-word settings searches should require ordered phrase matches');
		assert.match(app, /function adminConfigFieldSearchMatches\(fieldEl, query\)/, 'field search should distinguish display text from config key paths');
		assert.match(app, /allowLastTokenPrefix: true/, 'display-text searches should allow a partial final token');
		assert.doesNotMatch(app, /query\.split\(' '\)\.filter\(Boolean\)\.every\(part => haystack\.includes\(part\)\)/, 'multi-word settings searches should not match separated query terms anywhere');
		assert.match(app, /const visible = !hasQuery \|\| adminConfigFieldSearchMatches\(fieldEl, query\);/, 'field visibility should depend on field-level matches only');
		assert.match(app, /fieldEl\.hidden = !visible;/, 'nonmatching fields should be hidden inside matching sections');
		assert.match(app, /querySelectorAll\('\.admin-select-wrap\.menu-open'\)[\s\S]*_closeMenu/, 'search should close open settings dropdown menus before hiding rows');
		assert.match(app, /const visible = !hasQuery \|\| visibleGroups\.has\(groupHeader\.dataset\.group \|\| ''\);\s*groupHeader\.hidden = !visible;/, 'group headers should only remain when they contain matches');
		assert.match(lang, /searchPlaceholder:\s*'Search settings\\u2026'/, 'missing settings search placeholder text');
		assert.match(styles, /\.admin-config-search-input \{[\s\S]*height: 30px;[\s\S]*background: rgba\(30, 33, 54, 0\.7\);/, 'settings search should use compact main-header search styling');
		assert.match(styles, /\.admin-config-header h2 \{[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/, 'header title should shrink without increasing header height');
		assert.match(styles, /\.admin-config-field\[hidden\][\s\S]*display: none !important;/, 'hidden search result fields should override flex display');
	});

	it('matches partial final words in setting labels without matching key-path siblings', () => {
		const helpers = loadSearchHelpers();
		assert.equal(
			helpers.adminConfigSearchMatches('Provider API Key Provider API key', 'api k', { allowLastTokenPrefix: true }),
			true,
			'partial final token should match API Key display text'
		);
		assert.equal(
			helpers.adminConfigSearchMatches('server.apiKeys.aiModel', 'api k'),
			false,
			'partial final token should not match apiKeys path on unrelated sibling fields'
		);
		assert.equal(
			helpers.adminConfigSearchMatches('server.apiKeys.aiModel', 'api key'),
			false,
			'completed singular phrase should not match plural apiKeys path on unrelated sibling fields'
		);
	});
});
