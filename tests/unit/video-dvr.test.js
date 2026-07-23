'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const DVR_FILE = path.join(PROJECT_ROOT, 'public', 'video-dvr.js');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');
const INDEX_FILE = path.join(PROJECT_ROOT, 'public', 'index.html');
const SW_FILE = path.join(PROJECT_ROOT, 'public', 'sw.js');
const LANG_FILE = path.join(PROJECT_ROOT, 'public', 'lang.js');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');
const DEFAULTS_FILE = path.join(PROJECT_ROOT, 'config.defaults.js');

function loadPureHelpers() {
	const src = fs.readFileSync(DVR_FILE, 'utf8');
	const start = src.indexOf('/* DVR_PURE_HELPERS_START */');
	const end = src.indexOf('/* DVR_PURE_HELPERS_END */');
	assert.ok(start > -1 && end > start, 'pure helper markers present');
	const helperSrc = src.slice(start, end);
	return new Function(`${helperSrc}; return { readMp4BoxHeader, findInitSegmentLength, extractFmp4Codecs, computeDvrEvictionCutoff, wallTimeFromEpochs };`)();
}

// Minimal fMP4 init segment builder (box sizes are 32-bit big-endian).
function mp4Box(type, ...payloads) {
	const payload = Buffer.concat(payloads.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
	const out = Buffer.alloc(8 + payload.length);
	out.writeUInt32BE(8 + payload.length, 0);
	out.write(type, 4, 'ascii');
	payload.copy(out, 8);
	return out;
}

function buildVideoTrak(profile, compat, level) {
	const avcc = mp4Box('avcC', Buffer.from([1, profile, compat, level, 0xff, 0xe1, 0x00, 0x00]));
	const avc1 = mp4Box('avc1', Buffer.alloc(78), avcc);
	const stsd = mp4Box('stsd', Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), avc1);
	return mp4Box('trak', mp4Box('mdia', mp4Box('minf', mp4Box('stbl', stsd))));
}

function buildAudioTrak(audioObjectType) {
	// ES descriptor tree: ES(0x03) > DecoderConfig(0x04, OTI 0x40=AAC) > DSI(0x05)
	const dsi = Buffer.from([0x05, 0x02, (audioObjectType << 3) | 0x02, 0x10]);
	const dcdBody = Buffer.concat([Buffer.from([0x40, 0x15]), Buffer.alloc(11), dsi]);
	const dcd = Buffer.concat([Buffer.from([0x04, dcdBody.length]), dcdBody]);
	const esBody = Buffer.concat([Buffer.from([0x00, 0x00, 0x00]), dcd]);
	const es = Buffer.concat([Buffer.from([0x03, esBody.length]), esBody]);
	const esds = mp4Box('esds', Buffer.alloc(4), es);
	const mp4a = mp4Box('mp4a', Buffer.alloc(28), esds);
	const stsd = mp4Box('stsd', Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), mp4a);
	return mp4Box('trak', mp4Box('mdia', mp4Box('minf', mp4Box('stbl', stsd))));
}

function buildInitSegment() {
	const ftyp = mp4Box('ftyp', Buffer.from('isom'), Buffer.alloc(4), Buffer.from('isomiso2avc1mp41'));
	const moov = mp4Box('moov', buildVideoTrak(0x64, 0x00, 0x1f), buildAudioTrak(2));
	return Buffer.concat([ftyp, moov]);
}

