'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

function read(filePath) {
	return fs.readFileSync(filePath, 'utf8');
}

describe('Homepage Inline Icons', () => {
	it('server homepage payload includes inlineIcons', () => {
		const server = read(SERVER_FILE);
		assert.match(server, /const inlineIcons = await buildHomepageInlineIcons\(visibleWidgets\);/);
		assert.match(server, /widgets:\s*visibleWidgets,\s*\n\s*inlineIcons,/);
	});

	it('server limits number of inlined home icons', () => {
		const server = read(SERVER_FILE);
		assert.match(server, /const HOMEPAGE_INLINE_ICON_LIMIT = 80;/);
		assert.match(server, /if \(icons\.length >= HOMEPAGE_INLINE_ICON_LIMIT\) break;/);
	});

	it('client prefers inline icon candidate before unified URL', () => {
		const app = read(APP_FILE);
		const start = app.indexOf('function iconCandidates(icon, itemState) {');
		assert.ok(start >= 0, 'iconCandidates function should exist');
		const end = app.indexOf('function loadBestIcon', start);
		assert.ok(end > start, 'loadBestIcon should exist after iconCandidates');
		const block = app.slice(start, end);
		const inlinePos = block.indexOf('const inline = getHomeInlineIcon(icon);');
		const unifiedPos = block.indexOf('cands.push(`icon/${ICON_VERSION}/');
		assert.ok(inlinePos >= 0, 'inline icon lookup should exist in iconCandidates');
		assert.ok(unifiedPos >= 0, 'unified icon URL candidate should exist in iconCandidates');
		assert.ok(inlinePos < unifiedPos, 'inline icon should be preferred before unified URL');
	});

	it('client persists and restores inline icon map in home snapshot', () => {
		const app = read(APP_FILE);
		assert.match(app, /inlineIcons:\s*Object\.fromEntries\(homeInlineIcons\),/);
		assert.match(app, /replaceHomeInlineIcons\(snapshot\.inlineIcons && typeof snapshot\.inlineIcons === 'object' \? snapshot\.inlineIcons : \{\}\);/);
	});

	it('client loads inline icons from embedded homepage bootstrap payload', () => {
		const app = read(APP_FILE);
		assert.match(app, /replaceHomeInlineIcons\(embeddedHome\.inlineIcons\);/);
	});
});
