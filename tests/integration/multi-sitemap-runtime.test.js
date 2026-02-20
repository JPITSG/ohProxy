'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const crypto = require('crypto');

const { basicAuthHeader, TEST_USERS } = require('../test-helpers');

function createMultiSitemapRuntimeApp(config = {}) {
	const app = express();
	app.use(express.json());

	const users = config.users || TEST_USERS;
	const defaultCatalog = [
		{ name: 'alpha', label: 'Alpha Home' },
		{ name: 'beta', label: 'Beta Home' },
	];
	const defaultPages = {
		alpha: {
			title: 'Alpha Dashboard',
			widgets: [{ item: { name: 'AlphaSwitch', state: 'OFF' }, label: 'Alpha Switch [OFF]' }],
		},
		beta: {
			title: 'Beta Dashboard',
			widgets: [{ item: { name: 'BetaSwitch', state: 'ON' }, label: 'Beta Switch [ON]' }],
		},
	};

	let sitemapCatalog = defaultCatalog.map((entry) => ({ ...entry }));
	let wsMode = 'polling';
	const sessions = new Map();

	function parseBasicAuthHeader(value) {
		if (!value || !/^basic /i.test(value)) return [null, null];
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

	function getCookieValue(header, name) {
		if (!header || !name) return '';
		for (const part of String(header).split(';')) {
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

	function sanitizeCatalog(entries) {
		if (!Array.isArray(entries)) return [];
		const out = [];
		const seen = new Set();
		for (const entry of entries) {
			const name = String(entry?.name || '').trim();
			if (!name || seen.has(name)) continue;
			seen.add(name);
			out.push({
				name,
				label: String(entry?.label || name).trim() || name,
			});
		}
		return out;
	}

	function resolveSitemapName(session) {
		const selected = String(session?.selectedSitemap || '').trim();
		const names = sitemapCatalog.map((entry) => entry.name);
		if (selected && names.includes(selected)) return selected;
		return names[0] || '';
	}

	function pageForSitemap(name) {
		const normalized = String(name || '').trim();
		const fallback = defaultPages.alpha;
		return defaultPages[normalized] || fallback;
	}

	function sitemapPageUrl(name) {
		const enc = encodeURIComponent(name);
		return `/rest/sitemaps/${enc}/${enc}?type=json`;
	}

	function bootstrapForSession(session) {
		const sitemapName = resolveSitemapName(session);
		const page = pageForSitemap(sitemapName);
		const rootPath = sitemapPageUrl(sitemapName);
		return {
			homepage: {
				sitemapName,
				pageUrl: rootPath,
				pageTitle: page.title || sitemapName,
				widgets: page.widgets || [],
				inlineIcons: {},
			},
			cache: {
				root: rootPath,
				pages: {
					[rootPath]: page,
				},
			},
		};
	}

	app.use((req, res, next) => {
		const [user, pass] = parseBasicAuthHeader(req.headers.authorization);
		if (!user || users[user] !== pass) {
			res.setHeader('WWW-Authenticate', 'Basic realm="Test"');
			res.status(401).send('Unauthorized');
			return;
		}
		next();
	});

	app.use((req, res, next) => {
		let sessionId = getCookieValue(req.headers.cookie, 'TestSession');
		if (!sessionId || !sessions.has(sessionId)) {
			sessionId = crypto.randomUUID();
			sessions.set(sessionId, {
				selectedSitemap: '',
				theme: 'dark',
			});
			res.setHeader('Set-Cookie', `TestSession=${sessionId}; Path=/; HttpOnly; SameSite=Lax`);
		}
		req.sessionId = sessionId;
		req.session = sessions.get(sessionId);
		next();
	});

	app.get('/rest/sitemaps', (req, res) => {
		const payload = sitemapCatalog.map((entry) => ({
			name: entry.name,
			label: entry.label,
			homepage: { link: sitemapPageUrl(entry.name).replace('?type=json', '') },
		}));
		res.json({ sitemaps: payload });
	});

	app.get('/rest/sitemaps/:name/:page', (req, res) => {
		const sitemapName = String(req.params.name || '').trim();
		const pageId = String(req.params.page || '').trim();
		if (!sitemapName || !pageId) {
			res.status(404).json({ error: 'Not found' });
			return;
		}
		if (sitemapName !== pageId) {
			res.status(404).json({ error: 'Not found' });
			return;
		}
		if (!sitemapCatalog.some((entry) => entry.name === sitemapName)) {
			res.status(404).json({ error: 'Not found' });
			return;
		}
		res.json(pageForSitemap(sitemapName));
	});

	app.get('/api/settings', (req, res) => {
		res.json({ selectedSitemap: req.session.selectedSitemap || '', theme: req.session.theme || 'dark' });
	});

	app.post('/api/settings', (req, res) => {
		if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
			res.status(400).json({ error: 'Invalid request body' });
			return;
		}
		if ('selectedSitemap' in req.body) {
			if (typeof req.body.selectedSitemap !== 'string') {
				res.status(400).json({ error: 'Invalid selectedSitemap value' });
				return;
			}
			req.session.selectedSitemap = req.body.selectedSitemap.trim();
		}
		sessions.set(req.sessionId, req.session);
		res.json({ ok: true, settings: { selectedSitemap: req.session.selectedSitemap || '' } });
	});

	app.get('/api/runtime', (req, res) => {
		const selected = resolveSitemapName(req.session);
		res.json({
			selectedSitemap: selected,
			sitemapCount: sitemapCatalog.length,
			selectorEnabled: sitemapCatalog.length > 1,
			wsMode,
		});
	});

	app.get('/api/push/bootstrap', (req, res) => {
		const selected = resolveSitemapName(req.session);
		const encoded = encodeURIComponent(selected);
		if (wsMode === 'atmosphere') {
			res.json({
				mode: wsMode,
				targets: [{
					sitemapName: selected,
					pageId: selected,
					path: `/rest/sitemaps/${encoded}/${encoded}?type=json`,
				}],
			});
			return;
		}
		if (wsMode === 'sse') {
			res.json({
				mode: wsMode,
				ssePath: `/rest/events?sitemap=${encoded}`,
			});
			return;
		}
		res.json({
			mode: 'polling',
			pollPath: `/rest/sitemaps/${encoded}/${encoded}?type=json`,
		});
	});

	app.get('/', (req, res) => {
		const { homepage, cache } = bootstrapForSession(req.session);
		res.type('html').send(
			'<!doctype html><html><body>\n' +
			`<script>window.__OH_HOMEPAGE__ = ${JSON.stringify(homepage)};</script>\n` +
			`<script>window.__OH_SITEMAP_CACHE__ = ${JSON.stringify(cache)};</script>\n` +
			'</body></html>'
		);
	});

	function resetState() {
		sitemapCatalog = defaultCatalog.map((entry) => ({ ...entry }));
		wsMode = 'polling';
		sessions.clear();
	}

	return {
		app,
		setCatalog(nextCatalog) {
			sitemapCatalog = sanitizeCatalog(nextCatalog);
		},
		setWsMode(nextMode) {
			const mode = String(nextMode || '').trim().toLowerCase();
			wsMode = ['polling', 'sse', 'atmosphere'].includes(mode) ? mode : 'polling';
		},
		resetState,
	};
}

function extractInlineBootstrapJson(html, key) {
	const text = String(html || '');
	const re = new RegExp(`window\\.${key}\\s*=\\s*(\\{[\\s\\S]*?\\});`);
	const match = text.match(re);
	if (!match?.[1]) return null;
	try {
		return JSON.parse(match[1]);
	} catch {
		return null;
	}
}

function createSessionClient(baseUrl, authHeaderValue) {
	let cookie = '';
	return async (path, init = {}) => {
		const headers = new Headers(init.headers || {});
		headers.set('Authorization', authHeaderValue);
		if (cookie) headers.set('Cookie', cookie);
		const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
		const setCookie = response.headers.get('set-cookie');
		if (setCookie) {
			const match = setCookie.match(/TestSession=([^;]+)/);
			if (match?.[1]) cookie = `TestSession=${match[1]}`;
		}
		return response;
	};
}

describe('Multi-Sitemap Runtime Integration', () => {
	let controls;
	let server;
	let baseUrl;

	before(async () => {
		controls = createMultiSitemapRuntimeApp();
		server = http.createServer(controls.app);
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		const addr = server.address();
		baseUrl = `http://127.0.0.1:${addr.port}`;
	});

	after(async () => {
		if (server) {
			await new Promise((resolve) => server.close(resolve));
		}
	});

	beforeEach(() => {
		controls.resetState();
	});

	it('uses persisted selected sitemap for bootstrap homepage and sitemap cache payloads', async () => {
		const client = createSessionClient(baseUrl, basicAuthHeader('testuser', 'testpassword'));

		const saveRes = await client('/api/settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ selectedSitemap: 'beta' }),
		});
		assert.strictEqual(saveRes.status, 200);

		const res = await client('/');
		assert.strictEqual(res.status, 200);
		const html = await res.text();
		const homepage = extractInlineBootstrapJson(html, '__OH_HOMEPAGE__');
		const cache = extractInlineBootstrapJson(html, '__OH_SITEMAP_CACHE__');

		assert.ok(homepage, 'expected __OH_HOMEPAGE__ payload');
		assert.ok(cache, 'expected __OH_SITEMAP_CACHE__ payload');
		assert.strictEqual(homepage.sitemapName, 'beta');
		assert.ok(String(cache.root || '').includes('/rest/sitemaps/beta/beta'));
	});

	it('falls back to first sitemap when persisted selected sitemap is missing', async () => {
		const client = createSessionClient(baseUrl, basicAuthHeader('testuser', 'testpassword'));
		await client('/api/settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ selectedSitemap: 'beta' }),
		});

		controls.setCatalog([{ name: 'alpha', label: 'Alpha Home' }, { name: 'gamma', label: 'Gamma Home' }]);

		const res = await client('/');
		assert.strictEqual(res.status, 200);
		const html = await res.text();
		const homepage = extractInlineBootstrapJson(html, '__OH_HOMEPAGE__');
		assert.ok(homepage);
		assert.strictEqual(homepage.sitemapName, 'alpha');
	});

	it('persists selected sitemap through settings endpoint and trims values', async () => {
		const client = createSessionClient(baseUrl, basicAuthHeader('testuser', 'testpassword'));

		const saveRes = await client('/api/settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ selectedSitemap: ' beta ' }),
		});
		assert.strictEqual(saveRes.status, 200);

		const getRes = await client('/api/settings');
		assert.strictEqual(getRes.status, 200);
		const payload = await getRes.json();
		assert.strictEqual(payload.selectedSitemap, 'beta');
	});

	it('exposes modal availability gate based on multi-sitemap catalog size', async () => {
		const client = createSessionClient(baseUrl, basicAuthHeader('testuser', 'testpassword'));

		let res = await client('/api/runtime');
		assert.strictEqual(res.status, 200);
		let runtime = await res.json();
		assert.strictEqual(runtime.sitemapCount, 2);
		assert.strictEqual(runtime.selectorEnabled, true);

		controls.setCatalog([{ name: 'alpha', label: 'Alpha Home' }]);
		res = await client('/api/runtime');
		assert.strictEqual(res.status, 200);
		runtime = await res.json();
		assert.strictEqual(runtime.sitemapCount, 1);
		assert.strictEqual(runtime.selectorEnabled, false);
	});

	it('keeps selected sitemap context across polling, sse, and atmosphere push modes', async () => {
		const client = createSessionClient(baseUrl, basicAuthHeader('testuser', 'testpassword'));
		await client('/api/settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ selectedSitemap: 'beta' }),
		});

		for (const mode of ['polling', 'sse', 'atmosphere']) {
			controls.setWsMode(mode);
			const res = await client('/api/push/bootstrap');
			assert.strictEqual(res.status, 200);
			const payload = await res.json();
			assert.strictEqual(payload.mode, mode);
			if (mode === 'polling') {
				assert.ok(String(payload.pollPath || '').includes('/rest/sitemaps/beta/beta'));
			} else if (mode === 'sse') {
				assert.ok(String(payload.ssePath || '').includes('sitemap=beta'));
			} else {
				assert.ok(Array.isArray(payload.targets));
				assert.strictEqual(payload.targets[0]?.sitemapName, 'beta');
				assert.ok(String(payload.targets[0]?.path || '').includes('/rest/sitemaps/beta/beta'));
			}
		}
	});

	it('falls back to first sitemap in push bootstrap when selected sitemap disappears', async () => {
		const client = createSessionClient(baseUrl, basicAuthHeader('testuser', 'testpassword'));
		await client('/api/settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ selectedSitemap: 'beta' }),
		});

		controls.setCatalog([{ name: 'alpha', label: 'Alpha Home' }]);
		controls.setWsMode('atmosphere');

		const res = await client('/api/push/bootstrap');
		assert.strictEqual(res.status, 200);
		const payload = await res.json();
		assert.strictEqual(payload.mode, 'atmosphere');
		assert.strictEqual(payload.targets[0]?.sitemapName, 'alpha');
		assert.ok(String(payload.targets[0]?.path || '').includes('/rest/sitemaps/alpha/alpha'));
	});
});
