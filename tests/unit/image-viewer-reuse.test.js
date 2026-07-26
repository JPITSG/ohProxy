'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');

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

function buildFunction(name, dependencies = {}) {
	const names = Object.keys(dependencies);
	const values = Object.values(dependencies);
	return Function(...names, `return (${extractFunction(app, name)});`)(...values);
}

describe('image viewer source reuse', () => {
	it('fits using the image aspect ratio instead of requesting the full frame width', () => {
		const imageViewerFitSize = buildFunction('imageViewerFitSize', {
			IMAGE_VIEWER_MAX_VIEWPORT: 0.9,
		});

		assert.deepStrictEqual(imageViewerFitSize(540, 780, 425, 850), {
			width: 383,
			height: 553,
		});
		assert.deepStrictEqual(imageViewerFitSize(1600, 900, 1242, 800), {
			width: 1118,
			height: 629,
		});
		assert.deepStrictEqual(imageViewerFitSize(0, 0, 425, 850), {
			width: 383,
			height: 765,
		});
	});

	it('only upgrades a loaded card image when the fitted viewer is materially wider', () => {
		const imageViewerFitSize = buildFunction('imageViewerFitSize', {
			IMAGE_VIEWER_MAX_VIEWPORT: 0.9,
		});
		const mobileWindow = { innerWidth: 425, innerHeight: 850 };
		const mobileNeedsUpgrade = buildFunction('imageViewerSourceNeedsUpgrade', {
			imageViewerFitSize,
			window: mobileWindow,
			IMAGE_VIEWER_UPGRADE_RATIO: 1.1,
		});
		assert.strictEqual(
			mobileNeedsUpgrade({ naturalWidth: 540, naturalHeight: 780 }),
			false,
			'the weather image already covers its fitted mobile viewer width'
		);

		const desktopWindow = { innerWidth: 1242, innerHeight: 800 };
		const desktopNeedsUpgrade = buildFunction('imageViewerSourceNeedsUpgrade', {
			imageViewerFitSize,
			window: desktopWindow,
			IMAGE_VIEWER_UPGRADE_RATIO: 1.1,
		});
		assert.strictEqual(desktopNeedsUpgrade({ naturalWidth: 368, naturalHeight: 207 }), true);
		assert.strictEqual(desktopNeedsUpgrade({ naturalWidth: 1050, naturalHeight: 590 }), false);
	});

	it('copies the decoded card bitmap into a bounded canvas without another request', () => {
		const calls = [];
		const classes = new Set();
		const imageViewerPreview = {
			width: 0,
			height: 0,
			getContext() {
				return {
					clearRect: (...args) => calls.push(['clearRect', ...args]),
					drawImage: (...args) => calls.push(['drawImage', ...args]),
				};
			},
		};
		const imageViewer = {
			classList: {
				add: (value) => classes.add(value),
				remove: (value) => classes.delete(value),
			},
		};
		const drawImageViewerPreview = buildFunction('drawImageViewerPreview', {
			imageViewer,
			imageViewerPreview,
			imageViewerPreviewNaturalWidth: 0,
			imageViewerPreviewNaturalHeight: 0,
			IMAGE_VIEWER_PREVIEW_MAX_DIMENSION: 4096,
			IMAGE_VIEWER_PREVIEW_MAX_PIXELS: 16 * 1024 * 1024,
			logJsError: assert.fail,
			clearImageViewerPreview: assert.fail,
			updateImageViewerFrameSize: () => {},
		});
		const source = { complete: true, naturalWidth: 8000, naturalHeight: 8000 };

		assert.strictEqual(drawImageViewerPreview(source), true);
		assert.strictEqual(imageViewerPreview.width, 4096);
		assert.strictEqual(imageViewerPreview.height, 4096);
		assert.strictEqual(calls.filter(([name]) => name === 'drawImage').length, 1);
		assert.ok(classes.has('has-preview'));
		assert.ok(!classes.has('image-ready'));
	});

	it('passes the rendered card image into the viewer and skips an immediate reload when adequate', () => {
		assert.match(
			app,
			/openImageViewer\(imgEl\.dataset\.mediaUrl \|\| mediaUrl, w\?\.refresh, \{ sourceImage: imgEl \}\);/
		);
		assert.match(
			app,
			/const sourceImage = options\.sourceImage \|\| findLoadedImageViewerSource\(target\);/
		);
		assert.match(
			app,
			/if \(options\.hasPreview && sourceImage && !imageViewerSourceNeedsUpgrade\(sourceImage\)\) \{\s*bindImageViewerToSource\(sourceImage, generation\);\s*return false;/s
		);
		assert.match(
			app,
			/imageViewerSourceLoadHandler = \(\) => \{[\s\S]*?drawImageViewerPreview\(sourceImage\);[\s\S]*?sourceImage\.addEventListener\('load', imageViewerSourceLoadHandler\);/
		);
	});

	it('keeps the preview visible while an optional larger image loads', () => {
		assert.match(app, /<canvas class="image-viewer-preview" aria-hidden="true"><\/canvas>/);
		assert.match(styles, /\.image-viewer\.loading:not\(\.has-preview\) \.image-viewer-frame \{\s*opacity: 0;\s*\}/s);
		assert.match(styles, /\.image-viewer\.has-preview \.image-viewer-preview \{\s*opacity: 1;\s*\}/s);
		assert.match(styles, /\.image-viewer\.has-preview:not\(\.image-ready\) \.image-viewer-img \{\s*opacity: 0;\s*\}/s);
	});

	it('keeps the preview opaque until the upgraded image has finished fading in', () => {
		assert.match(
			styles,
			/\.image-viewer-preview \{[\s\S]*?visibility: visible;[\s\S]*?visibility 0s linear;[\s\S]*?\}/
		);
		assert.match(
			styles,
			/\.image-viewer\.has-preview\.image-ready \.image-viewer-preview \{\s*opacity: 1;\s*visibility: hidden;\s*transition-delay: 0s, 0s, \.4s;\s*\}/s
		);
	});

	it('resolves proxy-cache settings through stable widget fallback keys', () => {
		assert.match(
			app,
			/function getWidgetProxyCacheConfig\(widget\) \{[\s\S]*?for \(const key of widgetConfigLookupKeys\(widget\)\) \{[\s\S]*?widgetProxyCacheConfigMap\.get\(key\);/
		);
		assert.match(app, /const proxyCacheConfig = isImage \? getWidgetProxyCacheConfig\(w\) : null;/);
		assert.match(app, /const cacheConfig = getWidgetProxyCacheConfig\(widget\);/);
	});
});
