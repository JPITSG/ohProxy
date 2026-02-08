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

const ANY_CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/;

// Mirror validation functions from server.js
function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function isPlainObject(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function hasAnyControlChars(value) {
	return ANY_CONTROL_CHARS_RE.test(value);
}

function parseOptionalInt(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
	if (value === '' || value === null || value === undefined) return null;
	if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
		if (value < min || value > max) return NaN;
		return value;
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!/^\d+$/.test(trimmed)) return NaN;
		const num = Number(trimmed);
		if (!Number.isFinite(num) || num < min || num > max) return NaN;
		return num;
	}
	return NaN;
}

// Period parser (mirrors server.js)
const MAX_PERIOD_SEC = 10 * 365.25 * 86400;
function parsePeriodToSeconds(period) {
	if (typeof period !== 'string' || !period) return 0;
	if (/^\d+[hDWMY]-\d+[hDWMY]$/.test(period)) {
		return parsePeriodToSeconds(period.split('-')[0]);
	}
	const simpleMatch = period.match(/^(\d*)([hDWMY])$/);
	if (simpleMatch) {
		const multiplier = simpleMatch[1] ? parseInt(simpleMatch[1], 10) : 1;
		const unitSec = { h: 3600, D: 86400, W: 604800, M: 2592000, Y: 31536000 };
		const sec = multiplier * unitSec[simpleMatch[2]];
		return Math.min(sec, MAX_PERIOD_SEC);
	}
	const isoMatch = period.match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
	if (isoMatch) {
		const [, y, mo, w, d, h, mi, s] = isoMatch;
		const sec = (parseInt(y || 0) * 31536000)
			+ (parseInt(mo || 0) * 2592000)
			+ (parseInt(w || 0) * 604800)
			+ (parseInt(d || 0) * 86400)
			+ (parseInt(h || 0) * 3600)
			+ (parseInt(mi || 0) * 60)
			+ (parseInt(s || 0));
		return sec > 0 ? Math.min(sec, MAX_PERIOD_SEC) : 0;
	}
	return 0;
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
	app.set('query parser', 'simple');
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
		if (!isPlainObject(req.body)) {
			return res.status(400).json({ error: 'Invalid request body' });
		}
		const { username, password } = req.body;

		// Validate username format
		if (!username || typeof username !== 'string' || hasAnyControlChars(username) || !/^[a-zA-Z0-9_-]{1,20}$/.test(username)) {
			return res.status(400).json({ error: 'Invalid username format' });
		}

		// Validate password
		if (!password || typeof password !== 'string' || hasAnyControlChars(password) || password.length > 200) {
			return res.status(400).json({ error: 'Invalid password format' });
		}

		res.json({ validated: true, username });
	});

	// Settings endpoint with whitelist
	app.post('/api/settings', express.json(), (req, res) => {
		const newSettings = req.body;
		if (!isPlainObject(newSettings)) {
			return res.status(400).json({ error: 'Invalid settings' });
		}

		const allowedKeys = ['slimMode', 'theme', 'fontSize', 'compactView', 'showLabels', 'darkMode'];
		const allowedKeySet = new Set(allowedKeys);
		const incomingKeys = Object.keys(newSettings);
		if (incomingKeys.some((key) => !allowedKeySet.has(key))) {
			return res.status(400).json({ error: 'Invalid settings key' });
		}
		const boolKeys = new Set(['slimMode', 'compactView', 'showLabels', 'darkMode']);
		const sanitized = {};
		for (const key of incomingKeys) {
			const val = newSettings[key];
			if (boolKeys.has(key)) {
				if (typeof val !== 'boolean') {
					return res.status(400).json({ error: `Invalid value for ${key}` });
				}
				sanitized[key] = val;
				continue;
			}
			if (key === 'theme') {
				if (typeof val !== 'string' || hasAnyControlChars(val)) {
					return res.status(400).json({ error: 'Invalid theme value' });
				}
				const theme = val.trim().toLowerCase();
				if (theme !== 'light' && theme !== 'dark') {
					return res.status(400).json({ error: 'Invalid theme value' });
				}
				sanitized[key] = theme;
				continue;
			}
			if (key === 'fontSize') {
				const size = parseOptionalInt(val, { min: 8, max: 32 });
				if (!Number.isFinite(size)) {
					return res.status(400).json({ error: 'Invalid fontSize value' });
				}
				sanitized[key] = size;
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

		if (!isPlainObject(req.body)) {
			return res.status(400).json({ error: 'Invalid request body' });
		}
		const { widgetId, rules, visibility } = req.body;

		if (!widgetId || typeof widgetId !== 'string' || widgetId.length > 200 || hasAnyControlChars(widgetId)) {
			return res.status(400).json({ error: 'Missing or invalid widgetId' });
		}

		if (rules !== undefined) {
			if (!Array.isArray(rules)) {
				return res.status(400).json({ error: 'Rules must be an array' });
			}
			if (rules.length > 100) {
				return res.status(400).json({ error: 'Too many rules' });
			}

			const validOperators = ['=', '!=', '>', '<', '>=', '<=', 'contains', '!contains', 'startsWith', 'endsWith', '*'];
			const validColors = ['green', 'orange', 'red'];
			const allowedRuleKeys = new Set(['operator', 'color', 'value']);

			for (const rule of rules) {
				if (!isPlainObject(rule)) {
					return res.status(400).json({ error: 'Each rule must be an object' });
				}
				const ruleKeys = Object.keys(rule);
				if (ruleKeys.some((key) => !allowedRuleKeys.has(key))) {
					return res.status(400).json({ error: 'Invalid rule key' });
				}
				if (!validOperators.includes(rule.operator)) {
					return res.status(400).json({ error: `Invalid operator: ${rule.operator}` });
				}
				if (!validColors.includes(rule.color)) {
					return res.status(400).json({ error: `Invalid color: ${rule.color}` });
				}
				if (rule.operator !== '*' && (rule.value === undefined || rule.value === null)) {
					return res.status(400).json({ error: 'Value required for non-wildcard operator' });
				}
				if (rule.value !== undefined && rule.value !== null) {
					const valueType = typeof rule.value;
					if (valueType === 'string') {
						if (rule.value.length > 200 || hasAnyControlChars(rule.value)) {
							return res.status(400).json({ error: 'Invalid rule value' });
						}
					} else if (valueType === 'number') {
						if (!Number.isFinite(rule.value)) {
							return res.status(400).json({ error: 'Invalid rule value' });
						}
					} else if (valueType !== 'boolean') {
						return res.status(400).json({ error: 'Invalid rule value' });
					}
				}
			}
		}

		if (visibility !== undefined) {
			const validVisibilities = ['all', 'normal', 'admin'];
			if (typeof visibility !== 'string' || hasAnyControlChars(visibility) || !validVisibilities.includes(visibility)) {
				return res.status(400).json({ error: `Invalid visibility: ${visibility}` });
			}
		}

		res.json({ ok: true, widgetId });
	});

	// Voice endpoint with length validation
	app.post('/api/voice', express.json(), (req, res) => {
		if (!isPlainObject(req.body)) {
			return res.status(400).json({ error: 'Invalid request body' });
		}
		const { command } = req.body;

		if (!command || typeof command !== 'string' || command.length > 500 || hasAnyControlChars(command)) {
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
			const rawItem = req.query?.item;
			const rawPeriod = req.query?.period;
			const rawMode = req.query?.mode;
			const rawTitle = req.query?.title;
			if (typeof rawItem !== 'string') {
				return res.status(400).send('Invalid item parameter');
			}
			if (rawPeriod !== undefined && typeof rawPeriod !== 'string') {
				return res.status(400).send('Invalid period parameter');
			}
			if ((rawMode !== undefined && typeof rawMode !== 'string') || (rawTitle !== undefined && typeof rawTitle !== 'string')) {
				return res.status(400).send('Invalid mode parameter');
			}
			const item = rawItem.trim();
			const period = typeof rawPeriod === 'string' ? rawPeriod.trim() : 'h';
			const mode = typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : 'dark';
			const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
		if (hasAnyControlChars(item) || hasAnyControlChars(period) || hasAnyControlChars(mode) || (title && hasAnyControlChars(title))) {
			return res.status(400).send('Invalid parameters');
		}
		if (title && title.length > 200) {
			return res.status(400).send('Invalid title parameter');
		}

		if (!item || !/^[a-zA-Z0-9_-]{1,50}$/.test(item)) {
			return res.status(400).send('Invalid item parameter');
		}

		if (period.length > 20 || !/^[0-9A-Za-z-]+$/.test(period) || !parsePeriodToSeconds(period)) {
			return res.status(400).send('Invalid period parameter');
		}
		if (!['light', 'dark'].includes(mode)) {
			return res.status(400).send('Invalid mode parameter');
		}

		res.json({ item, period, mode, title });
	});

	// Video preview with allowlist validation
	app.get('/video-preview', (req, res) => {
		const rawUrl = req.query?.url;
		if (typeof rawUrl !== 'string') {
			return res.status(400).send('Missing URL');
		}
		const url = rawUrl.trim();
		if (!url || url.length > 2048 || hasAnyControlChars(url)) {
			return res.status(400).send('Missing URL');
		}

		let target;
		try {
			target = new URL(url);
		} catch {
			let decoded = url;
			try { decoded = decodeURIComponent(url); } catch {}
			if (!decoded || decoded.length > 2048 || hasAnyControlChars(decoded)) {
				return res.status(400).send('Invalid URL');
			}
			try {
				target = new URL(decoded);
			} catch {
				return res.status(400).send('Invalid URL');
			}
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
		it('rejects non-whitelisted keys', async () => {
			const res = await fetch(`${baseUrl}/api/settings`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ slimMode: true, maliciousKey: 'evil', __proto__: 'bad' }),
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects invalid value types', async () => {
			const res = await fetch(`${baseUrl}/api/settings`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
				body: JSON.stringify({ theme: { nested: 'object' } }),
			});
			assert.strictEqual(res.status, 400);
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
			const res = await fetch(`${baseUrl}/chart?item=test<script>&period=h&mode=dark`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects item over 50 chars', async () => {
			const res = await fetch(`${baseUrl}/chart?item=${'a'.repeat(51)}&period=h&mode=dark`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects invalid period', async () => {
			const res = await fetch(`${baseUrl}/chart?item=test&period=X&mode=dark`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects invalid mode', async () => {
			const res = await fetch(`${baseUrl}/chart?item=test&period=D&mode=evil`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects title over 200 chars', async () => {
			const res = await fetch(`${baseUrl}/chart?item=test&period=h&mode=dark&title=${'a'.repeat(201)}`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('accepts valid parameters', async () => {
			const res = await fetch(`${baseUrl}/chart?item=Temperature_Living&period=D&mode=light&title=Living`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 200);
		});

		it('defaults period to h when omitted', async () => {
			const res = await fetch(`${baseUrl}/chart?item=Temperature_Living&mode=dark`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 200);
		});

		it('accepts multiplied period 4h', async () => {
			const res = await fetch(`${baseUrl}/chart?item=Test_Item&period=4h&mode=dark`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 200);
		});

		it('accepts multiplied period 2W', async () => {
			const res = await fetch(`${baseUrl}/chart?item=Test_Item&period=2W&mode=dark`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 200);
		});

		it('accepts ISO 8601 period PT1H30M', async () => {
			const res = await fetch(`${baseUrl}/chart?item=Test_Item&period=PT1H30M&mode=dark`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 200);
		});

		it('accepts ISO 8601 period P2W', async () => {
			const res = await fetch(`${baseUrl}/chart?item=Test_Item&period=P2W&mode=dark`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 200);
		});

		it('accepts ISO 8601 period P1DT12H', async () => {
			const res = await fetch(`${baseUrl}/chart?item=Test_Item&period=P1DT12H&mode=dark`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 200);
		});

		it('accepts past-future period 2h-1h', async () => {
			const res = await fetch(`${baseUrl}/chart?item=Test_Item&period=2h-1h&mode=dark`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 200);
		});

		it('rejects unrecognised period string', async () => {
			const res = await fetch(`${baseUrl}/chart?item=Test_Item&period=invalid&mode=dark`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects overly long period', async () => {
			const res = await fetch(`${baseUrl}/chart?item=Test_Item&period=${'P'.repeat(25)}&mode=dark`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
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

		it('accepts RTSP URL with credentials in allowlist', async () => {
			const res = await fetch(`${baseUrl}/video-preview?url=${encodeURIComponent('rtsp://user:pass@camera.local:554/stream')}`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 200);
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
