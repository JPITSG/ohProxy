'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Presence Nearby Days Wheel Navigation', () => {
	it('maps wheel direction on the nearby-days body to the existing nav buttons', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /var ctxLat=0,ctxLon=0,ctxOffset=0,ctxRadius=100,ctxWheelNavUntil=0;/);
		assert.match(server, /function bindCtxBody\(\)\{[\s\S]*?var body=ctxMenu\.querySelector\('\.ctx-body'\);[\s\S]*?body\.addEventListener\('wheel',function\(e\)\{[\s\S]*?if\(!e\.deltaY\|\|Math\.abs\(e\.deltaY\)<=Math\.abs\(e\.deltaX\)\)return;[\s\S]*?if\(triggerCtxNavFromWheel\(e\.deltaY\)\)e\.preventDefault\(\);[\s\S]*?\},\{passive:false\}\);[\s\S]*?\}/);
		assert.match(server, /function triggerCtxNavFromWheel\(deltaY\)\{[\s\S]*?var btn=ctxMenu\.querySelector\(deltaY>0\?'\.ctx-older':'\.ctx-newer'\);[\s\S]*?if\(!btn\)return false;[\s\S]*?if\(now<ctxWheelNavUntil\)return true;[\s\S]*?ctxWheelNavUntil=now\+180;[\s\S]*?btn\.click\(\);[\s\S]*?return true;[\s\S]*?\}/);
		assert.ok(server.includes("ctxMenu.innerHTML=ctxHeader()+'<div class=\"ctx-body\">'+bodyHtml+'</div>';"));
	});

	it('keeps existing nearby days visible while older and newer pages load', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /function loadNearbyDays\(options\)\{[\s\S]*?options=options\|\|\{\};[\s\S]*?if\(!options\.preserveEntries&&!ctxDragging\)\{[\s\S]*?renderCtxMenuBody\('\x3cdiv class="ctx-loading">Loading\\\\u2026\x3c\/div>'\);[\s\S]*?\}/);
		assert.match(server, /if\(newerBtn\)newerBtn\.addEventListener\('click',function\(e\)\{e\.stopPropagation\(\);ctxOffset=Math\.max\(0,ctxOffset-5\);loadNearbyDays\(\{preserveEntries:true\}\)\}\);/);
		assert.match(server, /if\(olderBtn\)olderBtn\.addEventListener\('click',function\(e\)\{e\.stopPropagation\(\);ctxOffset\+=5;loadNearbyDays\(\{preserveEntries:true\}\)\}\);/);
	});
});
