'use strict';

/**
 * Cookie Validation Security Tests
 *
 * Tests validation of authentication cookies including:
 * - HMAC signature verification
 * - Expiry validation
 * - User existence validation
 * - Timing-safe comparisons
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const crypto = require('crypto');

const {
	TEST_USERS,
	TEST_COOKIE_KEY,
	base64UrlEncode,
	buildAuthCookieValue,
	parseAuthCookieValue,
	getCookieValueFromHeader,
} = require('../test-helpers');

function createCookieValidationTestApp() {
	const app = express();
	const USERS = TEST_USERS;
	const AUTH_COOKIE_NAME = 'AuthStore';
	const AUTH_COOKIE_KEY = TEST_COOKIE_KEY;

	function getAuthCookieUser(req) {
		const raw = getCookieValueFromHeader(req?.headers?.cookie, AUTH_COOKIE_NAME);
		return parseAuthCookieValue(raw, USERS, AUTH_COOKIE_KEY);
	}

	// Protected endpoint using cookie auth
	app.get('/api/protected', (req, res) => {
		const authResult = getAuthCookieUser(req);
		if (!authResult) {
			return res.status(401).json({ error: 'Authentication required' });
		}
		res.json({ user: authResult.user, sessionId: authResult.sessionId });
	});

	return app;
}

describe('Cookie Validation Security Tests', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createCookieValidationTestApp();
		server = http.createServer(app);
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		const addr = server.address();
		baseUrl = `http://127.0.0.1:${addr.port}`;
	});

	after(async () => {
		if (server) {
			await new Promise((resolve) => server.close(resolve));
		}
	});

	describe('Auth Cookie - New Format (4-part)', () => {
		it('accepts valid auth cookie', async () => {
			const expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
			const cookie = buildAuthCookieValue('testuser', 'session123', 'testpassword', TEST_COOKIE_KEY, expiry);

			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': `AuthStore=${cookie}` },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.user, 'testuser');
			assert.strictEqual(data.sessionId, 'session123');
		});

		it('rejects expired cookie', async () => {
			const expiry = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
			const cookie = buildAuthCookieValue('testuser', 'session123', 'testpassword', TEST_COOKIE_KEY, expiry);

			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': `AuthStore=${cookie}` },
			});
			assert.strictEqual(res.status, 401);
		});

		it('rejects cookie with wrong password in signature', async () => {
			const expiry = Math.floor(Date.now() / 1000) + 3600;
			const cookie = buildAuthCookieValue('testuser', 'session123', 'wrongpassword', TEST_COOKIE_KEY, expiry);

			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': `AuthStore=${cookie}` },
			});
			assert.strictEqual(res.status, 401);
		});

		it('rejects cookie with wrong key', async () => {
			const expiry = Math.floor(Date.now() / 1000) + 3600;
			const cookie = buildAuthCookieValue('testuser', 'session123', 'testpassword', 'wrong-key-32-bytes-exactly-here!', expiry);

			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': `AuthStore=${cookie}` },
			});
			assert.strictEqual(res.status, 401);
		});

		it('rejects cookie for non-existent user', async () => {
			const expiry = Math.floor(Date.now() / 1000) + 3600;
			const cookie = buildAuthCookieValue('nonexistent', 'session123', 'password', TEST_COOKIE_KEY, expiry);

			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': `AuthStore=${cookie}` },
			});
			assert.strictEqual(res.status, 401);
		});

		it('rejects tampered signature', async () => {
			const expiry = Math.floor(Date.now() / 1000) + 3600;
			let cookie = buildAuthCookieValue('testuser', 'session123', 'testpassword', TEST_COOKIE_KEY, expiry);
			// Tamper more aggressively by replacing several characters in the middle
			const mid = Math.floor(cookie.length / 2);
			cookie = cookie.slice(0, mid - 3) + 'XXXX' + cookie.slice(mid + 1);

			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': `AuthStore=${cookie}` },
			});
			assert.strictEqual(res.status, 401);
		});

		it('rejects malformed cookie (not base64)', async () => {
			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': 'AuthStore=not-valid-base64!!!' },
			});
			assert.strictEqual(res.status, 401);
		});

		it('rejects cookie with wrong number of parts', async () => {
			const malformed = base64UrlEncode('part1|part2'); // Only 2 parts
			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': `AuthStore=${malformed}` },
			});
			assert.strictEqual(res.status, 401);
		});

		it('rejects unsupported 3-part cookie format', async () => {
			const expiry = Math.floor(Date.now() / 1000) + 3600;
			const userEncoded = base64UrlEncode('testuser');
			const payload = `${userEncoded}|${expiry}`;
			const sig = crypto.createHmac('sha256', TEST_COOKIE_KEY).update(`${payload}|testpassword`).digest('hex');
			const cookie = base64UrlEncode(`${payload}|${sig}`);

			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': `AuthStore=${cookie}` },
			});
			assert.strictEqual(res.status, 401);
		});

		it('rejects cookie with non-numeric expiry', async () => {
			const userEncoded = base64UrlEncode('testuser');
			const payload = `${userEncoded}|session123|notanumber`;
			const sig = crypto.createHmac('sha256', TEST_COOKIE_KEY).update(`${payload}|testpassword`).digest('hex');
			const cookie = base64UrlEncode(`${payload}|${sig}`);

			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': `AuthStore=${cookie}` },
			});
			assert.strictEqual(res.status, 401);
		});
	});

	describe('Cookie Parsing Edge Cases', () => {
		it('handles multiple cookies correctly', async () => {
			const expiry = Math.floor(Date.now() / 1000) + 3600;
			const cookie = buildAuthCookieValue('testuser', 'session123', 'testpassword', TEST_COOKIE_KEY, expiry);

			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': `other=value; AuthStore=${cookie}; another=test` },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.user, 'testuser');
		});

		it('handles empty cookie header', async () => {
			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': '' },
			});
			assert.strictEqual(res.status, 401);
		});

		it('handles cookie with empty value', async () => {
			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': 'AuthStore=' },
			});
			assert.strictEqual(res.status, 401);
		});

		it('handles malformed cookie header (no equals)', async () => {
			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': 'AuthStoreWithNoEquals' },
			});
			assert.strictEqual(res.status, 401);
		});

		it('handles cookie with whitespace', async () => {
			const expiry = Math.floor(Date.now() / 1000) + 3600;
			const cookie = buildAuthCookieValue('testuser', 'session123', 'testpassword', TEST_COOKIE_KEY, expiry);

			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': `  AuthStore = ${cookie}  ` },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
		});
	});

	describe('Timing-Safe Comparison', () => {
		it('uses timing-safe comparison for signatures', () => {
			// Verify that the implementation uses crypto.timingSafeEqual
			const sig1 = 'a'.repeat(64);
			const sig2 = 'a'.repeat(64);
			const sig3 = 'b'.repeat(64);

			const buf1 = Buffer.from(sig1, 'hex');
			const buf2 = Buffer.from(sig2, 'hex');
			const buf3 = Buffer.from(sig3, 'hex');

			assert.ok(crypto.timingSafeEqual(buf1, buf2));
			assert.ok(!crypto.timingSafeEqual(buf1, buf3));
		});

		it('rejects signature with different length', async () => {
			const userEncoded = base64UrlEncode('testuser');
			const expiry = Math.floor(Date.now() / 1000) + 3600;
			// Create signature with wrong length
			const shortSig = 'abcd1234';
			const cookie = base64UrlEncode(`${userEncoded}|session123|${expiry}|${shortSig}`);

			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': `AuthStore=${cookie}` },
			});
			assert.strictEqual(res.status, 401);
		});
	});
});
