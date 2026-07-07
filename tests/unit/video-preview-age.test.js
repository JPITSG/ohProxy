'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Video preview capture mtime integrity', () => {
	it('captures to a temp file and renames into place only on success', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		const start = server.indexOf('async function captureVideoPreview(');
		assert.ok(start > -1);
		const body = server.slice(start, start + 3000);
		assert.match(body, /const tempPath = path\.join\(VIDEO_PREVIEW_DIR, `\$\{hash\}\.tmp\.jpg`\);/);
		// ffmpeg must write the temp path, not the final path
		assert.match(body, /'-q:v', '2',\s*tempPath,/);
		// success path: verify non-empty output then atomic rename (preserves the
		// temp file's mtime, which is the frame capture time)
		assert.match(body, /if \(!killed && code === 0\) \{\s*try \{\s*const tempStats = fs\.statSync\(tempPath\);\s*if \(tempStats\.size > 0\) \{\s*fs\.renameSync\(tempPath, outputPath\);\s*finalized = true;/);
		// failure paths discard the temp file and leave the old thumbnail alone
		assert.match(body, /if \(!finalized\) discardTempFile\(\);/);
		assert.match(body, /ok: finalized,/);
	});

	it('serves the capture time as the preview version', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const previewVersion = String\(Math\.trunc\(stats\.mtimeMs\)\);/);
		assert.match(server, /res\.set\('X-Preview-Version', previewVersion\);/);
	});
});

describe('Video preview age badge', () => {
	it('formats ages across the full unit range', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		const start = app.indexOf('function formatVideoPreviewAge(ageMs)');
		assert.ok(start > -1);
		const body = app.slice(start, app.indexOf('function getVideoPreviewAgeBadge'));
		assert.match(body, /const seconds = Math\.max\(1, Math\.floor\(ageMs \/ 1000\)\);/);
		for (const unit of ['year', 'month', 'week', 'day', 'hour', 'minute', 'second']) {
			assert.ok(body.includes(`['${unit}',`), `missing unit ${unit}`);
		}
		assert.match(body, /return `\$\{count\} \$\{name\}\$\{count === 1 \? '' : 's'\} ago`;/);
	});

	it('stores the capture timestamp when the preview version resolves', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /applyVideoPreviewUrl\(previewDiv, previewUrl\);\s*setVideoPreviewCapturedAt\(previewDiv, version \|\| ''\);/);
		// clearing the preview clears the badge too
		assert.match(app, /applyVideoPreviewUrl\(previewDiv, ''\);\s*setVideoPreviewCapturedAt\(previewDiv, ''\);\s*return;/);
	});

	it('shows the badge only while the preview is up and hides once playing', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /videoEl\.addEventListener\('playing', \(\) => setVideoStreamLive\(videoEl, true\)\);/);
		assert.match(app, /for \(const evt of \['loadstart', 'emptied', 'error'\]\) \{\s*videoEl\.addEventListener\(evt, \(\) => setVideoStreamLive\(videoEl, false\)\);\s*\}/);
		assert.match(app, /const visible = capturedAt > 0 && !streamLive;\s*badge\.classList\.toggle\('hidden', !visible\);/);
	});

	it('marks thumbnails older than the freshness window with the alert background', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const VIDEO_PREVIEW_STALE_MS = 60000;/);
		// re-evaluated on every badge update, so the 1s ticker flips the state
		// live as the thumbnail crosses the threshold
		assert.match(app, /const ageMs = Date\.now\(\) - capturedAt;\s*const text = formatVideoPreviewAge\(ageMs\);\s*if \(badge\.textContent !== text\) badge\.textContent = text;\s*badge\.classList\.toggle\('stale', ageMs > VIDEO_PREVIEW_STALE_MS\);/);
	});

	it('ticks visible badges and stops the ticker when none remain', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function ensureVideoPreviewAgeTicker\(\) \{\s*if \(videoPreviewAgeTicker\) return;\s*videoPreviewAgeTicker = setInterval\(\(\) => \{[\s\S]*?if \(!anyVisible\) \{\s*clearInterval\(videoPreviewAgeTicker\);\s*videoPreviewAgeTicker = null;\s*\}\s*\}, 1000\);/);
		// avoid DOM churn: text is only written when it changes
		assert.match(app, /if \(badge\.textContent !== text\) badge\.textContent = text;/);
	});

	it('styles the badge like the control buttons (size, corners, opacity) in gray', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		const start = css.indexOf('.video-preview-age {');
		assert.ok(start > -1);
		const block = css.slice(start, css.indexOf('}', start));
		assert.match(block, /bottom: 8px;/);
		assert.match(block, /left: 8px;/);
		assert.match(block, /z-index: 20;/);
		assert.match(block, /height: 32px;/);
		assert.match(block, /border-radius: 6\.4px;/);
		assert.match(block, /background: #000000;/);
		assert.match(block, /opacity: \.4;/);
		assert.match(block, /transition: opacity \.4s ease;/);
		assert.match(block, /pointer-events: none;/);
		// hidden in fullscreen like the preview and spinner
		assert.match(css, /\.video-container:fullscreen \.video-preview-age,/);
		assert.match(css, /\.video-container\.fs-active \.video-preview-age \{/);
	});
});
