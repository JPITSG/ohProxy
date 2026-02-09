'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

function createPath(pts, interpolation) {
	if (!pts || pts.length === 0) return '';
	if (pts.length === 1) return 'M ' + pts[0].x + ' ' + pts[0].y;
	const path = ['M ' + pts[0].x + ' ' + pts[0].y];
	for (let i = 1; i < pts.length; i++) {
		if (interpolation === 'step') {
			path.push('L ' + pts[i].x + ' ' + pts[i - 1].y);
			path.push('L ' + pts[i].x + ' ' + pts[i].y);
		} else {
			path.push('L ' + pts[i].x + ' ' + pts[i].y);
		}
	}
	return path.join(' ');
}

function scientificMantissa(absNum, mantDec) {
	if (absNum === 0) return '0';
	let exp = Math.floor(Math.log10(absNum));
	let mantissa = absNum / Math.pow(10, exp);
	if (Math.abs(mantissa - 1) < 1e-12) mantissa = 1;
	if (Math.abs(mantissa - 10) < 1e-12) {
		mantissa = 1;
		exp += 1;
	}
	let mantissaText = mantissa.toFixed(mantDec);
	const mantissaNum = parseFloat(mantissaText);
	if (Number.isFinite(mantissaNum) && mantissaNum >= 10) {
		exp += 1;
		mantissaText = (mantissaNum / 10).toFixed(mantDec);
	}
	return mantissaText + 'E' + exp;
}

function javaDecimalFormatGuard(number) {
	if (typeof number !== 'number' || !Number.isFinite(number)) return String(number);
	return number.toString();
}

describe('Chart Edge Cases', () => {
	it('returns a valid move path for single-point datasets', () => {
		const path = createPath([{ x: 42, y: 7 }], 'linear');
		assert.strictEqual(path, 'M 42 7');
	});

	it('keeps scientific mantissa normalized for powers of ten', () => {
		assert.strictEqual(scientificMantissa(1000, 1), '1.0E3');
		assert.strictEqual(scientificMantissa(1000000, 2), '1.00E6');
	});

	it('guards decimal formatter against Infinity and NaN', () => {
		assert.strictEqual(javaDecimalFormatGuard(Infinity), 'Infinity');
		assert.strictEqual(javaDecimalFormatGuard(-Infinity), '-Infinity');
		assert.strictEqual(javaDecimalFormatGuard(NaN), 'NaN');
	});
});
