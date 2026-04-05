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
	it('adds period navigation buttons before rotate/fullscreen in chart header controls', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /id="chartPeriodBack"/);
		assert.match(server, /id="chartPeriodForward"/);
		assert.match(server, /id="chartPeriodLatest"/);
		assert.match(server, /id="chartPeriodLatest"[\s\S]*M20 22L4 22/);
		assert.match(server, /id="chartPeriodLatest"[\s\S]*stroke-width="1\.2"/);
		assert.match(server, /id="chartRotate"/);
		assert.match(server, /id="chartPeriodBack"[\s\S]*id="chartPeriodForward"[\s\S]*id="chartPeriodLatest"[\s\S]*id="chartRotate"[\s\S]*id="chartFullscreen"/);
	});

	it('wires chart period navigation and parent URL sync', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		const chartJs = fs.readFileSync(CHART_JS_FILE, 'utf8');
		const chartCss = fs.readFileSync(CHART_CSS_FILE, 'utf8');
		assert.match(server, /window\._chartPeriodOffset=\$\{inlineJson\(normalizeChartPeriodOffsetValue\(periodOffset\)\)\};/);
		assert.match(chartJs, /var CHART_PERIOD_OFFSET = normalizeChartPeriodOffset\(window\._chartPeriodOffset\);/);
		assert.match(chartJs, /function buildChartUrlForOffset\(nextOffset\) \{/);
		assert.match(chartJs, /url\.searchParams\.delete\('_t'\);/);
		assert.match(chartJs, /if \(normalizedOffset > 0\) \{\s*url\.searchParams\.set\('offset', String\(normalizedOffset\)\);\s*\} else \{\s*url\.searchParams\.delete\('offset'\);\s*\}/);
		assert.match(chartJs, /window\.parent\.postMessage\(\{\s*type: 'ohproxy-chart-url-state',/);
		assert.match(chartJs, /forwardBtn\.style\.display = CHART_PERIOD_OFFSET > 0 \? 'flex' : 'none';/);
		assert.match(chartJs, /latestBtn\.style\.display = CHART_PERIOD_OFFSET > 0 \? 'flex' : 'none';/);
		assert.match(chartJs, /function navigateChartOffset\(nextOffset\) \{/);
		assert.match(chartJs, /latestBtn\.addEventListener\('click', function\(\) \{\s*navigateChartOffset\(0\);\s*\}\);/);
		assert.match(chartCss, /\.chart-nav-btn::after \{/);
		assert.match(chartCss, /width: 15\.5px;/);
		assert.match(chartCss, /height: 15\.5px;/);
		assert.match(chartCss, /-webkit-mask-image: url\("data:image\/svg\+xml,%3Csvg xmlns='http:\/\/www\.w3\.org\/2000\/svg' viewBox='0 0 24 24'%3E%3Cpath d='M7\.41 8\.59 12 13\.17l4\.59-4\.58L18 10l-6 6-6-6z'\/%3E%3C\/svg%3E"\);/);
		assert.match(chartCss, /\.chart-nav-prev::after \{\s*transform: rotate\(90deg\);/);
		assert.match(chartCss, /\.chart-nav-next::after \{\s*transform: rotate\(270deg\);/);
	});

	it('gates rotate visibility to touch fullscreen and resets rotation when fullscreen exits', () => {
		const chartJs = fs.readFileSync(CHART_JS_FILE, 'utf8');
		assert.match(chartJs, /var rotateBtn = document\.getElementById\('chartRotate'\);/);
		assert.match(chartJs, /var w = this\.container\.clientWidth \|\| rect\.width;/);
		assert.match(chartJs, /var h = this\.container\.clientHeight \|\| rect\.height;/);
		assert.match(chartJs, /this\.isFullscreenActive = false;/);
		assert.match(chartJs, /this\.isFullscreenRotated = false;/);
		assert.match(chartJs, /isRotatedViewportMode\(\) \{\s*return this\.isFullscreenActive && this\.isFullscreenRotated;\s*\}/);
		assert.match(chartJs, /clientToContainerPoint\(clientX, clientY\) \{/);
		assert.match(chartJs, /if \(this\.isRotatedViewportMode\(\)\) \{\s*\/\/ Inverse of CSS rotate\(90deg\): screen x follows local y, screen y follows inverted local x\.\s*x = \(relY \/ rectH\) \* localW;\s*y = \(\(rectW - relX\) \/ rectW\) \* localH;\s*\}/);
		assert.match(chartJs, /clientToPlotPoint\(clientX, clientY\) \{/);
		assert.match(chartJs, /var plotPoint = this\.clientToPlotPoint\(touch\.clientX, touch\.clientY\);/);
		assert.match(chartJs, /var closest = plotPoint \? this\.findClosestPoint\(plotPoint\.x\) : null;/);
		assert.match(chartJs, /onTouchStart\(e\) \{\s*if \(this\.seriesSets\.length === 0\) return;/);
		assert.doesNotMatch(chartJs, /onTouchStart\(e\) \{\s*if \(!this\.layout\.sm \|\| this\.seriesSets\.length === 0\) return;/);
		assert.match(chartJs, /var plotPoint = this\.clientToPlotPoint\(e\.clientX, e\.clientY\);/);
		assert.match(chartJs, /var closest = this\.findClosestPoint\(cursorX\);/);
		assert.match(chartJs, /rotateBtn\.style\.display = \(isTouchDevice && fsActive\) \? 'flex' : 'none';/);
		assert.match(chartJs, /if \(!isTouchDevice \|\| !fsActive\) return;\s*isRotated = !isRotated;\s*applyRotation\(\);/);
		assert.match(chartJs, /if \(!fsActive\) \{\s*isRotated = false;\s*applyRotation\(\);\s*\}/);
		assert.match(chartJs, /document\.body\.classList\.add\('chart-fs-rotated'\);/);
		assert.match(chartJs, /document\.body\.classList\.remove\('chart-fs-rotated'\);/);
		assert.match(chartJs, /function syncRendererFullscreenState\(\) \{\s*if \(!chartRenderer\) return;\s*chartRenderer\.isFullscreenActive = !!fsActive;\s*chartRenderer\.isFullscreenRotated = !!\(fsActive && isRotated\);\s*\}/);
		assert.match(chartJs, /syncRendererFullscreenState\(\);/);
		assert.match(chartJs, /var CHART_REFLOW_DEBOUNCE_MS = 64;/);
		assert.match(chartJs, /if \(chartReflowDebounceTimer\) \{\s*clearTimeout\(chartReflowDebounceTimer\);\s*\}/);
		assert.match(chartJs, /chartReflowDebounceTimer = window\.setTimeout\(function\(\) \{/);
		assert.match(chartJs, /chartReflowRafId = window\.requestAnimationFrame\(function\(\) \{\s*chartReflowRafId = 0;\s*reflowChartLayout\(\);/);
		assert.doesNotMatch(chartJs, /var reflowDelays = \[0, 60, 180, 320\];/);
		assert.match(chartJs, /window\.addEventListener\('orientationchange', scheduleChartReflow\);/);
		assert.match(chartJs, /window\.addEventListener\('resize', scheduleChartReflow\);/);
		assert.match(chartJs, /if \(window\.visualViewport\) \{\s*window\.visualViewport\.addEventListener\('resize', scheduleChartReflow\);\s*\}/);
	});

	it('limits chart animation classes to initial paint only', () => {
		const chartJs = fs.readFileSync(CHART_JS_FILE, 'utf8');
		const chartCss = fs.readFileSync(CHART_CSS_FILE, 'utf8');
		assert.match(chartJs, /this\.hasRenderedOnce = false;/);
		assert.match(chartJs, /var animated = document\.documentElement\.classList\.contains\('chart-animated'\) && !this\.hasRenderedOnce;/);
		assert.match(chartJs, /this\.svg\.classList\.toggle\('chart-animated-once', animated\);/);
		assert.match(chartJs, /if \(w > 0 && h > 0\) \{\s*this\.hasRenderedOnce = true;\s*\}/);
		assert.match(chartCss, /\.chart-svg\.chart-animated-once \.chart-line \{/);
		assert.match(chartCss, /\.chart-svg\.chart-animated-once \.chart-area \{/);
		assert.match(chartCss, /\.chart-svg\.chart-animated-once \.data-point \{/);
	});

	it('uses a 90 degree fullscreen rotated chart-card layout', () => {
		const chartCss = fs.readFileSync(CHART_CSS_FILE, 'utf8');
		assert.match(chartCss, /body\.chart-fs-rotated \.chart-card \{/);
		assert.match(chartCss, /width:\s*100vh;/);
		assert.match(chartCss, /height:\s*100vw;/);
		assert.match(chartCss, /transform:\s*translate\(-50%, -50%\) rotate\(90deg\);/);
	});
});
