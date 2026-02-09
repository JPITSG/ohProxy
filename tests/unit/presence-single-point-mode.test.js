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
		assert.match(server, /if \(hasLat !== hasLon\) \{\s*return res\.status\(400\)\.type\('text\/plain'\)\.send\('Both lat and lon are required'\);/);
		assert.match(server, /return res\.status\(400\)\.type\('text\/plain'\)\.send\('Invalid lat\/lon'\);/);
	});

	it('allows single-point mode without trackgps while keeping history mode gated', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /if \(!singlePointMode && !user\.trackgps\) \{\s*return res\.status\(403\)\.type\('text\/html'\)\.send\('<!DOCTYPE html><html><head><\/head><body><\/body><\/html>'\);/);
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

	it('uses passed lat/lon as zoom-home target in single-point mode', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const homeLatValue = singlePointMode \? singlePointLat : hLat;/);
		assert.match(server, /const homeLonValue = singlePointMode \? singlePointLon : hLon;/);
	});
});
