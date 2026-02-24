'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function read(relPath) {
	return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
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
		const styles = read('public/styles.css');
		assert.match(styles, /\.admin-config-footer \{[\s\S]*border-top: 1px solid var\(--glass-border-color\);/, 'footer should keep its top divider');
		assert.match(styles, /\.admin-config-sections > \.admin-config-section:last-of-type:not\(\.collapsed\) \.admin-config-section-body \{\s*border-bottom: none;/, 'last expanded section should drop its bottom border to prevent a double divider');
	});
});
