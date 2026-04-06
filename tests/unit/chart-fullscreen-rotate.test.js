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
		assert.match(server, /const backTooltipAttrs = hasPreviousPeriod[\s\S]*data-range-from="\$\{escapeHtml\(safeNavTooltipData\.back\?\.from \|\| ''\)\}" data-range-to="\$\{escapeHtml\(safeNavTooltipData\.back\?\.to \|\| ''\)\}"[\s\S]*' data-tooltip-message="No data available"';/);
		assert.match(server, /id="chartPeriodBack"[\s\S]*\$\{backTooltipAttrs\}[\s\S]*hasPreviousPeriod \? '' : ' aria-disabled="true" data-nav-disabled="true"'/);
		assert.match(server, /id="chartPeriodForward"/);
		assert.match(server, /const forwardTooltipAttrs = safeNavTooltipData\.forward[\s\S]*data-range-from="\$\{escapeHtml\(safeNavTooltipData\.forward\.from\)\}" data-range-to="\$\{escapeHtml\(safeNavTooltipData\.forward\.to\)\}"/);
		assert.match(server, /id="chartPeriodForward"[\s\S]*\$\{forwardTooltipAttrs\}/);
		assert.match(server, /id="chartPeriodLatest"/);
		assert.match(server, /const latestTooltipAttrs = safeNavTooltipData\.latest[\s\S]*data-range-from="\$\{escapeHtml\(safeNavTooltipData\.latest\.from\)\}" data-range-to="\$\{escapeHtml\(safeNavTooltipData\.latest\.to\)\}"/);
		assert.match(server, /id="chartPeriodLatest"[\s\S]*\$\{latestTooltipAttrs\}/);
		assert.match(server, /id="chartPeriodLatest"[\s\S]*M20 22L4 22/);
		assert.match(server, /id="chartPeriodLatest"[\s\S]*stroke-width="1\.2"/);
		assert.match(server, /id="chartNavTooltip"/);
		assert.match(server, /chart-nav-tooltip-line chart-nav-tooltip-line-secondary/);
		assert.match(server, /id="chartRotate"/);
		assert.match(server, /id="chartPeriodBack"[\s\S]*id="chartPeriodForward"[\s\S]*id="chartPeriodLatest"[\s\S]*id="chartRotate"[\s\S]*id="chartFullscreen"/);
	});

	it('wires chart period navigation, custom range tooltips, and parent URL sync', () => {
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
		assert.match(chartJs, /var navTooltip = document\.getElementById\('chartNavTooltip'\);/);
		assert.match(chartJs, /function getNavTooltipData\(btn\) \{/);
		assert.match(chartJs, /var message = btn\.getAttribute\('data-tooltip-message'\) \|\| '';/);
		assert.match(chartJs, /if \(message\) return \{ message: message \};/);
		assert.match(chartJs, /btn\.addEventListener\('mouseenter', function\(e\) \{\s*showNavTooltip\(btn, e\);\s*\}\);/);
		assert.match(chartJs, /btn\.addEventListener\('focus', function\(\) \{\s*showNavTooltip\(btn\);\s*\}\);/);
		assert.match(chartJs, /bindNavTooltip\(forwardBtn\);/);
		assert.match(chartJs, /if \(isNavButtonDisabled\(backBtn\)\) \{\s*e\.preventDefault\(\);\s*return;\s*\}/);
		assert.match(chartJs, /function hideNavTooltip\(\) \{\s*if \(!navTooltip\) return;\s*navTooltip\.classList\.remove\('visible'\);\s*\}/);
		assert.match(chartJs, /window\.addEventListener\('resize', hideNavTooltip\);/);
		assert.match(chartJs, /function navigateChartOffset\(nextOffset\) \{/);
		assert.match(chartJs, /forwardBtn\.addEventListener\('click', function\(\) \{\s*hideNavTooltip\(\);\s*navigateChartPeriod\(-1\);\s*\}\);/);
		assert.match(chartJs, /latestBtn\.addEventListener\('click', function\(\) \{\s*hideNavTooltip\(\);\s*navigateChartOffset\(0\);\s*\}\);/);
		assert.match(chartCss, /\.chart-nav-btn::after \{/);
		assert.match(chartCss, /\.chart-nav-tooltip \{/);
		assert.match(chartCss, /\.chart-nav-tooltip\.chart-nav-tooltip-single \.chart-nav-tooltip-arrow,/);
		assert.match(chartCss, /\.chart-nav-tooltip-line \{\s*font-size: \.7rem;\s*font-weight: 500;/);
		assert.match(chartCss, /\.chart-nav-tooltip-arrow \{/);
		assert.match(chartCss, /\.chart-fs-btn\[aria-disabled="true"\] \{/);
		assert.match(chartCss, /width: 16px;/);
		assert.match(chartCss, /height: 16px;/);
		assert.match(chartCss, /#chartPeriodLatest svg \{/);
		assert.match(chartCss, /#chartPeriodLatest svg \{\s*width: 15px;/);
		assert.match(chartCss, /#chartPeriodLatest svg \{[\s\S]*height: 15px;/);
		assert.match(chartCss, /-webkit-mask-image: url\("data:image\/svg\+xml,%3Csvg xmlns='http:\/\/www\.w3\.org\/2000\/svg' viewBox='0 0 24 24'%3E%3Cpath d='M7\.41 8\.59 12 13\.17l4\.59-4\.58L18 10l-6 6-6-6z'\/%3E%3C\/svg%3E"\);/);
		assert.match(chartCss, /\.chart-nav-prev::after \{\s*transform: rotate\(90deg\);/);
		assert.match(chartCss, /\.chart-nav-next::after \{\s*transform: rotate\(270deg\);/);
	});

	it('checks previous-period availability during chart generation and invalidates old chart html cache entries', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /function chartHasPreviousPeriodData\(item, periodWindow, service = '', forceAsItem = false, preloadedItemDefinition = null, periodOffset = 0\) \{/);
		assert.match(server, /function buildChartNavigationTooltipData\(periodWindow, periodOffset = 0\) \{/);
		assert.match(server, /from: formatChartPeriodTooltipTimestamp\(start\),/);
		assert.match(server, /to: formatChartPeriodTooltipTimestamp\(end\),/);
		assert.match(server, /forward: normalizedOffset > 0 \? formatRange\(Math\.max\(0, normalizedOffset - 1\)\) : null,/);
		assert.match(server, /const nextOffset = normalizeChartPeriodOffsetValue\(periodOffset\) \+ 1;/);
		assert.match(server, /return Array\.isArray\(previousSeriesList\) && previousSeriesList\.length > 0;/);
		assert.match(server, /const hasPreviousPeriod = await chartHasPreviousPeriodData\(item, window, service, forceAsItem, preloadedItemDefinition, normalizedOffset\);/);
		assert.match(server, /const hasPreviousPeriod = await chartHasPreviousPeriodData\(item, periodWindow, service, forceAsItem, null, periodOffset\);/);
		assert.match(server, /const navTooltipData = buildChartNavigationTooltipData\(window, normalizedOffset\);/);
		assert.match(server, /const rendered = renderChartFromSeries\(rawSeriesList, period, mode, title, legend, yAxisDecimalPattern, periodWindow, interpolation, dataHash, unitSymbol, periodOffset, hasPreviousPeriod\);/);
		assert.match(server, /\|prevnav:v2\|/);
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
