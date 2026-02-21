'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');

describe('Switch Mapping Icon Style', () => {
	it('enforces 36px switch button height when icon mapping is active', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(css, /\.switch-card \.inline-controls \.switch-btn\.mapping-icon-ready \{[\s\S]*?height: 36px;/);
		assert.match(css, /\.switch-card \.inline-controls \.switch-btn\.mapping-icon-ready \{[\s\S]*?min-height: 36px;/);
	});

	it('scales switch mapping icons to 1.25x while icon-mapping is active', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(css, /\.switch-card \.inline-controls \.switch-btn\.mapping-icon-ready \.mapping-icon \{[\s\S]*?width: 1\.1875rem;/);
		assert.match(css, /\.switch-card \.inline-controls \.switch-btn\.mapping-icon-ready \.mapping-icon \{[\s\S]*?height: 1\.1875rem;/);
		assert.match(css, /\.switch-card \.inline-controls \.switch-btn\.mapping-icon-ready \.mapping-icon \{[\s\S]*?flex: 0 0 1\.1875rem;/);
	});

	it('keeps slider toggle height unchanged at 28px', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(css, /\.switch-card \.inline-controls \.switch-btn\.switch-toggle \{[\s\S]*?height: 28px;/);
	});
});
