'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const USERS_CLI_FILE = path.join(PROJECT_ROOT, 'users-cli.js');

describe('Users CLI reserved username guard', () => {
	it('rejects reserved admin username case-insensitively before createUser call', () => {
		const cli = fs.readFileSync(USERS_CLI_FILE, 'utf8');
		assert.match(cli, /String\(username\)\.trim\(\)\.toLowerCase\(\)\s*===\s*'admin'/, 'missing case-insensitive admin username guard');
		assert.match(cli, /Error: Username 'admin' is reserved and cannot be created/, 'missing reserved admin error message');

		const guardIndex = cli.indexOf("String(username).trim().toLowerCase() === 'admin'");
		const createUserIndex = cli.indexOf('sessions.createUser(username, password, role)');
		assert.ok(guardIndex !== -1, 'reserved username guard not found');
		assert.ok(createUserIndex !== -1, 'sessions.createUser call not found');
		assert.ok(guardIndex < createUserIndex, 'guard should run before attempting user creation');
	});
});
