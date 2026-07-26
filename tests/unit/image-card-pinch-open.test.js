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

describe('two-finger image-card viewer handoff', () => {
	it('preserves the pinch geometry and scale from the card gesture', () => {
		const mediaTouchPairGeometry = buildFunction('mediaTouchPairGeometry');
		const mediaPinchScale = buildFunction('mediaPinchScale');
		const geometry = mediaTouchPairGeometry([
			{ clientX: 20, clientY: 30 },
			{ clientX: 80, clientY: 110 },
		]);

		assert.deepStrictEqual(geometry, {
			distance: 100,
			centerX: 50,
			centerY: 70,
		});
		assert.strictEqual(mediaPinchScale(1, 100, 150, 4), 1.5);
		assert.strictEqual(mediaPinchScale(2, 100, 250, 4), 4);
		assert.strictEqual(mediaPinchScale(1, 100, 50, 4), 1);
	});

	it('maps the touched point on the card to the same point in the viewer', () => {
		const imageViewerSourcePointPercent = buildFunction('imageViewerSourcePointPercent');
		const source = {
			getBoundingClientRect: () => ({
				left: 100,
				top: 200,
				width: 400,
				height: 200,
			}),
		};

		assert.deepStrictEqual(imageViewerSourcePointPercent(source, 200, 250), {
			x: 25,
			y: 25,
		});
		assert.deepStrictEqual(imageViewerSourcePointPercent(source, 50, 500), {
			x: 0,
			y: 100,
		});
	});

	it('opens on the first intentional pinch movement without discarding that movement', () => {
		const transfer = {
			opened: false,
			startGeometry: { distance: 100 },
			sourceImage: {},
		};
		const activations = [];
		const mediaTouchPairGeometry = buildFunction('mediaTouchPairGeometry');
		const moveImageViewerCardPinchTransfer = buildFunction(
			'moveImageViewerCardPinchTransfer',
			{
				imageViewerCardPinchTransfer: transfer,
				imageViewerTrackedCardPinchTouches: (_transfer, touches) => touches,
				mediaTouchPairGeometry,
				IMAGE_VIEWER_CARD_PINCH_OPEN_THRESHOLD_PX: 4,
				noteMediaZoomTouch: () => {},
				activateImageViewerCardPinchTransfer: (_transfer, geometry) => activations.push(geometry.distance),
			}
		);
		const eventAtDistance = (distance) => ({
			touches: [
				{ clientX: 0, clientY: 0 },
				{ clientX: distance, clientY: 0 },
			],
			cancelable: true,
			preventDefault() {},
		});

		moveImageViewerCardPinchTransfer(transfer, eventAtDistance(103));
		assert.deepStrictEqual(activations, []);
		moveImageViewerCardPinchTransfer(transfer, eventAtDistance(106));
		assert.deepStrictEqual(activations, [106]);
	});

	it('wires a non-passive gesture bridge while retaining one-finger page scrolling', () => {
		assert.match(
			app,
			/document\.addEventListener\('touchstart', handleImageViewerCardPinchTouchStart, \{ passive: false, capture: true \}\);/
		);
		assert.match(
			app,
			/openImageViewer\(\s*transfer\.sourceImage\.dataset\.mediaUrl,\s*transfer\.sourceImage\.dataset\.refreshMs,\s*\{ sourceImage: transfer\.sourceImage \}\s*\);/s
		);
		assert.match(
			app,
			/document\.addEventListener\(\s*'touchmove',[\s\S]*?\{ passive: false, capture: true, signal: controller\.signal \}/
		);
		assert.match(app, /transfer\.opened = true;\s*imageViewer\.classList\.add\('pinching'\);/);
		assert.match(
			app,
			/onGestureStart: \(\) => imageViewer\?\.classList\.add\('pinching'\),\s*onGestureEnd: \(\) => imageViewer\?\.classList\.remove\('pinching'\)/
		);
		assert.match(app, /Date\.now\(\) < Number\(imgEl\._ohPinchOpenSuppressClickUntil \|\| 0\)/);
		assert.match(app, /if \(isImageViewerCardPinchTransferOpen\(\)\) \{\s*clearTwoFingerHold\(\);/s);
		assert.match(styles, /\.image-viewer-trigger \{\s*cursor: zoom-in;\s*touch-action: pan-y;\s*\}/s);
		assert.match(styles, /\.image-viewer\.pinching \.image-viewer-img \{\s*transition-duration: 0s, \.4s;\s*\}/s);
		assert.match(styles, /\.image-viewer\.pinching \.image-viewer-preview \{\s*transition-duration: 0s, \.4s, 0s;\s*\}/s);
	});
});
