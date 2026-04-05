'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Presence Nearby Days Anchor Follow', () => {
	it('repositions the nearby-days popup from stored map coordinates during map movement', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /var ctxMenuOffsetX=0,ctxMenuOffsetY=0;/);
		assert.match(server, /function getCtxAnchorPixel\(\)\{[\s\S]*?if\(!isFinite\(ctxLat\)\|\|!isFinite\(ctxLon\)\)return null;[\s\S]*?var lonlat=new OpenLayers\.LonLat\(ctxLon,ctxLat\)\.transform\(wgs84,proj\);[\s\S]*?return map\.getPixelFromLonLat\(lonlat\);[\s\S]*?\}/);
		assert.match(server, /function positionCtxMenuFromAnchor\(\)\{[\s\S]*?if\(!ctxMenu\|\|ctxMenu\.style\.display!=='block'\)return false;[\s\S]*?var px=getCtxAnchorPixel\(\);[\s\S]*?if\(!px\)return false;[\s\S]*?setCtxMenuPosition\(px\.x\+ctxMenuOffsetX,px\.y\+ctxMenuOffsetY\);[\s\S]*?clampCtxMenu\(\);[\s\S]*?return true;[\s\S]*?\}/);
		assert.match(server, /function updateCtxMenuAnchor\(\)\{[\s\S]*?if\(!ctxMenu\|\|ctxMenu\.style\.display!=='block'\|\|ctxDragActive\|\|ctxDragging\)return;[\s\S]*?positionCtxMenuFromAnchor\(\);[\s\S]*?\}/);
		assert.match(server, /function updateAnchoredTooltips\(\)\{[\s\S]*?updateRedTooltip\(\);[\s\S]*?updateBluePinnedTooltip\(\);[\s\S]*?updateCtxMenuAnchor\(\);[\s\S]*?\}/);
	});

	it('stores manual popup dragging as an offset from the anchored map point', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /function syncCtxMenuOffsetToAnchor\(\)\{[\s\S]*?var px=getCtxAnchorPixel\(\);[\s\S]*?if\(!px\)return false;[\s\S]*?var pos=getCtxMenuPosition\(\);[\s\S]*?ctxMenuOffsetX=pos\.x-px\.x;[\s\S]*?ctxMenuOffsetY=pos\.y-px\.y;[\s\S]*?return true;[\s\S]*?\}/);
		assert.match(server, /handle\.addEventListener\('mousedown',function\(e\)\{[\s\S]*?syncCtxMenuOffsetToAnchor\(\);[\s\S]*?ctxMenuStartX=parseInt\(ctxMenu\.style\.left,10\)\|\|0;[\s\S]*?ctxMenuStartY=parseInt\(ctxMenu\.style\.top,10\)\|\|0;[\s\S]*?\}\);/);
		assert.match(server, /document\.addEventListener\('mousemove',function\(e\)\{[\s\S]*?if\(!ctxDragActive\)return;[\s\S]*?setCtxMenuPosition\(newX,newY\);[\s\S]*?clampCtxMenu\(\);[\s\S]*?syncCtxMenuOffsetToAnchor\(\);[\s\S]*?\},true\);/);
		assert.match(server, /function ctxUpdatePos\(e,persistOffset\)\{[\s\S]*?ctxMenuOffsetX=0;[\s\S]*?ctxMenuOffsetY=0;[\s\S]*?setCtxMenuPosition\(px\.x,px\.y\);[\s\S]*?if\(ctxMenu\.style\.display==='block'\)\{[\s\S]*?clampCtxMenu\(\);[\s\S]*?if\(persistOffset\)syncCtxMenuOffsetToAnchor\(\);[\s\S]*?\}[\s\S]*?return true;[\s\S]*?\}/);
		assert.match(server, /if\(ctxUpdatePos\(e,true\)\)\{loadNearbyDays\(\)\}else\{closeCtxMenu\(\)\}/);
	});
});
