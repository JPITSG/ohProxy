'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('SSE Reconnect Delay Wiring', () => {
	it('uses immediate delay for first reconnect attempt and 5s for subsequent attempts', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /let sseReconnectAttempt = 0;/);
		assert.match(server, /const delayMs = sseReconnectAttempt === 0 \? 0 : SSE_RECONNECT_MS;/);
		assert.match(server, /sseReconnectAttempt\+\+;/);
		assert.match(server, /sseReconnectTimer = setTimeout\(\(\) => \{/);
		assert.match(server, /\}, delayMs\);/);
	});

	it('resets reconnect attempt state on successful connect and explicit stop', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /logMessage\('\[SSE\] Connected to event stream'\);\s*sseReconnectAttempt = 0;/);
		assert.match(server, /function stopSSE\(\) \{[\s\S]*?sseReconnectAttempt = 0;/);
	});
});
