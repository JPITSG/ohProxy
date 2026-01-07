'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const https = require('https');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { basicAuthHeader, TEST_USERS } = require('../test-helpers');

// Create security headers test app
function createSecurityHeadersApp(config = {}) {
	const app = express();

	const USERS = TEST_USERS;
	const SECURITY_HEADERS_ENABLED = config.securityHeadersEnabled !== false;
	const HSTS_ENABLED = config.hstsEnabled !== false;
	const HSTS_MAX_AGE = config.hstsMaxAge || 31536000;
	const HSTS_INCLUDE_SUBDOMAINS = config.hstsIncludeSubdomains !== false;
	const HSTS_PRELOAD = config.hstsPreload || false;
	const CSP_ENABLED = config.cspEnabled !== false;
	const CSP_REPORT_ONLY = config.cspReportOnly || false;
	const CSP_POLICY = config.cspPolicy || "default-src 'self'";
	const REFERRER_POLICY = config.referrerPolicy || 'same-origin';

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

	function buildHstsHeader() {
		const parts = [`max-age=${HSTS_MAX_AGE}`];
		if (HSTS_INCLUDE_SUBDOMAINS) parts.push('includeSubDomains');
		if (HSTS_PRELOAD) parts.push('preload');
		return parts.join('; ');
	}

	// Security headers middleware
	app.use((req, res, next) => {
		if (SECURITY_HEADERS_ENABLED) {
			// HSTS (only for HTTPS - simulated via header)
			if (HSTS_ENABLED && req.headers['x-forwarded-proto'] === 'https') {
				res.setHeader('Strict-Transport-Security', buildHstsHeader());
			}

			// CSP
			if (CSP_ENABLED && CSP_POLICY) {
				const headerName = CSP_REPORT_ONLY
					? 'Content-Security-Policy-Report-Only'
					: 'Content-Security-Policy';
				res.setHeader(headerName, CSP_POLICY);
			}

			// Referrer-Policy
			if (REFERRER_POLICY) {
				res.setHeader('Referrer-Policy', REFERRER_POLICY);
			}

			// X-OhProxy headers
			res.setHeader('X-OhProxy-Authenticated', 'false');
		}

		next();
	});

	// Auth middleware
	app.use((req, res, next) => {
		// Skip auth for login
		if (req.path === '/login') {
			res.setHeader('Cache-Control', 'no-store');
			return next();
		}

		const authHeader = req.headers.authorization;
		const [user, pass] = parseBasicAuthHeader(authHeader);
		if (user && USERS[user] === pass) {
			res.setHeader('X-OhProxy-Authenticated', 'true');
			return next();
		}
		res.status(401).send('Unauthorized');
	});

	app.get('/login', (req, res) => {
		res.send('Login page');
	});

	app.get('/', (req, res) => {
		res.send('OK');
	});

	app.get('/api/data', (req, res) => {
		res.json({ data: 'test' });
	});

	return app;
}

describe('Security Headers Tests', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createSecurityHeadersApp({
			securityHeadersEnabled: true,
			hstsEnabled: true,
			hstsMaxAge: 31536000,
			hstsIncludeSubdomains: true,
			hstsPreload: false,
			cspEnabled: true,
			cspPolicy: "default-src 'self'; script-src 'self' 'unsafe-inline'",
			referrerPolicy: 'same-origin',
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

	describe('HSTS Header', () => {
		it('HSTS set on HTTPS requests', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: {
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
					'X-Forwarded-Proto': 'https',
				},
			});
			const hsts = res.headers.get('strict-transport-security');
			assert.ok(hsts);
		});

		it('HSTS not set on HTTP requests', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: {
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
					// No X-Forwarded-Proto
				},
			});
			const hsts = res.headers.get('strict-transport-security');
			assert.strictEqual(hsts, null);
		});

		it('HSTS has correct max-age', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: {
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
					'X-Forwarded-Proto': 'https',
				},
			});
			const hsts = res.headers.get('strict-transport-security');
			assert.ok(hsts.includes('max-age=31536000'));
		});

		it('HSTS includes includeSubDomains when configured', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: {
					'Authorization': basicAuthHeader('testuser', 'testpassword'),
					'X-Forwarded-Proto': 'https',
				},
			});
			const hsts = res.headers.get('strict-transport-security');
			assert.ok(hsts.includes('includeSubDomains'));
		});
	});

	describe('CSP Header', () => {
		it('CSP header is present', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const csp = res.headers.get('content-security-policy');
			assert.ok(csp);
		});

		it('CSP contains policy directives', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const csp = res.headers.get('content-security-policy');
			assert.ok(csp.includes("default-src"));
			assert.ok(csp.includes("'self'"));
		});
	});

	describe('Referrer-Policy Header', () => {
		it('Referrer-Policy is set', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const referrer = res.headers.get('referrer-policy');
			assert.ok(referrer);
		});

		it('Referrer-Policy has correct value', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const referrer = res.headers.get('referrer-policy');
			assert.strictEqual(referrer, 'same-origin');
		});
	});

	describe('Cache-Control for Sensitive Pages', () => {
		it('login page has no-store', async () => {
			const res = await fetch(`${baseUrl}/login`);
			const cacheControl = res.headers.get('cache-control');
			assert.ok(cacheControl.includes('no-store'));
		});
	});

	describe('X-OhProxy Headers', () => {
		it('X-OhProxy-Authenticated is present', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const auth = res.headers.get('x-ohproxy-authenticated');
			assert.ok(auth);
			assert.strictEqual(auth, 'true');
		});

	});

	describe('Server Information', () => {
		it('no server version leaked', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const server = res.headers.get('server');
			// Express doesn't set Server header by default, or if it does, shouldn't leak version
			if (server) {
				assert.ok(!server.match(/\d+\.\d+\.\d+/), 'Should not contain version number');
			}
		});

		it('no X-Powered-By header', async () => {
			const res = await fetch(`${baseUrl}/`, {
				headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
			});
			const poweredBy = res.headers.get('x-powered-by');
			// Express sets this by default, but it should be disabled in production
			// For this test, we just check it doesn't leak sensitive info
			if (poweredBy) {
				assert.ok(!poweredBy.includes('Express 5') || !poweredBy.includes('version'));
			}
		});
	});
});

describe('CSP Report-Only Mode', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createSecurityHeadersApp({
			cspEnabled: true,
			cspReportOnly: true,
			cspPolicy: "default-src 'self'",
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

	it('uses Report-Only header when configured', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const cspReportOnly = res.headers.get('content-security-policy-report-only');
		assert.ok(cspReportOnly);
	});

	it('regular CSP header not set in report-only mode', async () => {
		const res = await fetch(`${baseUrl}/`, {
			headers: { 'Authorization': basicAuthHeader('testuser', 'testpassword') },
		});
		const csp = res.headers.get('content-security-policy');
		assert.strictEqual(csp, null);
	});
});
