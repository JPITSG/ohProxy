'use strict';

/**
 * Extra Validation and Sanitization Tests
 *
 * Adds additional security-focused validation coverage for edge cases
 * across multiple endpoints.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

const { basicAuthHeader, TEST_USERS } = require('../test-helpers');

const ANY_CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/;

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

function stripControlChars(value) {
	return safeText(value).replace(ANY_CONTROL_CHARS_RE, '');
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

function isValidSitemapName(value) {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isValidSha1(value) {
	return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
}

function normalizeOpenhabPath(raw) {
	const text = safeText(raw).trim();
	if (!text) return '';
	const decoded = text.startsWith('/') ? text : decodeURIComponent(text);
	return decoded.startsWith('/') ? decoded : '';
}

function createExtraValidationTestApp() {
	const app = express();
	app.set('query parser', 'simple');
	app.use(express.json({ limit: '64kb', strict: true, type: 'application/json' }));
	app.use((err, req, res, next) => {
		if (err && err.type === 'entity.parse.failed') {
			return res.status(400).json({ error: 'Invalid JSON' });
		}
		if (err && err.type === 'entity.too.large') {
			return res.status(413).json({ error: 'Payload too large' });
		}
		return next(err);
	});

	const USERS = TEST_USERS;
	const PROXY_ALLOWLIST = [
		{ host: 'allowed.example.com', port: null },
		{ host: 'camera.local', port: '554' },
		{ host: 'stream.example.com', port: '8554' },
	];

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
			req.user = {
				username: user,
				role: user === 'admin' ? 'admin' : 'normal',
				trackgps: true,
			};
			req.ohProxyUser = user;
			req.ohProxySession = { username: user };
			return next();
		}
		return res.status(401).json({ error: 'Invalid credentials' });
	});

	app.post('/api/auth/login', (req, res) => {
		if (!isPlainObject(req.body)) {
			return res.status(400).json({ error: 'Invalid request body' });
		}
		const { username, password } = req.body;
		if (!username || typeof username !== 'string' || hasAnyControlChars(username) || !/^[a-zA-Z0-9_-]{1,20}$/.test(username)) {
			return res.status(400).json({ error: 'Invalid username format' });
		}
		if (!password || typeof password !== 'string' || hasAnyControlChars(password) || password.length > 200) {
			return res.status(400).json({ error: 'Invalid password format' });
		}
		return res.json({ ok: true, username });
	});

	app.post('/api/settings', (req, res) => {
		const newSettings = req.body;
		if (!isPlainObject(newSettings)) {
			return res.status(400).json({ error: 'Invalid settings' });
		}
		const allowedKeys = ['slimMode', 'theme', 'fontSize', 'compactView', 'showLabels', 'darkMode', 'paused'];
		const allowedKeySet = new Set(allowedKeys);
		const incomingKeys = Object.keys(newSettings);
		if (incomingKeys.some((key) => !allowedKeySet.has(key))) {
			return res.status(400).json({ error: 'Invalid settings key' });
		}

		const boolKeys = new Set(['slimMode', 'compactView', 'showLabels', 'darkMode', 'paused']);
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
		return res.json({ settings: sanitized });
	});

	app.post('/api/jslog', (req, res) => {
		const body = req.body;
		if (!isPlainObject(body)) {
			return res.status(400).json({ error: 'Invalid request body' });
		}
		if ('message' in body && typeof body.message !== 'string') {
			return res.status(400).json({ error: 'Invalid message' });
		}
		if ('url' in body && typeof body.url !== 'string') {
			return res.status(400).json({ error: 'Invalid url' });
		}
		if ('stack' in body && typeof body.stack !== 'string') {
			return res.status(400).json({ error: 'Invalid stack' });
		}
		if ('userAgent' in body && typeof body.userAgent !== 'string') {
			return res.status(400).json({ error: 'Invalid userAgent' });
		}
		if ('line' in body && typeof body.line !== 'number') {
			return res.status(400).json({ error: 'Invalid line' });
		}
		if ('col' in body && typeof body.col !== 'number') {
			return res.status(400).json({ error: 'Invalid col' });
		}
		const message = typeof body.message === 'string' ? stripControlChars(body.message).slice(0, 2000) : '';
		const stack = typeof body.stack === 'string' ? stripControlChars(body.stack).slice(0, 5000) : '';
		if (!message && !stack) {
			return res.status(400).json({ error: 'No error message or stack provided' });
		}
		return res.json({ ok: true });
	});

	app.post('/api/gps', (req, res) => {
		const body = req.body;
		if (!isPlainObject(body)) {
			return res.status(400).json({ error: 'Invalid request body' });
		}
		if (typeof body.lat !== 'number' || typeof body.lon !== 'number') {
			return res.status(400).json({ error: 'Invalid coordinates' });
		}
		const rawLat = Number.isFinite(body.lat) ? body.lat : null;
		const rawLon = Number.isFinite(body.lon) ? body.lon : null;
		if (rawLat === null || rawLon === null || rawLat < -90 || rawLat > 90 || rawLon < -180 || rawLon > 180) {
			return res.status(400).json({ error: 'Invalid coordinates' });
		}
		if ('accuracy' in body && typeof body.accuracy !== 'number') {
			return res.status(400).json({ error: 'Invalid accuracy' });
		}
		if ('batt' in body && typeof body.batt !== 'number') {
			return res.status(400).json({ error: 'Invalid battery value' });
		}
		return res.json({ ok: true });
	});

	app.post('/api/card-config', (req, res) => {
		if (req.user?.role !== 'admin') {
			return res.status(403).json({ error: 'Admin access required' });
		}
		if (!isPlainObject(req.body)) {
			return res.status(400).json({ error: 'Invalid request body' });
		}
		const { widgetId, rules, visibility, defaultMuted, iframeHeight, proxyCacheSeconds } = req.body;
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

		if (defaultMuted !== undefined && typeof defaultMuted !== 'boolean') {
			return res.status(400).json({ error: 'defaultMuted must be a boolean' });
		}

		if (iframeHeight !== undefined) {
			const parsed = parseOptionalInt(iframeHeight, { min: 0, max: 10000 });
			if (parsed === null) {
				// allow empty
			} else if (!Number.isFinite(parsed)) {
				return res.status(400).json({ error: 'iframeHeight must be empty or a positive integer (max 10000)' });
			}
		}

		if (proxyCacheSeconds !== undefined) {
			const parsed = parseOptionalInt(proxyCacheSeconds, { min: 0, max: 86400 });
			if (parsed === null) {
				// allow empty
			} else if (!Number.isFinite(parsed)) {
				return res.status(400).json({ error: 'proxyCacheSeconds must be empty or an integer 0-86400' });
			}
		}

		return res.json({ ok: true, widgetId });
	});

	app.post('/api/voice', (req, res) => {
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
		return res.json({ ok: true, command: trimmed });
	});

	app.get('/manifest.webmanifest', (req, res) => {
		const rawTheme = req.query?.theme;
		const theme = (typeof rawTheme === 'string' && !hasAnyControlChars(rawTheme))
			? rawTheme.toLowerCase()
			: '';
		if (theme !== 'light' && theme !== 'dark') {
			return res.json({ theme_applied: false, theme_color: '#default' });
		}
		const color = theme === 'light' ? '#f8fafc' : '#0f172a';
		return res.json({ theme_applied: true, theme_color: color });
	});

	function resolveRootPath(req) {
		const rawRoot = typeof req.query?.root === 'string' ? req.query.root : '';
		const rawSitemap = typeof req.query?.sitemap === 'string' ? req.query.sitemap : '';
		const rootInput = rawRoot && !hasAnyControlChars(rawRoot) && rawRoot.length <= 512 ? rawRoot : '';
		const sitemapInput = rawSitemap && !hasAnyControlChars(rawSitemap) && rawSitemap.length <= 64 ? rawSitemap : '';
		let rootPath = '';

		if (rootInput && !rootInput.includes('..') && !rootInput.includes('\\')) {
			const normalized = normalizeOpenhabPath(rootInput);
			if (normalized && normalized.includes('/rest/sitemaps/')) {
				rootPath = normalized;
			}
		}

		if (!rootPath && sitemapInput && isValidSitemapName(sitemapInput)) {
			const nameEnc = encodeURIComponent(sitemapInput);
			rootPath = `/rest/sitemaps/${nameEnc}/${nameEnc}`;
		}

		return rootPath;
	}

	app.get('/search-index', (req, res) => {
		const rootPath = resolveRootPath(req);
		if (!rootPath) {
			return res.status(400).json({ error: 'Missing root or sitemap parameter' });
		}
		return res.json({ rootPath });
	});

	app.get('/sitemap-full', (req, res) => {
		const rootPath = resolveRootPath(req);
		if (!rootPath) {
			return res.status(400).json({ error: 'Missing root or sitemap parameter' });
		}
		return res.json({ rootPath });
	});

	app.get('/rest/sitemaps/:name', (req, res) => {
		const rawDelta = req.query?.delta;
		if (typeof rawDelta !== 'string') {
			return res.json({ delta: false, since: '' });
		}
		const delta = rawDelta.trim();
		if (hasAnyControlChars(delta) || (delta !== '1' && delta !== 'true')) {
			return res.json({ delta: false, since: '' });
		}
		const rawSince = typeof req.query?.since === 'string' ? req.query.since : '';
		const since = isValidSha1(rawSince) ? rawSince : '';
		return res.json({ delta: true, since });
	});

	app.get('/chart', (req, res) => {
		const rawItem = req.query?.item;
		const rawPeriod = req.query?.period;
		const rawMode = req.query?.mode;
		const rawTitle = req.query?.title;
		if (typeof rawItem !== 'string' || typeof rawPeriod !== 'string') {
			return res.status(400).send('Invalid item parameter');
		}
		if ((rawMode !== undefined && typeof rawMode !== 'string') || (rawTitle !== undefined && typeof rawTitle !== 'string')) {
			return res.status(400).send('Invalid mode parameter');
		}
		const item = rawItem.trim();
		const period = rawPeriod.trim();
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
		if (!['h', 'D', 'W', 'M', 'Y'].includes(period)) {
			return res.status(400).send('Invalid period parameter');
		}
		if (!['light', 'dark'].includes(mode)) {
			return res.status(400).send('Invalid mode parameter');
		}
		return res.json({ ok: true });
	});

	app.get('/api/chart-hash', (req, res) => {
		const rawItem = req.query?.item;
		const rawPeriod = req.query?.period;
		const rawMode = req.query?.mode;
		const rawTitle = req.query?.title;
		if (typeof rawItem !== 'string' || typeof rawPeriod !== 'string') {
			return res.status(400).json({ error: 'Invalid item' });
		}
		if ((rawMode !== undefined && typeof rawMode !== 'string') || (rawTitle !== undefined && typeof rawTitle !== 'string')) {
			return res.status(400).json({ error: 'Invalid mode' });
		}
		const item = rawItem.trim();
		const period = rawPeriod.trim();
		const mode = typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : 'dark';
		const title = (typeof rawTitle === 'string' ? rawTitle.trim() : '') || item;
		if (hasAnyControlChars(item) || hasAnyControlChars(period) || hasAnyControlChars(mode) || (title && hasAnyControlChars(title))) {
			return res.status(400).json({ error: 'Invalid parameters' });
		}
		if (title && title.length > 200) {
			return res.status(400).json({ error: 'Invalid title' });
		}
		if (!item || !/^[a-zA-Z0-9_-]{1,50}$/.test(item)) {
			return res.status(400).json({ error: 'Invalid item' });
		}
		if (!['h', 'D', 'W', 'M', 'Y'].includes(period)) {
			return res.status(400).json({ error: 'Invalid period' });
		}
		if (!['light', 'dark'].includes(mode)) {
			return res.status(400).json({ error: 'Invalid mode' });
		}
		return res.json({ ok: true });
	});

	app.get('/proxy', (req, res) => {
		const raw = req.query?.url;
		if (raw === undefined) {
			return res.status(400).send('Missing proxy target');
		}
		if (typeof raw !== 'string') {
			return res.status(400).send('Invalid proxy target');
		}
		const text = raw.trim();
		if (!text || text.length > 2048 || hasAnyControlChars(text)) {
			return res.status(400).send('Invalid proxy target');
		}

		let target;
		try {
			target = new URL(text);
		} catch {
			let decoded = text;
			try { decoded = decodeURIComponent(text); } catch {}
			if (!decoded || decoded.length > 2048 || hasAnyControlChars(decoded)) {
				return res.status(400).send('Invalid proxy target');
			}
			try {
				target = new URL(decoded);
			} catch {
				return res.status(400).send('Invalid proxy target');
			}
		}

		if (!['http:', 'https:', 'rtsp:'].includes(target.protocol)) {
			return res.status(400).send('Invalid proxy target');
		}
		if (target.port && (!/^\d+$/.test(target.port) || Number(target.port) < 1 || Number(target.port) > 65535)) {
			return res.status(400).send('Invalid proxy target');
		}
		if (!isProxyTargetAllowed(target, PROXY_ALLOWLIST)) {
			return res.status(403).send('Proxy target not allowed');
		}

		if (target.protocol === 'rtsp:') {
			if (req.query?.w !== undefined && typeof req.query.w !== 'string') {
				return res.status(400).send('Invalid viewport width');
			}
			const rawWidth = parseOptionalInt(req.query?.w, { min: 0, max: 10000 });
			if (req.query?.w !== undefined && !Number.isFinite(rawWidth)) {
				return res.status(400).send('Invalid viewport width');
			}
			const viewportWidth = Number.isFinite(rawWidth) ? rawWidth : 0;
			return res.json({ ok: true, protocol: 'rtsp', viewportWidth });
		}

		if (req.query?.cache !== undefined && typeof req.query.cache !== 'string') {
			return res.status(400).send('Invalid cache parameter');
		}
		const cacheSeconds = parseOptionalInt(req.query?.cache, { min: 0, max: 86400 });
		if (req.query?.cache !== undefined && !Number.isFinite(cacheSeconds)) {
			return res.status(400).send('Invalid cache parameter');
		}
		return res.json({ ok: true, protocol: target.protocol, cacheSeconds: Number.isFinite(cacheSeconds) ? cacheSeconds : 0 });
	});

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
		return res.json({ ok: true, url });
	});

	return app;
}

describe('Extra Validation Coverage', () => {
	let server;
	let baseUrl;
	const authHeader = basicAuthHeader('testuser', 'testpassword');
	const adminAuthHeader = basicAuthHeader('admin', 'adminpass123');

	before(async () => {
		const app = createExtraValidationTestApp();
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

	async function postJson(path, body, auth = authHeader) {
		return fetch(`${baseUrl}${path}`, {
			method: 'POST',
			headers: {
				'Authorization': auth,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});
	}

	async function get(path, auth = authHeader) {
		return fetch(`${baseUrl}${path}`, {
			headers: {
				'Authorization': auth,
			},
		});
	}

	describe('/api/auth/login additional validation', () => {
		const cases = [
			{ name: 'rejects array body', body: [], status: 400 },
			{ name: 'rejects string body', body: 'oops', status: 400 },
			{ name: 'rejects missing username', body: { password: 'test' }, status: 400 },
			{ name: 'rejects missing password', body: { username: 'user' }, status: 400 },
			{ name: 'rejects username with control char', body: { username: 'user\nname', password: 'test' }, status: 400 },
			{ name: 'rejects username with dot', body: { username: 'user.name', password: 'test' }, status: 400 },
			{ name: 'rejects username with colon', body: { username: 'user:name', password: 'test' }, status: 400 },
			{ name: 'rejects password non-string', body: { username: 'user', password: 12345 }, status: 400 },
			{ name: 'rejects password with control char', body: { username: 'user', password: 'pa\tss' }, status: 400 },
			{ name: 'accepts minimal username with max-length password', body: { username: 'a', password: 'p'.repeat(200) }, status: 200 },
		];

		for (const testCase of cases) {
			it(testCase.name, async () => {
				const res = await postJson('/api/auth/login', testCase.body);
				assert.strictEqual(res.status, testCase.status);
			});
		}
	});

	describe('/api/settings additional validation', () => {
		const cases = [
			{ name: 'rejects null body', body: null, status: 400 },
			{ name: 'rejects array body', body: [], status: 400 },
			{ name: 'rejects unknown key', body: { slimMode: true, evil: true }, status: 400 },
			{ name: 'rejects boolean key as string', body: { darkMode: 'true' }, status: 400 },
			{ name: 'rejects theme with control char', body: { theme: 'dark\n' }, status: 400 },
			{ name: 'rejects invalid theme', body: { theme: 'blue' }, status: 400 },
			{ name: 'rejects fontSize float', body: { fontSize: 12.5 }, status: 400 },
			{ name: 'rejects fontSize non-digit string', body: { fontSize: '12px' }, status: 400 },
			{ name: 'rejects fontSize too small', body: { fontSize: 7 }, status: 400 },
			{ name: 'rejects fontSize too large', body: { fontSize: 33 }, status: 400 },
		];

		for (const testCase of cases) {
			it(testCase.name, async () => {
				const res = await postJson('/api/settings', testCase.body);
				assert.strictEqual(res.status, testCase.status);
			});
		}

		it('accepts theme with whitespace and normalizes', async () => {
			const res = await postJson('/api/settings', { theme: ' DARK ' });
			assert.strictEqual(res.status, 200);
			const data = await res.json();
			assert.strictEqual(data.settings.theme, 'dark');
		});

		it('accepts minimum fontSize with boolean keys', async () => {
			const res = await postJson('/api/settings', { fontSize: 8, darkMode: true, slimMode: false });
			assert.strictEqual(res.status, 200);
			const data = await res.json();
			assert.strictEqual(data.settings.fontSize, 8);
		});
	});

	describe('/api/jslog additional validation', () => {
		const cases = [
			{ name: 'rejects non-object body', body: [], status: 400 },
			{ name: 'rejects message non-string', body: { message: 123 }, status: 400 },
			{ name: 'rejects url non-string', body: { message: 'err', url: [] }, status: 400 },
			{ name: 'rejects stack non-string', body: { message: 'err', stack: {} }, status: 400 },
			{ name: 'rejects userAgent non-string', body: { message: 'err', userAgent: 5 }, status: 400 },
			{ name: 'rejects line non-number', body: { message: 'err', line: '10' }, status: 400 },
			{ name: 'rejects col non-number', body: { message: 'err', col: '2' }, status: 400 },
			{ name: 'rejects missing message and stack', body: { url: 'http://x' }, status: 400 },
			{ name: 'accepts message only', body: { message: 'boom', url: 'http://x' }, status: 200 },
			{ name: 'accepts stack only', body: { stack: 'trace' }, status: 200 },
		];

		for (const testCase of cases) {
			it(testCase.name, async () => {
				const res = await postJson('/api/jslog', testCase.body);
				assert.strictEqual(res.status, testCase.status);
			});
		}
	});

	describe('/api/gps additional validation', () => {
		const cases = [
			{ name: 'rejects non-object body', body: [], status: 400 },
			{ name: 'rejects missing lat', body: { lon: 10 }, status: 400 },
			{ name: 'rejects missing lon', body: { lat: 10 }, status: 400 },
			{ name: 'rejects lat non-number', body: { lat: '10', lon: 10 }, status: 400 },
			{ name: 'rejects lon non-number', body: { lat: 10, lon: '10' }, status: 400 },
			{ name: 'rejects lat out of range', body: { lat: 90.1, lon: 10 }, status: 400 },
			{ name: 'rejects lon out of range', body: { lat: 10, lon: -181 }, status: 400 },
			{ name: 'rejects accuracy non-number', body: { lat: 10, lon: 10, accuracy: '5' }, status: 400 },
			{ name: 'rejects battery non-number', body: { lat: 10, lon: 10, batt: '5' }, status: 400 },
			{ name: 'accepts boundary values', body: { lat: -90, lon: 180, accuracy: 0, batt: 100 }, status: 200 },
		];

		for (const testCase of cases) {
			it(testCase.name, async () => {
				const res = await postJson('/api/gps', testCase.body);
				assert.strictEqual(res.status, testCase.status);
			});
		}
	});

	describe('/api/voice additional validation', () => {
		const cases = [
			{ name: 'rejects non-object body', body: [], status: 400 },
			{ name: 'rejects command non-string', body: { command: 10 }, status: 400 },
			{ name: 'rejects empty command', body: { command: '' }, status: 400 },
			{ name: 'rejects whitespace-only command', body: { command: '   ' }, status: 400 },
			{ name: 'rejects command with control chars', body: { command: 'play\nnow' }, status: 400 },
			{ name: 'accepts valid command', body: { command: ' Turn on lights ' }, status: 200 },
		];

		for (const testCase of cases) {
			it(testCase.name, async () => {
				const res = await postJson('/api/voice', testCase.body);
				assert.strictEqual(res.status, testCase.status);
			});
		}
	});

	describe('/api/card-config additional validation', () => {
		const longRules = Array.from({ length: 101 }, () => ({ operator: '=', color: 'green', value: true }));
		const cases = [
			{ name: 'rejects non-admin users', body: { widgetId: 'test', rules: [] }, status: 403, auth: authHeader },
			{ name: 'rejects non-object body', body: [], status: 400, auth: adminAuthHeader },
			{ name: 'rejects missing widgetId', body: { rules: [] }, status: 400, auth: adminAuthHeader },
			{ name: 'rejects widgetId with control char', body: { widgetId: 'bad\nid', rules: [] }, status: 400, auth: adminAuthHeader },
			{ name: 'rejects rules non-array', body: { widgetId: 'ok', rules: {} }, status: 400, auth: adminAuthHeader },
			{ name: 'rejects rules over limit', body: { widgetId: 'ok', rules: longRules }, status: 400, auth: adminAuthHeader },
			{ name: 'rejects rule with invalid key', body: { widgetId: 'ok', rules: [{ operator: '=', color: 'red', value: 1, extra: true }] }, status: 400, auth: adminAuthHeader },
			{ name: 'rejects rule invalid operator', body: { widgetId: 'ok', rules: [{ operator: '~~', color: 'red', value: 1 }] }, status: 400, auth: adminAuthHeader },
			{ name: 'rejects rule invalid color', body: { widgetId: 'ok', rules: [{ operator: '=', color: 'blue', value: 1 }] }, status: 400, auth: adminAuthHeader },
			{ name: 'rejects rule missing value for non-wildcard', body: { widgetId: 'ok', rules: [{ operator: '=', color: 'red' }] }, status: 400, auth: adminAuthHeader },
			{ name: 'rejects rule value object', body: { widgetId: 'ok', rules: [{ operator: '=', color: 'red', value: { bad: true } }] }, status: 400, auth: adminAuthHeader },
			{ name: 'rejects invalid visibility', body: { widgetId: 'ok', rules: [], visibility: 'super' }, status: 400, auth: adminAuthHeader },
			{ name: 'rejects defaultMuted non-boolean', body: { widgetId: 'ok', rules: [], defaultMuted: 'yes' }, status: 400, auth: adminAuthHeader },
			{ name: 'rejects iframeHeight invalid', body: { widgetId: 'ok', rules: [], iframeHeight: '10px' }, status: 400, auth: adminAuthHeader },
			{ name: 'rejects proxyCacheSeconds invalid', body: { widgetId: 'ok', rules: [], proxyCacheSeconds: 86401 }, status: 400, auth: adminAuthHeader },
			{ name: 'accepts valid optional fields', body: { widgetId: 'ok', rules: [], defaultMuted: true, iframeHeight: '240', proxyCacheSeconds: '60' }, status: 200, auth: adminAuthHeader },
			{ name: 'accepts wildcard rule without value', body: { widgetId: 'ok', rules: [{ operator: '*', color: 'green' }] }, status: 200, auth: adminAuthHeader },
		];

		for (const testCase of cases) {
			it(testCase.name, async () => {
				const res = await postJson('/api/card-config', testCase.body, testCase.auth);
				assert.strictEqual(res.status, testCase.status);
			});
		}
	});

	describe('Manifest, sitemap, and delta validation', () => {
		it('accepts light theme', async () => {
			const res = await get('/manifest.webmanifest?theme=light');
			assert.strictEqual(res.status, 200);
			const data = await res.json();
			assert.strictEqual(data.theme_applied, true);
		});

		it('accepts dark theme', async () => {
			const res = await get('/manifest.webmanifest?theme=dark');
			assert.strictEqual(res.status, 200);
			const data = await res.json();
			assert.strictEqual(data.theme_applied, true);
		});

		it('ignores invalid theme', async () => {
			const res = await get('/manifest.webmanifest?theme=evil');
			assert.strictEqual(res.status, 200);
			const data = await res.json();
			assert.strictEqual(data.theme_applied, false);
		});

		it('accepts search-index root path', async () => {
			const res = await get('/search-index?root=/rest/sitemaps/demo/demo');
			assert.strictEqual(res.status, 200);
			const data = await res.json();
			assert.strictEqual(data.rootPath, '/rest/sitemaps/demo/demo');
		});

		it('rejects search-index root without sitemap path', async () => {
			const res = await get('/search-index?root=/etc/passwd');
			assert.strictEqual(res.status, 400);
		});

		it('rejects search-index root with traversal', async () => {
			const res = await get('/search-index?root=/rest/sitemaps/../secret');
			assert.strictEqual(res.status, 400);
		});

		it('rejects search-index root with backslash', async () => {
			const root = encodeURIComponent('/rest\\sitemaps\\demo');
			const res = await get(`/search-index?root=${root}`);
			assert.strictEqual(res.status, 400);
		});

		it('accepts search-index sitemap name', async () => {
			const res = await get('/search-index?sitemap=default');
			assert.strictEqual(res.status, 200);
			const data = await res.json();
			assert.ok(data.rootPath.includes('/rest/sitemaps/default/default'));
		});

		it('rejects search-index invalid sitemap name', async () => {
			const res = await get('/search-index?sitemap=bad%20name');
			assert.strictEqual(res.status, 400);
		});

		it('rejects search-index missing parameters', async () => {
			const res = await get('/search-index');
			assert.strictEqual(res.status, 400);
		});

		it('accepts sitemap-full sitemap name', async () => {
			const res = await get('/sitemap-full?sitemap=home');
			assert.strictEqual(res.status, 200);
		});

		it('rejects sitemap-full invalid sitemap name', async () => {
			const res = await get('/sitemap-full?sitemap=bad%20name');
			assert.strictEqual(res.status, 400);
		});

		it('accepts delta query', async () => {
			const res = await get('/rest/sitemaps/test?delta=1');
			assert.strictEqual(res.status, 200);
			const data = await res.json();
			assert.strictEqual(data.delta, true);
		});

		it('ignores invalid delta query', async () => {
			const res = await get('/rest/sitemaps/test?delta=maybe');
			assert.strictEqual(res.status, 200);
			const data = await res.json();
			assert.strictEqual(data.delta, false);
		});
	});

	describe('Chart and chart-hash validation', () => {
		it('rejects chart missing item', async () => {
			const res = await get('/chart?period=h');
			assert.strictEqual(res.status, 400);
		});

		it('rejects chart invalid period', async () => {
			const res = await get('/chart?item=Temp_Sensor&period=Q');
			assert.strictEqual(res.status, 400);
		});

		it('rejects chart item with invalid chars', async () => {
			const res = await get('/chart?item=bad%20name&period=h');
			assert.strictEqual(res.status, 400);
		});

		it('rejects chart invalid mode', async () => {
			const res = await get('/chart?item=Temp_Sensor&period=h&mode=blue');
			assert.strictEqual(res.status, 400);
		});

		it('rejects chart title with control chars', async () => {
			const res = await get('/chart?item=Temp_Sensor&period=h&title=bad%0Aname');
			assert.strictEqual(res.status, 400);
		});

		it('accepts chart valid parameters', async () => {
			const res = await get('/chart?item=Temp_Sensor&period=h&mode=dark&title=OK');
			assert.strictEqual(res.status, 200);
		});

		it('rejects chart-hash empty item', async () => {
			const res = await get('/api/chart-hash?item=&period=h');
			assert.strictEqual(res.status, 400);
		});

		it('rejects chart-hash invalid period', async () => {
			const res = await get('/api/chart-hash?item=Temp_Sensor&period=Q');
			assert.strictEqual(res.status, 400);
		});

		it('rejects chart-hash title too long', async () => {
			const longTitle = 'a'.repeat(201);
			const res = await get(`/api/chart-hash?item=Temp_Sensor&period=h&title=${encodeURIComponent(longTitle)}`);
			assert.strictEqual(res.status, 400);
		});

		it('accepts chart-hash valid parameters', async () => {
			const res = await get('/api/chart-hash?item=Temp_Sensor&period=D&mode=light');
			assert.strictEqual(res.status, 200);
		});
	});

	describe('Proxy and video-preview validation', () => {
		it('rejects proxy invalid protocol', async () => {
			const target = encodeURIComponent('ftp://allowed.example.com/image.jpg');
			const res = await get(`/proxy?url=${target}`);
			assert.strictEqual(res.status, 400);
		});

		it('rejects proxy disallowed host', async () => {
			const target = encodeURIComponent('http://evil.example.com/image.jpg');
			const res = await get(`/proxy?url=${target}`);
			assert.strictEqual(res.status, 403);
		});

		it('rejects proxy invalid port', async () => {
			const target = encodeURIComponent('http://allowed.example.com:70000/image.jpg');
			const res = await get(`/proxy?url=${target}`);
			assert.strictEqual(res.status, 400);
		});

		it('accepts proxy rtsp with credentials', async () => {
			const target = encodeURIComponent('rtsp://user:pass@camera.local/stream');
			const res = await get(`/proxy?url=${target}`);
			assert.strictEqual(res.status, 200);
			const data = await res.json();
			assert.strictEqual(data.protocol, 'rtsp');
		});

		it('rejects proxy rtsp invalid width', async () => {
			const target = encodeURIComponent('rtsp://camera.local/stream');
			const res = await get(`/proxy?url=${target}&w=12px`);
			assert.strictEqual(res.status, 400);
		});

		it('rejects proxy cache non-integer', async () => {
			const target = encodeURIComponent('http://allowed.example.com/image.jpg');
			const res = await get(`/proxy?url=${target}&cache=1h`);
			assert.strictEqual(res.status, 400);
		});

		it('accepts proxy cache within range', async () => {
			const target = encodeURIComponent('http://allowed.example.com/image.jpg');
			const res = await get(`/proxy?url=${target}&cache=60`);
			assert.strictEqual(res.status, 200);
			const data = await res.json();
			assert.strictEqual(data.cacheSeconds, 60);
		});

		it('rejects video-preview non-rtsp protocol', async () => {
			const target = encodeURIComponent('http://camera.local/stream');
			const res = await get(`/video-preview?url=${target}`);
			assert.strictEqual(res.status, 400);
		});

		it('rejects video-preview disallowed host', async () => {
			const target = encodeURIComponent('rtsp://evil.example.com/stream');
			const res = await get(`/video-preview?url=${target}`);
			assert.strictEqual(res.status, 403);
		});

		it('accepts video-preview rtsp with credentials', async () => {
			const target = encodeURIComponent('rtsp://user:pass@camera.local/stream');
			const res = await get(`/video-preview?url=${target}`);
			assert.strictEqual(res.status, 200);
		});
	});
});
