'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

const server = fs.readFileSync(SERVER_FILE, 'utf8');

// Extract the client-side sequence logic and run it for real against synthetic marker arrays.
function extractPlaybackSequenceRunner() {
	const hav = server.match(/function haversineMeters\(lat1,lon1,lat2,lon2\)\{[\s\S]*?return R\*2\*Math\.atan2\(Math\.sqrt\(a\),Math\.sqrt\(1-a\)\);\s*\}/);
	const build = server.match(/function buildPlaybackSequence\(\)\{[\s\S]*?return seq;\s*\}/);
	assert.ok(hav, 'haversineMeters found in presence script');
	assert.ok(build, 'buildPlaybackSequence found in presence script');
	return (markers) => new Function('markers', `var PLAYBACK_MIN_DIST_M=50;\n${hav[0]}\n${build[0]}\nreturn buildPlaybackSequence();`)(markers);
}

describe('Presence playback (VCR) controls', () => {
	it('renders the five playback buttons in order inside the search modal', () => {
		assert.match(server, /<div id="search-modal">[\s\S]*?<div class="playback-controls">/);
		assert.match(server, /<div class="playback-controls">\s*<button class="map-ctrl-btn" id="pb-back" type="button"[\s\S]*?id="pb-play"[\s\S]*?id="pb-pause"[\s\S]*?id="pb-stop"[\s\S]*?id="pb-forward"/);
		assert.match(server, /\.playback-controls\{display:flex;justify-content:space-between;gap:6px;margin-top:8px\}/);
	});

	it('hardcodes the 1s step interval and 50m skip threshold', () => {
		assert.match(server, /var PLAYBACK_STEP_MS=1000;/);
		assert.match(server, /var PLAYBACK_MIN_DIST_M=50;/);
		assert.match(server, /playbackTimer=setTimeout\(playbackTick,PLAYBACK_STEP_MS\);/);
	});

	it('skips pins within 50m of the last displayed pin', () => {
		const buildSeq = extractPlaybackSequenceRunner();
		// ~0.00018 deg lat = ~20m jitter around the first pin, then a far pin
		const jitter = [
			[0, 0, 'blue', 't0'],
			[0.00018, 0, 'blue', 't1'],
			[0.00009, 0, 'blue', 't2'],
			[0.00015, 0, 'blue', 't3'],
			[0.02, 0, 'red', 't4'],
		];
		assert.deepStrictEqual(buildSeq(jitter), [0, 4]);
	});

	it('shows slow drift once it accumulates past 50m of the last displayed pin', () => {
		const buildSeq = extractPlaybackSequenceRunner();
		// steps of ~33m: each is within 50m of the previous raw pin, but the
		// second accumulates to ~67m from the last DISPLAYED pin
		const drift = [
			[0, 0, 'blue', 't0'],
			[0.0003, 0, 'blue', 't1'],
			[0.0006, 0, 'red', 't2'],
		];
		assert.deepStrictEqual(buildSeq(drift), [0, 2]);
	});

	it('always includes the newest pin even when within 50m of the last displayed pin', () => {
		const buildSeq = extractPlaybackSequenceRunner();
		const markers = [
			[0, 0, 'blue', 't0'],
			[0.0054, 0, 'blue', 't1'],
			[0.00549, 0, 'red', 't2'], // ~10m from previous
		];
		assert.deepStrictEqual(buildSeq(markers), [0, 1, 2]);
		assert.deepStrictEqual(buildSeq([[10, 10, 'red', 't0']]), [0]);
	});

	it('wires the button state matrix through setMapControlDisabled', () => {
		assert.match(server, /function syncPlaybackButtons\(\)\{\s*var inSession=playbackState!=='idle';\s*setMapControlDisabled\(pbPlayBtn,playbackState==='playing'\|\|\(!inSession&&markers\.length<2\)\);\s*setMapControlDisabled\(pbPauseBtn,playbackState!=='playing'\);\s*setMapControlDisabled\(pbStopBtn,!inSession\);\s*setMapControlDisabled\(pbBackBtn,!inSession\|\|playbackPos<=0\);\s*setMapControlDisabled\(pbForwardBtn,!inSession\);\s*\}/);
		assert.match(server, /pbPlayBtn\.addEventListener\('click',function\(\)\{\s*if\(pbPlayBtn\.disabled\)return;\s*if\(playbackState==='paused'\)\{resumePlayback\(\);return\}\s*startPlayback\(\);\s*\}\);/);
	});

	it('starts playback from the full-day extent with a red playhead and traveling tooltip', () => {
		assert.match(server, /function startPlayback\(\)\{\s*if\(playbackState!=='idle'\|\|markers\.length<2\)return;\s*playbackSeq=buildPlaybackSequence\(\);\s*if\(playbackSeq\.length<2\)return;\s*clearPresenceMapPopups\(\);\s*playbackState='playing';\s*playbackPos=0;\s*zoomToMarkers\(\);\s*renderPlaybackFrame\(\);/);
		assert.match(server, /addPlaybackMarkerFeature\(markers\[idx\],idx,p===playbackPos\?'red':'blue'\);\s*\}\s*red=markers\[playbackSeq\[playbackPos\]\];\s*setTooltipHtml\(redTooltip,red\[3\]\);\s*var headLonLat=new OpenLayers\.LonLat\(red\[1\],red\[0\]\)\.transform\(wgs84,proj\);\s*if\(!map\.getExtent\(\)\.containsLonLat\(headLonLat\)\)map\.panTo\(headLonLat\);\s*updateRedTooltip\(\);/);
	});

	it('stop and natural completion restore the original markers without moving the map', () => {
		assert.match(server, /function stopPlayback\(\)\{\s*if\(playbackState==='idle'\)return;\s*clearPlaybackTimer\(\);\s*playbackState='idle';\s*playbackSeq=\[\];\s*playbackPos=0;\s*restoreOriginalMarkers\(\);\s*syncZoomButtonState\(\);\s*syncPlaybackButtons\(\);\s*setTimeout\(updateAnchoredTooltips,100\);\s*\}/);
		assert.match(server, /function playbackTick\(\)\{\s*playbackTimer=null;\s*if\(playbackState!=='playing'\)return;\s*if\(playbackPos>=playbackSeq\.length-2\)\{stopPlayback\(\);return\}/);
		assert.match(server, /function restoreOriginalMarkers\(\)\{\s*clearBlueTooltipSelectionState\(\);\s*vector\.removeAllFeatures\(\);\s*markers\.forEach\(function\(m,i\)\{\s*addPlaybackMarkerFeature\(m,i,m\[2\]\);\s*\}\);/);
	});

	it('loading a different day resets any active playback session', () => {
		assert.match(server, /searchEmpty\.style\.display='none';\s*resetPlaybackForDayChange\(\);\s*clearBlueTooltipSelectionState\(\);/);
		assert.match(server, /setTimeout\(updateAnchoredTooltips,100\);\s*syncPlaybackButtons\(\);\s*\}\)\.catch\(/);
	});
});
