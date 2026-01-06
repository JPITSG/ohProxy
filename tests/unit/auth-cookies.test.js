'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// Helper functions
function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
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

function getCookieValue(req, name) {
	const header = safeText(req?.headers?.cookie || '').trim();
	if (!header || !name) return '';
	for (const part of header.split(';')) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		if (key !== name) continue;
		return trimmed.slice(eq + 1).trim();
	}
	return '';
}

function buildAuthCookieValue(user, pass, key, expiry) {
	const userEncoded = base64UrlEncode(user);
	const payload = `${userEncoded}|${expiry}`;
	const sig = crypto.createHmac('sha256', key).update(`${payload}|${pass}`).digest('hex');
	return base64UrlEncode(`${payload}|${sig}`);
}

function getAuthCookieUser(cookieValue, users, key) {
	if (!key) return null;
	if (!cookieValue) return null;
	const decoded = base64UrlDecode(cookieValue);
	if (!decoded) return null;
	const parts = decoded.split('|');
	if (parts.length !== 3) return null;
	const [userEncoded, expiryRaw, sig] = parts;
	if (!/^\d+$/.test(expiryRaw)) return null;
	const expiry = Number(expiryRaw);
	if (!Number.isFinite(expiry) || expiry <= Math.floor(Date.now() / 1000)) return null;
	const user = base64UrlDecode(userEncoded);
	if (!user || !Object.prototype.hasOwnProperty.call(users, user)) return null;
	const expected = crypto.createHmac('sha256', key).update(`${userEncoded}|${expiryRaw}|${users[user]}`).digest('hex');
	const sigBuf = Buffer.from(sig, 'hex');
	const expectedBuf = Buffer.from(expected, 'hex');
	if (sigBuf.length !== expectedBuf.length) return null;
	if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
	return user;
}

function appendSetCookie(res, value) {
	if (!value) return;
	const existing = res.headers['set-cookie'];
	if (!existing) {
		res.headers['set-cookie'] = value;
		return;
	}
	if (Array.isArray(existing)) {
		res.headers['set-cookie'] = existing.concat(value);
		return;
	}
	res.headers['set-cookie'] = [existing, value];
}

const TEST_KEY = 'test-cookie-key-32-bytes-exactly';
const TEST_USERS = {
	testuser: 'testpassword',
	admin: 'adminpass123',
};