describe('Video timeshift (DVR) engine helpers', () => {
	it('detects a complete fMP4 init segment, asking for more data until moov closes', () => {
		const { findInitSegmentLength } = loadPureHelpers();
		const init = buildInitSegment();
		assert.strictEqual(findInitSegmentLength(init), init.length);
		// trailing media data does not change the init boundary
		const withMoof = Buffer.concat([init, mp4Box('moof', Buffer.alloc(16))]);
		assert.strictEqual(findInitSegmentLength(withMoof), init.length);
		// incomplete moov / split header => "need more bytes"
		assert.strictEqual(findInitSegmentLength(init.slice(0, init.length - 1)), 0);
		assert.strictEqual(findInitSegmentLength(init.slice(0, 5)), 0);
	});

	it('rejects payloads that are not fragmented MP4', () => {
		const { findInitSegmentLength } = loadPureHelpers();
		assert.strictEqual(findInitSegmentLength(Buffer.from('GARBAGE-NOT-AN-MP4-STREAM')), -1);
		// an MJPEG-ish or moof-first stream has no leading ftyp/moov
		assert.strictEqual(findInitSegmentLength(mp4Box('moof', Buffer.alloc(8))), -1);
	});

	it('derives RFC 6381 codec strings from avcC and esds boxes', () => {
		const { extractFmp4Codecs } = loadPureHelpers();
		assert.deepStrictEqual(extractFmp4Codecs(buildInitSegment()), ['avc1.64001f', 'mp4a.40.2']);
		// video-only stream (camera without audio)
		const ftyp = mp4Box('ftyp', Buffer.from('isom'), Buffer.alloc(4));
		const videoOnly = Buffer.concat([ftyp, mp4Box('moov', buildVideoTrak(0x42, 0xc0, 0x1e))]);
		assert.deepStrictEqual(extractFmp4Codecs(videoOnly), ['avc1.42c01e']);
		// HE-AAC signalled through the DecoderSpecificInfo audioObjectType
		const heAac = Buffer.concat([ftyp, mp4Box('moov', buildAudioTrak(5))]);
		assert.deepStrictEqual(extractFmp4Codecs(heAac), ['mp4a.40.5']);
	});

	it('trims the rolling window without crossing the playhead', () => {
		const { computeDvrEvictionCutoff } = loadPureHelpers();
		// inside the window (incl. slack): nothing to trim
		assert.strictEqual(computeDvrEvictionCutoff(0, 200, 195, 300), null);
		// window exceeded while at the live edge: trim down to windowSeconds
		assert.strictEqual(computeDvrEvictionCutoff(0, 400, 395, 300), 100);
		// playhead parked in old history: trim stops short of the playhead
		assert.strictEqual(computeDvrEvictionCutoff(0, 400, 50, 300), 45);
		// playhead so old that only a sliver could go: skip (avoid churn)
		assert.strictEqual(computeDvrEvictionCutoff(0, 400, 8, 300), null);
		assert.strictEqual(computeDvrEvictionCutoff(NaN, 400, 8, 300), null);
	});

	it('maps media time to wall-clock time across reconnect epochs', () => {
		const { wallTimeFromEpochs } = loadPureHelpers();
		const w1 = 1700000000000;
		const w2 = w1 + 500000; // reconnected after a gap
		const epochs = [{ media: 0, wall: w1 }, { media: 100, wall: w2 }];
		assert.strictEqual(wallTimeFromEpochs(epochs, 40).getTime(), w1 + 40000);
		assert.strictEqual(wallTimeFromEpochs(epochs, 150).getTime(), w2 + 50000);
		// exactly at the stitch boundary the newer epoch wins
		assert.strictEqual(wallTimeFromEpochs(epochs, 100).getTime(), w2);
		assert.strictEqual(wallTimeFromEpochs([], 10), null);
		assert.strictEqual(wallTimeFromEpochs(epochs, NaN), null);
	});
});

