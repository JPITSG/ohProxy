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
	const source = extractFunction(app, name);
	return Function(...names, `return (${source});`)(...values);
}

describe('Hybrid media zoom input handling', () => {
	it('classifies the event source instead of the device touch capability', () => {
		const mediaZoomLastTouchAt = new WeakMap();
		const isFinePointerEvent = buildFunction('isFinePointerEvent', {
			mediaZoomLastTouchAt,
			MEDIA_ZOOM_LEGACY_TOUCH_GUARD_MS: 750,
		});
		const element = {};

		assert.strictEqual(isFinePointerEvent({ pointerType: 'mouse' }, element), true);
		assert.strictEqual(isFinePointerEvent({ pointerType: 'pen' }, element), true);
		assert.strictEqual(isFinePointerEvent({ pointerType: 'touch' }, element), false);
		assert.strictEqual(isFinePointerEvent({ sourceCapabilities: { firesTouchEvents: true } }, element), false);
		assert.strictEqual(isFinePointerEvent({}, element), true);

		mediaZoomLastTouchAt.set(element, Date.now());
		assert.strictEqual(isFinePointerEvent({}, element), false);
		// Explicit pointer metadata remains authoritative on hybrid devices.
		assert.strictEqual(isFinePointerEvent({ pointerType: 'mouse' }, element), true);
	});

	it('installs fine-pointer and pinch video handlers together', () => {
		const start = app.indexOf('function initVideoZoom(videoEl, zoomStage)');
		const end = app.indexOf('// The ring animation is paused', start);
		const body = app.slice(start, end);

		assert.doesNotMatch(body, /isTouchDevice\(\)/);
		assert.match(body, /zoomStage\.addEventListener\('click', \(e\) => \{\s*if \(!isFinePointerEvent\(e, zoomStage\)\) return;/);
		assert.match(body, /zoomStage\.addEventListener\('pointermove', \(e\) => \{\s*if \(!isFinePointerEvent\(e, zoomStage\)\) return;/);
		assert.match(body, /attachPinchZoomHandlers\(zoomStage, \{/);
	});

	it('uses one image zoom state for click, pointer movement, and pinch', () => {
		const start = app.indexOf('function ensureImageViewer()');
		const end = app.indexOf('function openImageViewer(', start);
		const body = app.slice(start, end);

		assert.match(app, /const imageViewerZoomState = createMediaZoomState\(\);/);
		assert.doesNotMatch(app, /imageViewerZoomed|const imgZoomState/);
		assert.doesNotMatch(body, /isTouchDevice\(\)/);
		assert.match(body, /imageViewerImg\.addEventListener\('click', \(e\) => \{\s*if \(state\.isSlim \|\| !isFinePointerEvent\(e, imageViewerImg\)\) return;/);
		assert.match(body, /imageViewerImg\.addEventListener\('pointermove', \(e\) => \{\s*if \(state\.isSlim \|\| !isFinePointerEvent\(e, imageViewerImg\)\) return;/);
		assert.match(body, /attachPinchZoomHandlers\(imageViewerImg, \{[\s\S]*?getState: \(\) => imageViewerZoomState,[\s\S]*?applyZoom: applyImageViewerZoom,[\s\S]*?resetZoom: resetImageViewerZoom/);
	});

	it('fully resets shared numeric zoom state and image presentation state', () => {
		const createMediaZoomState = buildFunction('createMediaZoomState');
		const resetMediaZoomState = buildFunction('resetMediaZoomState');
		const zoomState = createMediaZoomState();
		Object.assign(zoomState, {
			scale: 3,
			translateX: 40,
			translateY: -20,
			pinchStartDist: 90,
			pinchStartScale: 2,
			panStartX: 5,
			panStartY: 6,
			panStartTranslateX: 7,
			panStartTranslateY: 8,
			isPanning: true,
		});
		resetMediaZoomState(zoomState);

		assert.deepStrictEqual(zoomState, createMediaZoomState());
		assert.match(app, /function resetImageViewerZoom\(\) \{\s*resetMediaZoomState\(imageViewerZoomState\);[\s\S]*?classList\.remove\('zoomed'\);[\s\S]*?style\.transform = '';[\s\S]*?style\.transformOrigin = '50% 50%';/);
		assert.match(app, /function openImageViewer\([\s\S]*?resetImageViewerZoom\(\);/);
		assert.match(app, /function closeImageViewer\([\s\S]*?resetImageViewerZoom\(\);/);
	});

	it('keeps the zoomed class presentational instead of owning image scale', () => {
		const start = styles.indexOf('.image-viewer-img.zoomed {');
		assert.ok(start >= 0);
		const rule = styles.slice(start, styles.indexOf('}', start) + 1);
		assert.match(rule, /cursor: zoom-out;/);
		assert.doesNotMatch(rule, /transform:/);
	});
});
