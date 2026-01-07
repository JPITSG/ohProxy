'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const crypto = require('crypto');

const { basicAuthHeader, TEST_USERS, TEST_COOKIE_KEY, generateTestAuthCookie } = require('../test-helpers');

// Create access control test app
function createAccessControlApp(config = {}) {
	const app = express();

	const USERS = config.users || TEST_USERS;
	const ALLOW_SUBNETS = config.allowSubnets || ['0.0.0.0'];
	const AUTH_COOKIE_NAME = config.cookieName || 'AuthStore';
	const AUTH_COOKIE_KEY = config.cookieKey || TEST_COOKIE_KEY;
	const AUTH_COOKIE_DAYS = config.cookieDays || 365;
	const PROXY_ALLOWLIST = config.proxyAllowlist || [];

	const sessions = new Map();
	const authLockouts = new Map();

	function safeText(value) {
		return value === null || value === undefined ? '' : String(value);
	}

	function normalizeRemoteIp(value) {
		const raw = safeText(value).trim();
		if (!raw) return '';
		if (raw.startsWith('::ffff:')) return raw.slice(7);
		return raw;
	}

	function isValidIpv4(value) {
		const parts = safeText(value).split('.');
		if (parts.length !== 4) return false;
		return parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
	}

	function ipToLong(ip) {
		if (!isValidIpv4(ip)) return null;
		return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0);
	}

	function ipInSubnet(ip, cidr) {
		if (cidr === '0.0.0.0' || cidr === '0.0.0.0/0') return true;
		const parts = safeText(cidr).split('/');
		if (parts.length !== 2) return false;
		const subnet = parts[0];
		const mask = Number(parts[1]);
		if (!Number.isInteger(mask) || mask < 0 || mask > 32) return false;
		const ipLong = ipToLong(ip);
		const subnetLong = ipToLong(subnet);
		if (ipLong === null || subnetLong === null) return false;
		const maskLong = mask === 0 ? 0 : (0xffffffff << (32 - mask)) >>> 0;
		return (ipLong & maskLong) === (subnetLong & maskLong);
	}

	function ipInAnySubnet(ip, subnets) {
		if (!Array.isArray(subnets) || !subnets.length) return false;
		for (const cidr of subnets) {
			if (ipInSubnet(ip, cidr)) return true;
		}
		return false;
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
		try {
			const sigBuf = Buffer.from(sig, 'hex');
			const expectedBuf = Buffer.from(expected, 'hex');
			if (sigBuf.length !== expectedBuf.length) return null;
			if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
		} catch {
			return null;
		}
		return user;
	}

	function isProxyAllowed(host) {
		if (!PROXY_ALLOWLIST.length) return false;
		return PROXY_ALLOWLIST.some(h => h.toLowerCase() === host.toLowerCase());
	}

	// Test endpoint to simulate different client IPs
	app.use((req, res, next) => {
		// Allow setting test IP via header
		const testIp = req.headers['x-test-client-ip'];
		req.clientIp = normalizeRemoteIp(testIp || req.socket?.remoteAddress || '');
		next();
	});

	// IP allowSubnets check
	app.use((req, res, next) => {
		if (!ipInAnySubnet(req.clientIp, ALLOW_SUBNETS)) {
			return res.status(403).json({ error: 'IP not allowed' });
		}
		next();
	});

	// Auth check (always required)
	app.use((req, res, next) => {
		// Auth-exempt paths (manifest with referer)
		if (req.path === '/manifest.webmanifest' && req.headers.referer) {
			req.authInfo = { auth: 'exempt', user: null };
			return next();
		}

		// Check cookie auth
		const cookieUser = getAuthCookieUser(req);
		if (cookieUser) {
			req.authInfo = { auth: 'authenticated', user: cookieUser };
			res.setHeader('X-OhProxy-Authenticated', 'true');
			return next();
		}

		// Check basic auth
		const authHeader = req.headers.authorization;
		const [user, pass] = parseBasicAuthHeader(authHeader);
		if (user && USERS[user] === pass) {
			req.authInfo = { auth: 'authenticated', user };
			res.setHeader('X-OhProxy-Authenticated', 'true');
			return next();
		}

		// Auth required
		res.setHeader('WWW-Authenticate', 'Basic realm="Test"');
		res.status(401).send('Unauthorized');
	});

	// Auth-exempt paths with referrer check
	app.get('/manifest.webmanifest', (req, res, next) => {
		if (req.headers.referer) {
			// Allow with referrer even without full auth
			return res.json({ name: 'test' });
		}
		// Otherwise, require auth (handled by middleware above)
		next();
	});

	app.get('/', (req, res) => {
		res.json({ authenticated: true, user: req.authInfo?.user });
	});

	app.get('/proxy', (req, res) => {
		const host = safeText(req.query.host || '').trim();
		if (!isProxyAllowed(host)) {
			return res.status(403).json({ error: 'Host not in allowlist' });
		}
		res.json({ allowed: true, host });
	});

	// Session tracking endpoint
	app.get('/api/session', (req, res) => {
		res.json({
			ip: req.clientIp,
			user: req.authInfo?.user,
		});
	});

	return app;
}

