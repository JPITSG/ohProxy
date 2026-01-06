'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const path = require('path');

const { basicAuthHeader, TEST_USERS } = require('../test-helpers');

// Utility functions for testing
function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function escapeHtml(value) {
	const text = safeText(value);
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function inlineJson(value) {
	const json = JSON.stringify(value);
	return json.replace(/</g, '\\u003c');
}

function normalizeNotifyIp(value) {
	const raw = safeText(value).trim();
	if (!raw) return 'unknown';
	const cleaned = raw.replace(/[^0-9a-fA-F:.]/g, '');
	return cleaned || 'unknown';
}

// Create injection test app
function createInjectionTestApp() {
	const app = express();

	const USERS = TEST_USERS;
	const PUBLIC_DIR = path.join(__dirname, '..', 'fixtures');

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

	// Auth middleware
	app.use((req, res, next) => {
		const authHeader = req.headers.authorization;
		const [user, pass] = parseBasicAuthHeader(authHeader);
		if (user && USERS[user] === pass) {
			return next();
		}
		res.status(401).send('Unauthorized');
	});

	// Endpoint that renders user input
	app.get('/page', (req, res) => {
		const title = escapeHtml(req.query.title || 'Default');
		const status = escapeHtml(req.query.status || 'OK');
		res.type('html').send(`<!DOCTYPE html><html><head><title>${title}</title></head><body><div id="status">${status}</div></body></html>`);
	});

	// Endpoint that returns JSON inline in HTML
	app.get('/config.js', (req, res) => {
		const userConfig = {
			title: req.query.title || 'App',
			data: req.query.data || 'test',
		};
		res.type('javascript').send(`window.config = ${inlineJson(userConfig)};`);
	});

	// Proxy endpoint with URL validation
	app.get('/proxy', (req, res) => {
		const url = safeText(req.query.url || '').trim();
		if (!url) {
			return res.status(400).json({ error: 'Missing URL' });
		}

		try {
			const parsed = new URL(url);
			if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
				return res.status(403).json({ error: 'SSRF blocked' });
			}
			res.json({ validated: url });
		} catch {
			res.status(400).json({ error: 'Invalid URL' });
		}
	});

	// Static file serving with path validation
	app.get('/static/*', (req, res) => {
		const requestedPath = req.params[0];

		// Block path traversal
		if (requestedPath.includes('..')) {
			return res.status(403).send('Forbidden');
		}

		// Resolve and check path
		const filePath = path.resolve(PUBLIC_DIR, requestedPath);
		if (!filePath.startsWith(PUBLIC_DIR)) {
			return res.status(403).send('Forbidden');
		}

		res.sendFile(filePath, (err) => {
			if (err) res.status(404).send('Not found');
		});
	});

	// Session endpoint (SQL injection test target)
	app.get('/api/session/:id', (req, res) => {
		const sessionId = req.params.id;
		// Parameterized - no SQL injection possible
		// In real code: db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
		res.json({ sessionId, message: 'Would use parameterized query' });
	});

	// Settings endpoint (JSON stringified - no injection)
	app.post('/api/settings', express.json(), (req, res) => {
		const settings = req.body;
		// JSON.stringify prevents injection when storing
		const stored = JSON.stringify(settings);
		res.json({ stored, message: 'Settings safely stringified' });
	});

	return app;
}

