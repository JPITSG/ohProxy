'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function read(relPath) {
	return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

describe('Config modal save dirty state', () => {
	it('keeps item settings Save disabled until modal values change', () => {
		const app = read('public/app.js');
		assert.match(app, /class="card-config-save" disabled>\$\{cc\.saveBtn\}<\/button>/, 'item settings Save should render disabled by default');
		assert.match(app, /function isCardConfigDirty\(\) \{[\s\S]*JSON\.stringify\(current\) !== cardConfigInitialStateJson;/, 'item settings should compare current values to the initial snapshot');
		assert.match(app, /function updateCardConfigSaveState\(\) \{[\s\S]*saveBtn\.disabled = !isCardConfigDirty\(\);/, 'item settings should enable Save only when dirty');
		assert.match(app, /cardConfigInitialStateJson = initialCardConfig \? JSON\.stringify\(initialCardConfig\) : null;\s*updateCardConfigSaveState\(\);/, 'item settings should keep Save disabled after capturing the open-state snapshot');
		assert.match(app, /querySelector\('\.card-config-body'\)\.addEventListener\('input', updateCardConfigSaveState\);/, 'item settings should react to text input changes');
		assert.match(app, /querySelector\('\.card-config-body'\)\.addEventListener\('change',/, 'item settings should react to non-radio change events');
		assert.match(app, /row\.remove\(\);\s*updateCardConfigSaveState\(\);/, 'item settings should react to deleted glow rules');
	});

	it('keeps System Settings Save disabled until modal values change', () => {
		const app = read('public/app.js');
		assert.match(app, /class="admin-config-save" disabled>\$\{ohLang\.adminConfig\.saveBtn\}<\/button>/, 'system settings Save should render disabled by default');
		assert.match(app, /function isAdminConfigDirty\(\) \{[\s\S]*JSON\.stringify\(collectAdminConfigValues\(\)\) !== adminConfigInitialStateJson;/, 'system settings should compare current values to the initial snapshot');
		assert.match(app, /function updateAdminConfigSaveState\(\) \{[\s\S]*saveBtn\.disabled = !isAdminConfigDirty\(\);/, 'system settings should enable Save only when dirty');
		assert.match(app, /adminConfigInitialStateJson = JSON\.stringify\(collectAdminConfigValues\(\)\);\s*updateAdminConfigSaveState\(\);/, 'system settings should keep Save disabled after capturing the open-state snapshot');
		assert.match(app, /querySelector\('\.admin-config-sections'\)\.addEventListener\('input', updateAdminConfigSaveState\);/, 'system settings should react to input changes');
		assert.match(app, /querySelector\('\.admin-config-sections'\)\.addEventListener\('change', updateAdminConfigSaveState\);/, 'system settings should react to toggle and dropdown changes');
		assert.match(app, /wrap\.insertBefore\(newRow, addBtn\);[\s\S]*updateAdminConfigSaveState\(\);/, 'system settings should react to added list rows');
	});

	it('emits change events from custom selects used by both modals', () => {
		const app = read('public/app.js');
		assert.match(app, /const changed = wrap\.dataset\.value !== val;[\s\S]*if \(changed\) wrap\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\);/, 'custom select option clicks should bubble change events');
		assert.match(app, /nativeSelect\.onchange = \(\) => \{[\s\S]*if \(changed\) wrap\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\);/, 'native select overlays should bubble change events');
	});
});
