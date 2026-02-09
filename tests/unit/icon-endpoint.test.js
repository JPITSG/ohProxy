'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

function read(filePath) {
	return fs.readFileSync(filePath, 'utf8');
}

// Replicate iconStateHash from server.js
function iconStateHash(state) {
	return crypto.createHash('sha256').update(state).digest('hex').slice(0, 12);
}

// Replicate normalizeIconName from server.js
function normalizeIconName(icon) {
	const raw = (icon === null || icon === undefined ? '' : String(icon)).replace(/\\/g, '/').trim();
	if (!raw) return '';
	const rel = raw.replace(/^\/+/, '');
	if (!rel) return '';
	const segments = rel.split('/');
	if (segments.some((seg) => seg === '.' || seg === '..' || seg === '')) return '';
	return segments.join('/');
}

describe('Unified Icon Endpoint', () => {
	describe('iconStateHash', () => {
		it('produces deterministic 12-char hex string', () => {
			const h1 = iconStateHash('ON');
			const h2 = iconStateHash('ON');
			assert.strictEqual(h1, h2);
			assert.strictEqual(h1.length, 12);
			assert.ok(/^[0-9a-f]{12}$/.test(h1));
		});

		it('produces different hashes for different states', () => {
			const h1 = iconStateHash('ON');
			const h2 = iconStateHash('OFF');
			assert.notStrictEqual(h1, h2);
		});
	});

	describe('normalizeIconName', () => {
		it('rejects path traversal with ..', () => {
			assert.strictEqual(normalizeIconName('../etc/passwd'), '');
		});

		it('rejects . segments', () => {
			assert.strictEqual(normalizeIconName('./icon'), '');
		});

		it('rejects empty segments', () => {
			assert.strictEqual(normalizeIconName('a//b'), '');
		});

		it('normalizes backslashes to forward slashes', () => {
			assert.strictEqual(normalizeIconName('a\\b'), 'a/b');
		});

		it('strips leading slashes', () => {
			assert.strictEqual(normalizeIconName('/heating'), 'heating');
		});

		it('returns empty for empty input', () => {
			assert.strictEqual(normalizeIconName(''), '');
			assert.strictEqual(normalizeIconName(null), '');
			assert.strictEqual(normalizeIconName(undefined), '');
		});

		it('preserves valid icon names', () => {
			assert.strictEqual(normalizeIconName('temperature'), 'temperature');
			assert.strictEqual(normalizeIconName('room/light'), 'room/light');
		});
	});

	describe('server route pattern', () => {
		it('server has unified /icon endpoint with regex', () => {
			const server = read(SERVER_FILE);
			assert.match(server, /app\.get\(\/\^\\\/icon\\\/\(v\\d\+\)\\\/\(\.\+\)\$\/i/);
		});

		it('server validates icon version against liveConfig', () => {
			const server = read(SERVER_FILE);
			assert.match(server, /version !== liveConfig\.iconVersion/);
		});

		it('server rejects path traversal in icon name', () => {
			const server = read(SERVER_FILE);
			assert.match(server, /seg === '\.\.' \|\| seg === ''/);
		});

		it('server validates format parameter', () => {
			const server = read(SERVER_FILE);
			assert.match(server, /rawFormat === 'svg' \? 'svg' : 'png'/);
		});

		it('server checks state for control characters', () => {
			const server = read(SERVER_FILE);
			assert.match(server, /ANY_CONTROL_CHARS_RE\.test\(stateStr\)/);
		});

		it('server sets immutable cache headers on response', () => {
			const server = read(SERVER_FILE);
			assert.match(server, /public, max-age=31536000, immutable/);
		});

		it('server returns 404 when icon not found', () => {
			const server = read(SERVER_FILE);
			assert.match(server, /res\.status\(404\)\.type\('text\/plain'\)\.send\('Icon not found'\)/);
		});
	});

	describe('resolveIcon single-source resolution', () => {
		it('server has resolveIcon function', () => {
			const server = read(SERVER_FILE);
			assert.match(server, /async function resolveIcon\(name, state, format\)/);
		});

		it('dynamic requests fetch from /icon/ endpoint with state and format', () => {
			const server = read(SERVER_FILE);
			const fn = server.slice(server.indexOf('async function resolveIcon('));
			assert.ok(fn.includes('/icon/${name}?state=${encodeURIComponent(state)}&format=${fmt}'));
		});

		it('static requests fetch from /images/ with exact format extension', () => {
			const server = read(SERVER_FILE);
			const fn = server.slice(server.indexOf('async function resolveIcon('));
			assert.ok(fn.includes('/images/${name}.${fmt}'));
		});

		it('does not contain fallback cascade', () => {
			const server = read(SERVER_FILE);
			const fn = server.slice(server.indexOf('async function resolveIcon('));
			const fnEnd = fn.indexOf('\nconst app');
			const body = fn.slice(0, fnEnd > 0 ? fnEnd : fn.length);
			// Should have only one fetchOpenhabBinary call, no tryFetchIcon fallback chain
			assert.ok(!body.includes('tryFetchIcon'), 'resolveIcon should not use tryFetchIcon fallback');
		});

		it('does not contain format conversion functions', () => {
			const server = read(SERVER_FILE);
			assert.ok(!server.includes('function convertSvgToPng'));
			assert.ok(!server.includes('function convertPngToSvg'));
			assert.ok(!server.includes('function convertToFormat'));
			assert.ok(!server.includes('function detectSvg'));
		});

		it('resizes PNG responses via ImageMagick', () => {
			const server = read(SERVER_FILE);
			assert.match(server, /async function resizeToPng\(buffer\)/);
		});
	});

	describe('icon cache cleanup', () => {
		it('server registers icon-cache-cleanup background task', () => {
			const server = read(SERVER_FILE);
			assert.match(server, /registerBackgroundTask\('icon-cache-cleanup'/);
		});

		it('cleanup respects iconCacheTtlMs setting', () => {
			const server = read(SERVER_FILE);
			assert.match(server, /liveConfig\.iconCacheTtlMs/);
		});
	});
});
