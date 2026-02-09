'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Mirrors the grid-line interpolation logic in public/chart.js.
function interpolateGridPoint(prev, curr, gridX, interpolation) {
	const segXSpan = curr.x - prev.x;
	let t = Math.abs(segXSpan) > 1e-9 ? (gridX - prev.x) / segXSpan : 1;
	if (!Number.isFinite(t)) t = 1;
	if (t < 0) t = 0;
	if (t > 1) t = 1;

	let y;
	let value;
	if (interpolation === 'step') {
		const atBoundary = Math.abs(gridX - curr.x) < 1e-4;
		y = atBoundary ? curr.y : prev.y;
		value = atBoundary ? curr.value : prev.value;
	} else {
		y = prev.y + t * (curr.y - prev.y);
		value = prev.value + t * (curr.value - prev.value);
	}
	const time = prev.t + t * (curr.t - prev.t);
	return { x: gridX, y, value, t: time };
}

function lineYAtX(points, plotX, cursorY, interpolation) {
	if (!points || points.length === 0) return null;
	if (points.length === 1) return points[0].y;
	if (plotX <= points[0].x) return points[0].y;

	for (let i = 1; i < points.length; i++) {
		const prev = points[i - 1];
		const curr = points[i];
		if (plotX > curr.x && i < points.length - 1) continue;
		const span = curr.x - prev.x;
		if (interpolation === 'step') {
			if (Math.abs(span) <= 1e-9 || Math.abs(plotX - curr.x) < 1e-4) {
				const lo = Math.min(prev.y, curr.y);
				const hi = Math.max(prev.y, curr.y);
				return Math.max(lo, Math.min(hi, cursorY));
			}
			return prev.y;
		}
		let t = Math.abs(span) > 1e-9 ? (plotX - prev.x) / span : 1;
		if (!Number.isFinite(t)) t = 1;
		if (t < 0) t = 0;
		if (t > 1) t = 1;
		return prev.y + t * (curr.y - prev.y);
	}
	return points[points.length - 1].y;
}

describe('Chart Step Interpolation', () => {
	it('uses linear interpolation in linear mode', () => {
		const prev = { x: 0, y: 100, value: 10, t: 0 };
		const curr = { x: 100, y: 0, value: 0, t: 1000 };
		const point = interpolateGridPoint(prev, curr, 50, 'linear');
		assert.strictEqual(point.value, 5);
		assert.strictEqual(point.y, 50);
		assert.strictEqual(point.t, 500);
	});

	it('holds previous value between samples in step mode', () => {
		const prev = { x: 0, y: 100, value: 10, t: 0 };
		const curr = { x: 100, y: 0, value: 0, t: 1000 };
		const point = interpolateGridPoint(prev, curr, 50, 'step');
		assert.strictEqual(point.value, 10);
		assert.strictEqual(point.y, 100);
		assert.strictEqual(point.t, 500);
	});

	it('switches to current value at segment boundary in step mode', () => {
		const prev = { x: 0, y: 100, value: 10, t: 0 };
		const curr = { x: 100, y: 0, value: 0, t: 1000 };
		const point = interpolateGridPoint(prev, curr, 100, 'step');
		assert.strictEqual(point.value, 0);
		assert.strictEqual(point.y, 0);
		assert.strictEqual(point.t, 1000);
	});

	it('does not produce NaN when consecutive points share x', () => {
		const prev = { x: 42, y: 10, value: 10, t: 1000 };
		const curr = { x: 42, y: 20, value: 20, t: 2000 };
		const point = interpolateGridPoint(prev, curr, 42, 'step');
		assert.ok(Number.isFinite(point.y));
		assert.ok(Number.isFinite(point.value));
		assert.ok(Number.isFinite(point.t));
	});

	it('uses horizontal step-line Y for hover proximity between samples', () => {
		const points = [{ x: 100, y: 200 }, { x: 300, y: 50 }];
		assert.strictEqual(lineYAtX(points, 250, 200, 'step'), 200);
	});

	it('treats step boundary as vertical segment for hover proximity', () => {
		const points = [{ x: 100, y: 200 }, { x: 300, y: 50 }];
		assert.strictEqual(lineYAtX(points, 300, 120, 'step'), 120);
	});
});
