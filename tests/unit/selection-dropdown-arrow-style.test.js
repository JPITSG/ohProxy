'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');

describe('Selection Dropdown Arrow Style', () => {
	it('adds right-aligned, vertically centered SVG indicator to selection triggers', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(css, /\.selection-card \.inline-controls \.fake-select::after \{/);
		assert.match(css, /\.selection-card \.inline-controls \.fake-select::after \{[\s\S]*?content: '';/);
		assert.match(css, /\.selection-card \.inline-controls \.fake-select::after \{[\s\S]*?width: 17\.5px;[\s\S]*?height: 17\.5px;/);
		assert.match(css, /\.selection-card \.inline-controls \.fake-select::after \{[\s\S]*?-webkit-mask-image: url\("data:image\/svg\+xml,/);
		assert.match(css, /\.selection-card \.inline-controls \.fake-select::after \{[\s\S]*?mask-image: url\("data:image\/svg\+xml,/);
		assert.match(css, /\.selection-card \.inline-controls \.fake-select::after \{[\s\S]*?right: 12px;/);
		assert.match(css, /\.selection-card \.inline-controls \.fake-select::after \{[\s\S]*?top: 50%;[\s\S]*?transform: translateY\(-50%\) rotate\(0deg\);/);
		assert.match(css, /\.selection-card \.inline-controls \.fake-select::after \{[\s\S]*?pointer-events: none;/);
		assert.match(css, /\.selection-card \.inline-controls \.fake-select::after \{[\s\S]*?transition: transform \.2s ease;/);
		assert.match(css, /\.selection-card\.menu-open \.inline-controls \.fake-select::after \{[\s\S]*?transform: translateY\(-50%\) rotate\(180deg\);/);
	});

	it('keeps selection trigger text centered in the middle', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(css, /\.selection-card \.inline-controls \.fake-select \{[\s\S]*?justify-content: center;/);
		assert.match(css, /\.selection-card \.inline-controls \.fake-select \{[\s\S]*?text-align: center;/);
	});
});
