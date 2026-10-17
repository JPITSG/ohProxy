'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CSS_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');
const INDEX_FILE = path.join(PROJECT_ROOT, 'public', 'index.html');

function ruleBodies(css, selectorPattern) {
	const re = new RegExp(`(^|\\n)\\s*${selectorPattern}\\s*\\{([^}]*)\\}`, 'g');
	const bodies = [];
	let m;
	while ((m = re.exec(css)) !== null) bodies.push(m[2]);
	return bodies;
}

describe('Grid card backdrop blur (scroll compositing cost)', () => {
	const css = fs.readFileSync(CSS_FILE, 'utf8');

	it('turns off backdrop-filter for grid cards', () => {
		const bodies = ruleBodies(css, '#grid \\.glass');
		assert.ok(bodies.some((b) => /(^|\s)backdrop-filter:\s*none;/.test(b) && /-webkit-backdrop-filter:\s*none;/.test(b)),
			'#grid .glass must set backdrop-filter and -webkit-backdrop-filter to none');
	});

	it('never re-enables a backdrop blur on grid cards', () => {
		const re = /([^{}]*#grid[^{}]*\.glass[^{}]*)\{([^}]*)\}/g;
		let m;
		while ((m = re.exec(css)) !== null) {
			const decl = m[2].match(/(?:^|[;\s])backdrop-filter:\s*([^;]+);/);
			if (decl) assert.strictEqual(decl[1].replace(/\s*!important/, '').trim(), 'none', `rule "${m[1].trim()}" sets backdrop-filter`);
		}
	});

	it('keeps the frosted header and the base glass blur for header controls', () => {
		const header = ruleBodies(css, 'header');
		assert.ok(header.some((b) => /backdrop-filter:\s*var\(--header-blur\)/.test(b)));
		const glass = ruleBodies(css, '\\.glass');
		assert.ok(glass.some((b) => /backdrop-filter:\s*var\(--glass-blur\)/.test(b)));
		const html = fs.readFileSync(INDEX_FILE, 'utf8');
		assert.match(html, /id="homeBtn"[^>]*class="[^"]*\bglass\b/);
	});

	it('keeps the page background layers that the blur used to sample opaque', () => {
		// The no-op argument depends on cards only ever covering the fixed background:
		// the gradient overlay above the dot grid must stay in place.
		const html = fs.readFileSync(INDEX_FILE, 'utf8');
		assert.match(html, /<div class="fixed inset-0 bg-grid opacity-60"><\/div>\s*<div class="fixed inset-0 bg-gradient-to-b[^"]*theme-overlay"><\/div>/);
	});
});