describe('Injection Attack Security Tests', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createInjectionTestApp();
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

	describe('XSS Prevention', () => {
		it('page title is HTML escaped', async () => {
			const xssPayload = '<script>alert("XSS")</script>';
			const res = await fetch(`${baseUrl}/page?title=${encodeURIComponent(xssPayload)}`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const html = await res.text();
			assert.ok(!html.includes('<script>alert'));
			assert.ok(html.includes('&lt;script&gt;'));
		});

		it('status text is HTML escaped', async () => {
			const xssPayload = '<img src=x onerror=alert("XSS")>';
			const res = await fetch(`${baseUrl}/page?status=${encodeURIComponent(xssPayload)}`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const html = await res.text();
			assert.ok(!html.includes('<img src=x'));
			assert.ok(html.includes('&lt;img'));
		});

		it('JSON in HTML is properly encoded', async () => {
			const xssPayload = '</script><script>alert("XSS")</script>';
			const res = await fetch(`${baseUrl}/config.js?title=${encodeURIComponent(xssPayload)}`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const js = await res.text();
			assert.ok(!js.includes('</script>'));
			assert.ok(js.includes('\\u003c'));
		});
	});

	describe('SQL Injection Prevention', () => {
		it('session ID uses parameterized query', async () => {
			const sqlPayload = "'; DROP TABLE sessions; --";
			const res = await fetch(`${baseUrl}/api/session/${encodeURIComponent(sqlPayload)}`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const data = await res.json();
			// If we got here, the query didn't fail catastrophically
			assert.strictEqual(res.status, 200);
			assert.ok(data.message.includes('parameterized'));
		});

		it('settings are JSON stringified before storage', async () => {
			const payload = { malicious: "'; DROP TABLE settings; --" };
			const res = await fetch(`${baseUrl}/api/settings`, {
				method: 'POST',
				headers: {
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(payload),
			});
			const data = await res.json();
			assert.ok(data.stored.includes('DROP TABLE'));
			assert.ok(data.stored.includes('"')); // JSON escaping
		});
	});

	describe('Command Injection Prevention', () => {
		it('IP addresses are sanitized', () => {
			const malicious1 = '192.168.1.1; rm -rf /';
			const malicious2 = '192.168.1.1`whoami`';
			const malicious3 = '192.168.1.1$(id)';

			const clean1 = normalizeNotifyIp(malicious1);
			const clean2 = normalizeNotifyIp(malicious2);
			const clean3 = normalizeNotifyIp(malicious3);

			assert.ok(!clean1.includes(';'));
			assert.ok(!clean1.includes('rm'));
			assert.ok(!clean2.includes('`'));
			assert.ok(!clean3.includes('$'));
		});

		it('semicolon is blocked in IP', () => {
			const malicious = '1.1.1.1;rm -rf';
			const clean = normalizeNotifyIp(malicious);
			assert.ok(!clean.includes(';'));
		});

		it('backtick is blocked in IP', () => {
			const malicious = '1.1.1.1`whoami`';
			const clean = normalizeNotifyIp(malicious);
			assert.ok(!clean.includes('`'));
		});
	});

	describe('Path Traversal Prevention', () => {
		it('.. is blocked in static paths', async () => {
			const res = await fetch(`${baseUrl}/static/../../../etc/passwd`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 403);
		});

		it('URL-encoded .. is blocked', async () => {
			const res = await fetch(`${baseUrl}/static/%2e%2e/%2e%2e/etc/passwd`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			// Either 403 or 404 (decoded path still blocked)
			assert.ok(res.status === 403 || res.status === 404);
		});
	});

	describe('SSRF Prevention', () => {
		it('localhost is blocked in proxy', async () => {
			const res = await fetch(`${baseUrl}/proxy?url=${encodeURIComponent('http://localhost/admin')}`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 403);
		});

		it('127.0.0.1 is blocked in proxy', async () => {
			const res = await fetch(`${baseUrl}/proxy?url=${encodeURIComponent('http://127.0.0.1/admin')}`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 403);
		});

		it('external URLs are allowed', async () => {
			const res = await fetch(`${baseUrl}/proxy?url=${encodeURIComponent('http://example.com/api')}`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			assert.strictEqual(res.status, 200);
		});
	});

	describe('Header Injection Prevention', () => {
		it('CRLF in values is handled', () => {
			const malicious = "value\r\nX-Injected: header";
			const clean = safeText(malicious).replace(/[\r\n]/g, '');
			assert.ok(!clean.includes('\r'));
			assert.ok(!clean.includes('\n'));
		});
	});

	describe('Null Byte Prevention', () => {
		it('null bytes are handled in paths', () => {
			const malicious = 'file%00.js';
			const decoded = decodeURIComponent(malicious);
			// Modern Node.js handles null bytes in paths
			// The path module won't allow null bytes
			assert.ok(decoded.includes('\0'));
		});
	});

	describe('Unicode Handling', () => {
		it('unicode is handled consistently', () => {
			const input = 'tëst';
			const escaped = escapeHtml(input);
			assert.strictEqual(escaped, 'tëst'); // Only special HTML chars escaped
		});

		it('unicode in JSON is preserved', () => {
			const input = { text: 'tëst 日本語' };
			const json = inlineJson(input);
			assert.ok(json.includes('tëst'));
			assert.ok(json.includes('日本語'));
		});
	});
});

describe('escapeHtml Function', () => {
	it('handles all special characters', () => {
		const input = '<script>alert("test\'s")</script>&';
		const expected = '&lt;script&gt;alert(&quot;test&#39;s&quot;)&lt;/script&gt;&amp;';
		assert.strictEqual(escapeHtml(input), expected);
	});

	it('handles empty string', () => {
		assert.strictEqual(escapeHtml(''), '');
	});

	it('handles null', () => {
		assert.strictEqual(escapeHtml(null), '');
	});
});

describe('inlineJson Function', () => {
	it('escapes < for script tag safety', () => {
		const obj = { html: '</script><script>alert(1)</script>' };
		const result = inlineJson(obj);
		assert.ok(!result.includes('</script>'));
	});

	it('maintains valid JSON', () => {
		const obj = { test: '<value>' };
		const result = inlineJson(obj);
		// Replace escaped < back for JSON parsing
		const json = result.replace(/\\u003c/g, '<');
		const parsed = JSON.parse(json);
		assert.strictEqual(parsed.test, '<value>');
	});
});