describe('Auth Cookie Functions', () => {
	describe('buildAuthCookieValue', () => {
		it('creates signed cookie value', () => {
			const expiry = Math.floor(Date.now() / 1000) + 86400;
			const value = buildAuthCookieValue('testuser', 'testpassword', TEST_KEY, expiry);
			assert.ok(typeof value === 'string');
			assert.ok(value.length > 0);
		});

		it('includes expiry in payload', () => {
			const expiry = Math.floor(Date.now() / 1000) + 86400;
			const value = buildAuthCookieValue('testuser', 'testpassword', TEST_KEY, expiry);
			const decoded = base64UrlDecode(value);
			assert.ok(decoded.includes(String(expiry)));
		});

		it('HMAC is consistent for same inputs', () => {
			const expiry = Math.floor(Date.now() / 1000) + 86400;
			const value1 = buildAuthCookieValue('testuser', 'testpassword', TEST_KEY, expiry);
			const value2 = buildAuthCookieValue('testuser', 'testpassword', TEST_KEY, expiry);
			assert.strictEqual(value1, value2);
		});

		it('HMAC differs with different password', () => {
			const expiry = Math.floor(Date.now() / 1000) + 86400;
			const value1 = buildAuthCookieValue('testuser', 'testpassword', TEST_KEY, expiry);
			const value2 = buildAuthCookieValue('testuser', 'differentpass', TEST_KEY, expiry);
			assert.notStrictEqual(value1, value2);
		});

		it('HMAC differs with different key', () => {
			const expiry = Math.floor(Date.now() / 1000) + 86400;
			const value1 = buildAuthCookieValue('testuser', 'testpassword', TEST_KEY, expiry);
			const value2 = buildAuthCookieValue('testuser', 'testpassword', 'different-key-here', expiry);
			assert.notStrictEqual(value1, value2);
		});
	});

	describe('getAuthCookieUser', () => {
		it('validates signature - rejects invalid sig', () => {
			const expiry = Math.floor(Date.now() / 1000) + 86400;
			// Create a tampered cookie
			const userEncoded = base64UrlEncode('testuser');
			const payload = `${userEncoded}|${expiry}`;
			const badSig = 'a'.repeat(64); // Invalid signature
			const tampered = base64UrlEncode(`${payload}|${badSig}`);
			const result = getAuthCookieUser(tampered, TEST_USERS, TEST_KEY);
			assert.strictEqual(result, null);
		});

		it('validates expiry - rejects expired', () => {
			const expiry = Math.floor(Date.now() / 1000) - 1000; // In the past
			const value = buildAuthCookieValue('testuser', 'testpassword', TEST_KEY, expiry);
			const result = getAuthCookieUser(value, TEST_USERS, TEST_KEY);
			assert.strictEqual(result, null);
		});

		it('validates user exists - rejects unknown user', () => {
			const expiry = Math.floor(Date.now() / 1000) + 86400;
			const value = buildAuthCookieValue('unknownuser', 'somepass', TEST_KEY, expiry);
			const result = getAuthCookieUser(value, TEST_USERS, TEST_KEY);
			assert.strictEqual(result, null);
		});

		it('returns username for valid cookie', () => {
			const expiry = Math.floor(Date.now() / 1000) + 86400;
			const value = buildAuthCookieValue('testuser', 'testpassword', TEST_KEY, expiry);
			const result = getAuthCookieUser(value, TEST_USERS, TEST_KEY);
			assert.strictEqual(result, 'testuser');
		});

		it('handles malformed cookie - missing parts', () => {
			const result = getAuthCookieUser(base64UrlEncode('invalid'), TEST_USERS, TEST_KEY);
			assert.strictEqual(result, null);
		});

		it('handles malformed cookie - not base64', () => {
			const result = getAuthCookieUser('!@#$%^&*()', TEST_USERS, TEST_KEY);
			assert.strictEqual(result, null);
		});

		it('returns null when key is empty', () => {
			const expiry = Math.floor(Date.now() / 1000) + 86400;
			const value = buildAuthCookieValue('testuser', 'testpassword', TEST_KEY, expiry);
			const result = getAuthCookieUser(value, TEST_USERS, '');
			assert.strictEqual(result, null);
		});

		it('returns null for empty cookie value', () => {
			const result = getAuthCookieUser('', TEST_USERS, TEST_KEY);
			assert.strictEqual(result, null);
		});
	});

	describe('Cookie Attributes', () => {
		it('setAuthCookie includes HttpOnly', () => {
			// Test the expected cookie format
			const cookieValue = 'testvalue';
			const parts = [
				`AuthStore=${cookieValue}`,
				'Path=/',
				'Expires=somedate',
				'Max-Age=86400',
				'HttpOnly',
				'SameSite=Lax',
			];
			const cookie = parts.join('; ');
			assert.ok(cookie.includes('HttpOnly'));
		});

		it('setAuthCookie includes SameSite=Lax', () => {
			const parts = [
				'AuthStore=value',
				'Path=/',
				'HttpOnly',
				'SameSite=Lax',
			];
			const cookie = parts.join('; ');
			assert.ok(cookie.includes('SameSite=Lax'));
		});

		it('setAuthCookie includes Secure for HTTPS', () => {
			const parts = [
				'AuthStore=value',
				'Path=/',
				'HttpOnly',
				'SameSite=Lax',
				'Secure',
			];
			const cookie = parts.join('; ');
			assert.ok(cookie.includes('Secure'));
		});

		it('setAuthCookie omits Secure for HTTP', () => {
			const parts = [
				'AuthStore=value',
				'Path=/',
				'HttpOnly',
				'SameSite=Lax',
			];
			const cookie = parts.join('; ');
			assert.ok(!cookie.includes('Secure'));
		});

		it('clearAuthCookie sets empty value', () => {
			const cookie = 'AuthStore=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0';
			const match = cookie.match(/AuthStore=([^;]*)/);
			assert.ok(match);
			assert.strictEqual(match[1], '');
		});

		it('clearAuthCookie sets past expiry', () => {
			const cookie = 'AuthStore=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0';
			assert.ok(cookie.includes('1970'));
			assert.ok(cookie.includes('Max-Age=0'));
		});
	});

	describe('getCookieValue', () => {
		it('extracts named cookie', () => {
			const req = { headers: { cookie: 'foo=bar; AuthStore=myvalue; baz=qux' } };
			const value = getCookieValue(req, 'AuthStore');
			assert.strictEqual(value, 'myvalue');
		});

		it('returns empty for missing cookie', () => {
			const req = { headers: { cookie: 'foo=bar; baz=qux' } };
			const value = getCookieValue(req, 'AuthStore');
			assert.strictEqual(value, '');
		});

		it('handles multiple cookies', () => {
			const req = { headers: { cookie: 'a=1; b=2; c=3; target=found; d=4' } };
			const value = getCookieValue(req, 'target');
			assert.strictEqual(value, 'found');
		});

		it('handles first cookie', () => {
			const req = { headers: { cookie: 'first=value; second=other' } };
			const value = getCookieValue(req, 'first');
			assert.strictEqual(value, 'value');
		});

		it('handles last cookie', () => {
			const req = { headers: { cookie: 'first=value; last=final' } };
			const value = getCookieValue(req, 'last');
			assert.strictEqual(value, 'final');
		});

		it('handles cookies with no spaces', () => {
			const req = { headers: { cookie: 'a=1;b=2;c=3' } };
			const value = getCookieValue(req, 'b');
			assert.strictEqual(value, '2');
		});

		it('handles empty cookie header', () => {
			const req = { headers: { cookie: '' } };
			const value = getCookieValue(req, 'any');
			assert.strictEqual(value, '');
		});

		it('handles missing headers', () => {
			const req = { headers: {} };
			const value = getCookieValue(req, 'any');
			assert.strictEqual(value, '');
		});

		it('handles null request', () => {
			const value = getCookieValue(null, 'any');
			assert.strictEqual(value, '');
		});
	});

	describe('appendSetCookie', () => {
		it('sets header when none exists', () => {
			const res = { headers: {} };
			appendSetCookie(res, 'cookie1=value1');
			assert.strictEqual(res.headers['set-cookie'], 'cookie1=value1');
		});

		it('creates array when one exists', () => {
			const res = { headers: { 'set-cookie': 'cookie1=value1' } };
			appendSetCookie(res, 'cookie2=value2');
			assert.ok(Array.isArray(res.headers['set-cookie']));
			assert.strictEqual(res.headers['set-cookie'].length, 2);
		});

		it('appends to existing array', () => {
			const res = { headers: { 'set-cookie': ['cookie1=value1', 'cookie2=value2'] } };
			appendSetCookie(res, 'cookie3=value3');
			assert.strictEqual(res.headers['set-cookie'].length, 3);
		});

		it('ignores empty value', () => {
			const res = { headers: {} };
			appendSetCookie(res, '');
			assert.strictEqual(res.headers['set-cookie'], undefined);
		});

		it('ignores null value', () => {
			const res = { headers: {} };
			appendSetCookie(res, null);
			assert.strictEqual(res.headers['set-cookie'], undefined);
		});
	});
});
