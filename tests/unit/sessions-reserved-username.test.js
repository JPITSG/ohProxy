'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SESSIONS_FILE = path.join(PROJECT_ROOT, 'sessions.js');

describe('Sessions reserved username guard', () => {
	it('defines and enforces reserved admin username check in createUser', () => {
		const content = fs.readFileSync(SESSIONS_FILE, 'utf8');
		assert.match(content, /const RESERVED_USERNAMES = new Set\(\['admin'\]\);/, 'missing reserved username set');
		assert.match(content, /function isReservedUsername\(username\) \{[\s\S]*\.trim\(\)\.toLowerCase\(\)/, 'missing normalized reserved username helper');
		assert.match(content, /function createUser\(username, password, role = 'normal'\) \{[\s\S]*if \(!USERNAME_REGEX\.test\(username\)\) return false;[\s\S]*if \(isReservedUsername\(username\)\) return false;/, 'missing createUser reserved username guard');
	});
});
