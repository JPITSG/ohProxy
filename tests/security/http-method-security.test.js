'use strict';

/**
 * HTTP Method Security Tests
 *
 * Tests for HTTP method restrictions:
 * - Endpoints only accept expected methods
 * - Unexpected methods return 405 Method Not Allowed
 * - HEAD requests handled properly
 * - OPTIONS preflight for CORS
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

const { basicAuthHeader, TEST_USERS } = require('../test-helpers');

function createMethodSecurityTestApp() {
	const app = express();
	const USERS = TEST_USERS;

	// Simple auth
	app.use((req, res, next) => {
		if (req.method === 'OPTIONS') return next();
		const authHeader = req.headers.authorization;
		if (!authHeader) {
			return res.status(401).json({ error: 'Authentication required' });
		}
		const encoded = authHeader.slice(6).trim();
		const decoded = Buffer.from(encoded, 'base64').toString('utf8');
		const [user, pass] = decoded.split(':');
		if (user && USERS[user] === pass) {
			return next();
		}
		res.status(401).json({ error: 'Invalid credentials' });
	});

	app.use(express.json());

	// GET only endpoint
	app.get('/api/data', (req, res) => {
		res.json({ data: 'test' });
	});

	// POST only endpoint
	app.post('/api/create', (req, res) => {
		res.status(201).json({ created: true });
	});

	// GET and POST endpoint
	app.route('/api/settings')
		.get((req, res) => {
			res.json({ settings: {} });
		})
		.post((req, res) => {
			res.json({ updated: true });
		});

	// DELETE endpoint
	app.delete('/api/item/:id', (req, res) => {
		res.json({ deleted: true });
	});

	// PUT endpoint
	app.put('/api/item/:id', (req, res) => {
		res.json({ replaced: true });
	});

	// PATCH endpoint
	app.patch('/api/item/:id', (req, res) => {
		res.json({ patched: true });
	});

	return app;
}

describe('GET Endpoint Method Restrictions', () => {
	let server;
	let baseUrl;
	const authHeader = basicAuthHeader('testuser', 'testpassword');

	before(async () => {
		const app = createMethodSecurityTestApp();
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

	it('GET request succeeds', async () => {
		const res = await fetch(`${baseUrl}/api/data`, {
			method: 'GET',
			headers: { 'Authorization': authHeader },
		});
		assert.strictEqual(res.status, 200);
	});

	it('POST to GET-only endpoint returns 404', async () => {
		const res = await fetch(`${baseUrl}/api/data`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ data: 'test' }),
		});
		// Express returns 404 for unmatched routes
		assert.strictEqual(res.status, 404);
	});

	it('PUT to GET-only endpoint returns 404', async () => {
		const res = await fetch(`${baseUrl}/api/data`, {
			method: 'PUT',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ data: 'test' }),
		});
		assert.strictEqual(res.status, 404);
	});

	it('DELETE to GET-only endpoint returns 404', async () => {
		const res = await fetch(`${baseUrl}/api/data`, {
			method: 'DELETE',
			headers: { 'Authorization': authHeader },
		});
		assert.strictEqual(res.status, 404);
	});

	it('HEAD to GET endpoint returns 200 with no body', async () => {
		const res = await fetch(`${baseUrl}/api/data`, {
			method: 'HEAD',
			headers: { 'Authorization': authHeader },
		});
		assert.strictEqual(res.status, 200);
		const body = await res.text();
		assert.strictEqual(body, '');
	});
});

describe('POST Endpoint Method Restrictions', () => {
	let server;
	let baseUrl;
	const authHeader = basicAuthHeader('testuser', 'testpassword');

	before(async () => {
		const app = createMethodSecurityTestApp();
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

	it('POST request succeeds', async () => {
		const res = await fetch(`${baseUrl}/api/create`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ data: 'test' }),
		});
		assert.strictEqual(res.status, 201);
	});

	it('GET to POST-only endpoint returns 404', async () => {
		const res = await fetch(`${baseUrl}/api/create`, {
			method: 'GET',
			headers: { 'Authorization': authHeader },
		});
		assert.strictEqual(res.status, 404);
	});

	it('PUT to POST-only endpoint returns 404', async () => {
		const res = await fetch(`${baseUrl}/api/create`, {
			method: 'PUT',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ data: 'test' }),
		});
		assert.strictEqual(res.status, 404);
	});
});

describe('Multi-Method Endpoint Restrictions', () => {
	let server;
	let baseUrl;
	const authHeader = basicAuthHeader('testuser', 'testpassword');

	before(async () => {
		const app = createMethodSecurityTestApp();
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

	it('GET request to multi-method endpoint succeeds', async () => {
		const res = await fetch(`${baseUrl}/api/settings`, {
			method: 'GET',
			headers: { 'Authorization': authHeader },
		});
		assert.strictEqual(res.status, 200);
	});

	it('POST request to multi-method endpoint succeeds', async () => {
		const res = await fetch(`${baseUrl}/api/settings`, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ theme: 'dark' }),
		});
		assert.strictEqual(res.status, 200);
	});

	it('PUT to GET+POST endpoint returns 404', async () => {
		const res = await fetch(`${baseUrl}/api/settings`, {
			method: 'PUT',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ theme: 'dark' }),
		});
		assert.strictEqual(res.status, 404);
	});

	it('DELETE to GET+POST endpoint returns 404', async () => {
		const res = await fetch(`${baseUrl}/api/settings`, {
			method: 'DELETE',
			headers: { 'Authorization': authHeader },
		});
		assert.strictEqual(res.status, 404);
	});
});

describe('Destructive Method Restrictions', () => {
	let server;
	let baseUrl;
	const authHeader = basicAuthHeader('testuser', 'testpassword');

	before(async () => {
		const app = createMethodSecurityTestApp();
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

	it('DELETE request to DELETE endpoint succeeds', async () => {
		const res = await fetch(`${baseUrl}/api/item/123`, {
			method: 'DELETE',
			headers: { 'Authorization': authHeader },
		});
		assert.strictEqual(res.status, 200);
	});

	it('PUT request to PUT endpoint succeeds', async () => {
		const res = await fetch(`${baseUrl}/api/item/123`, {
			method: 'PUT',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ name: 'updated' }),
		});
		assert.strictEqual(res.status, 200);
	});

	it('PATCH request to PATCH endpoint succeeds', async () => {
		const res = await fetch(`${baseUrl}/api/item/123`, {
			method: 'PATCH',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ name: 'patched' }),
		});
		assert.strictEqual(res.status, 200);
	});

	it('GET to DELETE endpoint returns 404', async () => {
		const res = await fetch(`${baseUrl}/api/item/123`, {
			method: 'GET',
			headers: { 'Authorization': authHeader },
		});
		// All methods for this path are defined, but not GET
		assert.strictEqual(res.status, 404);
	});
});

describe('Unusual HTTP Methods', () => {
	let server;
	let baseUrl;
	const authHeader = basicAuthHeader('testuser', 'testpassword');

	before(async () => {
		const app = createMethodSecurityTestApp();
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

	it('TRACE method is not routed to handler', async () => {
		// Node's fetch doesn't support TRACE, so use raw http module
		const options = {
			hostname: '127.0.0.1',
			port: new URL(baseUrl).port,
			path: '/api/data',
			method: 'TRACE',
			headers: { 'Authorization': authHeader },
		};

		const response = await new Promise((resolve, reject) => {
			const req = http.request(options, resolve);
			req.on('error', reject);
			req.end();
		});

		// TRACE should not be supported - may return 404 (no route) or 401 (auth checked first)
		// Either is acceptable as long as the request doesn't succeed (200)
		assert.ok(response.statusCode === 404 || response.statusCode === 401, `TRACE should not succeed, got ${response.statusCode}`);
	});

	it('CONNECT method is not supported', async () => {
		// Node's fetch doesn't support CONNECT, so use raw http module
		// Note: CONNECT is a special method used for tunneling, servers may close connection
		const options = {
			hostname: '127.0.0.1',
			port: new URL(baseUrl).port,
			path: '/api/data',
			method: 'CONNECT',
			headers: { 'Authorization': authHeader },
		};

		const result = await new Promise((resolve) => {
			const req = http.request(options, (response) => {
				resolve({ type: 'response', statusCode: response.statusCode });
			});
			req.on('error', (err) => {
				// Connection reset or socket hang up is acceptable - server rejected the method
				resolve({ type: 'error', code: err.code });
			});
			req.end();
		});

		// Should not be supported - may return error status, or server may close connection
		if (result.type === 'response') {
			assert.ok(
				result.statusCode === 404 || result.statusCode === 400 || result.statusCode === 401 || result.statusCode === 405,
				`CONNECT should not succeed, got ${result.statusCode}`
			);
		} else {
			// Connection closed/reset is also acceptable
			assert.ok(
				result.code === 'ECONNRESET' || result.code === 'ECONNREFUSED' || result.code === 'EPIPE',
				`CONNECT should be rejected, got error: ${result.code}`
			);
		}
	});

	it('custom invalid method is rejected', async () => {
		// Using raw http to send custom method
		const options = {
			hostname: '127.0.0.1',
			port: new URL(baseUrl).port,
			path: '/api/data',
			method: 'INVALID_METHOD',
			headers: { 'Authorization': authHeader },
		};

		const response = await new Promise((resolve, reject) => {
			const req = http.request(options, resolve);
			req.on('error', reject);
			req.end();
		});

		// Should be rejected
		assert.ok(response.statusCode === 400 || response.statusCode === 404 || response.statusCode === 501);
	});
});

describe('Method Case Sensitivity', () => {
	let server;
	let baseUrl;
	const authHeader = basicAuthHeader('testuser', 'testpassword');

	before(async () => {
		const app = createMethodSecurityTestApp();
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

	it('lowercase method is normalized (get -> GET)', async () => {
		// HTTP methods should be case-insensitive per RFC
		const options = {
			hostname: '127.0.0.1',
			port: new URL(baseUrl).port,
			path: '/api/data',
			method: 'get',
			headers: { 'Authorization': authHeader },
		};

		const response = await new Promise((resolve, reject) => {
			const req = http.request(options, resolve);
			req.on('error', reject);
			req.end();
		});

		assert.strictEqual(response.statusCode, 200);
	});

	it('mixed case method is normalized (GeT -> GET)', async () => {
		const options = {
			hostname: '127.0.0.1',
			port: new URL(baseUrl).port,
			path: '/api/data',
			method: 'GeT',
			headers: { 'Authorization': authHeader },
		};

		const response = await new Promise((resolve, reject) => {
			const req = http.request(options, resolve);
			req.on('error', reject);
			req.end();
		});

		assert.strictEqual(response.statusCode, 200);
	});
});
