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
		assert.match(server, /if\(!singlePointMode\)\{\s*document\.getElementById\('search-modal'\)\.addEventListener\('keydown'/);
		assert.match(server, /if\(!singlePointMode\)\{\s*var hoverControl=new OpenLayers\.Control\.SelectFeature/);
	});

	it('uses current red marker as zoom-home target and keeps current zoom level', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /document\.getElementById\('zoom-home'\)\.addEventListener\('click',function\(\)\{\s*if\(red\)\{\s*map\.setCenter\(new OpenLayers\.LonLat\(red\[1\],red\[0\]\)\.transform\(wgs84,proj\)\);/);
	});
});