describe('Video timeshift (DVR) wiring', () => {
	it('ships video-dvr.js in the app shell and the service worker precache', () => {
		const index = fs.readFileSync(INDEX_FILE, 'utf8');
		const sw = fs.readFileSync(SW_FILE, 'utf8');
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(index, /<script src="video-dvr\.__JS_VERSION__\.js"><\/script>\s*<script src="app\.__JS_VERSION__\.js"><\/script>/);
		assert.match(sw, /'\.\/video-dvr\.__JS_VERSION__\.js',/);
		// versioned asset route (each shell script needs its own; without it
		// the catch-all serves the HTML shell instead of the script)
		assert.match(server, /const VIDEO_DVR_JS_PATH = path\.join\(PUBLIC_DIR, 'video-dvr\.js'\);/);
		assert.match(server, /app\.get\(\/\^\\\/video-dvr\\\.v\[\\w\.-\]\+\\\.js\$\/i, \(req, res\) => \{\s*sendVersionedAsset\(res, VIDEO_DVR_JS_PATH, 'application\/javascript; charset=utf-8'\);\s*\}\);/);
	});

	it('starts widget streams through the DVR engine with a direct-src fallback', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function startVideoWidgetStream\(videoEl, videoContainer, videoSrc\)/);
		assert.match(app, /const videoSrc = `\$\{videoUrl\}&w=\$\{containerWidth\}`;\s*startVideoWidgetStream\(videoEl, videoContainer, videoSrc\);/);
		// URL change tears down the old session before the new stream starts
		assert.match(app, /resetVideoZoom\(videoEl\);\s*if \(videoEl\.__dvr\) videoEl\.__dvr\.destroy\(\);\s*requestAnimationFrame/);
		// engine-declined or engine-failed sessions fall back to plain src
		assert.match(app, /onFallback: \(\) => \{\s*videoEl\.src = videoSrc;\s*videoEl\.play\(\)\.catch\(\(\) => \{\}\);\s*\},/);
		assert.match(app, /if \(session\) return;\s*\}\s*videoEl\.src = videoSrc;/);
	});

	it('keeps the live-stream babysitters away from intentional DVR pauses', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		// health check: never force-play a user-paused, suspended or
		// scrub-held DVR session
		assert.match(app, /if \(videoEl\.__dvr && \(videoEl\.__dvr\.isUserPaused\(\) \|\| videoEl\.__dvr\.isSuspended\(\) \|\| videoEl\.__dvr\.isScrubbing\(\)\)\) return;\s*if \(videoEl\.src && videoEl\.paused && !videoEl\.ended\)/);
		// stalled babysitter respects the DVR pause and held scrubs too
		assert.match(app, /if \(videoEl\.__dvr && \(videoEl\.__dvr\.isUserPaused\(\) \|\| videoEl\.__dvr\.isScrubbing\(\)\)\) return;\s*if \(videoEl\.src\) \{\s*videoEl\.play\(\)/);
		// restart goes through the engine instead of a src round-trip
		assert.match(app, /if \(videoEl\.__dvr\) \{\s*videoEl\.__dvr\.restart\(\);\s*videoEl\.play\(\)\.catch\(\(\) => \{\}\);\s*return;\s*\}/);
	});

	it('suspends instead of dropping DVR sessions across visibility changes', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function pauseVideoStreamsForVisibility\(\) \{[\s\S]*?video\.__dvr\.suspend\(\);\s*continue;/);
		assert.match(app, /function resumeVideoStreamsFromVisibility\(\) \{[\s\S]*?video\.__dvr\.resumeFromSuspend\(\);[\s\S]*?continue;/);
		assert.match(app, /function stopAllVideoStreams\(\) \{[\s\S]*?if \(video\.__dvr\) video\.__dvr\.destroy\(\);/);
		// widget losing its URL destroys the session before removing the DOM
		assert.match(app, /if \(staleVideo && staleVideo\.__dvr\) staleVideo\.__dvr\.destroy\(\);/);
	});

	it('rotates the DVR bar together with fs-rotated fullscreen video', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		const adds = app.match(/videoEl\.classList\.add\('fs-rotated'\);\s*(?:\/\/[^\n]*\n\s*)*videoContainer\.classList\.add\('dvr-rotated'\);/g) || [];
		assert.strictEqual(adds.length, 2, 'both fs-rotated paths sync the dvr-rotated container class');
		assert.match(app, /videoEl\.classList\.remove\('fs-rotated'\);\s*if \(videoContainer\) videoContainer\.classList\.remove\('dvr-rotated'\);/);
		assert.match(css, /\.video-container\.dvr-rotated \.video-dvr \{[\s\S]*?rotate\(90deg\)[\s\S]*?\}/);
		// the engine reads the rotated flag to scrub along the vertical axis
		const dvr = fs.readFileSync(DVR_FILE, 'utf8');
		assert.match(dvr, /videoContainer\.classList\.contains\('dvr-rotated'\)/);
		assert.match(dvr, /event\.clientY - rect\.top/);
	});

	it('lays the bar out clear of the existing overlay controls', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		const start = css.indexOf('.video-dvr {');
		assert.ok(start > -1);
		const block = css.slice(start, css.indexOf('}', start));
		assert.match(block, /left: 8px;/);
		assert.match(block, /right: 88px;/); // mute (right:48 + 32px) + gap
		// 34px outer at bottom:7 puts the 32px black area inside the 1px
		// border exactly on the buttons' 8px-inset 32px band
		assert.match(block, /bottom: 7px;/);
		assert.match(block, /height: 34px;/);
		assert.match(block, /z-index: 26;/); // above video(15)/badges(20)/fs buttons(25)
		assert.match(block, /touch-action: none;/);
		// bar surface is half-transparent; the controls on it are opaque
		assert.match(block, /background: rgba\(0, 0, 0, \.5\);/);
		assert.match(block, /border: 1px solid #3a3a3a;/);
		assert.match(css, /\.video-clock\.dvr-shifted \{/);
	});

	it('exposes the timeshift settings via config defaults, validation and the admin modal', () => {
		const defaults = fs.readFileSync(DEFAULTS_FILE, 'utf8');
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		const app = fs.readFileSync(APP_FILE, 'utf8');
		const lang = fs.readFileSync(LANG_FILE, 'utf8');
		assert.match(defaults, /videoDvr: \{[\s\S]*?enabled: true,[\s\S]*?windowSeconds: 300,[\s\S]*?\},/);
		// MediaSource object URLs need media-src blob: in the CSP
		assert.match(defaults, /media-src 'self' blob:;/);
		// startup + live-reload validation
		assert.match(server, /ensureBoolean\(CLIENT_CONFIG\.videoDvr\?\.enabled, 'client\.videoDvr\.enabled', errors\);/);
		assert.match(server, /ensureNumber\(CLIENT_CONFIG\.videoDvr\?\.windowSeconds, 'client\.videoDvr\.windowSeconds', \{ min: 30 \}, errors\);/);
		assert.match(server, /if \(isPlainObject\(c\.videoDvr\)\) \{[\s\S]*?client\.videoDvr\.enabled[\s\S]*?client\.videoDvr\.windowSeconds[\s\S]*?\}/);
		// admin settings modal section + labels
		assert.match(app, /id: 'client-video', group: 'client', reloadRequired: true,\s*fields: \[\s*\{ key: 'client\.videoDvr\.enabled', type: 'toggle' \},\s*\{ key: 'client\.videoDvr\.windowSeconds', type: 'number', min: 30 \},\s*\],/);
		assert.match(lang, /'client-video': 'VIDEO',/);
		assert.match(lang, /'client\.videoDvr\.enabled': 'Video Timeshift \(DVR\)',/);
		assert.match(lang, /'client\.videoDvr\.windowSeconds': 'Timeshift Window \(s\)',/);
		assert.match(lang, /'client\.videoDvr\.enabled': 'In-browser timeshift buffer/);
		assert.match(lang, /'client\.videoDvr\.windowSeconds': 'Rolling timeshift history/);
	});

	it('shows the bar immediately but keeps it inert until history exists', () => {
		const dvr = fs.readFileSync(DVR_FILE, 'utf8');
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(dvr, /const DVR_UNLOCK_WINDOW_S = 5;/);
		assert.match(dvr, /barLocked = span < DVR_UNLOCK_WINDOW_S;\s*bar\.classList\.toggle\('locked', barLocked\);/);
		// every entry point respects the lock: scrub, play/pause, LIVE
		assert.match(dvr, /if \(!bar\.classList\.contains\('ready'\) \|\| barLocked\) return;/);
		assert.match(dvr, /playBtn\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); if \(barLocked\) return; togglePlay\(\); \}\);/);
		assert.match(dvr, /liveBtn\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); if \(barLocked\) return; goLive\(\); \}\);/);
		assert.match(css, /\.video-dvr\.locked \.video-dvr-play,\s*\.video-dvr\.locked \.video-dvr-track,\s*\.video-dvr\.locked \.video-dvr-live \{\s*opacity: \.45;\s*cursor: default;\s*\}/);
	});

	it('scrubs live while dragging, not only on release', () => {
		const dvr = fs.readFileSync(DVR_FILE, 'utf8');
		assert.match(dvr, /const DRAG_SEEK_THROTTLE_MS = 150;/);
		// pointerdown disarms follow-live, pauses for the scrub preview and
		// seeks immediately...
		assert.match(dvr, /session\.followLive = false;[\s\S]*?videoEl\.pause\(\);[\s\S]*?lastDragFraction = trackFraction\(e\);\s*previewScrub\(lastDragFraction\);\s*scrubSeek\(lastDragFraction\);/);
		// ...and pointermove keeps seeking, throttled
		assert.match(dvr, /const fraction = trackFraction\(e\);\s*lastDragFraction = fraction;\s*previewScrub\(fraction\);/);
		assert.match(dvr, /if \(now - lastDragSeekAt >= DRAG_SEEK_THROTTLE_MS\) \{\s*lastDragSeekAt = now;\s*scrubSeek\(fraction\);/);
		// a HELD pointer stays live: every append re-resolves the preview
		// against the stretched timeline and reseeks once the landing target
		// has drifted past the threshold
		assert.match(dvr, /const DRAG_DRIFT_RESEEK_S = 0\.5;/);
		assert.match(dvr, /if \(dragging\) \{\s*previewScrub\(lastDragFraction\);\s*const tw = timelineWindow\(\);\s*if \(tw && Math\.abs\(timelineTime\(lastDragFraction, tw\) - videoEl\.currentTime\) > DRAG_DRIFT_RESEEK_S\) \{\s*scrubSeek\(lastDragFraction\);\s*\}\s*return;\s*\}/);
		// drag-initiated seeking must not re-arm follow-live mid-drag
		assert.match(dvr, /addVideoListener\('seeking', \(\) => \{[\s\S]*?if \(dragging\) return;/);
		// release still applies the authoritative position + live decision,
		// and resumes playback unless the user had paused
		assert.match(dvr, /haptic\(\);\s*applyScrub\(trackFraction\(e\)\);/);
		assert.match(dvr, /function applyScrub\(fraction\) \{[\s\S]*?if \(!session\.userPaused\) videoEl\.play\(\)\.catch\(\(\) => \{\}\);/);
		// the babysitters can tell a held scrub apart from a stall
		assert.match(dvr, /session\.isScrubbing = \(\) => dragging;/);
	});

	it('shows the landing bubble on hover, kept live while the pointer rests', () => {
		const dvr = fs.readFileSync(DVR_FILE, 'utf8');
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		// drag preview and hover preview share one bubble writer
		assert.match(dvr, /function positionBubble\(fraction\) \{/);
		assert.match(dvr, /const behind = positionBubble\(fraction\);\s*offsetLabel\.textContent = behind !== null && behind > LIVE_LATENCY_SHIFT_S \? '-' \+ formatOffset\(behind\) : '';/);
		// mouse hover shows the bubble without engaging the scrub; touch has
		// no hover and goes straight to the drag path; a locked bar stays inert
		assert.match(dvr, /track\.addEventListener\('pointerenter', \(e\) => \{\s*if \(e\.pointerType === 'touch' \|\| dragging \|\| !bar\.classList\.contains\('ready'\) \|\| barLocked\) return;\s*lastHoverFraction = trackFraction\(e\);\s*setHovering\(true\);\s*positionBubble\(lastHoverFraction\);\s*\}\);/);
		assert.match(dvr, /track\.addEventListener\('pointerleave', \(\) => \{\s*setHovering\(false\);\s*\}\);/);
		assert.match(dvr, /if \(!dragging\) \{\s*if \(e\.pointerType === 'touch' \|\| !bar\.classList\.contains\('ready'\) \|\| barLocked\) return;\s*lastHoverFraction = trackFraction\(e\);\s*setHovering\(true\);\s*positionBubble\(lastHoverFraction\);\s*return;\s*\}/);
		// a resting hover pointer stays live as appends stretch the span
		assert.match(dvr, /if \(hovering\) \{\s*if \(barLocked\) setHovering\(false\);\s*else positionBubble\(lastHoverFraction\);\s*\}/);
		assert.match(css, /\.video-dvr\.hover-preview \.video-dvr-bubble,\s*\.video-dvr\.dragging \.video-dvr-bubble \{ display: block; \}/);
	});

	it('keeps zoom available for paused and time-shifted DVR frames', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		// pause/waiting/stalled leave a valid frame on a DVR session
		assert.match(app, /const transientWithFrame = e && \(e\.type === 'pause' \|\| e\.type === 'waiting' \|\| e\.type === 'stalled'\);\s*if \(transientWithFrame && videoEl\.__dvr && videoEl\.readyState >= 2\) return;\s*setVideoZoomReady\(videoEl, false\);/);
		// paused scrubbing re-arms via 'seeked' (no 'playing' follows)
		assert.match(app, /videoEl\.addEventListener\('seeked', \(\) => \{\s*if \(videoEl\.__dvr && videoEl\.readyState >= 2\) setVideoZoomReady\(videoEl, true\);\s*\}\);/);
		// card re-renders must not kill zoom on a paused DVR review
		assert.match(app, /setVideoZoomReady\(videoEl, !videoEl\.ended && \(!videoEl\.paused \|\| \(!!videoEl\.__dvr && videoEl\.readyState >= 2\)\)\);/);
		// visibility resume restores zoom for a paused-in-review session
		assert.match(app, /video\.__dvr\.resumeFromSuspend\(\);[\s\S]*?if \(!video\.ended && video\.readyState >= 2\) setVideoZoomReady\(video, true\);/);
	});

	it('scales the timeline to the buffered span and glides position changes', () => {
		const dvr = fs.readFileSync(DVR_FILE, 'utf8');
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		// the track represents exactly the buffered span (oldest -> live
		// edge), so the played fill covers the full rail at the live edge
		assert.match(dvr, /return \{ start: range\.start, end: range\.end, windowS: spanS, origin: range\.start \};/);
		assert.match(dvr, /const posPct = live \? 100 : timelinePct\(clamped, tw\);/);
		assert.match(dvr, /fill\.style\.width = posPct \+ '%';\s*thumb\.style\.left = posPct \+ '%';/);
		// scrub targets clamp into the buffered span
		assert.match(dvr, /const target = tw\.origin \+ tw\.windowS \* fraction;\s*return Math\.min\(tw\.end, Math\.max\(tw\.start, target\)\);/);
		// the scale extrapolates the live edge between appends (positions
		// would otherwise see-saw: right on timeupdate, left on each append)
		// and a UI ticker repaints between media events; seeks still clamp
		// to the real buffered end
		assert.match(dvr, /const UI_TICK_MS = 100;/);
		assert.match(dvr, /const EDGE_EXTRAPOLATION_MAX_S = 2\.5;/);
		assert.match(dvr, /if \(range\.end !== edgeBaseEnd\) \{\s*edgeBaseEnd = range\.end;\s*edgeBaseWall = performance\.now\(\);\s*\}/);
		assert.match(dvr, /const scaleEnd = range\.end \+ Math\.min\(EDGE_EXTRAPOLATION_MAX_S, \(performance\.now\(\) - edgeBaseWall\) \/ 1000\);/);
		assert.match(dvr, /const uiTicker = setInterval\(\(\) => \{\s*if \(session\.destroyed \|\| session\.suspended \|\| document\.hidden\) return;\s*if \(!bar\.classList\.contains\('ready'\)\) return;\s*scheduleUiUpdate\(\);\s*\}, UI_TICK_MS\);/);
		assert.match(dvr, /clearInterval\(watchdog\);\s*clearInterval\(uiTicker\);/);
		// the short glide smooths the discrete residue and is disabled while
		// dragging so the pointer is tracked 1:1
		assert.match(css, /\.video-dvr-fill \{[^}]*transition: width \.2s linear;[^}]*\}/);
		assert.match(css, /\.video-dvr\.dragging \.video-dvr-fill \{ transition: none; \}/);
		assert.match(css, /transition: transform \.15s ease, left \.2s linear;/);
		assert.match(css, /\.video-dvr\.dragging \.video-dvr-thumb \{ transform: scale\(1\.35\); transition: transform \.15s ease; \}/);
		// the gray remainder past the thumb still covers the whole rail
		assert.match(dvr, /avail\.className = 'video-dvr-avail';/);
		assert.match(css, /\.video-dvr-avail \{/);
	});

	it('does not swallow play-button clicks with mid-click icon repaints', () => {
		const dvr = fs.readFileSync(DVR_FILE, 'utf8');
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		// icon only rewrites when the paused state flips - rewriting the svg
		// between mousedown and mouseup makes the browser drop the click
		assert.match(dvr, /const wantIcon = videoEl\.paused \? 'play' : 'pause';\s*if \(playBtn\.dataset\.icon !== wantIcon\) \{\s*playBtn\.dataset\.icon = wantIcon;\s*playBtn\.innerHTML = videoEl\.paused \? PLAY_SVG : PAUSE_SVG;/);
		assert.match(css, /\.video-dvr-play svg \{[^}]*pointer-events: none;[^}]*\}/);
	});

	it('pulses the live dot while at the live edge', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(css, /@keyframes dvr-live-pulse \{/);
		assert.match(css, /\.video-dvr\.at-live \.video-dvr-live-dot \{\s*animation: dvr-live-pulse 1\.6s ease-in-out infinite;\s*\}/);
	});

	it('streams around the worker RPC fetch transport', () => {
		const dvr = fs.readFileSync(DVR_FILE, 'utf8');
		const transport = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'transport-client.js'), 'utf8');
		// The SW HTTP RPC ships bodies as single buffered payloads - an
		// endless stream never completes, stalling first playback for the
		// full workerRpcTimeoutMs before the native-fetch fallback kicks in.
		// The engine therefore always uses the pristine native fetch.
		assert.match(transport, /window\.__OH_NATIVE_FETCH__ = state\.nativeFetch;/);
		assert.match(dvr, /const doFetch = window\.__OH_NATIVE_FETCH__ \|\| window\.fetch;\s*doFetch\(url, \{ credentials: 'same-origin', cache: 'no-store', signal: ctrl\.signal \}\)/);
	});

	it('handles the hard parts of the MSE pipeline in the engine', () => {
		const dvr = fs.readFileSync(DVR_FILE, 'utf8');
		// reconnects stitch onto the live edge instead of restarting at zero
		assert.match(dvr, /const offset = item\.first \? 0 : liveEdge\(\) \+ 0\.1;\s*sourceBuffer\.timestampOffset = offset;/);
		assert.match(dvr, /epochs\.push\(\{ media: offset, wall: Date\.now\(\) \}\);/);
		// quota pressure shrinks the window instead of dying
		assert.match(dvr, /err\.name === 'QuotaExceededError'/);
		assert.match(dvr, /windowSeconds = Math\.max\(DVR_MIN_WINDOW_S, Math\.floor\(windowSeconds \* 0\.75\)\);/);
		// iPhone (iOS 17.1+) support via ManagedMediaSource
		assert.match(dvr, /window\.MediaSource \|\| window\.ManagedMediaSource/);
		assert.match(dvr, /disableRemotePlayback/);
		// native players (iOS fullscreen) get a scrubbable live range
		assert.match(dvr, /setLiveSeekableRange/);
		// detached elements clean themselves up (page switches, re-renders)
		assert.match(dvr, /if \(!document\.contains\(videoEl\)\) destroy\(\);/);
		// repeated failures pin the widget to the legacy path for the session
		assert.match(dvr, /dvrFailureCounts\.get\(url\) \|\| 0\) >= MAX_FAILURES_PER_URL\) return null;/);
	});
});
