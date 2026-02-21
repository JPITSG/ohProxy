'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Startup Instance Marker Wiring', () => {
	it('logs a startup separator before startup status logs', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		const marker = "logMessage('-----');";
		const startup = "logMessage('[Startup] Starting ohProxy instance...');";
		const markerIndex = server.indexOf(marker);
		const startupIndex = server.indexOf(startup);
		assert.ok(markerIndex >= 0, 'startup marker log must exist');
		assert.ok(startupIndex >= 0, 'startup status log must exist');
		assert.ok(markerIndex < startupIndex, 'startup marker must be logged first');
	});
});
