'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Chart Error Theme', () => {
	it('uses chart light and dark backgrounds for chart endpoint error pages', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const isChartRequest = req\?\.path === '\/chart';/);
		assert.match(server, /bg = dark \? '#080b28' : '#f1f2f9';/);
		assert.match(server, /fg = dark \? '#fafafa' : '#0f172a';/);
	});

	it('keeps the existing generic styled-error colors for non-chart requests', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /bg = dark \? '#1e1e1e' : '#f5f6fa';/);
		assert.match(server, /fg = dark \? 'rgba\(234,235,238,0\.98\)' : 'rgba\(19,21,54,0\.98\)';/);
	});
});
