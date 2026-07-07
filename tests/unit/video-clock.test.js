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
		assert.ok(start > -1);
		const body = app.slice(start, start + 2200);
		// each presented frame stamps the current time and re-arms the callback
		assert.match(body, /const hasFrameCallback = typeof videoEl\.requestVideoFrameCallback === 'function';/);
		assert.match(body, /const text = formatDT\(new Date\(\), TIME_FORMAT\);\s*if \(clock\.textContent !== text\) clock\.textContent = text;\s*clock\.classList\.remove\('hidden'\);/);
		// exactly one armed callback via pending flag; never cancelled from event
		// handlers (cancelling on 'playing' can starve the chain on live streams)
		assert.match(body, /if \(!hasFrameCallback \|\| frameCallbackPending\) return;\s*frameCallbackPending = true;\s*videoEl\.requestVideoFrameCallback\(onFrame\);/);
		assert.doesNotMatch(body, /cancelVideoFrameCallback/);
		// no wall-clock interval anywhere in the clock: a stalled stream must freeze it
		assert.doesNotMatch(body, /setInterval|setTimeout|requestAnimationFrame/);
		// fallback path only advances when currentTime actually moved
		assert.match(body, /if \(videoEl\.currentTime === lastMediaTime\) return;\s*lastMediaTime = videoEl\.currentTime;\s*onFrame\(\);/);
	});

	it('hides the clock whenever the stream resets to the preview state', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /if \(!live\) \{\s*const clock = container\.querySelector\('\.video-clock'\);\s*if \(clock\) clock\.classList\.add\('hidden'\);\s*\}/);
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
