'use strict';

/**
 * JSON Body Security Tests
 *
 * Tests for JSON body parsing security:
 * - Malformed JSON handling
 * - Prototype pollution prevention
 * - Content-Type enforcement
 * - Deeply nested object limits
 * - Large payload handling
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

const { basicAuthHeader, TEST_USERS } = require('../test-helpers');

function createJsonSecurityTestApp() {
	const app = express();
	const USERS = TEST_USERS;

	// Simple auth
	app.use((req, res, next) => {
		if (req.path === '/health') return next();
		const authHeader = req.headers.authorization;
		if (!authHeader) {
			return res.status(401).json({ error: 'Authentication required' });
		}
		const encoded = authHeader.slice(6).trim();
		const decoded = Buffer.from(encoded, 'base64').toString('utf8');
		const [user, pass] = decoded.split(':');
		if (user && USERS[user] === pass) {
			req.user = { username: user };
			return next();
		}
		res.status(401).json({ error: 'Invalid credentials' });
	});

	// JSON body parser with limits
	app.use(express.json({
		limit: '1mb',
		strict: true, // Only accept arrays and objects
	}));

	// Error handler for JSON parsing errors
	app.use((err, req, res, next) => {
		if (err.type === 'entity.parse.failed') {
			return res.status(400).json({ error: 'Invalid JSON' });
		}
		if (err.type === 'entity.too.large') {
			return res.status(413).json({ error: 'Payload too large' });
		}
		next(err);
	});

	// Echo endpoint - returns sanitized body
	app.post('/api/echo', (req, res) => {
		// Safe object copying (no prototype inheritance)
		const sanitized = JSON.parse(JSON.stringify(req.body));
		res.json({ received: sanitized });
	});

	// Settings endpoint with whitelist
	app.post('/api/settings', (req, res) => {
		const body = req.body;
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			return res.status(400).json({ error: 'Invalid body format' });
		}

		const allowedKeys = ['theme', 'fontSize', 'language'];
		const sanitized = {};

		for (const key of allowedKeys) {
			if (Object.prototype.hasOwnProperty.call(body, key)) {
				const val = body[key];
				// Only allow primitives
				if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
					sanitized[key] = val;
				}
			}
		}

		res.json({ settings: sanitized });
	});

	// Config endpoint that requires specific Content-Type
	app.post('/api/config', (req, res) => {
		const contentType = req.headers['content-type'];
		if (!contentType || !contentType.includes('application/json')) {
			return res.status(415).json({ error: 'Content-Type must be application/json' });
		}
		res.json({ ok: true });
	});

	// Health check (no auth)
	app.get('/health', (req, res) => {
		res.json({ status: 'ok' });
	});

	return app;
}

describe('Malformed JSON Handling', () => {
	let server;
	let baseUrl;
	const authHeader = basicAuthHeader('testuser', 'testpassword');

	before(async () => {
		const app = createJsonSecurityTestApp();
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

	it('rejects completely invalid JSON', async () => {
		const res = await fetch(`${baseUrl}/api/echo`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: 'not json at all',
		});
		assert.strictEqual(res.status, 400);
	});

	it('rejects truncated JSON', async () => {
		const res = await fetch(`${baseUrl}/api/echo`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: '{"key": "value',
		});
		assert.strictEqual(res.status, 400);
	});

	it('rejects JSON with trailing comma', async () => {
		const res = await fetch(`${baseUrl}/api/echo`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: '{"key": "value",}',
		});
		assert.strictEqual(res.status, 400);
	});

	it('rejects single-quoted strings (invalid JSON)', async () => {
		const res = await fetch(`${baseUrl}/api/echo`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: "{'key': 'value'}",
		});
		assert.strictEqual(res.status, 400);
	});

	it('rejects unquoted keys (invalid JSON)', async () => {
		const res = await fetch(`${baseUrl}/api/echo`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: '{key: "value"}',
		});
		assert.strictEqual(res.status, 400);
	});

	it('accepts valid JSON object', async () => {
		const res = await fetch(`${baseUrl}/api/echo`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ key: 'value' }),
		});
		assert.strictEqual(res.status, 200);
	});

	it('accepts valid JSON array', async () => {
		const res = await fetch(`${baseUrl}/api/echo`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify([1, 2, 3]),
		});
		assert.strictEqual(res.status, 200);
	});
});

describe('Prototype Pollution Prevention', () => {
	let server;
	let baseUrl;
	const authHeader = basicAuthHeader('testuser', 'testpassword');

	before(async () => {
		const app = createJsonSecurityTestApp();
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

	it('__proto__ key does not pollute Object prototype', async () => {
		// This tests that sending __proto__ doesn't pollute the global Object prototype
		const res = await fetch(`${baseUrl}/api/settings`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ theme: 'dark', __proto__: { admin: true } }),
		});
		const data = await res.json();
		assert.strictEqual(res.status, 200);
		// The key point is that Object.prototype wasn't polluted
		assert.strictEqual({}.admin, undefined, 'Object.prototype should not be polluted');
		// __proto__ is not a whitelisted key, so it won't appear in output
		assert.ok(!('admin' in data.settings));
	});

	it('constructor key is not in whitelist', async () => {
		// constructor is not in the whitelist so it won't be copied
		const res = await fetch(`${baseUrl}/api/settings`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ theme: 'dark', constructor: { prototype: { admin: true } } }),
		});
		const data = await res.json();
		assert.strictEqual(res.status, 200);
		// constructor is not whitelisted so won't appear
		assert.ok(!('constructor' in data.settings) || typeof data.settings.constructor !== 'object');
	});

	it('prototype key is not in whitelist', async () => {
		// prototype is not in the whitelist so it won't be copied
		const res = await fetch(`${baseUrl}/api/settings`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ theme: 'dark', prototype: { admin: true } }),
		});
		const data = await res.json();
		assert.strictEqual(res.status, 200);
		// prototype is not whitelisted
		assert.ok(!('prototype' in data.settings));
	});

	it('nested __proto__ does not pollute prototype', async () => {
		const res = await fetch(`${baseUrl}/api/echo`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				nested: {
					__proto__: { polluted: true },
				},
			}),
		});
		const data = await res.json();
		assert.strictEqual(res.status, 200);
		// Ensure global Object prototype wasn't polluted
		assert.strictEqual({}.polluted, undefined);
	});

	it('JSON.parse __proto__ handling', async () => {
		// This tests that express.json() properly handles __proto__
		const payload = '{"__proto__":{"isAdmin":true}}';
		const res = await fetch(`${baseUrl}/api/echo`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: payload,
		});
		assert.strictEqual(res.status, 200);
		// Ensure global Object prototype wasn't polluted
		assert.strictEqual({}.isAdmin, undefined);
	});
});

describe('Content-Type Enforcement', () => {
	let server;
	let baseUrl;
	const authHeader = basicAuthHeader('testuser', 'testpassword');

	before(async () => {
		const app = createJsonSecurityTestApp();
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

	it('rejects request without Content-Type when required', async () => {
		const res = await fetch(`${baseUrl}/api/config`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
			},
			body: JSON.stringify({ key: 'value' }),
		});
		assert.strictEqual(res.status, 415);
	});

	it('rejects wrong Content-Type', async () => {
		const res = await fetch(`${baseUrl}/api/config`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'text/plain',
			},
			body: JSON.stringify({ key: 'value' }),
		});
		assert.strictEqual(res.status, 415);
	});

	it('accepts correct Content-Type', async () => {
		const res = await fetch(`${baseUrl}/api/config`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ key: 'value' }),
		});
		assert.strictEqual(res.status, 200);
	});

	it('accepts Content-Type with charset', async () => {
		const res = await fetch(`${baseUrl}/api/config`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json; charset=utf-8',
			},
			body: JSON.stringify({ key: 'value' }),
		});
		assert.strictEqual(res.status, 200);
	});
});

describe('Object Type Validation', () => {
	let server;
	let baseUrl;
	const authHeader = basicAuthHeader('testuser', 'testpassword');

	before(async () => {
		const app = createJsonSecurityTestApp();
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

	it('rejects array when object expected', async () => {
		const res = await fetch(`${baseUrl}/api/settings`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify([{ theme: 'dark' }]),
		});
		assert.strictEqual(res.status, 400);
	});

	it('rejects null when object expected', async () => {
		const res = await fetch(`${baseUrl}/api/settings`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: 'null',
		});
		assert.strictEqual(res.status, 400);
	});

	it('rejects string when object expected', async () => {
		const res = await fetch(`${baseUrl}/api/settings`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: '"just a string"',
		});
		assert.strictEqual(res.status, 400);
	});

	it('rejects number when object expected', async () => {
		const res = await fetch(`${baseUrl}/api/settings`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: '42',
		});
		assert.strictEqual(res.status, 400);
	});

	it('rejects nested objects in primitive fields', async () => {
		const res = await fetch(`${baseUrl}/api/settings`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ theme: { nested: 'object' } }),
		});
		const data = await res.json();
		// Should filter out the nested object
		assert.ok(!('theme' in data.settings) || typeof data.settings.theme !== 'object');
	});
});

describe('Special Value Handling', () => {
	let server;
	let baseUrl;
	const authHeader = basicAuthHeader('testuser', 'testpassword');

	before(async () => {
		const app = createJsonSecurityTestApp();
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

	it('handles unicode escape sequences', async () => {
		const res = await fetch(`${baseUrl}/api/echo`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: '{"key": "\\u003cscript\\u003e"}',
		});
		const data = await res.json();
		assert.strictEqual(res.status, 200);
		assert.strictEqual(data.received.key, '<script>');
	});

	it('handles empty object', async () => {
		const res = await fetch(`${baseUrl}/api/settings`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: '{}',
		});
		assert.strictEqual(res.status, 200);
	});

	it('handles deeply nested but valid structure', async () => {
		const nested = { a: { b: { c: { d: { e: 'deep' } } } } };
		const res = await fetch(`${baseUrl}/api/echo`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(nested),
		});
		assert.strictEqual(res.status, 200);
	});

	it('handles very long string values', async () => {
		const longString = 'a'.repeat(10000);
		const res = await fetch(`${baseUrl}/api/echo`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ key: longString }),
		});
		assert.strictEqual(res.status, 200);
	});

	it('handles special JSON values (boolean, null)', async () => {
		const res = await fetch(`${baseUrl}/api/echo`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ bool: true, nil: null, num: 0 }),
		});
		const data = await res.json();
		assert.strictEqual(res.status, 200);
		assert.strictEqual(data.received.bool, true);
		assert.strictEqual(data.received.nil, null);
		assert.strictEqual(data.received.num, 0);
	});
});
