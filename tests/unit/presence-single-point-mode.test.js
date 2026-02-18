'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Presence Single-Point Mode', () => {
	it('validates lat/lon query pair and range', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const rawLat = req\.query\?\.lat;/);
		assert.match(server, /const rawLon = req\.query\?\.lon;/);
		assert.match(server, /if \(hasLat !== hasLon\) \{\s*return sendStyledError\(res, req, 400, 'Both lat and lon are required'\);/);
		assert.match(server, /return sendStyledError\(res, req, 400, 'Invalid lat\/lon'\);/);
	});

	it('allows single-point mode without trackgps while keeping history mode gated', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /if \(!singlePointMode && !user\.trackgps\) \{\s*return sendStyledError\(res, req, 403\);/);
	});

	it('builds a single red marker with no tooltip content in single-point mode', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /if \(singlePointMode\) \{\s*const lat = Math\.round\(singlePointLat \* 10000000\) \/ 10000000;\s*const lon = Math\.round\(singlePointLon \* 10000000\) \/ 10000000;\s*markers\.push\(\[lat, lon, 'red', ''\]\);/);
	});

	it('conditionally removes search and context UI in single-point mode', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /\$\{singlePointMode \? '' : `<div id="red-tooltip" class="tooltip"><\/div>/);
		assert.match(server, /\$\{singlePointMode \? '' : `<div id="search-modal">/);
		assert.match(server, /if\(!singlePointMode\)\{\s*var presenceRoot=document\.getElementById\('presence-root'\);\s*var searchModal=document\.getElementById\('search-modal'\);/);
		assert.match(server, /searchModal\.addEventListener\('keydown'/);
		assert.match(server, /if\(!singlePointMode\)\{\s*var hoverControl=new OpenLayers\.Control\.SelectFeature/);
	});

	it('uses current red marker as zoom-home target and keeps current zoom level', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /document\.getElementById\('zoom-home'\)\.addEventListener\('click',function\(\)\{\s*if\(red\)\{\s*map\.setCenter\(new OpenLayers\.LonLat\(red\[1\],red\[0\]\)\.transform\(wgs84,proj\)\);/);
	});

	it('adds fullscreen touch rotate control that resets on fullscreen exit', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /<div id="presence-root">/);
		assert.match(server, /#presence-root\.presence-rotated\{top:50%;left:50%;width:100vh;height:100vw;transform:translate\(-50%,-50%\) rotate\(90deg\)\}/);
		assert.match(server, /#map-rotate\{display:none\}/);
		assert.match(server, /<button class="map-ctrl-btn" id="map-rotate" type="button">/);
		assert.match(server, /var rotateBtn=document\.getElementById\('map-rotate'\);/);
		assert.match(server, /rotateBtn\.style\.display=\(isTouchDevice&&fsActive\)\?'flex':'none';/);
		assert.match(server, /rotateBtn\.addEventListener\('click',function\(\)\{\s*if\(!isTouchDevice\|\|!fsActive\)return;\s*isRotated=!isRotated;\s*applyRotation\(\);/);
		assert.match(server, /function isRotatedTouchPanMode\(\)\{\s*return isTouchDevice&&presenceFullscreenActive&&presenceRotated;\s*\}/);
		assert.match(server, /map\.pan\(-dy,dx,\{animate:false\}\);/);
		assert.match(server, /presenceFullscreenActive=fsActive;/);
		assert.match(server, /if\(!fsActive\)\{\s*isRotated=false;\s*applyRotation\(\);\s*\}/);
	});

	it('shows search modal in constrained fullscreen only when measured layout fit allows', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /@media\(max-width:767px\)\{#search-modal\{display:none!important\}\}/);
		assert.match(server, /@media\(max-width:767px\)\{#presence-root\.presence-fs-search-visible #search-modal\{display:block!important\}\}/);
		assert.match(server, /@media\(pointer:coarse\)\{#presence-root\.presence-fs-search-visible #map-controls\{background:rgb\(245,246,250\);border:1px solid rgba\(150,150,150,0\.3\);box-shadow:/);
		assert.match(server, /function computeSearchModalFullscreenFit\(\)\{/);
		assert.match(server, /var clearOfControls=\s*controlsRect\.right\+searchVisibilityGap<=modalRect\.left\|\|\s*modalRect\.right\+searchVisibilityGap<=controlsRect\.left\|\|\s*controlsRect\.bottom\+searchVisibilityGap<=modalRect\.top\|\|\s*modalRect\.bottom\+searchVisibilityGap<=controlsRect\.top;/);
		assert.match(server, /var shouldShow=presenceFullscreenActive&&isSpaceConstrainedViewport\(\)&&computeSearchModalFullscreenFit\(\);/);
		assert.match(server, /updateFullscreenSearchVisibility=queueSearchModalFullscreenVisibilityUpdate;/);
		assert.match(server, /window\.addEventListener\('resize',queueSearchModalFullscreenVisibilityUpdate\);/);
		assert.match(server, /window\.addEventListener\('orientationchange',queueSearchModalFullscreenVisibilityUpdate\);/);
		assert.match(server, /function handleDateInputViewportResize\(\)\{/);
		assert.match(server, /if\(keyboardWasOpen&&currentHeight>=viewportHeightBaseline-keyboardCloseThreshold\)\{\s*active\.blur\(\);/);
		assert.match(server, /if\(window\.visualViewport\)window\.visualViewport\.addEventListener\('resize',handleDateInputViewportResize\);/);
		assert.match(server, /function blurSearchDateInputsFromMapTouch\(\)\{/);
		assert.match(server, /document\.addEventListener\('click',closeMonthMenu\);/);
		assert.match(server, /closeMonthMenu\(\);/);
		assert.match(server, /mapEl\.addEventListener\('touchstart',blurSearchDateInputsFromMapTouch,\{passive:true,capture:true\}\);/);
	});

	it('gates presence hover glow styles to hover-capable pointers', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /@media\(hover:hover\)\{\.map-ctrl-btn:hover\{/);
		assert.match(server, /@media\(hover:hover\)\{\.search-controls button:hover,\.search-controls input:hover\{/);
		assert.match(server, /@media\(pointer:coarse\)\{\.map-ctrl-btn:hover\{background:rgba\(19,21,54,0\.12\);border-color:rgba\(19,21,54,0\.2\);box-shadow:none\}\}/);
		assert.match(server, /@media\(pointer:coarse\)\{\.search-controls button:hover\{background:rgba\(19,21,54,0\.08\);border-color:rgba\(19,21,54,0\.2\);box-shadow:none\}\}/);
		assert.match(server, /@media\(pointer:coarse\)\{\.search-controls input:hover\{background:rgba\(255,255,255,0\.7\);border-color:rgba\(19,21,54,0\.2\);box-shadow:inset 0 1px 3px rgba\(0,0,0,0\.08\)\}\}/);
	});
});
