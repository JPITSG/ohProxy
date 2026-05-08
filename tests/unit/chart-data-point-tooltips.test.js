'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CHART_JS_FILE = path.join(PROJECT_ROOT, 'public', 'chart.js');

describe('Chart Data Point Tooltips', () => {
	it('binds every rendered marker to tooltip data through a shared helper', () => {
		const chartJs = fs.readFileSync(CHART_JS_FILE, 'utf8');

		assert.match(chartJs, /appendDataPointCircle\(group, pt, delay, extraClass\) \{[\s\S]*?circle\.dataset\.idx = this\.circleData\.length;[\s\S]*?this\.circleData\.push\(pt\);[\s\S]*?group\.appendChild\(circle\);/);
		assert.match(chartJs, /this\.appendDataPointCircle\(pointsGroup, \{ x: gd\.x, y: interpY, value: interpValue, t: interpTime \}, gd\.delay \+ 's', 'data-point-interval'\);/);
		assert.match(chartJs, /this\.appendDataPointCircle\(pointsGroup, entry\.point, delays\[idx\], entry\.cls\);/);
	});

	it('keeps min and max markers above interval markers for hover hit-testing', () => {
		const chartJs = fs.readFileSync(CHART_JS_FILE, 'utf8');
		const intervalIdx = chartJs.indexOf('// Add interpolated points at grid lines');
		const extremaIdx = chartJs.indexOf('// Add min/max points last so extreme markers remain the top hover target.');

		assert.ok(intervalIdx > 0, 'interpolated marker block is missing');
		assert.ok(extremaIdx > intervalIdx, 'min/max markers should be appended after interval markers');
	});

	it('uses bubbling SVG pointer events and exact marker data on desktop hover', () => {
		const chartJs = fs.readFileSync(CHART_JS_FILE, 'utf8');

		assert.match(chartJs, /pointsGroup\.addEventListener\('mouseover', e => \{[\s\S]*?var point = this\.getPointForEventTarget\(e\.target\);[\s\S]*?if \(point\) this\.showTooltip\(e, point\);[\s\S]*?\}\);/);
		assert.match(chartJs, /pointsGroup\.addEventListener\('mousemove', e => \{[\s\S]*?var point = this\.getPointForEventTarget\(e\.target\);[\s\S]*?if \(point\) this\.showTooltip\(e, point\);[\s\S]*?\}\);/);
		assert.match(chartJs, /var hoveredPoint = this\.getPointForEventTarget\(e\.target\);[\s\S]*?if \(hoveredPoint\) \{[\s\S]*?this\.showTooltip\(e, hoveredPoint\);[\s\S]*?return;[\s\S]*?\}/);
		assert.doesNotMatch(chartJs, /pointsGroup\.addEventListener\('mouseenter'/);
	});

	it('prevents temporary line-hover circles from intercepting marker hover events', () => {
		const chartJs = fs.readFileSync(CHART_JS_FILE, 'utf8');

		assert.match(chartJs, /circle\.style\.pointerEvents = 'none';/);
		assert.match(chartJs, /getDataPointElement\(target\) \{[\s\S]*?classList\.contains\('data-point'\)[\s\S]*?dataset\.idx !== undefined[\s\S]*?return el;[\s\S]*?\}/);
	});
});
