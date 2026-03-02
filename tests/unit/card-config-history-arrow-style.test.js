'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');

describe('Card Config History Arrow Style', () => {
	it('uses selection-style SVG chevron indicators on history nav buttons', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(css, /\.history-older, \.history-newer \{[\s\S]*?padding: 11px 12px;/);
		assert.match(css, /\.history-older::after,\s*\.history-newer::after \{/);
		assert.match(css, /\.history-older::after,\s*\.history-newer::after \{[\s\S]*?content: '';/);
		assert.match(css, /\.history-older::after,\s*\.history-newer::after \{[\s\S]*?width: 17\.5px;[\s\S]*?height: 17\.5px;/);
		assert.match(css, /\.history-older::after,\s*\.history-newer::after \{[\s\S]*?-webkit-mask-image: url\("data:image\/svg\+xml,/);
		assert.match(css, /\.history-older::after,\s*\.history-newer::after \{[\s\S]*?mask-image: url\("data:image\/svg\+xml,/);
		assert.match(css, /\.history-older::after,\s*\.history-newer::after \{[\s\S]*?display: inline-block;/);
		assert.match(css, /\.history-older::after,\s*\.history-newer::after \{[\s\S]*?margin-left: 4px;/);
		assert.match(css, /\.history-older::after,\s*\.history-newer::after \{[\s\S]*?position: relative;[\s\S]*?top: -1px;[\s\S]*?transform: rotate\(0deg\);/);
		assert.match(css, /\.history-older::after,\s*\.history-newer::after \{[\s\S]*?pointer-events: none;/);
	});

	it('keeps older arrow slightly lower and flips newer arrow upward', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(css, /\.history-older::after \{[\s\S]*?top: 0;/);
		assert.match(css, /\.history-older::after \{[\s\S]*?transform: rotate\(0deg\);/);
		assert.match(css, /\.history-newer::after \{[\s\S]*?top: 1px;/);
		assert.match(css, /\.history-newer::after \{[\s\S]*?transform: rotate\(180deg\);/);
	});
});
