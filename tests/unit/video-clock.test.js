'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Video stream clock', () => {
	it('no longer burns a drawtext time overlay into the transcoded stream', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.doesNotMatch(server, /drawtext=/);
		// -vf is now scale-only and omitted entirely when no width is requested
		assert.match(server, /const scaleArgs = scaleWidth > 0 \? \['-vf', `scale=\$\{scaleWidth\}:-2`\] : \[\];/);
		assert.match(server, /\.\.\.scaleArgs,\s*'-c:v', 'libx264',/);
	});

	it('drives the clock exclusively from presented video frames', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		const start = app.indexOf('function initVideoClock(videoEl, videoContainer)');
		const end = app.indexOf('function buildCompactSearchPlaceholder');
		assert.ok(start > -1 && end > start);
		const body = app.slice(start, end);
		// each presented frame stamps the current time, clears the stall alert,
		// re-arms the watchdog and the callback
		assert.match(body, /const hasFrameCallback = typeof videoEl\.requestVideoFrameCallback === 'function';/);
		assert.match(body, /const text = formatDT\(new Date\(\), TIME_FORMAT\);\s*if \(clock\.textContent !== text\) clock\.textContent = text;\s*clock\.classList\.remove\('stalled'\);\s*clock\.classList\.remove\('hidden'\);\s*armClockStallWatchdog\(\);/);
		// exactly one armed callback via pending flag; never cancelled from event
		// handlers (cancelling on 'playing' can starve the chain on live streams)
		assert.match(body, /if \(!hasFrameCallback \|\| frameCallbackPending\) return;\s*frameCallbackPending = true;\s*videoEl\.requestVideoFrameCallback\(onFrame\);/);
		assert.doesNotMatch(body, /cancelVideoFrameCallback/);
		// the displayed time is never advanced by wall-clock timers: the only
		// textContent write sits in the frame callback, and the only timer is
		// the stall watchdog, which just flags the alert class
		assert.doesNotMatch(body, /setInterval|requestAnimationFrame/);
		assert.strictEqual((body.match(/textContent = /g) || []).length, 1);
		assert.match(body, /stallTimer = setTimeout\(markClockStalled, VIDEO_CLOCK_STALL_MS\);/);
		assert.match(body, /const markClockStalled = \(\) => \{\s*stallTimer = null;\s*const clock = videoContainer\.querySelector\('\.video-clock'\);\s*if \(clock && !clock\.classList\.contains\('hidden'\)\) clock\.classList\.add\('stalled'\);\s*\};/);
		// fallback path only advances when currentTime actually moved
		assert.match(body, /if \(videoEl\.currentTime === lastMediaTime\) return;\s*lastMediaTime = videoEl\.currentTime;\s*onFrame\(\);/);
	});

	it('flags a stalled stream with the alert background and clears it on reset', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(app, /const VIDEO_CLOCK_STALL_MS = 3000;/);
		// stream reset hides the clock and drops any stall alert
		assert.match(app, /clock\.classList\.add\('hidden'\);\s*clock\.classList\.remove\('stalled'\);/);
		// shared alert background for stale thumbnail + stalled clock; only the
		// background changes, so the clock keeps its .5 opacity while stalled
		assert.match(css, /\.video-preview-age\.stale,\s*\.video-clock\.stalled \{\s*background: #8b0000;\s*\}/);
	});

	it('hides the clock whenever the stream resets to the preview state', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /if \(!live\) \{\s*const clock = container\.querySelector\('\.video-clock'\);\s*if \(clock\) \{\s*clock\.classList\.add\('hidden'\);\s*clock\.classList\.remove\('stalled'\);\s*\}\s*\}/);
		// created hidden; only a presented frame reveals it
		assert.match(app, /streamClock\.className = 'video-clock hidden';/);
		assert.match(app, /initVideoClock\(videoEl, videoContainer\);/);
	});

	it('styles the clock like the control buttons, black at 50% opacity, top right', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		const start = css.indexOf('.video-clock {');
		assert.ok(start > -1);
		const block = css.slice(start, css.indexOf('}', start));
		assert.match(block, /top: 8px;/);
		assert.match(block, /right: 8px;/);
		assert.match(block, /height: 32px;/);
		assert.match(block, /border-radius: 6\.4px;/);
		assert.match(block, /background: #000000;/);
		assert.match(block, /color: #ffffff;/);
		assert.match(block, /opacity: \.5;/);
		assert.match(block, /font-variant-numeric: tabular-nums;/);
		assert.match(block, /pointer-events: none;/);
		// unlike preview/spinner/age badge, the clock stays visible in fullscreen
		// (parity with the old burned-in overlay)
		const fsRuleStart = css.indexOf('/* Hide preview/spinner/age badge in fullscreen */');
		assert.ok(fsRuleStart > -1);
		const fsRule = css.slice(fsRuleStart, css.indexOf('}', fsRuleStart));
		assert.doesNotMatch(fsRule, /video-clock/);
	});
});
