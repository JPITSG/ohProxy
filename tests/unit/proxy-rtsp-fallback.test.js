'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { Writable } = require('stream');

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function targetPortForUrl(url) {
	if (url.port) return url.port;
	if (url.protocol === 'https:') return '443';
	if (url.protocol === 'rtsp:') return '554';
	if (url.protocol === 'rtsps:') return '322';
	return '80';
}

function urlsHaveSameHostPort(left, right) {
	if (!(left instanceof URL) || !(right instanceof URL)) return false;
	const leftHost = safeText(left.hostname).toLowerCase();
	const rightHost = safeText(right.hostname).toLowerCase();
	if (!leftHost || !rightHost || leftHost !== rightHost) return false;
	return targetPortForUrl(left) === targetPortForUrl(right);
}

function openhabProxyPath(baseUrl) {
	try {
		const base = new URL(baseUrl);
		const basePath = base.pathname && base.pathname !== '/' ? base.pathname.replace(/\/$/, '') : '';
		return `${basePath}/proxy`;
	} catch {
		return '/proxy';
	}
}

function isOpenhabWidgetProxyTarget(target, baseUrl) {
	if (!(target instanceof URL)) return false;
	if (target.pathname !== openhabProxyPath(baseUrl)) return false;
	const sitemap = safeText(target.searchParams.get('sitemap')).trim();
	const widgetId = safeText(target.searchParams.get('widgetId')).trim();
	if (!sitemap || !widgetId) return false;
	let openhabTarget;
	try {
		openhabTarget = new URL(baseUrl);
	} catch {
		return false;
	}
	return urlsHaveSameHostPort(target, openhabTarget);
}

