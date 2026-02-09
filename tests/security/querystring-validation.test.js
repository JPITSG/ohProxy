'use strict';

/**
 * Query String Parameter Validation Tests
 *
 * Tests validation of query string parameters across all endpoints.
 * Ensures proper sanitization to prevent injection attacks.
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

function isValidSitemapName(value) {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function normalizeOpenhabPath(raw) {
	const text = safeText(raw).trim();
	if (!text) return '';
	const decoded = text.startsWith('/') ? text : decodeURIComponent(text);
	return decoded.startsWith('/') ? decoded : '';
}

function createQueryStringTestApp() {
	const app = express();
	app.set('query parser', 'simple');
	const USERS = TEST_USERS;
	const PROXY_ALLOWLIST = [
		{ host: 'camera.local', port: '554' },
		{ host: 'allowed.example.com', port: null },
		{ host: 'stream.local', port: null },
	];

	const VALID_VIDEO_ENCODINGS = new Set(['rtsp', 'mjpeg', 'hls', 'mp4']);

	function resolveVideoEncoding(rawEncoding, target) {
		if (typeof rawEncoding === 'string' && rawEncoding.trim()) {
			const enc = rawEncoding.trim().toLowerCase();
			if (VALID_VIDEO_ENCODINGS.has(enc)) return enc;
		}
		if (target.protocol === 'rtsp:') return 'rtsp';
		const pathname = (target.pathname || '').toLowerCase();
		if (pathname.endsWith('.m3u8')) return 'hls';
		if (pathname.endsWith('.mp4') || pathname.endsWith('.m4v')) return 'mp4';
		if (pathname.endsWith('.mjpg') || pathname.endsWith('.mjpeg') || pathname.includes('mjpeg')) return 'mjpeg';
		return null;
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
			req.user = { username: user };
			return next();
		}
		res.status(401).json({ error: 'Invalid credentials' });
	});

	// Manifest endpoint - theme param validation
	app.get('/manifest.webmanifest', (req, res) => {
		const rawTheme = req.query?.theme;
		const theme = (typeof rawTheme === 'string' && !hasAnyControlChars(rawTheme))
			? rawTheme.toLowerCase()
			: '';
		if (theme !== 'light' && theme !== 'dark') {
			// Returns default manifest (theme not applied)
			return res.json({ theme_applied: false, theme_color: '#default' });
		}
		const color = theme === 'light' ? '#f8fafc' : '#0f172a';
		res.json({ theme_applied: true, theme_color: color });
	});

	// Search index endpoint - root and sitemap param validation
	app.get('/search-index', (req, res) => {
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

		if (!rootPath) {
			return res.status(400).json({ error: 'Missing root or sitemap parameter' });
		}

		res.json({ rootPath });
	});

	// REST delta endpoint - delta param validation
	app.get('/rest/sitemaps/:name', (req, res) => {
		const rawDelta = req.query?.delta;
		if (typeof rawDelta !== 'string') {
			return res.json({ delta: false, data: 'full response' });
		}
		const delta = rawDelta.trim();
		if (hasAnyControlChars(delta)) {
			return res.json({ delta: false, data: 'full response' });
		}
		if (delta !== '1' && delta !== 'true') {
			return res.json({ delta: false, data: 'full response' });
		}
		res.json({ delta: true, data: 'delta response' });
	});

	// Proxy endpoint - url and w param validation
	app.get('/proxy', (req, res) => {
		const raw = req.query?.url;

		if (raw !== undefined) {
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

			// Validate encoding param
			const rawEncoding = req.query?.encoding;
			if (rawEncoding !== undefined && typeof rawEncoding !== 'string') {
				return res.status(400).send('Invalid encoding parameter');
			}
			const encoding = resolveVideoEncoding(rawEncoding, target);

			// Validate viewport width (w param) for video streams
			if (encoding) {
				if (req.query?.w !== undefined && typeof req.query.w !== 'string') {
					return res.status(400).send('Invalid viewport width');
				}
				const rawWidth = parseOptionalInt(req.query?.w, { min: 0, max: 10000 });
				if (req.query?.w !== undefined && !Number.isFinite(rawWidth)) {
					return res.status(400).send('Invalid viewport width');
				}
				const viewportWidth = Number.isFinite(rawWidth) ? rawWidth : 0;
				return res.json({ ok: true, encoding, viewportWidth });
			}

			return res.json({ ok: true, protocol: target.protocol });
		}

		res.status(400).send('Missing url parameter');
	});

	return app;
}

describe('Query String Parameter Validation Tests', () => {
	let server;
	let baseUrl;
	const authHeader = basicAuthHeader('testuser', 'testpassword');

	before(async () => {
		const app = createQueryStringTestApp();
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

	describe('/manifest.webmanifest - Theme Validation', () => {
		it('accepts light theme', async () => {
			const res = await fetch(`${baseUrl}/manifest.webmanifest?theme=light`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.theme_applied, true);
			assert.strictEqual(data.theme_color, '#f8fafc');
		});

		it('accepts dark theme', async () => {
			const res = await fetch(`${baseUrl}/manifest.webmanifest?theme=dark`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.theme_applied, true);
			assert.strictEqual(data.theme_color, '#0f172a');
		});

		it('rejects invalid theme (uses default)', async () => {
			const res = await fetch(`${baseUrl}/manifest.webmanifest?theme=evil`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.theme_applied, false);
		});

		it('handles XSS attempt in theme (uses default)', async () => {
			const res = await fetch(`${baseUrl}/manifest.webmanifest?theme=<script>alert(1)</script>`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.theme_applied, false);
		});

		it('is case insensitive', async () => {
			const res = await fetch(`${baseUrl}/manifest.webmanifest?theme=LIGHT`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(data.theme_applied, true);
		});

		it('handles missing theme param (uses default)', async () => {
			const res = await fetch(`${baseUrl}/manifest.webmanifest`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.theme_applied, false);
		});
	});

	describe('/search-index - Root and Sitemap Validation', () => {
		it('accepts valid root path', async () => {
			const res = await fetch(`${baseUrl}/search-index?root=/rest/sitemaps/demo/demo`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.rootPath, '/rest/sitemaps/demo/demo');
		});

		it('rejects root without /rest/sitemaps/', async () => {
			const res = await fetch(`${baseUrl}/search-index?root=/etc/passwd`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('accepts valid sitemap name', async () => {
			const res = await fetch(`${baseUrl}/search-index?sitemap=default`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.ok(data.rootPath.includes('/rest/sitemaps/default/default'));
		});

		it('rejects sitemap name with spaces', async () => {
			const res = await fetch(`${baseUrl}/search-index?sitemap=test%20space`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects path traversal in root', async () => {
			const res = await fetch(`${baseUrl}/search-index?root=/rest/sitemaps/../../../etc/passwd`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects missing both params', async () => {
			const res = await fetch(`${baseUrl}/search-index`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});
	});

	describe('/rest/sitemaps - Delta Validation', () => {
		it('accepts delta=1', async () => {
			const res = await fetch(`${baseUrl}/rest/sitemaps/test?delta=1`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(data.delta, true);
		});

		it('accepts delta=true', async () => {
			const res = await fetch(`${baseUrl}/rest/sitemaps/test?delta=true`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(data.delta, true);
		});

		it('rejects other delta values', async () => {
			const res = await fetch(`${baseUrl}/rest/sitemaps/test?delta=yes`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(data.delta, false);
		});

		it('handles missing delta param', async () => {
			const res = await fetch(`${baseUrl}/rest/sitemaps/test`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(data.delta, false);
		});

		it('rejects XSS in delta', async () => {
			const res = await fetch(`${baseUrl}/rest/sitemaps/test?delta=<script>`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(data.delta, false);
		});
	});

	describe('/proxy - URL and Width Validation', () => {
		it('accepts valid HTTP URL in allowlist', async () => {
			const url = encodeURIComponent('http://allowed.example.com/image.jpg');
			const res = await fetch(`${baseUrl}/proxy?url=${url}`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.ok, true);
		});

		it('rejects URL not in allowlist', async () => {
			const url = encodeURIComponent('http://evil.com/image.jpg');
			const res = await fetch(`${baseUrl}/proxy?url=${url}`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 403);
		});

		it('rejects non-http/https/rtsp protocols', async () => {
			const url = encodeURIComponent('file:///etc/passwd');
			const res = await fetch(`${baseUrl}/proxy?url=${url}`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects javascript: protocol', async () => {
			const url = encodeURIComponent('javascript:alert(1)');
			const res = await fetch(`${baseUrl}/proxy?url=${url}`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('accepts RTSP URL with valid width', async () => {
			const url = encodeURIComponent('rtsp://camera.local:554/stream');
			const res = await fetch(`${baseUrl}/proxy?url=${url}&w=800`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.encoding, 'rtsp');
			assert.strictEqual(data.viewportWidth, 800);
		});

		it('accepts RTSP URL with credentials', async () => {
			const url = encodeURIComponent('rtsp://user:pass@camera.local:554/stream');
			const res = await fetch(`${baseUrl}/proxy?url=${url}&w=800`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.encoding, 'rtsp');
			assert.strictEqual(data.viewportWidth, 800);
		});

		it('rejects negative width values', async () => {
			const url = encodeURIComponent('rtsp://camera.local:554/stream');
			const res = await fetch(`${baseUrl}/proxy?url=${url}&w=-100`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects width values over 10000', async () => {
			const url = encodeURIComponent('rtsp://camera.local:554/stream');
			const res = await fetch(`${baseUrl}/proxy?url=${url}&w=99999`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('rejects non-numeric width', async () => {
			const url = encodeURIComponent('rtsp://camera.local:554/stream');
			const res = await fetch(`${baseUrl}/proxy?url=${url}&w=abc`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('accepts width at boundary (10000)', async () => {
			const url = encodeURIComponent('rtsp://camera.local:554/stream');
			const res = await fetch(`${baseUrl}/proxy?url=${url}&w=10000`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(data.encoding, 'rtsp');
			assert.strictEqual(data.viewportWidth, 10000);
		});

		it('rejects missing url param', async () => {
			const res = await fetch(`${baseUrl}/proxy`, {
				headers: { 'Authorization': authHeader },
			});
			assert.strictEqual(res.status, 400);
		});

		it('handles URL-encoded URL', async () => {
			const url = 'http%3A%2F%2Fallowed.example.com%2Ftest';
			const res = await fetch(`${baseUrl}/proxy?url=${url}`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
		});
	});

	describe('/proxy - Encoding Parameter Validation', () => {
		it('accepts encoding=mjpeg (lowercase)', async () => {
			const url = encodeURIComponent('http://stream.local/cam');
			const res = await fetch(`${baseUrl}/proxy?url=${url}&encoding=mjpeg`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.encoding, 'mjpeg');
		});

		it('accepts encoding=HLS (uppercase, case insensitive)', async () => {
			const url = encodeURIComponent('http://stream.local/live');
			const res = await fetch(`${baseUrl}/proxy?url=${url}&encoding=HLS`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.encoding, 'hls');
		});

		it('accepts encoding=Mp4 (mixed case)', async () => {
			const url = encodeURIComponent('http://stream.local/video');
			const res = await fetch(`${baseUrl}/proxy?url=${url}&encoding=Mp4`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.encoding, 'mp4');
		});

		it('accepts encoding=RTSP (explicit)', async () => {
			const url = encodeURIComponent('rtsp://camera.local:554/stream');
			const res = await fetch(`${baseUrl}/proxy?url=${url}&encoding=RTSP`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.encoding, 'rtsp');
		});

		it('auto-detects hls from .m3u8 URL when encoding absent', async () => {
			const url = encodeURIComponent('http://stream.local/live/index.m3u8');
			const res = await fetch(`${baseUrl}/proxy?url=${url}`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.encoding, 'hls');
		});

		it('auto-detects mp4 from .mp4 URL when encoding absent', async () => {
			const url = encodeURIComponent('http://stream.local/clip.mp4');
			const res = await fetch(`${baseUrl}/proxy?url=${url}`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.encoding, 'mp4');
		});

		it('auto-detects mjpeg from .mjpeg URL when encoding absent', async () => {
			const url = encodeURIComponent('http://stream.local/cam.mjpeg');
			const res = await fetch(`${baseUrl}/proxy?url=${url}`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.encoding, 'mjpeg');
		});

		it('auto-detects rtsp from rtsp:// protocol when encoding absent', async () => {
			const url = encodeURIComponent('rtsp://camera.local:554/stream');
			const res = await fetch(`${baseUrl}/proxy?url=${url}`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.encoding, 'rtsp');
		});

		it('falls through to HTTP proxy when no encoding match', async () => {
			const url = encodeURIComponent('http://allowed.example.com/image.jpg');
			const res = await fetch(`${baseUrl}/proxy?url=${url}`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.protocol, 'http:');
			assert.strictEqual(data.encoding, undefined);
		});

		it('ignores unrecognized encoding value and auto-detects', async () => {
			const url = encodeURIComponent('rtsp://camera.local:554/stream');
			const res = await fetch(`${baseUrl}/proxy?url=${url}&encoding=bogus`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.encoding, 'rtsp');
		});

		it('accepts viewport width for non-RTSP encoding (hls)', async () => {
			const url = encodeURIComponent('http://stream.local/live/index.m3u8');
			const res = await fetch(`${baseUrl}/proxy?url=${url}&encoding=hls&w=1920`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.encoding, 'hls');
			assert.strictEqual(data.viewportWidth, 1920);
		});

		it('accepts viewport width for mjpeg encoding', async () => {
			const url = encodeURIComponent('http://stream.local/cam');
			const res = await fetch(`${baseUrl}/proxy?url=${url}&encoding=mjpeg&w=640`, {
				headers: { 'Authorization': authHeader },
			});
			const data = await res.json();
			assert.strictEqual(res.status, 200);
			assert.strictEqual(data.encoding, 'mjpeg');
			assert.strictEqual(data.viewportWidth, 640);
		});
	});
});
