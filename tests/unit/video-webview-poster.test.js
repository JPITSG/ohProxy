'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

const TRANSPARENT_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

describe('Video WebView poster placeholder', () => {
	// Android WebView fills a poster-less <video> with WebChromeClient's built-in
	// gray play-button bitmap, painting it over the .video-preview thumbnail behind
	// the element. It only does that when the attribute is absent.
	it('declares a transparent poster placeholder', () => {
		assert.match(app, /const VIDEO_TRANSPARENT_POSTER = '([^']+)';/);
		const declared = app.match(/const VIDEO_TRANSPARENT_POSTER = '([^']+)';/)[1];
		assert.strictEqual(declared, TRANSPARENT_GIF);
	});

	it('the placeholder is a real 1x1 fully transparent GIF', () => {
		const buf = Buffer.from(TRANSPARENT_GIF.split(',')[1], 'base64');
		assert.strictEqual(buf.slice(0, 6).toString('ascii'), 'GIF89a');
		assert.strictEqual(buf.readUInt16LE(6), 1, 'width must be 1');
		assert.strictEqual(buf.readUInt16LE(8), 1, 'height must be 1');
		// Graphic Control Extension (21 F9 04), low bit of the packed field is the
		// transparent-colour flag. Without it the poster would paint an opaque pixel.
		const gce = buf.indexOf(Buffer.from([0x21, 0xF9, 0x04]));
		assert.ok(gce >= 0, 'must carry a Graphic Control Extension');
		assert.strictEqual(buf[gce + 3] & 1, 1, 'transparent colour flag must be set');
	});

	it('sets the placeholder on every newly created stream element', () => {
		assert.match(app, /videoEl\.setAttribute\('poster', VIDEO_TRANSPARENT_POSTER\);/);
	});

	it('restores the placeholder after resume instead of clearing the attribute', () => {
		// Clearing it would hand the element back to WebView's default poster.
		assert.match(app, /video\.poster = VIDEO_TRANSPARENT_POSTER;/);
		// Comments legitimately mention the call, so assert against code only.
		const code = app.replace(/^\s*\/\/.*$/gm, '');
		assert.ok(
			!/removeAttribute\(['"]poster['"]\)/.test(code),
			'no code path may remove the poster attribute outright'
		);
	});
});
