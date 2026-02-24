'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

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
		assert.match(source, /if \(probe\.ok\) \{\s*await pipeStreamingProxy\(targetUrl, res, headers\);\s*return;\s*\}/s);
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
