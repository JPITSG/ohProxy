'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SESSIONS_FILE = path.join(PROJECT_ROOT, 'sessions.js');

describe('Sessions Users Table Schema', () => {
	it('defines disabled, trackgps, voice_preference, and mapview_rendering in base users schema', () => {
		const source = fs.readFileSync(SESSIONS_FILE, 'utf8');
		assert.match(source, /CREATE TABLE IF NOT EXISTS users \(/);
		assert.match(source, /disabled INTEGER DEFAULT 0/);
		assert.match(source, /trackgps INTEGER DEFAULT 0/);
		assert.match(source, /voice_preference TEXT DEFAULT 'system'/);
		assert.match(source, /mapview_rendering TEXT DEFAULT 'ohproxy'/);
	});
});
