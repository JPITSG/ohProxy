'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function read(relPath) {
	return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

describe('Daily log rotation wiring', () => {
	it('defines logRotationEnabled default in config.defaults.js', () => {
		const defaults = read('config.defaults.js');
		assert.match(defaults, /logRotationEnabled:\s*false/, 'missing server.logRotationEnabled default false');
	});

	it('wires log rotation setting in server config parsing and validation', () => {
		const server = read('server.js');
		assert.match(server, /const LOG_ROTATION_ENABLED = SERVER_CONFIG\.logRotationEnabled === true/, 'missing LOG_ROTATION_ENABLED parse');
		assert.match(server, /ensureBoolean\(SERVER_CONFIG\.logRotationEnabled, 'server\.logRotationEnabled', errors\);/, 'missing startup validation for server.logRotationEnabled');
		assert.match(server, /ensureBoolean\(s\.logRotationEnabled, 'server\.logRotationEnabled', errors\);/, 'missing admin validation for server.logRotationEnabled');
		assert.match(server, /logRotationEnabled:\s*LOG_ROTATION_ENABLED,/, 'missing liveConfig.logRotationEnabled initialization');
		assert.match(server, /liveConfig\.logRotationEnabled = newServer\.logRotationEnabled === true/, 'missing hot-reload update for logRotationEnabled');
		assert.match(server, /function scheduleLogRotation\(\)/, 'missing scheduleLogRotation helper');
		assert.match(server, /function rotateConfiguredLogFiles\(\)/, 'missing rotateConfiguredLogFiles helper');
		assert.match(server, /startBackgroundTasks\(\);\s*syncLogRotationSchedule\(\);/, 'missing startup sync for log rotation schedule');
	});

	it('exposes log rotation setting in admin config modal schema and i18n labels', () => {
		const app = read('public/app.js');
		const lang = read('public/lang.js');
		assert.match(app, /id:\s*'logging'[\s\S]*server\.logRotationEnabled/, 'missing logging section field for logRotationEnabled');
		assert.doesNotMatch(app, /id:\s*'sessions'[\s\S]*server\.logRotationEnabled/, 'logRotationEnabled should not be in sessions section');
		assert.match(lang, /'server\.logRotationEnabled': 'Daily Log Rotation'/, 'missing label for logRotationEnabled');
		assert.match(lang, /'server\.logRotationEnabled': 'Rotate configured log files daily at local midnight'/, 'missing description for logRotationEnabled');
	});
});
