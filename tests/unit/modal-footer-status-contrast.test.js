'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');

describe('Modal Footer Pending Status Contrast', () => {
	it('defines a dedicated modal pending status color variable', () => {
		const styles = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(styles, /--color-modal-status-pending:\s*var\(--color-status-pending\);/);
		assert.match(styles, /--color-modal-status-pending-rgb:\s*255,\s*219,\s*117;/);
		assert.match(styles, /body\.theme-light[\s\S]*--color-modal-status-pending:\s*rgb\(201,\s*99,\s*0\);/);
		assert.match(styles, /body\.theme-light[\s\S]*--color-modal-status-pending-rgb:\s*201,\s*99,\s*0;/);
	});

	it('uses modal pending variable for sitemap and admin footer status text', () => {
		const styles = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(styles, /\.sitemap-select-status\.pending\s*\{\s*color:\s*var\(--color-modal-status-pending\);\s*\}/);
		assert.match(styles, /\.card-config-status\.warning,\s*\.admin-config-status\.warning\s*\{\s*color:\s*var\(--color-modal-status-pending\);\s*\}/);
		assert.match(styles, /\.admin-restart-badge\s*\{[\s\S]*color:\s*var\(--color-modal-status-pending\);[\s\S]*\}/);
		assert.match(styles, /\.admin-restart-badge\s*\{[\s\S]*background:\s*rgba\(var\(--color-modal-status-pending-rgb\),\s*0\.15\);[\s\S]*\}/);
		assert.match(styles, /\.admin-restart-badge\s*\{[\s\S]*border:\s*1px solid rgba\(var\(--color-modal-status-pending-rgb\),\s*0\.3\);[\s\S]*\}/);
	});
});
