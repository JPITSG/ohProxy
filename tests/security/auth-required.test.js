'use strict';

/**
 * Authentication Required Tests
 *
 * Tests that all protected endpoints properly require authentication
 * and return 401 or redirect to login when accessed without auth.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');

const {
	basicAuthHeader,
	TEST_USERS,
	TEST_COOKIE_KEY,
	generateTestAuthCookie,
	parseAuthCookieValue,
	getCookieValueFromHeader,
} = require('../test-helpers');

// Create a minimal test app that mirrors the auth behavior of the real server
function createAuthTestApp(config = {}) {
	const app = express();

	const USERS = config.users || TEST_USERS;
	const AUTH_MODE = config.authMode || 'html';
	const AUTH_COOKIE_NAME = config.cookieName || 'AuthStore';
	const AUTH_COOKIE_KEY = config.cookieKey || TEST_COOKIE_KEY;

	function safeText(value) {
		return value === null || value === undefined ? '' : String(value);
	}

	function getRequestPath(req) {
		const raw = safeText(req?.originalUrl || req?.url || '');
		if (!raw) return '';
		const q = raw.indexOf('?');
		return q === -1 ? raw : raw.slice(0, q);
	}

	function isAuthExemptPath(req) {
		const pathname = getRequestPath(req);
		if (!pathname) return false;
		if (pathname === '/manifest.webmanifest') return true;
		return false;
	}

	function hasMatchingReferrer(req) {
		const ref = safeText(req?.headers?.referer || req?.headers?.referrer || '').trim();
		const host = safeText(req?.headers?.host || '').trim().toLowerCase();
		if (!ref || !host) return false;
		let refUrl;
		try {
			refUrl = new URL(ref);
		} catch {
			return false;
		}
		return safeText(refUrl.host).trim().toLowerCase() === host;
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

	function getAuthCookieUser(req) {
		const raw = getCookieValueFromHeader(req?.headers?.cookie, AUTH_COOKIE_NAME);
		const parsed = parseAuthCookieValue(raw, USERS, AUTH_COOKIE_KEY);
		return parsed ? parsed.user : null;
	}

	// Auth middleware - mirrors server.js behavior
	app.use((req, res, next) => {
		// Manifest requires matching referrer for PWA install
		if (isAuthExemptPath(req) && hasMatchingReferrer(req)) {
			req.ohProxyAuth = 'unauthenticated';
			return next();
		}

		// HTML auth mode
		if (AUTH_MODE === 'html') {
			// Check cookie auth
			if (AUTH_COOKIE_KEY && AUTH_COOKIE_NAME) {
				const cookieUser = getAuthCookieUser(req);
				if (cookieUser) {
					req.ohProxyAuth = 'authenticated';
					req.ohProxyUser = cookieUser;
					return next();
				}
			}

			// Allow login.js and fonts
			if (req.path === '/login.js' || req.path.startsWith('/fonts/')) {
				req.ohProxyAuth = 'unauthenticated';
				return next();
			}

			// Not authenticated - check request type
			const acceptHeader = req.headers.accept || '';
			const reqPath = req.path.toLowerCase();

			const isHtmlPageRequest = acceptHeader.includes('text/html') &&
				!reqPath.endsWith('.js') &&
				!reqPath.endsWith('.css') &&
				!reqPath.endsWith('.png') &&
				!reqPath.endsWith('.jpg') &&
				!reqPath.endsWith('.ico') &&
				!reqPath.endsWith('.svg') &&
				!reqPath.endsWith('.woff') &&
				!reqPath.endsWith('.woff2');

			if (isHtmlPageRequest) {
				// Redirect non-root paths to / for login
				if (req.path !== '/') {
					return res.redirect('/');
				}
				// Serve login page
				return res.status(200).send('LOGIN_PAGE');
			}

			// API/asset requests without auth - return 401
			return res.status(401).json({ error: 'Authentication required' });
		}

		// Basic auth mode
		const [user, pass] = parseBasicAuthHeader(req.headers.authorization);
		if (user && USERS[user] === pass) {
			req.ohProxyAuth = 'authenticated';
			req.ohProxyUser = user;
			return next();
		}

		res.setHeader('WWW-Authenticate', 'Basic realm="Test"');
		res.status(401).send('Unauthorized');
	});

	// Test endpoints mirroring server.js routes
	app.post('/api/auth/login', express.json(), (req, res) => {
		res.json({ info: 'Login endpoint - always accessible' });
	});

	app.get('/config.js', (req, res) => {
		res.type('application/javascript').send('window.__CONFIG__={};');
	});

	app.get('/api/settings', (req, res) => {
		res.json({ settings: {} });
	});

	app.post('/api/settings', express.json(), (req, res) => {
		res.json({ success: true });
	});

	app.get('/api/card-config/:widgetId', (req, res) => {
		res.json({ rules: {} });
	});

	app.post('/api/card-config', express.json(), (req, res) => {
		res.json({ success: true });
	});

	app.get('/sw.js', (req, res) => {
		res.type('application/javascript').send('// SW');
	});

	app.get('/manifest.webmanifest', (req, res) => {
		res.json({ name: 'test' });
	});

	app.get('/search-index', (req, res) => {
		res.json({ items: [] });
	});

	app.get('/video-preview', (req, res) => {
		res.json({ preview: 'test' });
	});

	app.get('/presence', (req, res) => {
		res.type('text/html').send('<!DOCTYPE html><html><body>Map</body></html>');
	});

	app.get('/proxy', (req, res) => {
		res.json({ proxied: true });
	});

	app.get(['/', '/index.html'], (req, res) => {
		res.send('MAIN_PAGE');
	});

	app.get('/login', (req, res) => {
		res.send('LOGIN_PAGE');
	});

	// Versioned assets
	app.get(/^\/app\.v[\w.-]+\.js$/i, (req, res) => {
		res.type('application/javascript').send('// App JS');
	});

	app.get(/^\/tailwind\.v[\w.-]+\.css$/i, (req, res) => {
		res.type('text/css').send('/* CSS */');
	});

	app.get(/^\/styles\.v[\w.-]+\.css$/i, (req, res) => {
		res.type('text/css').send('/* CSS */');
	});

	app.get(/^\/icons\/apple-touch-icon\.v[\w.-]+\.png$/i, (req, res) => {
		res.type('image/png').send('PNG');
	});

	app.get('/icons/icon-192.png', (req, res) => {
		res.type('image/png').send('PNG');
	});

	app.get('/favicon.ico', (req, res) => {
		res.type('image/x-icon').send('ICO');
	});

	app.get('/images/v1/test.png', (req, res) => {
		res.type('image/png').send('PNG');
	});

	app.get('/login.js', (req, res) => {
		res.type('application/javascript').send('// Login JS');
	});

	app.get('/fonts/test.woff2', (req, res) => {
		res.type('font/woff2').send('FONT');
	});

	return app;
}

