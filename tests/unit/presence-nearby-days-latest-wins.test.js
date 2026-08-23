'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Presence Nearby Days Latest-Wins Requests', () => {
	it('every load supersedes the previous request before fetching', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /var ctxReqSeq=0,ctxReqCtl=null;/);
		assert.match(server, /function abortNearbyDaysRequest\(\)\{ctxReqSeq\+\+;if\(ctxReqCtl\)\{ctxReqCtl\.abort\(\);ctxReqCtl=null\}\}/);
		assert.match(server, /if\(ctxReqCtl\)ctxReqCtl\.abort\(\);\s*ctxReqCtl=window\.AbortController\?new AbortController\(\):null;\s*var seq=\+\+ctxReqSeq;\s*fetch\('\/api\/presence\/nearby-days\?lat='\+ctxLat\+'&lon='\+ctxLon\+'&offset='\+ctxOffset\+'&radius='\+ctxRadius,ctxReqCtl\?\{signal:ctxReqCtl\.signal\}:undefined\)/);
	});

	it('stale responses cannot render over a newer request', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /\.then\(function\(data\)\{\s*if\(seq!==ctxReqSeq\)return;\s*if\(!data\.ok\)/);
		assert.match(server, /\.catch\(function\(\)\{\s*if\(seq!==ctxReqSeq\)return;\s*renderCtxMenuBody\('\x3cdiv class="ctx-empty">Request failed\x3c\/div>'\)/);
	});

	it('closing the menu aborts any in-flight request so late replies cannot repaint markers', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /function closeCtxMenu\(\)\{abortNearbyDaysRequest\(\);ctxMenu\.style\.display='none';/);
	});
});
