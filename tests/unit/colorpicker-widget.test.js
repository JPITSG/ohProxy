'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Replicated from app.js for unit testing

function hsbToRgb(h, s, b) {
	const hh = ((h % 360) + 360) % 360;
	const ss = Math.max(0, Math.min(100, s)) / 100;
	const bb = Math.max(0, Math.min(100, b)) / 100;
	const c = bb * ss;
	const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
	const m = bb - c;
	let r1 = 0, g1 = 0, b1 = 0;
	if (hh < 60) { r1 = c; g1 = x; }
	else if (hh < 120) { r1 = x; g1 = c; }
	else if (hh < 180) { g1 = c; b1 = x; }
	else if (hh < 240) { g1 = x; b1 = c; }
	else if (hh < 300) { r1 = x; b1 = c; }
	else { r1 = c; b1 = x; }
	return {
		r: Math.round((r1 + m) * 255),
		g: Math.round((g1 + m) * 255),
		b: Math.round((b1 + m) * 255),
	};
}

function parseHsbState(stateStr) {
	const fallback = { h: 0, s: 0, b: 0 };
	if (!stateStr || stateStr === 'NULL' || stateStr === 'UNDEF') return fallback;
	const parts = String(stateStr).split(',');
	if (parts.length < 3) return fallback;
	const h = Number(parts[0]);
	const s = Number(parts[1]);
	const b = Number(parts[2]);
	if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(b)) return fallback;
	return {
		h: Math.max(0, Math.min(360, h)),
		s: Math.max(0, Math.min(100, s)),
		b: Math.max(0, Math.min(100, b)),
	};
}

describe('Colorpicker Widget', () => {
	describe('parseHsbState', () => {
		it('parses valid HSB string "120,100,50"', () => {
			const result = parseHsbState('120,100,50');
			assert.deepStrictEqual(result, { h: 120, s: 100, b: 50 });
		});

		it('returns fallback for empty string', () => {
			const result = parseHsbState('');
			assert.deepStrictEqual(result, { h: 0, s: 0, b: 0 });
		});

		it('returns fallback for null', () => {
			const result = parseHsbState(null);
			assert.deepStrictEqual(result, { h: 0, s: 0, b: 0 });
		});

		it('returns fallback for undefined', () => {
			const result = parseHsbState(undefined);
			assert.deepStrictEqual(result, { h: 0, s: 0, b: 0 });
		});

		it('returns fallback for "NULL"', () => {
			const result = parseHsbState('NULL');
			assert.deepStrictEqual(result, { h: 0, s: 0, b: 0 });
		});

		it('returns fallback for "UNDEF"', () => {
			const result = parseHsbState('UNDEF');
			assert.deepStrictEqual(result, { h: 0, s: 0, b: 0 });
		});

		it('clamps out-of-range hue to 360', () => {
			const result = parseHsbState('400,50,50');
			assert.strictEqual(result.h, 360);
			assert.strictEqual(result.s, 50);
			assert.strictEqual(result.b, 50);
		});

		it('clamps negative saturation to 0', () => {
			const result = parseHsbState('180,-10,50');
			assert.strictEqual(result.s, 0);
		});

		it('clamps brightness above 100 to 100', () => {
			const result = parseHsbState('0,0,150');
			assert.strictEqual(result.b, 100);
		});

		it('returns fallback for incomplete string', () => {
			const result = parseHsbState('120,50');
			assert.deepStrictEqual(result, { h: 0, s: 0, b: 0 });
		});

		it('parses decimal values', () => {
			const result = parseHsbState('120.5,50.3,75.8');
			assert.strictEqual(result.h, 120.5);
			assert.strictEqual(result.s, 50.3);
			assert.strictEqual(result.b, 75.8);
		});
	});

	describe('hsbToRgb', () => {
		it('converts red (0,100,100) to (255,0,0)', () => {
			const result = hsbToRgb(0, 100, 100);
			assert.strictEqual(result.r, 255);
			assert.strictEqual(result.g, 0);
			assert.strictEqual(result.b, 0);
		});

		it('converts green (120,100,100) to (0,255,0)', () => {
			const result = hsbToRgb(120, 100, 100);
			assert.strictEqual(result.r, 0);
			assert.strictEqual(result.g, 255);
			assert.strictEqual(result.b, 0);
		});

		it('converts blue (240,100,100) to (0,0,255)', () => {
			const result = hsbToRgb(240, 100, 100);
			assert.strictEqual(result.r, 0);
			assert.strictEqual(result.g, 0);
			assert.strictEqual(result.b, 255);
		});

		it('converts black (any,any,0) to (0,0,0)', () => {
			const result = hsbToRgb(180, 50, 0);
			assert.strictEqual(result.r, 0);
			assert.strictEqual(result.g, 0);
			assert.strictEqual(result.b, 0);
		});

		it('converts white (0,0,100) to (255,255,255)', () => {
			const result = hsbToRgb(0, 0, 100);
			assert.strictEqual(result.r, 255);
			assert.strictEqual(result.g, 255);
			assert.strictEqual(result.b, 255);
		});

		it('converts yellow (60,100,100) to (255,255,0)', () => {
			const result = hsbToRgb(60, 100, 100);
			assert.strictEqual(result.r, 255);
			assert.strictEqual(result.g, 255);
			assert.strictEqual(result.b, 0);
		});

		it('converts cyan (180,100,100) to (0,255,255)', () => {
			const result = hsbToRgb(180, 100, 100);
			assert.strictEqual(result.r, 0);
			assert.strictEqual(result.g, 255);
			assert.strictEqual(result.b, 255);
		});

		it('converts magenta (300,100,100) to (255,0,255)', () => {
			const result = hsbToRgb(300, 100, 100);
			assert.strictEqual(result.r, 255);
			assert.strictEqual(result.g, 0);
			assert.strictEqual(result.b, 255);
		});

		it('handles 50% brightness correctly', () => {
			const result = hsbToRgb(0, 100, 50);
			assert.strictEqual(result.r, 128);
			assert.strictEqual(result.g, 0);
			assert.strictEqual(result.b, 0);
		});
	});
});
