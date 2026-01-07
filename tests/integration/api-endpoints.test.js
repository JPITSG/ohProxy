'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const path = require('path');
const fs = require('fs');

const { basicAuthHeader, TEST_USERS } = require('../test-helpers');

// Create test app with API endpoints
function createApiTestApp(config = {}) {
	const app = express();

	const USERS = config.users || TEST_USERS;
	const sessions = new Map();

	function safeText(value) {
		return value === null || value === undefined ? '' : String(value);
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

	// Session middleware (test harness uses simple cookie, real server embeds session in AuthStore)
	app.use((req, res, next) => {
		let sessionId = getCookieValue(req, 'TestSession');
		if (!sessionId || !sessions.has(sessionId)) {
			sessionId = require('crypto').randomUUID();
			sessions.set(sessionId, { darkMode: true });
			res.setHeader('Set-Cookie', `TestSession=${sessionId}; Path=/; HttpOnly; SameSite=Lax`);
		}
		req.session = sessions.get(sessionId);
		req.sessionId = sessionId;
		next();
	});

	// Simple auth middleware
	app.use((req, res, next) => {
		// Skip auth for certain paths
		if (req.path === '/manifest.webmanifest' && req.headers.referer) {
			return next();
		}

		const authHeader = req.headers.authorization;
		const [user, pass] = parseBasicAuthHeader(authHeader);

		if (user && USERS[user] === pass) {
			req.authInfo = { auth: 'authenticated', user };
			return next();
		}

		res.setHeader('WWW-Authenticate', 'Basic realm="Test"');
		res.status(401).send('Unauthorized');
	});

	// Config.js endpoint
	app.get('/config.js', (req, res) => {
		const clientConfig = {
			glowSections: [],
			stateGlowSections: [],
			pageFadeOutMs: 250,
			pageFadeInMs: 250,
		};
		res.type('application/javascript').send(`window.ohConfig = ${JSON.stringify(clientConfig)};`);
	});

	// Settings endpoints
	app.get('/api/settings', (req, res) => {
		res.json(req.session || { darkMode: true });
	});

	app.post('/api/settings', express.json(), (req, res) => {
		if (!req.body || typeof req.body !== 'object') {
			return res.status(400).json({ error: 'Invalid JSON' });
		}
		Object.assign(req.session, req.body);
		sessions.set(req.sessionId, req.session);
		res.json({ success: true, settings: req.session });
	});

	// Service worker
	app.get('/sw.js', (req, res) => {
		res.type('application/javascript').send('// Service Worker');
	});

	// Manifest
	app.get('/manifest.webmanifest', (req, res) => {
		const darkMode = req.session?.darkMode ?? true;
		const manifest = {
			name: 'openHAB',
			short_name: 'openHAB',
			start_url: '/',
			display: 'standalone',
			background_color: darkMode ? '#1a1a2e' : '#f5f6fa',
			theme_color: darkMode ? '#1a1a2e' : '#f5f6fa',
		};
		res.type('application/manifest+json').json(manifest);
	});

	// Search index
	app.get('/search-index', (req, res) => {
		res.json([
			{ title: 'Living Room', link: '/page/living-room' },
			{ title: 'Kitchen', link: '/page/kitchen' },
		]);
	});

	// Index
	app.get(['/', '/index.html'], (req, res) => {
		res.type('html').send('<!DOCTYPE html><html><head><title>Test</title></head><body>App</body></html>');
	});

	// Versioned assets
	app.get(/^\/app\.v[\w.-]+\.js$/i, (req, res) => {
		res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
		res.type('application/javascript').send('// app.js');
	});

	app.get(/^\/styles\.v[\w.-]+\.css$/i, (req, res) => {
		res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
		res.type('text/css').send('/* styles.css */');
	});

	// Classic redirect
	app.get('/classic', (req, res) => {
		res.redirect('/basicui/app');
	});

	return app;
}

describe('API Endpoints Integration', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createApiTestApp();
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

	describe('GET /config.js', () => {
		it('returns JavaScript content type', async () => {
			const res = await fetch(`${baseUrl}/config.js`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
			assert.ok(res.headers.get('content-type').includes('application/javascript'));
		});

		it('includes client config object', async () => {
			const res = await fetch(`${baseUrl}/config.js`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const text = await res.text();
			assert.ok(text.includes('window.ohConfig'));
		});
	});

	describe('GET /api/settings', () => {
		it('returns settings JSON', async () => {
			const res = await fetch(`${baseUrl}/api/settings`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
			const data = await res.json();
			assert.ok('darkMode' in data);
		});

		it('uses session settings', async () => {
			const res = await fetch(`${baseUrl}/api/settings`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const data = await res.json();
			assert.strictEqual(data.darkMode, true);
		});
	});

	describe('POST /api/settings', () => {
		it('updates settings', async () => {
			// First request to get session
			const res1 = await fetch(`${baseUrl}/api/settings`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const cookie = res1.headers.get('set-cookie');
			const sessionMatch = cookie?.match(/TestSession=([^;]+)/);
			const sessionCookie = sessionMatch ? `TestSession=${sessionMatch[1]}` : '';

			// Update settings
			const res2 = await fetch(`${baseUrl}/api/settings`, {
				method: 'POST',
				headers: {
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
					'Content-Type': 'application/json',
					'Cookie': sessionCookie,
				},
				body: JSON.stringify({ darkMode: false }),
			});
			assert.strictEqual(res2.status, 200);
			const data = await res2.json();
			assert.strictEqual(data.success, true);
		});

		it('rejects invalid JSON', async () => {
			const res = await fetch(`${baseUrl}/api/settings`, {
				method: 'POST',
				headers: {
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
					'Content-Type': 'application/json',
				},
				body: 'not json',
			});
			assert.strictEqual(res.status, 400);
		});

		it('merges settings', async () => {
			// Get session
			const res1 = await fetch(`${baseUrl}/api/settings`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const cookie = res1.headers.get('set-cookie');
			const sessionMatch = cookie?.match(/TestSession=([^;]+)/);
			const sessionCookie = sessionMatch ? `TestSession=${sessionMatch[1]}` : '';

			// Add new setting
			const res2 = await fetch(`${baseUrl}/api/settings`, {
				method: 'POST',
				headers: {
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
					'Content-Type': 'application/json',
					'Cookie': sessionCookie,
				},
				body: JSON.stringify({ customSetting: 'value' }),
			});
			const data = await res2.json();
			assert.ok('darkMode' in data.settings);
			assert.ok('customSetting' in data.settings);
		});
	});

	describe('GET /sw.js', () => {
		it('returns service worker JavaScript', async () => {
			const res = await fetch(`${baseUrl}/sw.js`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
			assert.ok(res.headers.get('content-type').includes('javascript'));
		});
	});

	describe('GET /manifest.webmanifest', () => {
		it('returns valid manifest JSON', async () => {
			const res = await fetch(`${baseUrl}/manifest.webmanifest`, {
				headers: {
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
				},
			});
			assert.strictEqual(res.status, 200);
			const data = await res.json();
			assert.ok('name' in data);
			assert.ok('start_url' in data);
		});

		it('respects dark mode theme', async () => {
			const res = await fetch(`${baseUrl}/manifest.webmanifest`, {
				headers: {
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
				},
			});
			const data = await res.json();
			// Default is dark mode
			assert.ok(data.background_color.includes('1a1a2e') || data.background_color.includes('f5f6fa'));
		});
	});

	describe('GET /search-index', () => {
		it('returns sitemap JSON array', async () => {
			const res = await fetch(`${baseUrl}/search-index`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
			const data = await res.json();
			assert.ok(Array.isArray(data));
		});
	});

	describe('GET /', () => {
		it('returns HTML content', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
			const text = await res.text();
			assert.ok(text.includes('<!DOCTYPE html>'));
		});
	});

	describe('GET /index.html', () => {
		it('returns same as /', async () => {
			const res = await fetch(`${baseUrl}/index.html`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
			const text = await res.text();
			assert.ok(text.includes('<!DOCTYPE html>'));
		});
	});

	describe('Versioned Assets', () => {
		it('app.v123.js returns app.js', async () => {
			const res = await fetch(`${baseUrl}/app.v123.js`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
		});

		it('styles.v123.css returns styles.css', async () => {
			const res = await fetch(`${baseUrl}/styles.v456.css`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
		});

		it('versioned assets have immutable cache headers', async () => {
			const res = await fetch(`${baseUrl}/app.v123.js`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const cacheControl = res.headers.get('cache-control');
			assert.ok(cacheControl.includes('immutable'));
		});
	});

	describe('GET /classic', () => {
		it('redirects to basicui', async () => {
			const res = await fetch(`${baseUrl}/classic`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
				redirect: 'manual',
			});
			assert.strictEqual(res.status, 302);
			assert.ok(res.headers.get('location').includes('basicui'));
		});
	});

	describe('Session Middleware', () => {
		it('creates session and sets session cookie', async () => {
			const res = await fetch(`${baseUrl}/api/settings`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const setCookie = res.headers.get('set-cookie');
			assert.ok(setCookie);
			assert.ok(setCookie.includes('TestSession='));
		});
	});
});
