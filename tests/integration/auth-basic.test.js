'use strict';

const { describe, it, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const { basicAuthHeader, TEST_USERS, TEST_COOKIE_KEY } = require('../test-helpers');

// Create a minimal test server that replicates auth behavior
function createTestApp(config = {}) {
	const app = express();

	const AUTH_REALM = config.realm || 'Test Realm';
	const AUTH_COOKIE_NAME = config.cookieName || 'AuthStore';
	const AUTH_COOKIE_KEY = config.cookieKey || TEST_COOKIE_KEY;
	const AUTH_COOKIE_DAYS = config.cookieDays || 365;
	const WHITELIST_SUBNETS = config.whitelistSubnets || [];
	const LAN_SUBNETS = config.lanSubnets || [];
	const USERS = config.users || TEST_USERS;

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

	function parseBasicAuthHeader(value) {
		if (!value) return [null, null];
		if (!/^basic /i.test(value)) return [null, null];
		const encoded = value.slice(6).trim();
		if (!encoded) return [null, null];
		let decoded = '';
		try {
			decoded = Buffer.from(encoded, 'base64').toString('utf8');
		} catch {
			return [null, null];
		}
		const idx = decoded.indexOf(':');
		if (idx === -1) return [decoded, ''];
		return [decoded.slice(0, idx), decoded.slice(idx + 1)];
	}

	function normalizeRemoteIp(value) {
		const raw = safeText(value).trim();
		if (!raw) return '';
		if (raw.startsWith('::ffff:')) return raw.slice(7);
		return raw;
	}

	function ipInSubnet(ip, cidr) {
		// Simplified - just check if 0.0.0.0
		if (cidr === '0.0.0.0' || cidr === '0.0.0.0/0') return true;
		// Basic /24 check
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

	// Auth middleware
	app.use((req, res, next) => {
		const ip = normalizeRemoteIp(req.socket?.remoteAddress || '');
		req.clientIp = ip;

		// Check whitelist
		if (ipInAnySubnet(ip, WHITELIST_SUBNETS)) {
			req.authInfo = { auth: 'authenticated', user: 'whitelist', lan: true };
			res.setHeader('X-OhProxy-Authenticated', 'true');
			res.setHeader('X-OhProxy-Lan', 'true');
			return next();
		}

		// Check LAN
		if (ipInAnySubnet(ip, LAN_SUBNETS)) {
			req.authInfo = { auth: 'authenticated', user: 'lan', lan: true };
			res.setHeader('X-OhProxy-Authenticated', 'true');
			res.setHeader('X-OhProxy-Lan', 'true');
			return next();
		}

		// Check cookie auth
		const cookieUser = getAuthCookieUser(req);
		if (cookieUser) {
			req.authInfo = { auth: 'authenticated', user: cookieUser, lan: false };
			res.setHeader('X-OhProxy-Authenticated', 'true');
			res.setHeader('X-OhProxy-Lan', 'false');
			return next();
		}

		// Check basic auth
		const authHeader = req.headers.authorization;
		const [user, pass] = parseBasicAuthHeader(authHeader);

		if (user && USERS[user] === pass) {
			req.authInfo = { auth: 'authenticated', user, lan: false };
			res.setHeader('X-OhProxy-Authenticated', 'true');
			res.setHeader('X-OhProxy-Lan', 'false');

			// Set auth cookie
			if (AUTH_COOKIE_KEY && AUTH_COOKIE_NAME) {
				const expiry = Math.floor(Date.now() / 1000) + Math.round(AUTH_COOKIE_DAYS * 86400);
				const cookieValue = buildAuthCookieValue(user, pass, AUTH_COOKIE_KEY, expiry);
				const expires = new Date(expiry * 1000).toUTCString();
				const parts = [
					`${AUTH_COOKIE_NAME}=${cookieValue}`,
					'Path=/',
					`Expires=${expires}`,
					'HttpOnly',
					'SameSite=Lax',
				];
				res.setHeader('Set-Cookie', parts.join('; '));
			}

			return next();
		}

		// Auth required
		res.setHeader('X-OhProxy-Authenticated', 'false');
		res.setHeader('X-OhProxy-Lan', 'false');
		res.setHeader('WWW-Authenticate', `Basic realm="${AUTH_REALM}"`);
		res.status(401).type('text/plain').send('Unauthorized');
	});

	// Test routes
	app.get('/', (req, res) => {
		res.send('OK');
	});

	app.get('/api/settings', (req, res) => {
		res.json({ darkMode: true });
	});

	app.get('/app.js', (req, res) => {
		res.type('application/javascript').send('// app.js');
	});

	app.get('/styles.css', (req, res) => {
		res.type('text/css').send('/* styles */');
	});

	return app;
}

describe('Basic Auth Integration', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createTestApp({
			realm: 'openHAB Proxy',
			lanSubnets: ['192.168.1.0/24'],
			whitelistSubnets: ['10.0.0.0/24'],
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

	it('returns 401 without credentials', async () => {
		const res = await fetch(`${baseUrl}/`);
		assert.strictEqual(res.status, 401);
		assert.ok(res.headers.get('www-authenticate'));
	});

	it('returns 401 with wrong password', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: {
				'Authorization': basicAuthHeader('testuser', 'wrongpassword'),
			},
		});
		assert.strictEqual(res.status, 401);
	});

	it('returns 401 with unknown user', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: {
				'Authorization': basicAuthHeader('unknownuser', 'somepass'),
			},
		});
		assert.strictEqual(res.status, 401);
	});

	it('returns 200 with valid credentials', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: {
				'Authorization': basicAuthHeader('testuser', 'testpassword'),
			},
		});
		assert.strictEqual(res.status, 200);
	});

	it('sets AuthStore cookie on success', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: {
				'Authorization': basicAuthHeader('testuser', 'testpassword'),
			},
		});
		const setCookie = res.headers.get('set-cookie');
		assert.ok(setCookie);
		assert.ok(setCookie.includes('AuthStore='));
	});

	it('cookie allows subsequent requests', async () => {
		// First request to get cookie
		const res1 = await fetch(`${baseUrl}/`, {
			headers: {
				'Authorization': basicAuthHeader('testuser', 'testpassword'),
			},
		});
		const setCookie = res1.headers.get('set-cookie');
		const match = setCookie.match(/AuthStore=([^;]+)/);
		const cookieValue = match[1];

		// Second request with just cookie
		const res2 = await fetch(`${baseUrl}/`, {
			headers: {
				'Cookie': `AuthStore=${cookieValue}`,
			},
		});
		assert.strictEqual(res2.status, 200);
	});

	it('static assets require auth', async () => {
		const res = await fetch(`${baseUrl}/app.js`);
		assert.strictEqual(res.status, 401);
	});

	it('static assets work with auth', async () => {
		const res = await fetch(`${baseUrl}/app.js`, {
			headers: {
				'Authorization': basicAuthHeader('testuser', 'testpassword'),
			},
		});
		assert.strictEqual(res.status, 200);
	});

	it('API endpoints require auth', async () => {
		const res = await fetch(`${baseUrl}/api/settings`);
		assert.strictEqual(res.status, 401);
	});

	it('API endpoints work with auth', async () => {
		const res = await fetch(`${baseUrl}/api/settings`, {
			headers: {
				'Authorization': basicAuthHeader('testuser', 'testpassword'),
			},
		});
		assert.strictEqual(res.status, 200);
		const data = await res.json();
		assert.ok('darkMode' in data);
	});

	it('sets X-OhProxy-Authenticated header', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: {
				'Authorization': basicAuthHeader('testuser', 'testpassword'),
			},
		});
		assert.strictEqual(res.headers.get('x-ohproxy-authenticated'), 'true');
	});

	it('sets X-OhProxy-Lan header to false for non-LAN', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: {
				'Authorization': basicAuthHeader('testuser', 'testpassword'),
			},
		});
		assert.strictEqual(res.headers.get('x-ohproxy-lan'), 'false');
	});

	it('WWW-Authenticate has correct realm', async () => {
		const res = await fetch(`${baseUrl}/`);
		const auth = res.headers.get('www-authenticate');
		assert.ok(auth.includes('openHAB Proxy'));
	});

	it('sets authenticated false on failure', async () => {
		const res = await fetch(`${baseUrl}/`);
		assert.strictEqual(res.headers.get('x-ohproxy-authenticated'), 'false');
	});

	it('handles admin user', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: {
				'Authorization': basicAuthHeader('admin', 'adminpass123'),
			},
		});
		assert.strictEqual(res.status, 200);
	});

	it('cookie includes HttpOnly', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: {
				'Authorization': basicAuthHeader('testuser', 'testpassword'),
			},
		});
		const setCookie = res.headers.get('set-cookie');
		assert.ok(setCookie.toLowerCase().includes('httponly'));
	});

	it('cookie includes SameSite=Lax', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: {
				'Authorization': basicAuthHeader('testuser', 'testpassword'),
			},
		});
		const setCookie = res.headers.get('set-cookie');
		assert.ok(setCookie.includes('SameSite=Lax'));
	});
});