describe('Authentication Required Tests - HTML Mode', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createAuthTestApp({ authMode: 'html' });
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

	describe('Protected Endpoints Return 401 Without Auth', () => {
		const protectedEndpoints = [
			{ method: 'GET', path: '/config.js', description: 'Client config' },
			{ method: 'GET', path: '/api/settings', description: 'User settings GET' },
			{ method: 'POST', path: '/api/settings', description: 'User settings POST', body: '{}' },
			{ method: 'GET', path: '/api/card-config/test123', description: 'Card config GET' },
			{ method: 'POST', path: '/api/card-config', description: 'Card config POST', body: '{}' },
			{ method: 'GET', path: '/search-index', description: 'Search index' },
			{ method: 'GET', path: '/video-preview?url=rtsp://test', description: 'Video preview' },
			{ method: 'GET', path: '/presence', description: 'GPS presence map' },
			{ method: 'GET', path: '/proxy?url=http://test', description: 'Proxy endpoint' },
			{ method: 'GET', path: '/app.v123.js', description: 'App JS (versioned)' },
			{ method: 'GET', path: '/tailwind.v123.css', description: 'Tailwind CSS (versioned)' },
			{ method: 'GET', path: '/styles.v123.css', description: 'Styles CSS (versioned)' },
		];

		for (const endpoint of protectedEndpoints) {
			it(`${endpoint.method} ${endpoint.path} - ${endpoint.description} returns 401`, async () => {
				const options = {
					method: endpoint.method,
					headers: {},
				};
				if (endpoint.body) {
					options.body = endpoint.body;
					options.headers['Content-Type'] = 'application/json';
				}
				const res = await fetch(`${baseUrl}${endpoint.path}`, options);
				assert.strictEqual(res.status, 401, `Expected 401 for ${endpoint.path}, got ${res.status}`);
			});
		}
	});

	describe('HTML Page Requests Redirect or Serve Login', () => {
		it('GET / serves login page', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: { 'Accept': 'text/html' },
			});
			// Should serve login page (200) in HTML mode
			assert.strictEqual(res.status, 200);
			const body = await res.text();
			assert.ok(body.includes('LOGIN_PAGE'), 'Should serve login page');
		});

		it('GET /login serves login page', async () => {
			const res = await fetch(`${baseUrl}/login`, {
				headers: { 'Accept': 'text/html' },
			});
			// In our test app, /login redirects to / for login
			assert.ok(res.status === 302 || res.status === 200);
		});

	});

	describe('Auth-Exempt Paths', () => {
		it('/manifest.webmanifest with matching referrer is allowed', async () => {
			const res = await fetch(`${baseUrl}/manifest.webmanifest`, {
				headers: { 'Referer': `${baseUrl}/` },
			});
			assert.strictEqual(res.status, 200);
		});

		it('/manifest.webmanifest without referrer returns 401', async () => {
			const res = await fetch(`${baseUrl}/manifest.webmanifest`);
			assert.strictEqual(res.status, 401);
		});

		it('/login.js is allowed (needed for login page)', async () => {
			const res = await fetch(`${baseUrl}/login.js`);
			assert.strictEqual(res.status, 200);
		});

		it('/fonts/* is allowed (needed for login page)', async () => {
			const res = await fetch(`${baseUrl}/fonts/test.woff2`);
			assert.strictEqual(res.status, 200);
		});
	});

	describe('Auth-Required Paths (previously exempt)', () => {
		it('/images/*.ext requires auth', async () => {
			const res = await fetch(`${baseUrl}/images/v1/test.png`);
			assert.strictEqual(res.status, 401);
		});

		it('/sw.js requires auth even with matching referrer', async () => {
			const res = await fetch(`${baseUrl}/sw.js`, {
				headers: { 'Referer': `${baseUrl}/` },
			});
			assert.strictEqual(res.status, 401);
		});

		it('/favicon.ico requires auth even with matching referrer', async () => {
			const res = await fetch(`${baseUrl}/favicon.ico`, {
				headers: { 'Referer': `${baseUrl}/` },
			});
			assert.strictEqual(res.status, 401);
		});

		it('/icons/* requires auth even with matching referrer', async () => {
			const res = await fetch(`${baseUrl}/icons/icon-192.png`, {
				headers: { 'Referer': `${baseUrl}/` },
			});
			assert.strictEqual(res.status, 401);
		});
	});

	describe('Authenticated Access Works', () => {
		it('protected endpoint with valid cookie returns 200', async () => {
			const validCookie = generateTestAuthCookie('testuser', 'testpassword', TEST_COOKIE_KEY, 365);
			const res = await fetch(`${baseUrl}/api/settings`, {
				headers: { 'Cookie': `AuthStore=${validCookie}` },
			});
			assert.strictEqual(res.status, 200);
		});

		it('main page with valid cookie returns content', async () => {
			const validCookie = generateTestAuthCookie('testuser', 'testpassword', TEST_COOKIE_KEY, 365);
			const res = await fetch(`${baseUrl}/`, {
				headers: {
					'Accept': 'text/html',
					'Cookie': `AuthStore=${validCookie}`,
				},
			});
			assert.strictEqual(res.status, 200);
			const body = await res.text();
			assert.ok(body.includes('MAIN_PAGE'), 'Should serve main page when authenticated');
		});
	});
});

