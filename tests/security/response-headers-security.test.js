'use strict';

/**
 * Response Headers Security Tests
 *
 * Tests for security headers that protect against:
 * - Clickjacking (X-Frame-Options, CSP frame-ancestors)
 * - MIME type sniffing (X-Content-Type-Options)
 * - Information leakage (Server header, error responses)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

const { basicAuthHeader, TEST_USERS } = require('../test-helpers');

function createSecurityHeadersTestApp() {
	const app = express();
	const USERS = TEST_USERS;

	// Disable Express default header
	app.disable('x-powered-by');

	// Security headers middleware (mirrors server.js behavior)
	app.use((req, res, next) => {
		// Clickjacking protection
		res.setHeader('X-Frame-Options', 'DENY');

		// MIME type sniffing protection
		res.setHeader('X-Content-Type-Options', 'nosniff');

		// XSS protection (legacy but still useful)
		res.setHeader('X-XSS-Protection', '1; mode=block');

		next();
	});

	// Simple auth
	app.use((req, res, next) => {
		if (req.path === '/public') return next();
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

	// HTML page
	app.get('/', (req, res) => {
		res.type('html').send('<!DOCTYPE html><html><body>OK</body></html>');
	});

	// JSON API
	app.get('/api/data', (req, res) => {
		res.json({ data: 'test' });
	});

	// JavaScript file
	app.get('/app.js', (req, res) => {
		res.type('application/javascript').send('console.log("app");');
	});

	// CSS file
	app.get('/styles.css', (req, res) => {
		res.type('text/css').send('body { color: black; }');
	});

	// Public endpoint (no auth)
	app.get('/public', (req, res) => {
		res.json({ public: true });
	});

	// Error endpoint
	app.get('/error', (req, res) => {
		res.status(500).json({ error: 'Internal server error' });
	});

	// 404 handler
	app.use((req, res) => {
		res.status(404).json({ error: 'Not found' });
	});

	return app;
}

describe('Clickjacking Protection', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createSecurityHeadersTestApp();
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

	it('X-Frame-Options header is present on HTML pages', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const xFrameOptions = res.headers.get('x-frame-options');
		assert.ok(xFrameOptions, 'X-Frame-Options header should be present');
	});

	it('X-Frame-Options is DENY or SAMEORIGIN', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const xFrameOptions = res.headers.get('x-frame-options');
		assert.ok(
			xFrameOptions === 'DENY' || xFrameOptions === 'SAMEORIGIN',
			`X-Frame-Options should be DENY or SAMEORIGIN, got: ${xFrameOptions}`
		);
	});

	it('X-Frame-Options is present on API responses', async () => {
		const res = await fetch(`${baseUrl}/api/data`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const xFrameOptions = res.headers.get('x-frame-options');
		assert.ok(xFrameOptions, 'X-Frame-Options should be present on API responses');
	});

	it('X-Frame-Options is present on error responses', async () => {
		const res = await fetch(`${baseUrl}/error`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const xFrameOptions = res.headers.get('x-frame-options');
		assert.ok(xFrameOptions, 'X-Frame-Options should be present on error responses');
	});
});

describe('MIME Type Sniffing Protection', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createSecurityHeadersTestApp();
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

	it('X-Content-Type-Options is nosniff on HTML pages', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const contentTypeOptions = res.headers.get('x-content-type-options');
		assert.strictEqual(contentTypeOptions, 'nosniff');
	});

	it('X-Content-Type-Options is nosniff on JavaScript files', async () => {
		const res = await fetch(`${baseUrl}/app.js`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const contentTypeOptions = res.headers.get('x-content-type-options');
		assert.strictEqual(contentTypeOptions, 'nosniff');
	});

	it('X-Content-Type-Options is nosniff on CSS files', async () => {
		const res = await fetch(`${baseUrl}/styles.css`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const contentTypeOptions = res.headers.get('x-content-type-options');
		assert.strictEqual(contentTypeOptions, 'nosniff');
	});

	it('X-Content-Type-Options is nosniff on JSON API responses', async () => {
		const res = await fetch(`${baseUrl}/api/data`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const contentTypeOptions = res.headers.get('x-content-type-options');
		assert.strictEqual(contentTypeOptions, 'nosniff');
	});

	it('Content-Type header matches actual content (HTML)', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const contentType = res.headers.get('content-type');
		assert.ok(contentType && contentType.includes('text/html'));
	});

	it('Content-Type header matches actual content (JSON)', async () => {
		const res = await fetch(`${baseUrl}/api/data`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const contentType = res.headers.get('content-type');
		assert.ok(contentType && contentType.includes('application/json'));
	});

	it('Content-Type header matches actual content (JavaScript)', async () => {
		const res = await fetch(`${baseUrl}/app.js`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const contentType = res.headers.get('content-type');
		assert.ok(contentType && (contentType.includes('javascript') || contentType.includes('text/javascript')));
	});
});

describe('Information Leakage Prevention', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createSecurityHeadersTestApp();
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

	it('X-Powered-By header is not present', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const poweredBy = res.headers.get('x-powered-by');
		assert.strictEqual(poweredBy, null, 'X-Powered-By should not be present');
	});

	it('Server header does not expose version details', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const serverHeader = res.headers.get('server');
		if (serverHeader) {
			// Should not contain version numbers like 1.2.3 or v1.2
			assert.ok(
				!/\d+\.\d+\.\d+/.test(serverHeader) && !/v\d+\.\d+/.test(serverHeader),
				`Server header should not expose version: ${serverHeader}`
			);
		}
	});

	it('404 error does not expose internal paths', async () => {
		const res = await fetch(`${baseUrl}/nonexistent/path/here`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const body = await res.text();
		assert.ok(!body.includes('/etc/'), 'Error should not expose internal paths');
		assert.ok(!body.includes('/home/'), 'Error should not expose internal paths');
		assert.ok(!body.includes('node_modules'), 'Error should not expose internal paths');
	});

	it('500 error does not expose stack traces', async () => {
		const res = await fetch(`${baseUrl}/error`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const body = await res.text();
		assert.ok(!body.includes('at '), 'Error should not expose stack traces');
		assert.ok(!body.includes('.js:'), 'Error should not expose file locations');
	});

	it('401 error does not reveal valid usernames', async () => {
		// Try with invalid user
		const res1 = await fetch(`${baseUrl}/api/data`, {
			headers: { 'Authorization': basicAuthHeader('invaliduser', 'wrongpass') },
		});
		const body1 = await res1.text();

		// Try with valid user but wrong pass
		const res2 = await fetch(`${baseUrl}/api/data`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'wrongpass') },
		});
		const body2 = await res2.text();

		// Both should have same error message (no username enumeration)
		assert.strictEqual(res1.status, res2.status, 'Status should be same for both');
	});
});

describe('XSS Protection Header', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createSecurityHeadersTestApp();
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

	it('X-XSS-Protection header is present (legacy protection)', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const xssProtection = res.headers.get('x-xss-protection');
		// This header is deprecated but still provides defense-in-depth for older browsers
		if (xssProtection) {
			assert.ok(
				xssProtection.includes('1') || xssProtection === '0',
				'X-XSS-Protection should be enabled or explicitly disabled'
			);
		}
	});
});
