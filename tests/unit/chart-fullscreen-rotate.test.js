'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');
const CHART_JS_FILE = path.join(PROJECT_ROOT, 'public', 'chart.js');
const CHART_CSS_FILE = path.join(PROJECT_ROOT, 'public', 'chart.css');

describe('Chart Fullscreen Rotate', () => {
	it('adds a rotate button before the fullscreen button in chart header controls', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /id="chartRotate"/);
		assert.match(server, /id="chartRotate"[\s\S]*id="chartFullscreen"/);
	});

	it('gates rotate visibility to touch fullscreen and resets rotation when fullscreen exits', () => {
		const chartJs = fs.readFileSync(CHART_JS_FILE, 'utf8');
		assert.match(chartJs, /var rotateBtn = document\.getElementById\('chartRotate'\);/);
		assert.match(chartJs, /var w = this\.container\.clientWidth \|\| rect\.width;/);
		assert.match(chartJs, /var h = this\.container\.clientHeight \|\| rect\.height;/);
		assert.match(chartJs, /rotateBtn\.style\.display = \(isTouchDevice && fsActive\) \? 'flex' : 'none';/);
		assert.match(chartJs, /if \(!isTouchDevice \|\| !fsActive\) return;\s*isRotated = !isRotated;\s*applyRotation\(\);/);
		assert.match(chartJs, /if \(!fsActive\) \{\s*isRotated = false;\s*applyRotation\(\);\s*\}/);
		assert.match(chartJs, /document\.body\.classList\.add\('chart-fs-rotated'\);/);
		assert.match(chartJs, /document\.body\.classList\.remove\('chart-fs-rotated'\);/);
		assert.match(chartJs, /var reflowDelays = \[0, 60, 180, 320\];/);
		assert.match(chartJs, /window\.addEventListener\('orientationchange', scheduleChartReflow\);/);
		assert.match(chartJs, /window\.addEventListener\('resize', scheduleChartReflow\);/);
	});

	it('uses a 90 degree fullscreen rotated chart-card layout', () => {
		const chartCss = fs.readFileSync(CHART_CSS_FILE, 'utf8');
		assert.match(chartCss, /body\.chart-fs-rotated \.chart-card \{/);
		assert.match(chartCss, /width:\s*100vh;/);
		assert.match(chartCss, /height:\s*100vw;/);
		assert.match(chartCss, /transform:\s*translate\(-50%, -50%\) rotate\(90deg\);/);
	});
});
