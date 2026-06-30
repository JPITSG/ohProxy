'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Presence zoom button state', () => {
	it('disables zoom controls at map zoom bounds using shared styling', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /\.map-ctrl-btn:disabled,\.map-ctrl-btn\.is-disabled\{background:rgba\(19,21,54,0\.05\);border-color:rgba\(19,21,54,0\.12\);box-shadow:none;color:rgba\(19,21,54,0\.32\);cursor:default;opacity:\.72\}/);
		assert.match(server, /var zoomInBtn=document\.getElementById\('zoom-in'\);\s*var zoomOutBtn=document\.getElementById\('zoom-out'\);/);
		assert.match(server, /function setMapControlDisabled\(btn,disabled\)\{\s*if\(!btn\)return;\s*btn\.disabled=!!disabled;\s*btn\.classList\.toggle\('is-disabled',!!disabled\);\s*btn\.setAttribute\('aria-disabled',disabled\?'true':'false'\);/);
		assert.match(server, /function getMinZoomLevel\(\)\{\s*if\(typeof map\.getMinZoom==='function'\)\{\s*var minZoom=map\.getMinZoom\(\);\s*if\(typeof minZoom==='number'&&isFinite\(minZoom\)\)return minZoom;\s*\}\s*return 0;\s*\}/);
		assert.match(server, /function syncZoomButtonState\(\)\{\s*var zoom=map\.getZoom\(\);\s*setMapControlDisabled\(zoomOutBtn,zoom<=getMinZoomLevel\(\)\);\s*setMapControlDisabled\(zoomInBtn,zoom>=getMaxZoomLevel\(\)\);/);
		assert.match(server, /map\.events\.register\('zoomend',map,syncZoomButtonState\);/);
		assert.match(server, /map\.events\.register\('updatesize',map,syncZoomButtonState\);/);
		assert.match(server, /zoomInBtn\.addEventListener\('click',function\(\)\{if\(zoomInBtn\.disabled\)return;map\.zoomIn\(\);syncZoomButtonState\(\)\}\);/);
		assert.match(server, /zoomOutBtn\.addEventListener\('click',function\(\)\{if\(zoomOutBtn\.disabled\)return;map\.zoomOut\(\);syncZoomButtonState\(\)\}\);/);
	});
});
