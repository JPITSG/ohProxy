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
		assert.match(defaults, /logRotationEnabled:\s*false/, 'missing server.backgroundTasks.logRotationEnabled default false');
	});

	it('wires log rotation setting in server config parsing and validation', () => {
		const server = read('server.js');
		assert.match(server, /const LOG_ROTATION_ENABLED = TASK_CONFIG\.logRotationEnabled === true;/, 'missing LOG_ROTATION_ENABLED parse');
		assert.match(server, /ensureBoolean\(TASK_CONFIG\.logRotationEnabled, 'server\.backgroundTasks\.logRotationEnabled', errors\);/, 'missing startup validation for logRotationEnabled');
		assert.match(server, /ensureBoolean\(s\.backgroundTasks\.logRotationEnabled, 'server\.backgroundTasks\.logRotationEnabled', errors\);/, 'missing admin validation for logRotationEnabled');
		assert.match(server, /logRotationEnabled:\s*LOG_ROTATION_ENABLED,/, 'missing liveConfig.logRotationEnabled initialization');
		assert.match(server, /liveConfig\.logRotationEnabled = newTasks\.logRotationEnabled === true;/, 'missing hot-reload update for logRotationEnabled');
		assert.match(server, /function scheduleLogRotation\(\)/, 'missing scheduleLogRotation helper');
		assert.match(server, /function rotateConfiguredLogFiles\(\)/, 'missing rotateConfiguredLogFiles helper');
		assert.match(server, /startBackgroundTasks\(\);\s*syncLogRotationSchedule\(\);/, 'missing startup sync for log rotation schedule');
	});

	it('exposes log rotation setting in admin config modal schema and i18n labels', () => {
		const app = read('public/app.js');
		const lang = read('public/lang.js');
		assert.match(app, /server\.backgroundTasks\.logRotationEnabled/, 'missing admin schema field for logRotationEnabled');
		assert.match(lang, /'server\.backgroundTasks\.logRotationEnabled': 'Daily Log Rotation'/, 'missing label for logRotationEnabled');
		assert.match(lang, /'server\.backgroundTasks\.logRotationEnabled': 'Rotate configured log files daily at local midnight \(00:00\); keeps \.1 through \.9 archives'/, 'missing description for logRotationEnabled');
	});
});