describe('Access Control Security Tests', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createAccessControlApp({
			allowSubnets: ['192.168.0.0/16', '10.0.0.0/8'],
			proxyAllowlist: ['allowed.example.com', 'api.example.com'],
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

	describe('IP Allow Subnets', () => {
		it('blocked IP returns 403', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: {
					'X-Test-Client-IP': '172.16.0.1',
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
				},
			});
			assert.strictEqual(res.status, 403);
		});

		it('allowed IP in 192.168.x.x proceeds', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: {
					'X-Test-Client-IP': '192.168.5.100',
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
				},
			});
			assert.strictEqual(res.status, 200);
		});

		it('allowed IP in 10.x.x.x proceeds', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: {
					'X-Test-Client-IP': '10.50.100.200',
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
				},
			});
			assert.strictEqual(res.status, 200);
		});
	});

	describe('IPv6-mapped IPv4', () => {
		it('::ffff: prefix is normalized', async () => {
			const res = await fetch(`${baseUrl}/api/session`, {
				headers: {
					'X-Test-Client-IP': '::ffff:192.168.1.100',
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
				},
			});
			assert.strictEqual(res.status, 200);
			const data = await res.json();
			assert.strictEqual(data.ip, '192.168.1.100');
		});
	});

	describe('Auth Cookie Expiry', () => {
		it('expired cookie is rejected', async () => {
			// Create an expired cookie (expiry in the past)
			const expiredCookie = generateTestAuthCookie('testuser', 'testpassword', TEST_COOKIE_KEY, -1);
			const res = await fetch(`${baseUrl}/`, {
				headers: {
					'X-Test-Client-IP': '192.168.5.100',
					'Cookie': `AuthStore=${expiredCookie}`,
				},
			});
			assert.strictEqual(res.status, 401);
		});

		it('valid cookie is accepted', async () => {
			const validCookie = generateTestAuthCookie('testuser', 'testpassword', TEST_COOKIE_KEY, 365);
			const res = await fetch(`${baseUrl}/`, {
				headers: {
					'X-Test-Client-IP': '192.168.5.100',
					'Cookie': `AuthStore=${validCookie}`,
				},
			});
			assert.strictEqual(res.status, 200);
		});
	});

	describe('Proxy Allowlist', () => {
		it('allowed host passes', async () => {
			const res = await fetch(`${baseUrl}/proxy?host=allowed.example.com`, {
				headers: {
					'X-Test-Client-IP': '192.168.1.100',
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
				},
			});
			assert.strictEqual(res.status, 200);
		});

		it('blocked host returns 403', async () => {
			const res = await fetch(`${baseUrl}/proxy?host=evil.example.com`, {
				headers: {
					'X-Test-Client-IP': '192.168.1.100',
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
				},
			});
			assert.strictEqual(res.status, 403);
		});

		it('host matching is case-insensitive', async () => {
			const res = await fetch(`${baseUrl}/proxy?host=ALLOWED.EXAMPLE.COM`, {
				headers: {
					'X-Test-Client-IP': '192.168.1.100',
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
				},
			});
			assert.strictEqual(res.status, 200);
		});
	});

	describe('Auth-Exempt Paths', () => {
		it('manifest allowed with referrer', async () => {
			const res = await fetch(`${baseUrl}/manifest.webmanifest`, {
				headers: {
					'X-Test-Client-IP': '192.168.5.100',
					'Referer': 'http://example.com/',
					// No Authorization header
				},
			});
			// Either allowed because of referer or requires auth
			// The test app allows with referer
			assert.strictEqual(res.status, 200);
		});
	});

	describe('Multiple Auth Methods', () => {
		it('cookie auth is tried first', async () => {
			const validCookie = generateTestAuthCookie('testuser', 'testpassword', TEST_COOKIE_KEY, 365);
			const res = await fetch(`${baseUrl}/api/session`, {
				headers: {
					'X-Test-Client-IP': '192.168.5.100',
					'Cookie': `AuthStore=${validCookie}`,
				},
			});
			const data = await res.json();
			assert.strictEqual(data.user, 'testuser');
		});

		it('basic auth works as fallback', async () => {
			const res = await fetch(`${baseUrl}/api/session`, {
				headers: {
					'X-Test-Client-IP': '192.168.5.100',
					'Authorization': basicAuthHeader('admin', 'adminpass123'),
				},
			});
			const data = await res.json();
			assert.strictEqual(data.user, 'admin');
		});
	});

	describe('Session IP Tracking', () => {
		it('client IP is tracked', async () => {
			const res = await fetch(`${baseUrl}/api/session`, {
				headers: {
					'X-Test-Client-IP': '192.168.1.123',
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
				},
			});
			const data = await res.json();
			assert.strictEqual(data.ip, '192.168.1.123');
		});
	});
});

describe('Access Control with Allow-All Subnet', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createAccessControlApp({
			allowSubnets: ['0.0.0.0'],
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

	it('0.0.0.0 allows all IPs', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: {
				'X-Test-Client-IP': '203.0.113.50',
				'Authorization': basicAuthHeader('testuser', 'testpassword'),
			},
		});
		assert.strictEqual(res.status, 200);
	});
});

describe('Access Control with Empty Subnets', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createAccessControlApp({
			allowSubnets: [],
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

	it('empty allowSubnets blocks all', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: {
				'X-Test-Client-IP': '192.168.1.1',
				'Authorization': basicAuthHeader('testuser', 'testpassword'),
			},
		});
		assert.strictEqual(res.status, 403);
	});
});
