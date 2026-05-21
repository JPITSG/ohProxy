'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Presence map blank interaction clearing', () => {
	it('clears nearby days and pinned previous-point tooltip only from blank map clicks or taps', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /function findAnyPresenceFeatureNearPixel\(px,maxDistance\)\{\s*return findLayerFeatureNearPixel\(vector,px,maxDistance\)\|\|findLayerFeatureNearPixel\(previewLayer,px,maxDistance\);\s*\}/);
		assert.match(server, /function clearPresenceMapPopupsFromBlankPixel\(px\)\{\s*if\(findAnyPresenceFeatureNearPixel\(px,36\)\)return false;\s*closeCtxMenu\(\);\s*clearBlueTooltipSelectionState\(\);\s*return true;\s*\}/);
		assert.match(server, /map\.events\.register\('click',map,function\(e\)\{\s*clearPresenceMapPopupsFromBlankPixel\(e\.xy\);\s*\}\);/);
		assert.match(server, /mapEl\.addEventListener\('touchend',function\(e\)\{[\s\S]*?if\(f\)\{[\s\S]*?showBlueAndHandleClick\(f,endPx,true\);[\s\S]*?\}else\{\s*clearPresenceMapPopupsFromBlankPixel\(endPx\);[\s\S]*?\},\{passive:true,capture:true\}\);/);
		assert.match(server, /mapEl\.addEventListener\('click',function\(e\)\{\s*var px=eventToPixel\(e\);\s*clearPresenceMapPopupsFromBlankPixel\(px\);\s*\}\);/);
	});
});
