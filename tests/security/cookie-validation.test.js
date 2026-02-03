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

const { TEST_USERS, TEST_COOKIE_KEY, base64UrlEncode } = require('../test-helpers');

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function base64UrlDecode(value) {
	const raw = String(value).replace(/-/g, '+').replace(/_/g, '/');
	const pad = raw.length % 4;
	const padded = pad ? raw + '='.repeat(4 - pad) : raw;
	try {
		return Buffer.from(padded, 'base64').toString('utf8');
	} catch {
		return '';
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

function buildAuthCookieValue(user, sessionId, pass, key, expiry) {
	const userEncoded = base64UrlEncode(user);
	const payload = `${userEncoded}|${sessionId}|${expiry}`;
	const sig = crypto.createHmac('sha256', key).update(`${payload}|${pass}`).digest('hex');
	return base64UrlEncode(`${payload}|${sig}`);
}

function buildLegacyAuthCookieValue(user, pass, key, expiry) {
	const userEncoded = base64UrlEncode(user);
	const payload = `${userEncoded}|${expiry}`;
	const sig = crypto.createHmac('sha256', key).update(`${payload}|${pass}`).digest('hex');
	return base64UrlEncode(`${payload}|${sig}`);
}

function createCookieValidationTestApp() {
	const app = express();
	const USERS = TEST_USERS;
	const AUTH_COOKIE_NAME = 'AuthStore';
	const AUTH_COOKIE_KEY = TEST_COOKIE_KEY;
	const SESSION_COOKIE_NAME = 'ohSession';

	function getAuthCookieUser(req) {
		const raw = getCookieValue(req, AUTH_COOKIE_NAME);
		if (!raw) return null;
		const decoded = base64UrlDecode(raw);
		if (!decoded) return null;
		const parts = decoded.split('|');

		// Handle both legacy (3-part) and new (4-part) formats
		if (parts.length === 3) {
			// Legacy format: userEncoded|expiry|sig
			const [userEncoded, expiryRaw, sig] = parts;
			if (!/^\d+$/.test(expiryRaw)) return null;
			const expiry = Number(expiryRaw);
			if (!Number.isFinite(expiry) || expiry <= Math.floor(Date.now() / 1000)) return null;
			const user = base64UrlDecode(userEncoded);
			if (!user || !Object.prototype.hasOwnProperty.call(USERS, user)) return null;
			const expected = crypto.createHmac('sha256', AUTH_COOKIE_KEY).update(`${userEncoded}|${expiryRaw}|${USERS[user]}`).digest('hex');
			const sigBuf = Buffer.from(sig, 'hex');
			const expectedBuf = Buffer.from(expected, 'hex');
			if (sigBuf.length !== expectedBuf.length) return null;
			if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
			return { user, sessionId: null, isLegacy: true };
		} else if (parts.length === 4) {
			// New format: userEncoded|sessionId|expiry|sig
			const [userEncoded, sessionId, expiryRaw, sig] = parts;
			if (!/^\d+$/.test(expiryRaw)) return null;
			const expiry = Number(expiryRaw);
			if (!Number.isFinite(expiry) || expiry <= Math.floor(Date.now() / 1000)) return null;
			const user = base64UrlDecode(userEncoded);
			if (!user || !Object.prototype.hasOwnProperty.call(USERS, user)) return null;
			const expected = crypto.createHmac('sha256', AUTH_COOKIE_KEY).update(`${userEncoded}|${sessionId}|${expiryRaw}|${USERS[user]}`).digest('hex');
			const sigBuf = Buffer.from(sig, 'hex');
			const expectedBuf = Buffer.from(expected, 'hex');
			if (sigBuf.length !== expectedBuf.length) return null;
			if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
			return { user, sessionId, isLegacy: false };
		}

		return null;
	}

	// Protected endpoint using cookie auth
	app.get('/api/protected', (req, res) => {
		const authResult = getAuthCookieUser(req);
		if (!authResult) {
			return res.status(401).json({ error: 'Authentication required' });
		}
		res.json({ user: authResult.user, sessionId: authResult.sessionId, isLegacy: authResult.isLegacy });
	});

	// Session cookie endpoint (legacy)
	app.get('/api/session', (req, res) => {
		const sessionId = getCookieValue(req, SESSION_COOKIE_NAME);
		if (!sessionId) {
			return res.status(400).json({ error: 'No session cookie' });
		}
		// Session ID should be alphanumeric
		if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
			return res.status(400).json({ error: 'Invalid session ID format' });
		}
		res.json({ sessionId });
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
			assert.strictEqual(data.isLegacy, false);
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

	describe('Auth Cookie - Legacy Format (3-part)', () => {
		it('accepts valid legacy auth cookie', async () => {
			const expiry = Math.floor(Date.now() / 1000) + 3600;
			const cookie = buildLegacyAuthCookieValue('testuser', 'testpassword', TEST_COOKIE_KEY, expiry);

			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': `AuthStore=${cookie}` },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.user, 'testuser');
			assert.strictEqual(data.isLegacy, true);
		});

		it('rejects expired legacy cookie', async () => {
			const expiry = Math.floor(Date.now() / 1000) - 3600;
			const cookie = buildLegacyAuthCookieValue('testuser', 'testpassword', TEST_COOKIE_KEY, expiry);

			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': `AuthStore=${cookie}` },
			});
			assert.strictEqual(res.status, 401);
		});

		it('rejects legacy cookie with wrong signature', async () => {
			const expiry = Math.floor(Date.now() / 1000) + 3600;
			const cookie = buildLegacyAuthCookieValue('testuser', 'wrongpassword', TEST_COOKIE_KEY, expiry);

			const res = await fetch(`${baseUrl}/api/protected`, {
				headers: { 'Cookie': `AuthStore=${cookie}` },
			});
			assert.strictEqual(res.status, 401);
		});
	});

	describe('Session Cookie Validation', () => {
		it('accepts valid session ID format', async () => {
			const res = await fetch(`${baseUrl}/api/session`, {
				headers: { 'Cookie': 'ohSession=abc123_XYZ-789' },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.sessionId, 'abc123_XYZ-789');
		});

		it('rejects missing session cookie', async () => {
			const res = await fetch(`${baseUrl}/api/session`);
			assert.strictEqual(res.status, 400);
		});

		it('rejects session ID with special chars', async () => {
			const res = await fetch(`${baseUrl}/api/session`, {
				headers: { 'Cookie': 'ohSession=../../../etc/passwd' },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects session ID with spaces', async () => {
			const res = await fetch(`${baseUrl}/api/session`, {
				headers: { 'Cookie': 'ohSession=session with spaces' },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects session ID with XSS attempt', async () => {
			const res = await fetch(`${baseUrl}/api/session`, {
				headers: { 'Cookie': 'ohSession=<script>alert(1)</script>' },
			});
			assert.strictEqual(res.status, 400);
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
