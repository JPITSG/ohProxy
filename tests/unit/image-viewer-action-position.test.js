'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');

describe('image viewer action positioning', () => {
	it('anchors the image viewer action buttons to the bottom-right with video-card spacing', () => {
		const styles = fs.readFileSync(STYLES_FILE, 'utf8');

		assert.match(styles, /\.image-viewer-actions \{\s*position: absolute;\s*top: auto;\s*right: 8px;\s*bottom: 8px;\s*display: flex;\s*gap: \.5rem;\s*z-index: 2;\s*\}/s);
		assert.match(styles, /\.image-viewer-close,\s*\.image-viewer-download \{\s*width: 32px;\s*height: 32px;/s);
	});

	it('reuses the image viewer hover opacity effect for enabled video corner buttons', () => {
		const styles = fs.readFileSync(STYLES_FILE, 'utf8');

		assert.match(styles, /\.image-viewer-close:hover,\s*\.image-viewer-download:hover \{\s*opacity: \.9;\s*\}/s);
		assert.match(styles, /\.video-mute-btn:hover:not\(:disabled\):not\(\[data-audio-state="hidden"\]\),\s*\.video-fullscreen-btn:hover:not\(:disabled\) \{\s*opacity: \.9 !important;\s*\}/s);
	});
});
