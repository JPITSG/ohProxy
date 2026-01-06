'use strict';

const { describe, it, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const crypto = require('crypto');

const { TEST_USERS, TEST_COOKIE_KEY } = require('../test-helpers');

// Create a test server with HTML auth mode
function createHtmlAuthApp(config = {}) {
	const app = express();

	const AUTH_COOKIE_NAME = config.cookieName || 'AuthStore';
	const AUTH_COOKIE_KEY = config.cookieKey || TEST_COOKIE_KEY;
	const AUTH_COOKIE_DAYS = config.cookieDays || 365;
	const LAN_SUBNETS = config.lanSubnets || [];
	const USERS = config.users || TEST_USERS;
	const CSRF_COOKIE_NAME = 'ohCSRF';

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

	function getAuthCookieUser(req) {
		if (!AUTH_COOKIE_KEY) return null;
		const raw = getCookieValue(req, AUTH_COOKIE_NAME);
		if (!raw) return null;
		const decoded = base64UrlDecode(raw);
		if (!decoded) return null;
		const parts = decoded.split('|');
		if (parts.length !== 3) return null;
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
		return user;
	}

	function normalizeRemoteIp(value) {
		const raw = safeText(value).trim();
		if (!raw) return '';
		if (raw.startsWith('::ffff:')) return raw.slice(7);
		return raw;
	}

	function ipInSubnet(ip, cidr) {
		if (cidr === '0.0.0.0' || cidr === '0.0.0.0/0') return true;
		const parts = cidr.split('/');
		if (parts.length !== 2) return false;
		const subnet = parts[0].split('.').slice(0, 3).join('.');
		const ipPrefix = ip.split('.').slice(0, 3).join('.');
		return subnet === ipPrefix;
	}

	function ipInAnySubnet(ip, subnets) {
		if (!Array.isArray(subnets) || !subnets.length) return false;
		for (const cidr of subnets) {
			if (ipInSubnet(ip, cidr)) return true;
		}
		return false;
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

	// Login endpoint
	app.post('/api/auth/login', express.json(), (req, res) => {
		// Validate CSRF
		if (!validateCsrfToken(req)) {
			return res.status(403).json({ success: false, error: 'Invalid CSRF token' });
		}

		const { username, password } = req.body;

		if (!username || !password) {
			return res.status(400).json({ success: false, error: 'Missing credentials' });
		}

		if (USERS[username] !== password) {
			return res.status(401).json({ success: false, error: 'Invalid credentials' });
		}

		// Set auth cookie
		const expiry = Math.floor(Date.now() / 1000) + Math.round(AUTH_COOKIE_DAYS * 86400);
		const cookieValue = buildAuthCookieValue(username, password, AUTH_COOKIE_KEY, expiry);
		const expires = new Date(expiry * 1000).toUTCString();
		const parts = [
			`${AUTH_COOKIE_NAME}=${cookieValue}`,
			'Path=/',
			`Expires=${expires}`,
			'HttpOnly',
			'SameSite=Lax',
		];
		appendSetCookie(res, parts.join('; '));

		res.json({ success: true });
	});

	// Auth middleware for HTML mode
	app.use((req, res, next) => {
		const ip = normalizeRemoteIp(req.socket?.remoteAddress || '');
		req.clientIp = ip;

		// Check LAN
		if (ipInAnySubnet(ip, LAN_SUBNETS)) {
			req.authInfo = { auth: 'authenticated', user: 'lan', lan: true };
			return next();
		}

		// Check cookie auth
		const cookieUser = getAuthCookieUser(req);
		if (cookieUser) {
			req.authInfo = { auth: 'authenticated', user: cookieUser, lan: false };
			return next();
		}

		// Allow login.js without auth
		if (req.path === '/login.js') {
			return next();
		}

		// For API requests, return JSON error
		if (req.path.startsWith('/api/')) {
			return res.status(401).json({ error: 'Unauthorized' });
		}

		// Serve login page with CSRF token
		const csrfToken = generateCsrfToken();
		appendSetCookie(res, `${CSRF_COOKIE_NAME}=${csrfToken}; Path=/; SameSite=Strict`);

		res.type('html').send(`<!DOCTYPE html>
<html>
<head><title>Login</title></head>
<body>
<form id="login-form">
<input name="username" placeholder="Username">
<input name="password" type="password" placeholder="Password">
<button type="submit">Login</button>
</form>
</body>
</html>`);
	});

	// Protected routes
	app.get('/', (req, res) => {
		res.send('Authenticated');
	});

	app.get('/api/settings', (req, res) => {
		res.json({ darkMode: true });
	});

	app.get('/login.js', (req, res) => {
		res.type('application/javascript').send('// login.js');
	});

	app.get('/app.js', (req, res) => {
		res.type('application/javascript').send('// app.js');
	});

	return app;
}

describe('HTML Auth Integration', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createHtmlAuthApp({
			lanSubnets: ['192.168.1.0/24'],
		});
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

	it('serves login.html for unauthenticated GET /', async () => {
		const res = await fetch(`${baseUrl}/`);
		assert.strictEqual(res.status, 200);
		const text = await res.text();
		assert.ok(text.includes('login-form'));
	});

	it('sets CSRF cookie with login page', async () => {
		const res = await fetch(`${baseUrl}/`);
		const setCookie = res.headers.get('set-cookie');
		assert.ok(setCookie);
		assert.ok(setCookie.includes('ohCSRF='));
	});

	it('login.js accessible without auth', async () => {
		const res = await fetch(`${baseUrl}/login.js`);
		assert.strictEqual(res.status, 200);
	});

	it('other JS requires auth (returns login page)', async () => {
		const res = await fetch(`${baseUrl}/app.js`);
		// In HTML mode, unauthenticated requests get login page
		const text = await res.text();
		assert.ok(text.includes('login-form'));
	});

	it('login with valid credentials succeeds', async () => {
		// First get CSRF token
		const loginPage = await fetch(`${baseUrl}/`);
		const csrfCookie = loginPage.headers.get('set-cookie').match(/ohCSRF=([^;]+)/)[1];

		const res = await fetch(`${baseUrl}/api/auth/login`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-CSRF-Token': csrfCookie,
				'Cookie': `ohCSRF=${csrfCookie}`,
			},
			body: JSON.stringify({ username: 'testuser', password: 'testpassword' }),
		});

		assert.strictEqual(res.status, 200);
		const data = await res.json();
		assert.strictEqual(data.success, true);
	});

	it('login sets AuthStore cookie', async () => {
		const loginPage = await fetch(`${baseUrl}/`);
		const csrfCookie = loginPage.headers.get('set-cookie').match(/ohCSRF=([^;]+)/)[1];

		const res = await fetch(`${baseUrl}/api/auth/login`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-CSRF-Token': csrfCookie,
				'Cookie': `ohCSRF=${csrfCookie}`,
			},
			body: JSON.stringify({ username: 'testuser', password: 'testpassword' }),
		});

		const setCookie = res.headers.get('set-cookie');
		assert.ok(setCookie);
		assert.ok(setCookie.includes('AuthStore='));
	});

	it('login with invalid credentials fails', async () => {
		const loginPage = await fetch(`${baseUrl}/`);
		const csrfCookie = loginPage.headers.get('set-cookie').match(/ohCSRF=([^;]+)/)[1];

		const res = await fetch(`${baseUrl}/api/auth/login`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-CSRF-Token': csrfCookie,
				'Cookie': `ohCSRF=${csrfCookie}`,
			},
			body: JSON.stringify({ username: 'testuser', password: 'wrongpassword' }),
		});

		assert.strictEqual(res.status, 401);
	});

	it('login without CSRF token fails', async () => {
		const res = await fetch(`${baseUrl}/api/auth/login`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ username: 'testuser', password: 'testpassword' }),
		});

		assert.strictEqual(res.status, 403);
	});

	it('login with wrong CSRF token fails', async () => {
		const loginPage = await fetch(`${baseUrl}/`);
		const csrfCookie = loginPage.headers.get('set-cookie').match(/ohCSRF=([^;]+)/)[1];

		const res = await fetch(`${baseUrl}/api/auth/login`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-CSRF-Token': 'wrong-token',
				'Cookie': `ohCSRF=${csrfCookie}`,
			},
			body: JSON.stringify({ username: 'testuser', password: 'testpassword' }),
		});

		assert.strictEqual(res.status, 403);
	});

	it('cookie auth bypasses login page', async () => {
		// First login to get auth cookie
		const loginPage = await fetch(`${baseUrl}/`);
		const csrfCookie = loginPage.headers.get('set-cookie').match(/ohCSRF=([^;]+)/)[1];

		const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-CSRF-Token': csrfCookie,
				'Cookie': `ohCSRF=${csrfCookie}`,
			},
			body: JSON.stringify({ username: 'testuser', password: 'testpassword' }),
		});

		const authCookie = loginRes.headers.get('set-cookie').match(/AuthStore=([^;]+)/)[1];

		// Now request with auth cookie
		const res = await fetch(`${baseUrl}/`, {
			headers: {
				'Cookie': `AuthStore=${authCookie}`,
			},
		});

		assert.strictEqual(res.status, 200);
		const text = await res.text();
		assert.strictEqual(text, 'Authenticated');
	});

	it('API returns 401 JSON not login page', async () => {
		const res = await fetch(`${baseUrl}/api/settings`);
		assert.strictEqual(res.status, 401);
		const data = await res.json();
		assert.ok('error' in data);
	});

	it('CSRF token is 64 hex characters', async () => {
		const res = await fetch(`${baseUrl}/`);
		const setCookie = res.headers.get('set-cookie');
		const match = setCookie.match(/ohCSRF=([^;]+)/);
		const token = match[1];
		assert.strictEqual(token.length, 64);
		assert.ok(/^[0-9a-f]+$/.test(token));
	});

	it('CSRF cookie is SameSite=Strict', async () => {
		const res = await fetch(`${baseUrl}/`);
		const setCookie = res.headers.get('set-cookie');
		assert.ok(setCookie.includes('SameSite=Strict'));
	});

	it('CSRF cookie is not HttpOnly (JS can read)', async () => {
		const res = await fetch(`${baseUrl}/`);
		const setCookie = res.headers.get('set-cookie');
		// Find the CSRF cookie part
		const csrfPart = setCookie.split(',').find(c => c.includes('ohCSRF'));
		assert.ok(!csrfPart.toLowerCase().includes('httponly'));
	});
});
