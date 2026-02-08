'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Replicated from public/chart.js.
function javaDecimalFormat(pattern, number) {
	// Handle positive/negative subpatterns
	var subpatterns = [];
	var inQuote = false;
	var splitIdx = -1;
	for (var i = 0; i < pattern.length; i++) {
		if (pattern[i] === "'") { inQuote = !inQuote; continue; }
		if (!inQuote && pattern[i] === ';') { splitIdx = i; break; }
	}
	if (splitIdx >= 0) {
		subpatterns = [pattern.substring(0, splitIdx), pattern.substring(splitIdx + 1)];
	} else {
		subpatterns = [pattern];
	}

	var isNeg = number < 0 || (1 / number === -Infinity);
	var pat = isNeg && subpatterns.length > 1 ? subpatterns[1] : subpatterns[0];
	var absNum = Math.abs(number);

	// Parse prefix, body, suffix by scanning for first/last format char
	var firstFmt = -1, lastFmt = -1;
	inQuote = false;
	for (var i = 0; i < pat.length; i++) {
		if (pat[i] === "'") { inQuote = !inQuote; continue; }
		if (!inQuote && /[0#.,E]/.test(pat[i])) {
			if (firstFmt < 0) firstFmt = i;
			lastFmt = i;
		}
	}
	if (firstFmt < 0) return pat; // no format chars

	var prefixRaw = pat.substring(0, firstFmt);
	var body = pat.substring(firstFmt, lastFmt + 1);
	var suffixRaw = pat.substring(lastFmt + 1);

	// Unquote helper
	function unquote(s) {
		var r = '', q = false;
		for (var i = 0; i < s.length; i++) {
			if (s[i] === "'") { q = !q; continue; }
			r += s[i];
		}
		return r;
	}
	var prefix = unquote(prefixRaw);
	var suffix = unquote(suffixRaw);

	// Check for percent suffix in raw suffix
	inQuote = false;
	for (var i = 0; i < suffixRaw.length; i++) {
		if (suffixRaw[i] === "'") { inQuote = !inQuote; continue; }
		if (!inQuote && suffixRaw[i] === '%') { absNum *= 100; break; }
	}

	// Scientific notation
	var eIdx = body.indexOf('E');
	if (eIdx >= 0) {
		var mantissaPat = body.substring(0, eIdx);
		// Count decimals in mantissa pattern
		var dotIdx = mantissaPat.indexOf('.');
		var mantDec = 0;
		if (dotIdx >= 0) {
			mantDec = mantissaPat.length - dotIdx - 1;
		}
		if (absNum === 0) {
			var result = (0).toFixed(mantDec) + 'E0';
		} else {
			var exp = Math.floor(Math.log10(absNum));
			var mantissa = absNum / Math.pow(10, exp);
			var result = mantissa.toFixed(mantDec) + 'E' + exp;
			// Normalize negative zero
			if (parseFloat(result.split('E')[0]) === 0 && result.charAt(0) === '-') {
				result = result.substring(1);
			}
		}
		var negPrefix = isNeg && subpatterns.length === 1 ? '-' : '';
		var formatted = negPrefix + prefix + result + suffix;
		// Normalize negative zero
		if (isNeg && parseFloat(formatted.replace(/[^0-9.eE+-]/g, '')) === 0) {
			return prefix + result + suffix;
		}
		return formatted;
	}

	// Determine decimal digits from pattern
	var dotPos = body.indexOf('.');
	var intPart = dotPos >= 0 ? body.substring(0, dotPos) : body;
	var decPart = dotPos >= 0 ? body.substring(dotPos + 1) : '';

	// Count forced (0) and optional (#) decimal digits
	var minDec = 0, maxDec = 0;
	for (var i = 0; i < decPart.length; i++) {
		if (decPart[i] === '0') { minDec++; maxDec++; }
		else if (decPart[i] === '#') { maxDec++; }
	}

	// Grouping: find last comma position in integer pattern
	var groupSize = 0;
	var lastComma = intPart.lastIndexOf(',');
	if (lastComma >= 0) {
		groupSize = intPart.length - lastComma - 1;
		// Remove commas for counting
		intPart = intPart.replace(/,/g, '');
	}

	// Min integer digits (count of 0s in integer part)
	var minInt = 0;
	for (var i = 0; i < intPart.length; i++) {
		if (intPart[i] === '0') minInt++;
	}
	if (minInt === 0) minInt = 1; // always at least one digit

	// Round to maxDec
	var rounded = maxDec >= 0 ? parseFloat(absNum.toFixed(maxDec)) : absNum;
	var parts = rounded.toFixed(maxDec).split('.');
	var intStr = parts[0];
	var decStr = parts.length > 1 ? parts[1] : '';

	// Pad integer to min digits
	while (intStr.length < minInt) intStr = '0' + intStr;

	// Trim trailing zeros in decimal beyond minDec
	if (decStr.length > minDec) {
		var trimmed = decStr.substring(0, minDec) + decStr.substring(minDec).replace(/0+$/, '');
		decStr = trimmed;
	}

	// Apply grouping
	if (groupSize > 0 && intStr.length > groupSize) {
		var grouped = '';
		var count = 0;
		for (var i = intStr.length - 1; i >= 0; i--) {
			if (count > 0 && count % groupSize === 0) grouped = ',' + grouped;
			grouped = intStr[i] + grouped;
			count++;
		}
		intStr = grouped;
	}

	var result = decStr ? intStr + '.' + decStr : intStr;

	// Negative prefix for single-pattern mode
	var negPrefix = isNeg && subpatterns.length === 1 ? '-' : '';
	var formatted = negPrefix + prefix + result + suffix;

	// Normalize negative zero
	if (isNeg && parseFloat(result) === 0) {
		return prefix + result + suffix;
	}
	return formatted;
}

describe('javaDecimalFormat', () => {
	const cases = [
		['#.##', 1.5, '1.5'],
		['#.##', 0, '0'],
		['#.##', 1.567, '1.57'],
		['0.00', 1, '1.00'],
		['0.00', 0, '0.00'],
		['0.00', 1.5, '1.50'],
		['0.00', -1, '-1.00'],
		['#,##0.0', 1234.5, '1,234.5'],
		['#,##0.0', 0, '0.0'],
		['#,##0', 1234567, '1,234,567'],
		['0.000', 1, '1.000'],
		['#', 1.7, '2'],
		['#', 0, '0'],
		["0.00'%'", 5.1, '5.10%'],
		['#.##;(#.##)', -3.5, '(3.5)'],
		['0.##E0', 1234, '1.23E3'],
		['#.##', -0.0001, '0'],
		['0.0', -0, '0.0'],
	];

	for (const [pattern, input, expected] of cases) {
		it(`pattern "${pattern}" with input ${Object.is(input, -0) ? '-0' : input} → "${expected}"`, () => {
			assert.strictEqual(javaDecimalFormat(pattern, input), expected);
		});
	}
});