function cleanExtractedRtspUrl(candidate) {
	let out = safeText(candidate).trim();
	if (!out) return '';
	out = out.replace(/(?:&(apos|quot|amp|lt|gt|#39);)+$/ig, '');
	out = out.replace(/[\s)>,;'"`]+$/g, '');
	return out;
}

function extractRtspUrlFromBody(body, _contentType) {
	if (!body) return '';
	let text = '';
	try {
		if (Buffer.isBuffer(body)) text = body.subarray(0, 131072).toString('utf8');
		else text = safeText(body).slice(0, 131072);
	} catch {
		return '';
	}
	if (!text) return '';
	const matches = text.match(/rtsps?:\/\/[^\s"'<>]+/ig) || [];
	for (const rawMatch of matches) {
		const cleaned = cleanExtractedRtspUrl(rawMatch);
		if (!cleaned) continue;
		try {
			const parsed = new URL(cleaned);
			if (parsed.protocol === 'rtsp:' || parsed.protocol === 'rtsps:') return parsed.toString();
		} catch {}
	}
	return '';
}

function extractFunction(source, name) {
	const start = source.indexOf(`function ${name}(`);
	assert.ok(start >= 0, `${name} must exist`);
	const bodyStart = source.indexOf('{', start);
	let depth = 0;
	for (let i = bodyStart; i < source.length; i += 1) {
		if (source[i] === '{') depth += 1;
		else if (source[i] === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error(`Could not extract ${name}`);
}

function buildServerFunction(source, name, dependencies = {}) {
	const names = Object.keys(dependencies);
	const values = Object.values(dependencies);
	return Function(...names, `return (${extractFunction(source, name)});`)(...values);
}

class ExpressResponseSink extends Writable {
	constructor() {
		super();
		this.statusCode = 200;
		this.headers = new Map();
		this.chunks = [];
	}

	status(value) {
		this.statusCode = value;
		return this;
	}

	setHeader(name, value) {
		this.headers.set(String(name).toLowerCase(), String(value));
	}

	_write(chunk, _encoding, callback) {
		this.chunks.push(Buffer.from(chunk));
		callback();
	}

	body() {
		return Buffer.concat(this.chunks);
	}
}

describe('RTSP proxy fallback helpers', () => {
	describe('isOpenhabWidgetProxyTarget', () => {
		it('matches same host/port and widget proxy query', () => {
			const target = new URL('http://192.168.1.29:8080/proxy?sitemap=default&widgetId=00010000');
			assert.strictEqual(isOpenhabWidgetProxyTarget(target, 'http://192.168.1.29:8080'), true);
		});

		it('matches when openHAB target has base path', () => {
			const target = new URL('http://example.com:8080/openhab/proxy?sitemap=demo&widgetId=12');
			assert.strictEqual(isOpenhabWidgetProxyTarget(target, 'http://example.com:8080/openhab'), true);
		});

		it('rejects host mismatch', () => {
			const target = new URL('http://192.168.1.30:8080/proxy?sitemap=default&widgetId=00010000');
			assert.strictEqual(isOpenhabWidgetProxyTarget(target, 'http://192.168.1.29:8080'), false);
		});

		it('rejects missing widgetId', () => {
			const target = new URL('http://192.168.1.29:8080/proxy?sitemap=default');
			assert.strictEqual(isOpenhabWidgetProxyTarget(target, 'http://192.168.1.29:8080'), false);
		});

		it('rejects non-proxy path', () => {
			const target = new URL('http://192.168.1.29:8080/rest/sitemaps/default?sitemap=default&widgetId=00010000');
			assert.strictEqual(isOpenhabWidgetProxyTarget(target, 'http://192.168.1.29:8080'), false);
		});
	});

	describe('extractRtspUrlFromBody', () => {
		it('extracts RTSP URL from openHAB HTML error body with &apos;', () => {
			const body = Buffer.from("HTTP ERROR 500 URL &apos;rtsp://admin:admin@192.168.1.40/0&apos; is not valid");
			assert.strictEqual(extractRtspUrlFromBody(body, 'text/html'), 'rtsp://admin:admin@192.168.1.40/0');
		});

		it('strips trailing punctuation and delimiters', () => {
			const body = 'failed: rtsp://camera.local/live.mjpeg, retry later';
			assert.strictEqual(extractRtspUrlFromBody(body, 'text/plain'), 'rtsp://camera.local/live.mjpeg');
		});

		it('returns first valid RTSP URL when multiple are present', () => {
			const body = 'bad rtsp://first.local/stream and rtsp://second.local/stream';
			assert.strictEqual(extractRtspUrlFromBody(body, 'text/plain'), 'rtsp://first.local/stream');
		});

		it('extracts RTSPS URL when present', () => {
			const body = 'secure stream rtsps://cam.local/secure/path';
			assert.strictEqual(extractRtspUrlFromBody(body, 'text/plain'), 'rtsps://cam.local/secure/path');
		});

		it('returns empty string when body has no RTSP URL', () => {
			assert.strictEqual(extractRtspUrlFromBody('no stream URL in this body', 'text/plain'), '');
		});

		it('returns empty string for invalid RTSP token', () => {
			assert.strictEqual(extractRtspUrlFromBody('rtsp://', 'text/plain'), '');
		});
	});
});

describe('RTSP fallback wiring in server route', () => {
	it('contains openHAB error probe and RTSP fallback routing', () => {
		const projectRoot = path.join(__dirname, '..', '..');
		const serverFile = path.join(projectRoot, 'server.js');
		const source = fs.readFileSync(serverFile, 'utf8');
		assert.match(source, /function fetchErrorBodyIfHttpError\(/);
		assert.match(source, /function extractRtspUrlFromBody\(/);
		assert.match(source, /const matches = text\.match\(\/rtsps\?:\\\/\\\/\[\^\\s"'<>\]\+\/ig\) \|\| \[\];/);
		assert.match(source, /const shouldTryRtspFallback = isOpenhabWidgetProxyTarget\(target, liveConfig\.ohTarget\);/);
		assert.match(source, /const fallbackUrl = extractRtspUrlFromBody\(probe\.body, probe\.contentType\);/);
		assert.match(source, /if \(startVideoProxyStream\(req, res, fallbackTarget, 'rtsp'\)\) return;/);
		assert.match(
			source,
			/fetchErrorBodyIfHttpError\(targetUrl, headers, 3, undefined,\s*\(redirectUrl\) => isProxyTargetAllowed\(redirectUrl, allowlist\), res\)/
		);
		assert.match(source, /if \(probe\.ok\) \{\s*return;\s*\}/s);
		const routeStart = source.indexOf('const shouldTryRtspFallback = isOpenhabWidgetProxyTarget');
		const routeEnd = source.indexOf('const fallbackUrl = extractRtspUrlFromBody', routeStart);
		assert.doesNotMatch(source.slice(routeStart, routeEnd), /pipeStreamingProxy/);
	});

	it('streams a successful openHAB response from the probe request itself', async () => {
		const projectRoot = path.join(__dirname, '..', '..');
		const serverSource = fs.readFileSync(path.join(projectRoot, 'server.js'), 'utf8');
		const fetchErrorBodyIfHttpError = buildServerFunction(
			serverSource,
			'fetchErrorBodyIfHttpError',
			{
				http,
				https,
				safeText,
				liveConfig: { userAgent: 'ohProxy-test' },
				REDIRECT_STATUS: new Set([301, 302, 303, 307, 308]),
				decodeCompressedBody: (body) => body,
				logMessage: () => {},
			}
		);

		let successfulBodyRequests = 0;
		const upstream = http.createServer((req, res) => {
			if (req.url === '/redirect') {
				res.writeHead(302, { Location: '/image' });
				res.end();
				return;
			}
			successfulBodyRequests += 1;
			res.writeHead(200, { 'Content-Type': 'image/png' });
			res.end(Buffer.from('single-request-image'));
		});
		await new Promise((resolve) => upstream.listen(0, 'localhost', resolve));

		try {
			const address = upstream.address();
			const sink = new ExpressResponseSink();
			const result = await fetchErrorBodyIfHttpError(
				`http://localhost:${address.port}/redirect`,
				{},
				3,
				undefined,
				() => true,
				sink
			);

			assert.strictEqual(result.ok, true);
			assert.strictEqual(result.streamed, true);
			assert.strictEqual(successfulBodyRequests, 1);
			assert.strictEqual(sink.statusCode, 200);
			assert.strictEqual(sink.headers.get('content-type'), 'image/png');
			assert.strictEqual(sink.headers.get('cache-control'), 'no-store');
			assert.strictEqual(sink.body().toString(), 'single-request-image');
		} finally {
			await new Promise((resolve) => upstream.close(resolve));
		}
	});
});

describe('RTSP fallback wiring in video preview capture', () => {
	it('contains preview source resolver with openHAB RTSP fallback', () => {
		const projectRoot = path.join(__dirname, '..', '..');
		const serverFile = path.join(projectRoot, 'server.js');
		const source = fs.readFileSync(serverFile, 'utf8');
		assert.match(source, /async function resolveVideoPreviewSource\(videoUrl, rawEncoding\)/);
		assert.match(source, /if \(!isOpenhabWidgetProxyTarget\(target, liveConfig\.ohTarget\)\)/);
		assert.match(source, /const probe = await fetchErrorBodyIfHttpError\(target\.toString\(\), headers, 3, getOhAgent\(\),/);
		assert.match(source, /const fallbackUrl = extractRtspUrlFromBody\(probe\.body, probe\.contentType\);/);
		assert.match(source, /encoding: 'rtsp'/);
		assert.match(source, /reason: 'fallback-not-allowlisted'/);
	});

	it('wires preview task through fallback-aware resolver and summary logging', () => {
		const projectRoot = path.join(__dirname, '..', '..');
		const serverFile = path.join(projectRoot, 'server.js');
		const source = fs.readFileSync(serverFile, 'utf8');
		assert.match(source, /async function captureVideoPreviewsTask\(options = \{\}\)/);
		assert.match(source, /const onlyMissing = options && options\.onlyMissing === true;/);
		assert.match(source, /const modeText = onlyMissing \? 'missing-only' : 'full';/);
		assert.match(source, /if \(onlyMissing\) \{/);
		assert.match(source, /const hash = videoUrlHash\(url\);/);
		assert.match(source, /stats\.skippedExisting \+= 1;/);
		assert.match(source, /const resolvedSource = await resolveVideoPreviewSource\(url, rawEnc\);/);
		assert.match(source, /async function captureVideoPreview\(cacheKeyUrl, sourceUrl, encoding\)/);
		assert.match(source, /const hash = videoUrlHash\(cacheKeyUrl\);/);
		assert.match(source, /const inputArgs = buildFfmpegInputArgs\(encoding, sourceUrl\);/);
		assert.match(source, /const result = await captureVideoPreview\(url, resolvedSource\.url, resolvedSource\.encoding\);/);
		assert.match(source, /\[Video\] Preview fallback resolved/);
		assert.match(source, /source=\$\{resolvedSource\.source\}, encoding=\$\{resolvedSource\.encoding\}/);
		assert.match(source, /\[Video\] Preview task finished/);
		assert.match(source, /fallback=\$\{stats\.fallbackUsed\}/);
		assert.match(source, /skippedExisting=\$\{stats\.skippedExisting\}/);
		assert.match(source, /\[Video\] Preview pruned \$\{pruned\} stale image\(s\)/);
	});

	it('bootstrap triggers missing-only preview capture on first sitemap refresh', () => {
		const projectRoot = path.join(__dirname, '..', '..');
		const serverFile = path.join(projectRoot, 'server.js');
		const source = fs.readFileSync(serverFile, 'utf8');
		assert.match(source, /if \(!videoPreviewInitialCaptureDone && liveConfig\.videoPreviewIntervalMs > 0\) \{/);
		assert.match(source, /captureVideoPreviewsTask\(\{ onlyMissing: true, reason: 'startup-bootstrap' \}\)\.catch/);
		assert.doesNotMatch(source, /const elapsed = Date\.now\(\) - lastRun;/);
	});
});
