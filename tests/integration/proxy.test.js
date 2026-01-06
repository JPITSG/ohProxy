'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

const { basicAuthHeader, TEST_USERS } = require('../test-helpers');

// Create upstream mock server
function createMockUpstream() {
	const app = express();

	app.get('/rest/items', (req, res) => {
		res.json([{ name: 'Item1', state: 'ON' }]);
	});

	app.get('/rest/sitemaps/demo', (req, res) => {
		res.json({ name: 'demo', homepage: { widgets: [] } });
	});

	app.get('/icon/test', (req, res) => {
		res.type('image/png').send(Buffer.from([0x89, 0x50, 0x4E, 0x47])); // PNG header
	});

	app.get('/chart', (req, res) => {
		res.type('image/png').send(Buffer.from([0x89, 0x50, 0x4E, 0x47]));
	});

	app.get('/external/resource', (req, res) => {
		res.json({ data: 'external' });
	});

	app.get('/redirect', (req, res) => {
		res.redirect('/redirected');
	});

	app.get('/redirected', (req, res) => {
		res.send('Redirected');
	});

	return app;
}

// Create proxy test app
function createProxyTestApp(config = {}) {
	const app = express();

	const USERS = config.users || TEST_USERS;
	const PROXY_ALLOWLIST = config.proxyAllowlist || [];
	const UPSTREAM_URL = config.upstreamUrl || 'http://localhost:3001';

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

	function parseProxyAllowEntry(value) {
		const raw = safeText(value).trim();
		if (!raw) return null;
		const candidate = /^(https?:)?\/\//i.test(raw) ? raw : `http://${raw}`;
		try {
			const url = new URL(candidate);
			const host = safeText(url.hostname).toLowerCase();
			if (!host) return null;
			return { host, port: safeText(url.port) };
		} catch {
			return null;
		}
	}

	function normalizeProxyAllowlist(list) {
		if (!Array.isArray(list)) return [];
		const out = [];
		for (const entry of list) {
			const parsed = parseProxyAllowEntry(entry);
			if (parsed) out.push(parsed);
		}
		return out;
	}

	function targetPortForUrl(url) {
		if (url.port) return url.port;
		return url.protocol === 'https:' ? '443' : '80';
	}

	function isProxyTargetAllowed(url, allowlist) {
		if (!allowlist.length) return false;
		const host = safeText(url.hostname).toLowerCase();
		const port = targetPortForUrl(url);
		for (const entry of allowlist) {
			if (entry.host !== host) continue;
			if (!entry.port) return true;
			if (entry.port === port) return true;
		}
		return false;
	}

	const normalizedAllowlist = normalizeProxyAllowlist(PROXY_ALLOWLIST);

	// Auth middleware
	app.use((req, res, next) => {
		const authHeader = req.headers.authorization;
		const [user, pass] = parseBasicAuthHeader(authHeader);

		if (user && USERS[user] === pass) {
			return next();
		}

		res.setHeader('WWW-Authenticate', 'Basic realm="Test"');
		res.status(401).send('Unauthorized');
	});

	// Proxy endpoint
	app.get('/proxy', async (req, res) => {
		const rawUrl = safeText(req.query.url || '').trim();

		if (!rawUrl) {
			return res.status(400).json({ error: 'Missing url parameter' });
		}

		let targetUrl;
		try {
			targetUrl = new URL(rawUrl);
		} catch {
			return res.status(400).json({ error: 'Invalid URL' });
		}

		if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
			return res.status(400).json({ error: 'Only http/https protocols allowed' });
		}

		if (!isProxyTargetAllowed(targetUrl, normalizedAllowlist)) {
			return res.status(403).json({ error: 'Host not in allowlist' });
		}

		try {
			const response = await fetch(targetUrl.href);
			const contentType = response.headers.get('content-type');
			const cacheControl = response.headers.get('cache-control');

			if (contentType) res.setHeader('Content-Type', contentType);
			if (cacheControl) res.setHeader('Cache-Control', cacheControl);

			const buffer = await response.arrayBuffer();
			res.send(Buffer.from(buffer));
		} catch (err) {
			res.status(502).json({ error: 'Upstream error' });
		}
	});

	// REST proxy (simulated)
	app.use('/rest', async (req, res) => {
		try {
			const response = await fetch(`${UPSTREAM_URL}/rest${req.path}`, {
				method: req.method,
				headers: {
					'User-Agent': 'ohProxy/1.0',
				},
			});
			const data = await response.json();
			res.json(data);
		} catch (err) {
			res.status(502).json({ error: 'Upstream error' });
		}
	});

	// Icon proxy
	app.use('/icon', async (req, res) => {
		try {
			const response = await fetch(`${UPSTREAM_URL}/icon${req.path}`);
			const contentType = response.headers.get('content-type');
			if (contentType) res.setHeader('Content-Type', contentType);
			const buffer = await response.arrayBuffer();
			res.send(Buffer.from(buffer));
		} catch {
			res.status(502).send('Upstream error');
		}
	});

	// Chart proxy
	app.use('/chart', async (req, res) => {
		try {
			const response = await fetch(`${UPSTREAM_URL}/chart${req.path}`);
			const contentType = response.headers.get('content-type');
			if (contentType) res.setHeader('Content-Type', contentType);
			const buffer = await response.arrayBuffer();
			res.send(Buffer.from(buffer));
		} catch {
			res.status(502).send('Upstream error');
		}
	});

	return app;
}

