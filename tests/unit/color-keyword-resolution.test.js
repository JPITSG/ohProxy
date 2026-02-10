'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Replicated from app.js for unit testing.
function safeText(value) {
	if (value === null || value === undefined) return '';
	return String(value);
}

function hexToRgb(hex) {
	const raw = hex.replace('#', '').trim();
	if (![3, 6, 8].includes(raw.length)) return null;
	const clean = raw.length === 3
		? raw.split('').map((c) => c + c).join('')
		: raw.slice(0, 6);
	const num = parseInt(clean, 16);
	if (Number.isNaN(num)) return null;
	return {
		r: (num >> 16) & 255,
		g: (num >> 8) & 255,
		b: num & 255,
	};
}

function parseRgbString(value) {
	const match = safeText(value).match(/rgba?\s*\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s]+([\d.]+))?/i);
	if (!match) return null;
	const r = Number(match[1]);
	const g = Number(match[2]);
	const b = Number(match[3]);
	const a = match[4] === undefined ? null : Number(match[4]);
	if (![r, g, b].every((n) => Number.isFinite(n))) return null;
	if (a !== null && (!Number.isFinite(a) || a <= 0)) return null;
	return { r, g, b };
}

const namedColors = new Map([
	['green', { r: 0, g: 128, b: 0 }],
	['blue', { r: 0, g: 0, b: 255 }],
	['red', { r: 255, g: 0, b: 0 }],
]);

function resolveNamedColor(color) {
	const key = safeText(color).trim().toLowerCase();
	return namedColors.get(key) || null;
}

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

function parseHsbTriplet(value) {
	const raw = safeText(value).trim();
	if (!raw) return null;
	const parts = raw.split(',');
	if (parts.length < 3) return null;
	const h = Number(parts[0]);
	const s = Number(parts[1]);
	const b = Number(parts[2]);
	if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(b)) return null;
	return {
		h: Math.max(0, Math.min(360, h)),
		s: Math.max(0, Math.min(100, s)),
		b: Math.max(0, Math.min(100, b)),
	};
}

function createColorResolver(cssVars) {
	const colorResolveCache = new Map();

	function resolveLiteralColorToRgb(color) {
		const c = safeText(color).trim();
		if (!c) return null;
		if (c.startsWith('#')) return hexToRgb(c);
		if (c.startsWith('rgb')) return parseRgbString(c);
		return resolveNamedColor(c);
	}

	function resolveCssVarColor(varName) {
		const raw = safeText(cssVars[varName] || '');
		return resolveLiteralColorToRgb(raw);
	}

	function resolveItemValueColor(itemState) {
		const raw = safeText(itemState).trim();
		if (!raw || raw === 'NULL' || raw === 'UNDEF') return null;
		const hsb = parseHsbTriplet(raw);
		if (hsb) return hsbToRgb(hsb.h, hsb.s, hsb.b);
		return resolveLiteralColorToRgb(raw);
	}

	function resolveOpenHabColorKeyword(color, ctx = {}) {
		const key = safeText(color).trim().toLowerCase();
		if (!key) return null;
		if (key === 'primary') return resolveCssVarColor('--color-primary');
		if (key === 'secondary') return resolveCssVarColor('--color-primary-light');
		if (key === 'itemvalue') return resolveItemValueColor(ctx.itemState);
		return null;
	}

	function colorResolveCacheKey(color, ctx = {}) {
		const key = safeText(color).trim().toLowerCase();
		if (!key) return '';
		if (key === 'itemvalue') return `${key}|${safeText(ctx.itemState).trim()}`;
		if (key === 'primary' || key === 'secondary') {
			return `${key}|${safeText(ctx.themeMode).trim().toLowerCase()}`;
		}
		return key;
	}

	return function resolveColorToRgb(color, ctx = {}) {
		const c = safeText(color).trim();
		if (!c) return null;
		const cacheKey = colorResolveCacheKey(c, ctx);
		if (cacheKey && colorResolveCache.has(cacheKey)) return colorResolveCache.get(cacheKey);
		let rgb = resolveOpenHabColorKeyword(c, ctx);
		if (!rgb) rgb = resolveLiteralColorToRgb(c);
		if (cacheKey) colorResolveCache.set(cacheKey, rgb);
		return rgb;
	};
}

describe('openHAB color keyword resolution', () => {
	const resolveColorToRgb = createColorResolver({
		'--color-primary': 'rgb(106, 116, 211)',
		'--color-primary-light': 'rgb(167, 182, 199)',
	});

	it('resolves primary to theme primary color', () => {
		const result = resolveColorToRgb('primary', { themeMode: 'dark' });
		assert.deepStrictEqual(result, { r: 106, g: 116, b: 211 });
	});

	it('resolves secondary to primary-light theme color', () => {
		const result = resolveColorToRgb('secondary', { themeMode: 'light' });
		assert.deepStrictEqual(result, { r: 167, g: 182, b: 199 });
	});

	it('resolves itemValue from HSB item state', () => {
		const result = resolveColorToRgb('itemValue', { itemState: '120,100,100' });
		assert.deepStrictEqual(result, { r: 0, g: 255, b: 0 });
	});

	it('resolves itemValue from literal state values', () => {
		assert.deepStrictEqual(resolveColorToRgb('itemValue', { itemState: '#00aaff' }), { r: 0, g: 170, b: 255 });
		assert.deepStrictEqual(resolveColorToRgb('itemValue', { itemState: 'rgb(10, 20, 30)' }), { r: 10, g: 20, b: 30 });
		assert.deepStrictEqual(resolveColorToRgb('itemValue', { itemState: 'green' }), { r: 0, g: 128, b: 0 });
	});

	it('leaves itemValue unresolved for invalid or undefined states', () => {
		assert.strictEqual(resolveColorToRgb('itemValue', { itemState: '' }), null);
		assert.strictEqual(resolveColorToRgb('itemValue', { itemState: 'NULL' }), null);
		assert.strictEqual(resolveColorToRgb('itemValue', { itemState: 'UNDEF' }), null);
		assert.strictEqual(resolveColorToRgb('itemValue', { itemState: 'not-a-color' }), null);
	});

	it('keeps existing literal color behavior', () => {
		assert.deepStrictEqual(resolveColorToRgb('#334455'), { r: 51, g: 68, b: 85 });
		assert.deepStrictEqual(resolveColorToRgb('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3 });
	});

	it('keeps itemValue cache isolated by item state', () => {
		const green = resolveColorToRgb('itemValue', { itemState: '120,100,100' });
		const red = resolveColorToRgb('itemValue', { itemState: '0,100,100' });
		const greenAgain = resolveColorToRgb('itemValue', { itemState: '120,100,100' });
		assert.deepStrictEqual(green, { r: 0, g: 255, b: 0 });
		assert.deepStrictEqual(red, { r: 255, g: 0, b: 0 });
		assert.deepStrictEqual(greenAgain, { r: 0, g: 255, b: 0 });
	});
});
