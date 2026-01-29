'use strict';

/**
 * Parameter Validation Security Tests
 *
 * Tests that API endpoints properly validate and sanitize input parameters
 * to prevent injection attacks and resource exhaustion.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const crypto = require('crypto');

const { basicAuthHeader, TEST_USERS, TEST_COOKIE_KEY, generateTestAuthCookie } = require('../test-helpers');

// Mirror validation functions from server.js
function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function isProxyTargetAllowed(url, allowlist) {
	if (!allowlist.length) return false;
	const host = safeText(url.hostname).toLowerCase();
	const port = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'rtsp:' ? '554' : '80');
	for (const entry of allowlist) {
		if (entry.host !== host) continue;
		if (!entry.port) return true;
		if (entry.port === port) return true;
	}
	return false;
}

// Create test app with validated endpoints
function createValidationTestApp() {
	const app = express();
	const USERS = TEST_USERS;
	const PROXY_ALLOWLIST = [
		{ host: 'allowed.example.com', port: null },
		{ host: 'camera.local', port: '554' },
	];

	// Simple auth middleware
	app.use((req, res, next) => {
		const authHeader = req.headers.authorization;
		if (!authHeader) {
			return res.status(401).json({ error: 'Authentication required' });
		}
		const encoded = authHeader.slice(6).trim();
		const decoded = Buffer.from(encoded, 'base64').toString('utf8');
		const [user, pass] = decoded.split(':');
		if (user && USERS[user] === pass) {
			req.user = { username: user, role: user === 'admin' ? 'admin' : 'normal' };
			return next();
		}
		res.status(401).json({ error: 'Invalid credentials' });
	});

	// Login endpoint (mirrors server.js validation)
	app.post('/api/auth/login', express.json(), (req, res) => {
		const { username, password } = req.body || {};

		// Validate username format
		if (!username || typeof username !== 'string' || !/^[a-zA-Z0-9_-]{1,20}$/.test(username)) {
			return res.status(400).json({ error: 'Invalid username format' });
		}

		// Validate password
		if (!password || typeof password !== 'string' || password.length > 200) {
			return res.status(400).json({ error: 'Invalid password format' });
		}

		res.json({ validated: true, username });
	});

	// Settings endpoint with whitelist
	app.post('/api/settings', express.json(), (req, res) => {
		const newSettings = req.body;
		if (!newSettings || typeof newSettings !== 'object' || Array.isArray(newSettings)) {
			return res.status(400).json({ error: 'Invalid settings' });
		}

		const allowedKeys = ['slimMode', 'theme', 'fontSize', 'compactView', 'showLabels'];
		const sanitized = {};
		for (const key of allowedKeys) {
			if (key in newSettings) {
				const val = newSettings[key];
				if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
					sanitized[key] = val;
				}
			}
		}

		res.json({ settings: sanitized });
	});

	// Card config endpoint with validation
	app.post('/api/card-config', express.json(), (req, res) => {
		// Admin only check
		if (req.user?.role !== 'admin') {
			return res.status(403).json({ error: 'Admin access required' });
		}

		const { widgetId, rules, visibility } = req.body || {};

		if (!widgetId || typeof widgetId !== 'string' || widgetId.length > 200) {
			return res.status(400).json({ error: 'Missing or invalid widgetId' });
		}

		if (rules !== undefined) {
			if (!Array.isArray(rules)) {
				return res.status(400).json({ error: 'Rules must be an array' });
			}

			const validOperators = ['=', '!=', '>', '<', '>=', '<=', 'contains', '!contains', 'startsWith', 'endsWith', '*'];
			const validColors = ['green', 'orange', 'red'];

			for (const rule of rules) {
				if (!rule || typeof rule !== 'object') {
					return res.status(400).json({ error: 'Each rule must be an object' });
				}
				if (!validOperators.includes(rule.operator)) {
					return res.status(400).json({ error: `Invalid operator: ${rule.operator}` });
				}
				if (!validColors.includes(rule.color)) {
					return res.status(400).json({ error: `Invalid color: ${rule.color}` });
				}
			}
		}

		if (visibility !== undefined) {
			const validVisibilities = ['all', 'normal', 'admin'];
			if (!validVisibilities.includes(visibility)) {
				return res.status(400).json({ error: `Invalid visibility: ${visibility}` });
			}
		}

		res.json({ ok: true, widgetId });
	});

	// Voice endpoint with length validation
	app.post('/api/voice', express.json(), (req, res) => {
		const { command } = req.body || {};

		if (!command || typeof command !== 'string' || command.length > 500) {
			return res.status(400).json({ error: 'Missing or invalid command' });
		}

		const trimmed = command.trim();
		if (!trimmed || trimmed.length > 500) {
			return res.status(400).json({ error: 'Empty or too long command' });
		}

		res.json({ ok: true, command: trimmed });
	});

	// Chart endpoint with strict validation
	app.get('/chart', (req, res) => {
		const item = safeText(req.query.item || '').trim();
		const period = safeText(req.query.period || '').trim();
		const widthRaw = safeText(req.query.width || '').trim();

		if (!item || !/^[a-zA-Z0-9_-]{1,50}$/.test(item)) {
			return res.status(400).send('Invalid item parameter');
		}

		if (!['h', 'D', 'W', 'M', 'Y'].includes(period)) {
			return res.status(400).send('Invalid period parameter');
		}

		const width = parseInt(widthRaw, 10);
		if (!Number.isFinite(width) || width < 0 || width > 10000) {
			return res.status(400).send('Invalid width parameter');
		}

		res.json({ item, period, width });
	});

	// Video preview with allowlist validation
	app.get('/video-preview', (req, res) => {
		const url = safeText(req.query.url).trim();
		if (!url) {
			return res.status(400).send('Missing URL');
		}

		let target;
		try {
			target = new URL(url);
		} catch {
			return res.status(400).send('Invalid URL');
		}

		if (target.protocol !== 'rtsp:') {
			return res.status(400).send('Invalid RTSP URL');
		}

		if (!isProxyTargetAllowed(target, PROXY_ALLOWLIST)) {
			return res.status(403).send('RTSP target not allowed');
		}

		res.json({ ok: true, url });
	});

	return app;
}

describe('Parameter Validation Security Tests', () => {
	let server;
	let baseUrl;
	const authHeader = basicAuthHeader('testuser', 'testpassword');
	const adminAuthHeader = basicAuthHeader('admin', 'adminpass123');

	before(async () => {
		const app = createValidationTestApp();
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

	describe('/api/auth/login - Username Validation', () => {
		it('rejects empty username', async () => {
			const res = await fetch(`${baseUrl}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ username: '', password: 'test' }),
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects username with special characters', async () => {
			const res = await fetch(`${baseUrl}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ username: 'user<script>', password: 'test' }),
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects username over 20 chars', async () => {
			const res = await fetch(`${baseUrl}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ username: 'a'.repeat(21), password: 'test' }),
			});
			assert.strictEqual(res.status, 400);
		});

		it('accepts username of exactly 20 chars', async () => {
			const res = await fetch(`${baseUrl}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ username: 'a'.repeat(20), password: 'test' }),
			});
			assert.notStrictEqual(res.status, 400);
		});

		it('rejects username with spaces', async () => {
			const res = await fetch(`${baseUrl}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ username: 'user name', password: 'test' }),
			});
			assert.strictEqual(res.status, 400);
		});

		it('accepts valid username', async () => {
			const res = await fetch(`${baseUrl}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ username: 'valid_user-123', password: 'test' }),
			});
			assert.strictEqual(res.status, 200);
		});

		it('rejects password over 200 chars', async () => {
			const res = await fetch(`${baseUrl}/api/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ username: 'user', password: 'p'.repeat(201) }),
			});
			assert.strictEqual(res.status, 400);
		});
	});

	describe('/api/settings - Whitelist Validation', () => {
		it('filters out non-whitelisted keys', async () => {
			const res = await fetch(`${baseUrl}/api/settings`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ slimMode: true, maliciousKey: 'evil', __proto__: 'bad' }),
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.settings.slimMode, true);
			assert.strictEqual(Object.hasOwn(data.settings, 'maliciousKey'), false);
			assert.strictEqual(Object.hasOwn(data.settings, '__proto__'), false);
		});

		it('rejects non-primitive values', async () => {
			const res = await fetch(`${baseUrl}/api/settings`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ theme: { nested: 'object' } }),
			});
			const data = await res.json();
			assert.strictEqual(data.settings.theme, undefined);
		});

		it('rejects arrays as body', async () => {
			const res = await fetch(`${baseUrl}/api/settings`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify([{ slimMode: true }]),
			});
			assert.strictEqual(res.status, 400);
		});
	});

	describe('/api/card-config - Admin and Validation', () => {
		it('rejects non-admin users', async () => {
			const res = await fetch(`${baseUrl}/api/card-config`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ widgetId: 'test', rules: [] }),
			});
			assert.strictEqual(res.status, 403);
		});

		it('rejects widgetId over 200 chars', async () => {
			const res = await fetch(`${baseUrl}/api/card-config`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': adminAuthHeader },
				body: JSON.stringify({ widgetId: 'x'.repeat(201), rules: [] }),
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects invalid operator', async () => {
			const res = await fetch(`${baseUrl}/api/card-config`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': adminAuthHeader },
				body: JSON.stringify({ widgetId: 'test', rules: [{ operator: 'INVALID', color: 'green', value: '1' }] }),
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects invalid color', async () => {
			const res = await fetch(`${baseUrl}/api/card-config`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': adminAuthHeader },
				body: JSON.stringify({ widgetId: 'test', rules: [{ operator: '=', color: 'purple', value: '1' }] }),
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects invalid visibility', async () => {
			const res = await fetch(`${baseUrl}/api/card-config`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': adminAuthHeader },
				body: JSON.stringify({ widgetId: 'test', visibility: 'superuser' }),
			});
			assert.strictEqual(res.status, 400);
		});

		it('accepts valid rules from admin', async () => {
			const res = await fetch(`${baseUrl}/api/card-config`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': adminAuthHeader },
				body: JSON.stringify({ widgetId: 'test', rules: [{ operator: '=', color: 'green', value: 'ON' }], visibility: 'all' }),
			});
			assert.strictEqual(res.status, 200);
		});
	});

	describe('/api/voice - Command Length Validation', () => {
		it('rejects command over 500 chars', async () => {
			const res = await fetch(`${baseUrl}/api/voice`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ command: 'a'.repeat(501) }),
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects empty command', async () => {
			const res = await fetch(`${baseUrl}/api/voice`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ command: '' }),
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects whitespace-only command', async () => {
			const res = await fetch(`${baseUrl}/api/voice`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ command: '   \t\n   ' }),
			});
			assert.strictEqual(res.status, 400);
		});

		it('accepts valid command', async () => {
			const res = await fetch(`${baseUrl}/api/voice`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ command: 'turn on the lights' }),
			});
			assert.strictEqual(res.status, 200);
		});
	});

	describe('/chart - Parameter Validation', () => {
		it('rejects item with special chars', async () => {
			const res = await fetch(`${baseUrl}/chart?item=test<script>&period=h&width=400`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects item over 50 chars', async () => {
			const res = await fetch(`${baseUrl}/chart?item=${'a'.repeat(51)}&period=h&width=400`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects invalid period', async () => {
			const res = await fetch(`${baseUrl}/chart?item=test&period=X&width=400`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects lowercase period (case-sensitive)', async () => {
			const res = await fetch(`${baseUrl}/chart?item=test&period=d&width=400`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects width over 10000', async () => {
			const res = await fetch(`${baseUrl}/chart?item=test&period=h&width=10001`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects negative width', async () => {
			const res = await fetch(`${baseUrl}/chart?item=test&period=h&width=-1`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects non-numeric width', async () => {
			const res = await fetch(`${baseUrl}/chart?item=test&period=h&width=abc`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('accepts valid parameters', async () => {
			const res = await fetch(`${baseUrl}/chart?item=Temperature_Living&period=D&width=800`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 200);
		});
	});

	describe('/video-preview - RTSP Allowlist Validation', () => {
		it('rejects missing URL', async () => {
			const res = await fetch(`${baseUrl}/video-preview`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects non-RTSP URL', async () => {
			const res = await fetch(`${baseUrl}/video-preview?url=${encodeURIComponent('http://example.com/stream')}`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects RTSP URL not in allowlist', async () => {
			const res = await fetch(`${baseUrl}/video-preview?url=${encodeURIComponent('rtsp://evil.com/stream')}`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 403);
		});

		it('accepts RTSP URL in allowlist', async () => {
			const res = await fetch(`${baseUrl}/video-preview?url=${encodeURIComponent('rtsp://camera.local:554/stream')}`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 200);
		});

		it('rejects RTSP URL with wrong port', async () => {
			const res = await fetch(`${baseUrl}/video-preview?url=${encodeURIComponent('rtsp://camera.local:555/stream')}`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 403);
		});

		it('rejects malformed URL', async () => {
			const res = await fetch(`${baseUrl}/video-preview?url=${encodeURIComponent('not-a-url')}`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});
	});
});