describe('Proxy Integration', () => {
	let upstreamServer;
	let upstreamUrl;
	let proxyServer;
	let proxyUrl;

	before(async () => {
		// Start upstream mock
		const upstreamApp = createMockUpstream();
		upstreamServer = http.createServer(upstreamApp);
		await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
		const upstreamAddr = upstreamServer.address();
		upstreamUrl = `http://127.0.0.1:${upstreamAddr.port}`;

		// Start proxy server
		const proxyApp = createProxyTestApp({
			proxyAllowlist: [`127.0.0.1:${upstreamAddr.port}`, 'allowed.example.com'],
			upstreamUrl: upstreamUrl,
		});
		proxyServer = http.createServer(proxyApp);
		await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
		const proxyAddr = proxyServer.address();
		proxyUrl = `http://127.0.0.1:${proxyAddr.port}`;
	});

	after(async () => {
		if (proxyServer) await new Promise((resolve) => proxyServer.close(resolve));
		if (upstreamServer) await new Promise((resolve) => upstreamServer.close(resolve));
	});

	describe('/proxy endpoint', () => {
		it('accepts allowlisted host', async () => {
			const targetUrl = encodeURIComponent(`${upstreamUrl}/external/resource`);
			const res = await fetch(`${proxyUrl}/proxy?url=${targetUrl}`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
		});

		it('rejects non-allowlisted host', async () => {
			const targetUrl = encodeURIComponent('http://evil.example.com/resource');
			const res = await fetch(`${proxyUrl}/proxy?url=${targetUrl}`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 403);
		});

		it('validates URL format', async () => {
			const res = await fetch(`${proxyUrl}/proxy?url=not-a-url`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects non-http protocols', async () => {
			const targetUrl = encodeURIComponent('ftp://example.com/file');
			const res = await fetch(`${proxyUrl}/proxy?url=${targetUrl}`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 400);
		});

		it('handles URL encoding', async () => {
			const targetUrl = encodeURIComponent(`${upstreamUrl}/external/resource?param=value&other=test`);
			const res = await fetch(`${proxyUrl}/proxy?url=${targetUrl}`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
		});

		it('returns correct content-type', async () => {
			const targetUrl = encodeURIComponent(`${upstreamUrl}/external/resource`);
			const res = await fetch(`${proxyUrl}/proxy?url=${targetUrl}`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.ok(res.headers.get('content-type').includes('json'));
		});

		it('handles missing url parameter', async () => {
			const res = await fetch(`${proxyUrl}/proxy`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 400);
		});

		it('requires authentication', async () => {
			const targetUrl = encodeURIComponent(`${upstreamUrl}/external/resource`);
			const res = await fetch(`${proxyUrl}/proxy?url=${targetUrl}`);
			assert.strictEqual(res.status, 401);
		});
	});

	describe('REST proxy', () => {
		it('forwards requests to openHAB', async () => {
			const res = await fetch(`${proxyUrl}/rest/items`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
			const data = await res.json();
			assert.ok(Array.isArray(data));
		});

		it('returns JSON data', async () => {
			const res = await fetch(`${proxyUrl}/rest/sitemaps/demo`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const data = await res.json();
			assert.ok('name' in data);
		});

		it('handles non-existent paths', async () => {
			// This might return 502 if upstream doesn't have the route
			const res = await fetch(`${proxyUrl}/rest/nonexistent`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			// Either 404 from upstream or 502 on error
			assert.ok(res.status === 404 || res.status === 502);
		});
	});

	describe('Icon proxy', () => {
		it('forwards icon requests', async () => {
			const res = await fetch(`${proxyUrl}/icon/test`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
		});

		it('returns image content', async () => {
			const res = await fetch(`${proxyUrl}/icon/test`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const contentType = res.headers.get('content-type');
			assert.ok(contentType.includes('image') || contentType.includes('png'));
		});
	});

	describe('Chart proxy', () => {
		it('forwards chart requests', async () => {
			const res = await fetch(`${proxyUrl}/chart`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
		});
	});

	describe('Allowlist matching', () => {
		it('port matching works', async () => {
			// Our allowlist includes 127.0.0.1 with the upstream port
			const targetUrl = encodeURIComponent(`${upstreamUrl}/external/resource`);
			const res = await fetch(`${proxyUrl}/proxy?url=${targetUrl}`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
		});

		it('wrong port is rejected', async () => {
			// Wrong port should be rejected
			const targetUrl = encodeURIComponent('http://127.0.0.1:9999/resource');
			const res = await fetch(`${proxyUrl}/proxy?url=${targetUrl}`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 403);
		});

		it('case-insensitive host match', async () => {
			// Note: allowed.example.com is in allowlist but won't connect
			// This test verifies the host matching logic
			const targetUrl = encodeURIComponent('http://ALLOWED.EXAMPLE.COM/resource');
			const res = await fetch(`${proxyUrl}/proxy?url=${targetUrl}`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			// Will fail to connect (502) but should pass allowlist check (not 403)
			assert.ok(res.status === 502); // Connection fails but host was allowed
		});
	});
});
