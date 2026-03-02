'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Presence Nearby Days Arrow Style', () => {
	it('uses history-style masked chevrons on nearby-days nav buttons', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /\.ctx-older,\.ctx-newer\{[\s\S]*?display:inline-flex;[\s\S]*?align-items:center;[\s\S]*?justify-content:center;[\s\S]*?text-align:center;/);
		assert.match(server, /\.ctx-older::after,\.ctx-newer::after\{[\s\S]*?content:'';[\s\S]*?width:17\.5px;[\s\S]*?height:17\.5px;/);
		assert.match(server, /\.ctx-older::after,\.ctx-newer::after\{[\s\S]*?-webkit-mask-image:url\("data:image\/svg\+xml,/);
		assert.match(server, /\.ctx-older::after,\.ctx-newer::after\{[\s\S]*?mask-image:url\("data:image\/svg\+xml,/);
		assert.match(server, /\.ctx-older::after\{[\s\S]*?top:0;[\s\S]*?transform:rotate\(0deg\);?\}/);
		assert.match(server, /\.ctx-newer::after\{[\s\S]*?top:1px;[\s\S]*?transform:rotate\(180deg\);?\}/);
	});

	it('renders nearby-days nav labels without unicode triangle glyphs', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /if\(hasNewer\)html\+='<button class="ctx-newer" type="button">Newer<\/button>';/);
		assert.match(server, /if\(data\.hasMore\)html\+='<button class="ctx-older" type="button">Older<\/button>';/);
		assert.doesNotMatch(server, /Newer \\\\u25B4/);
		assert.doesNotMatch(server, /Older \\\\u25BE/);
	});
});
