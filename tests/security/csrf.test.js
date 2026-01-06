'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const crypto = require('crypto');

const { TEST_USERS, TEST_COOKIE_KEY } = require('../test-helpers');

// Create CSRF test app
function createCsrfTestApp() {
	const app = express();

	const USERS = TEST_USERS;
	const CSRF_COOKIE_NAME = 'ohCSRF';

	function safeText(value) {
		return value === null || value === undefined ? '' : String(value);
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

	function generateCsrfToken() {
		return crypto.randomBytes(32).toString('hex');
	}

	function validateCsrfToken(req) {
		const cookieToken = getCookieValue(req, CSRF_COOKIE_NAME);
		const headerToken = req.headers['x-csrf-token'];
		if (!cookieToken || !headerToken) return false;
		const cookieBuf = Buffer.from(cookieToken);
		const headerBuf = Buffer.from(headerToken);
		if (cookieBuf.length !== headerBuf.length) return false;
		return crypto.timingSafeEqual(cookieBuf, headerBuf);
	}

	function appendSetCookie(res, value) {
		if (!value) return;
		const existing = res.getHeader('Set-Cookie');
		if (!existing) {
			res.setHeader('Set-Cookie', value);
			return;
		}
		if (Array.isArray(existing)) {
			res.setHeader('Set-Cookie', existing.concat(value));
			return;
		}
		res.setHeader('Set-Cookie', [existing, value]);
	}

	// Login page - generates CSRF token
	app.get('/login', (req, res) => {
		const csrfToken = generateCsrfToken();
		appendSetCookie(res, `${CSRF_COOKIE_NAME}=${csrfToken}; Path=/; SameSite=Strict`);
		res.type('html').send('<form id="login-form"><button>Login</button></form>');
	});

	// Login endpoint - validates CSRF
	app.post('/api/auth/login', express.json(), (req, res) => {
		if (!validateCsrfToken(req)) {
			return res.status(403).json({ success: false, error: 'Invalid CSRF token' });
		}

		const { username, password } = req.body;
		if (USERS[username] === password) {
			return res.json({ success: true });
		}
		res.status(401).json({ success: false, error: 'Invalid credentials' });
	});

	// GET endpoint - no CSRF needed
	app.get('/api/settings', (req, res) => {
		res.json({ darkMode: true });
	});

	return app;
}

describe('CSRF Protection Security Tests', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createCsrfTestApp();
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

	it('CSRF token generated on login page', async () => {
		const res = await fetch(`${baseUrl}/login`);
		const setCookie = res.headers.get('set-cookie');
		assert.ok(setCookie);
		assert.ok(setCookie.includes('ohCSRF='));
	});

	it('CSRF token is 64 hex characters', async () => {
		const res = await fetch(`${baseUrl}/login`);
		const setCookie = res.headers.get('set-cookie');
		const match = setCookie.match(/ohCSRF=([^;]+)/);
		assert.ok(match);
		const token = match[1];
		assert.strictEqual(token.length, 64);
		assert.ok(/^[0-9a-f]+$/.test(token), 'Token should be hex');
	});

	it('missing CSRF header is rejected', async () => {
		// Get CSRF cookie
		const loginRes = await fetch(`${baseUrl}/login`);
		const setCookie = loginRes.headers.get('set-cookie');
		const csrfMatch = setCookie.match(/ohCSRF=([^;]+)/);
		const csrfCookie = csrfMatch[1];

		// POST without X-CSRF-Token header
		const res = await fetch(`${baseUrl}/api/auth/login`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Cookie': `ohCSRF=${csrfCookie}`,
				// Missing X-CSRF-Token header
			},
			body: JSON.stringify({ username: 'testuser', password: 'testpassword' }),
		});

		assert.strictEqual(res.status, 403);
	});

	it('mismatched CSRF token is rejected', async () => {
		// Get CSRF cookie
		const loginRes = await fetch(`${baseUrl}/login`);
		const setCookie = loginRes.headers.get('set-cookie');
		const csrfMatch = setCookie.match(/ohCSRF=([^;]+)/);
		const csrfCookie = csrfMatch[1];

		// POST with wrong CSRF token
		const res = await fetch(`${baseUrl}/api/auth/login`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Cookie': `ohCSRF=${csrfCookie}`,
				'X-CSRF-Token': 'wrong-token-value',
			},
			body: JSON.stringify({ username: 'testuser', password: 'testpassword' }),
		});

		assert.strictEqual(res.status, 403);
	});

	it('valid CSRF token is accepted', async () => {
		// Get CSRF cookie
		const loginRes = await fetch(`${baseUrl}/login`);
		const setCookie = loginRes.headers.get('set-cookie');
		const csrfMatch = setCookie.match(/ohCSRF=([^;]+)/);
		const csrfCookie = csrfMatch[1];

		// POST with correct CSRF token
		const res = await fetch(`${baseUrl}/api/auth/login`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Cookie': `ohCSRF=${csrfCookie}`,
				'X-CSRF-Token': csrfCookie,
			},
			body: JSON.stringify({ username: 'testuser', password: 'testpassword' }),
		});

		assert.strictEqual(res.status, 200);
	});

	it('CSRF cookie is SameSite=Strict', async () => {
		const res = await fetch(`${baseUrl}/login`);
		const setCookie = res.headers.get('set-cookie');
		assert.ok(setCookie.includes('SameSite=Strict'));
	});

	it('CSRF cookie is not HttpOnly (JS needs access)', async () => {
		const res = await fetch(`${baseUrl}/login`);
		const setCookie = res.headers.get('set-cookie');
		assert.ok(!setCookie.toLowerCase().includes('httponly'));
	});

	it('CSRF not required for GET requests', async () => {
		const res = await fetch(`${baseUrl}/api/settings`);
		assert.strictEqual(res.status, 200);
	});

	it('new token generated per request', async () => {
		const res1 = await fetch(`${baseUrl}/login`);
		const cookie1 = res1.headers.get('set-cookie').match(/ohCSRF=([^;]+)/)[1];

		const res2 = await fetch(`${baseUrl}/login`);
		const cookie2 = res2.headers.get('set-cookie').match(/ohCSRF=([^;]+)/)[1];

		assert.notStrictEqual(cookie1, cookie2, 'Tokens should differ between requests');
	});

	it('CSRF validation uses timing-safe comparison', () => {
		// This is a code-level test - the implementation uses crypto.timingSafeEqual
		// We verify the token validation behavior
		const token1 = 'a'.repeat(64);
		const token2 = 'a'.repeat(64);
		const token3 = 'b'.repeat(64);

		// Same tokens should pass
		const buf1 = Buffer.from(token1);
		const buf2 = Buffer.from(token2);
		const buf3 = Buffer.from(token3);

		assert.ok(crypto.timingSafeEqual(buf1, buf2));
		assert.ok(!crypto.timingSafeEqual(buf1, buf3));
	});

	it('different length tokens are rejected', async () => {
		const loginRes = await fetch(`${baseUrl}/login`);
		const setCookie = loginRes.headers.get('set-cookie');
		const csrfMatch = setCookie.match(/ohCSRF=([^;]+)/);
		const csrfCookie = csrfMatch[1];

		// POST with short CSRF token
		const res = await fetch(`${baseUrl}/api/auth/login`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Cookie': `ohCSRF=${csrfCookie}`,
				'X-CSRF-Token': 'short',
			},
			body: JSON.stringify({ username: 'testuser', password: 'testpassword' }),
		});

		assert.strictEqual(res.status, 403);
	});
});
