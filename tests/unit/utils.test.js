'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// Utility functions replicated from server.js for testing
// Since server.js doesn't export these, we test the logic directly

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function formatLogTimestamp(date) {
	const pad = (value) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function escapeHtml(value) {
	const text = safeText(value);
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function configNumber(value, fallback) {
	const num = Number(value);
	return Number.isFinite(num) ? num : fallback;
}

function base64UrlEncode(value) {
	return Buffer.from(String(value), 'utf8')
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
}

function base64UrlDecode(value) {
	const raw = safeText(value).replace(/-/g, '+').replace(/_/g, '/');
	if (!raw) return null;
	const pad = raw.length % 4;
	const padded = pad ? raw + '='.repeat(4 - pad) : raw;
	try {
		return Buffer.from(padded, 'base64').toString('utf8');
	} catch {
		return null;
	}
}

function hashString(value) {
	return crypto.createHash('sha1').update(value).digest('hex');
}

function inlineJson(value) {
	const json = JSON.stringify(value);
	// Escape < to prevent script tag injection
	return json.replace(/</g, '\\u003c');
}

describe('Utility Functions', () => {
	describe('safeText', () => {
		it('returns string for string input', () => {
			assert.strictEqual(safeText('hello'), 'hello');
		});

		it('returns empty for null', () => {
			assert.strictEqual(safeText(null), '');
		});

		it('returns empty for undefined', () => {
			assert.strictEqual(safeText(undefined), '');
		});

		it('converts number to string', () => {
			assert.strictEqual(safeText(123), '123');
		});

		it('handles objects', () => {
			assert.strictEqual(safeText({}), '[object Object]');
		});

		it('handles arrays', () => {
			assert.strictEqual(safeText([1, 2, 3]), '1,2,3');
		});

		it('handles boolean true', () => {
			assert.strictEqual(safeText(true), 'true');
		});

		it('handles boolean false', () => {
			assert.strictEqual(safeText(false), 'false');
		});

		it('handles zero', () => {
			assert.strictEqual(safeText(0), '0');
		});

		it('handles empty string', () => {
			assert.strictEqual(safeText(''), '');
		});
	});

	describe('escapeHtml', () => {
		it('escapes ampersand', () => {
			assert.strictEqual(escapeHtml('&'), '&amp;');
		});

		it('escapes less than', () => {
			assert.strictEqual(escapeHtml('<'), '&lt;');
		});

		it('escapes greater than', () => {
			assert.strictEqual(escapeHtml('>'), '&gt;');
		});

		it('escapes double quotes', () => {
			assert.strictEqual(escapeHtml('"'), '&quot;');
		});

		it('escapes single quotes', () => {
			assert.strictEqual(escapeHtml("'"), '&#39;');
		});

		it('handles mixed content', () => {
			assert.strictEqual(escapeHtml('<script>'), '&lt;script&gt;');
		});

		it('handles complex HTML attack', () => {
			const input = '<img src="x" onerror="alert(\'XSS\')">';
			const expected = '&lt;img src=&quot;x&quot; onerror=&quot;alert(&#39;XSS&#39;)&quot;&gt;';
			assert.strictEqual(escapeHtml(input), expected);
		});

		it('handles null input', () => {
			assert.strictEqual(escapeHtml(null), '');
		});

		it('handles undefined input', () => {
			assert.strictEqual(escapeHtml(undefined), '');
		});

		it('preserves safe text', () => {
			assert.strictEqual(escapeHtml('Hello World'), 'Hello World');
		});
	});

	describe('configNumber', () => {
		it('parses valid integer', () => {
			assert.strictEqual(configNumber('123', 0), 123);
		});

		it('parses valid number directly', () => {
			assert.strictEqual(configNumber(456, 0), 456);
		});

		it('returns default for NaN string', () => {
			assert.strictEqual(configNumber('abc', 99), 99);
		});

		it('handles negative numbers', () => {
			assert.strictEqual(configNumber('-5', 0), -5);
		});

		it('handles float', () => {
			assert.strictEqual(configNumber('3.14', 0), 3.14);
		});

		it('handles null (Number(null) is 0, which is finite)', () => {
			// Number(null) === 0, which is finite, so returns 0 not fallback
			assert.strictEqual(configNumber(null, 42), 0);
		});

		it('handles undefined (Number(undefined) is NaN)', () => {
			// Number(undefined) === NaN, which is not finite, so returns fallback
			assert.strictEqual(configNumber(undefined, 42), 42);
		});

		it('handles Infinity', () => {
			assert.strictEqual(configNumber(Infinity, 0), 0);
		});

		it('handles -Infinity', () => {
			assert.strictEqual(configNumber(-Infinity, 0), 0);
		});

		it('handles empty string (Number("") is 0, which is finite)', () => {
			// Number('') === 0, which is finite, so returns 0 not fallback
			assert.strictEqual(configNumber('', 10), 0);
		});
	});

	describe('base64UrlEncode', () => {
		it('encodes correctly', () => {
			const encoded = base64UrlEncode('hello');
			assert.strictEqual(typeof encoded, 'string');
			assert.ok(encoded.length > 0);
		});

		it('replaces + and /', () => {
			// Use a string that produces + and / in standard base64
			const input = '>>>???'; // This should produce characters needing replacement
			const encoded = base64UrlEncode(input);
			assert.ok(!encoded.includes('+'), 'Should not contain +');
			assert.ok(!encoded.includes('/'), 'Should not contain /');
		});

		it('removes padding', () => {
			const encoded = base64UrlEncode('a'); // 'a' produces padding in base64
			assert.ok(!encoded.endsWith('='), 'Should not end with =');
		});

		it('handles empty string', () => {
			assert.strictEqual(base64UrlEncode(''), '');
		});

		it('handles unicode', () => {
			const encoded = base64UrlEncode('日本語');
			assert.ok(encoded.length > 0);
		});
	});

	describe('base64UrlDecode', () => {
		it('decodes correctly', () => {
			const original = 'hello world';
			const encoded = base64UrlEncode(original);
			const decoded = base64UrlDecode(encoded);
			assert.strictEqual(decoded, original);
		});

		it('handles missing padding', () => {
			const original = 'test';
			const encoded = base64UrlEncode(original);
			const decoded = base64UrlDecode(encoded);
			assert.strictEqual(decoded, original);
		});

		it('returns null for empty input', () => {
			assert.strictEqual(base64UrlDecode(''), null);
		});

		it('handles url-safe characters', () => {
			const original = 'special+/chars';
			const encoded = base64UrlEncode(original);
			const decoded = base64UrlDecode(encoded);
			assert.strictEqual(decoded, original);
		});

		it('roundtrip with unicode', () => {
			const original = '日本語テスト';
			const encoded = base64UrlEncode(original);
			const decoded = base64UrlDecode(encoded);
			assert.strictEqual(decoded, original);
		});
	});

	describe('hashString', () => {
		it('returns consistent SHA1 hash', () => {
			const hash1 = hashString('test');
			const hash2 = hashString('test');
			assert.strictEqual(hash1, hash2);
		});

		it('returns different hash for different input', () => {
			const hash1 = hashString('test1');
			const hash2 = hashString('test2');
			assert.notStrictEqual(hash1, hash2);
		});

		it('returns 40 character hex string', () => {
			const hash = hashString('anything');
			assert.strictEqual(hash.length, 40);
			assert.ok(/^[0-9a-f]+$/.test(hash), 'Should be hex');
		});

		it('handles empty string', () => {
			const hash = hashString('');
			assert.strictEqual(hash.length, 40);
		});

		it('handles unicode', () => {
			const hash = hashString('日本語');
			assert.strictEqual(hash.length, 40);
		});
	});

	describe('inlineJson', () => {
		it('escapes less-than for script safety', () => {
			const result = inlineJson({ text: '<script>' });
			assert.ok(!result.includes('<'), 'Should not contain raw <');
			assert.ok(result.includes('\\u003c'), 'Should contain escaped <');
		});

		it('handles null', () => {
			const result = inlineJson(null);
			assert.strictEqual(result, 'null');
		});

		it('handles objects', () => {
			const result = inlineJson({ key: 'value' });
			assert.ok(result.includes('"key"'));
			assert.ok(result.includes('"value"'));
		});

		it('handles arrays', () => {
			const result = inlineJson([1, 2, 3]);
			assert.strictEqual(result, '[1,2,3]');
		});

		it('handles nested objects', () => {
			const obj = { outer: { inner: '<test>' } };
			const result = inlineJson(obj);
			assert.ok(!result.includes('<'), 'Should escape nested < chars');
		});
	});

	describe('formatLogTimestamp', () => {
		it('returns ISO-like format', () => {
			const date = new Date('2024-06-15T14:30:45');
			const result = formatLogTimestamp(date);
			assert.strictEqual(result, '2024-06-15 14:30:45');
		});

		it('pads single digits', () => {
			const date = new Date('2024-01-05T09:05:03');
			const result = formatLogTimestamp(date);
			assert.strictEqual(result, '2024-01-05 09:05:03');
		});

		it('handles midnight', () => {
			const date = new Date('2024-12-31T00:00:00');
			const result = formatLogTimestamp(date);
			assert.strictEqual(result, '2024-12-31 00:00:00');
		});

		it('handles end of day', () => {
			const date = new Date('2024-07-20T23:59:59');
			const result = formatLogTimestamp(date);
			assert.strictEqual(result, '2024-07-20 23:59:59');
		});
	});
});
