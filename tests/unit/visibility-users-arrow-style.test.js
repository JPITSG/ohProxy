'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');

describe('Visibility Users Arrow Style', () => {
	it('uses history-style masked chevron indicators for less/more nav buttons', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(css, /\.visibility-users-less::after,\s*\.visibility-users-more::after \{/);
		assert.match(css, /\.visibility-users-less::after,\s*\.visibility-users-more::after \{[\s\S]*?width: 17\.5px;[\s\S]*?height: 17\.5px;/);
		assert.match(css, /\.visibility-users-less::after,\s*\.visibility-users-more::after \{[\s\S]*?-webkit-mask-image: url\("data:image\/svg\+xml,/);
		assert.match(css, /\.visibility-users-less::after,\s*\.visibility-users-more::after \{[\s\S]*?mask-image: url\("data:image\/svg\+xml,/);
	});

	it('keeps more arrow down and less arrow up with history-matching vertical offsets', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(css, /\.visibility-users-more::after \{[\s\S]*?top: 0;[\s\S]*?transform: rotate\(0deg\);/);
		assert.match(css, /\.visibility-users-less::after \{[\s\S]*?top: 1px;[\s\S]*?transform: rotate\(180deg\);/);
	});
});