describe('Authentication Required Tests - Basic Auth Mode', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createAuthTestApp({ authMode: 'basic' });
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

	describe('Protected Endpoints Return 401 Without Auth', () => {
		const protectedEndpoints = [
			{ method: 'GET', path: '/', description: 'Main page' },
			{ method: 'GET', path: '/config.js', description: 'Client config' },
			{ method: 'GET', path: '/api/settings', description: 'User settings' },
			{ method: 'GET', path: '/search-index', description: 'Search index' },
			{ method: 'GET', path: '/presence', description: 'GPS presence map' },
			{ method: 'GET', path: '/proxy?url=http://test', description: 'Proxy endpoint' },
		];

		for (const endpoint of protectedEndpoints) {
			it(`${endpoint.method} ${endpoint.path} - ${endpoint.description} returns 401`, async () => {
				const res = await fetch(`${baseUrl}${endpoint.path}`);
				assert.strictEqual(res.status, 401, `Expected 401 for ${endpoint.path}, got ${res.status}`);
				// Basic auth should have WWW-Authenticate header
				const wwwAuth = res.headers.get('WWW-Authenticate');
				assert.ok(wwwAuth && wwwAuth.toLowerCase().includes('basic'), 'Should have Basic WWW-Authenticate header');
			});
		}
	});

	describe('Authenticated Access Works', () => {
		it('protected endpoint with valid basic auth returns 200', async () => {
			const res = await fetch(`${baseUrl}/api/settings`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
		});

		it('main page with valid basic auth returns content', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
		});

		it('invalid credentials return 401', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'wrongpassword') },
			});
			assert.strictEqual(res.status, 401);
		});
	});
});

describe('Referrer Validation', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createAuthTestApp({ authMode: 'html' });
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

	it('mismatched referrer host is rejected', async () => {
		const res = await fetch(`${baseUrl}/manifest.webmanifest`, {
			headers: { 'Referer': 'http://evil.com/' },
		});
		assert.strictEqual(res.status, 401);
	});

	it('matching referrer host is accepted', async () => {
		const res = await fetch(`${baseUrl}/manifest.webmanifest`, {
			headers: { 'Referer': `${baseUrl}/somepage` },
		});
		assert.strictEqual(res.status, 200);
	});

	it('referrer with different port is rejected', async () => {
		const res = await fetch(`${baseUrl}/manifest.webmanifest`, {
			headers: { 'Referer': 'http://127.0.0.1:9999/' },
		});
		assert.strictEqual(res.status, 401);
	});
});
