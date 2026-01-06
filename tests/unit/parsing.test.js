'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// Parsing functions replicated from server.js

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function parseBasicAuthHeader(value) {
	if (!value) return [null, null];
	if (!/^basic /i.test(value)) return [null, null];
	const encoded = value.slice(6).trim();
	if (!encoded) return [null, null];
	let decoded = '';
	try {
		decoded = Buffer.from(encoded, 'base64').toString('utf8');
	} catch {
		return [null, null];
	}
	const idx = decoded.indexOf(':');
	if (idx === -1) return [decoded, ''];
	return [decoded.slice(0, idx), decoded.slice(idx + 1)];
}

function getBasicAuthCredentials(req) {
	if (!req || !req.headers) return [null, null];
	const header = req.headers.authorization || req.headers.Authorization;
	return parseBasicAuthHeader(header);
}

// Test users file parser
function loadAuthUsers(filePath) {
	if (!filePath) return null;
	let content = '';
	try {
		content = fs.readFileSync(filePath, 'utf8');
	} catch {
		return null;
	}
	const users = {};
	const lines = content.split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
		let pos = trimmed.indexOf(':');
		if (pos === -1) pos = trimmed.indexOf('=');
		if (pos === -1) continue;
		const user = trimmed.slice(0, pos).trim();
		const passPart = trimmed.slice(pos + 1).trim();
		const comma = passPart.indexOf(',');
		const pass = comma === -1 ? passPart : passPart.slice(0, comma).trim();
		if (!user) continue;
		users[user] = pass;
	}
	return users;
}

function parseTimeString(value) {
	const raw = safeText(value).trim().toLowerCase();
	if (!raw) return null;

	// Match patterns like: 10s, 10secs, 10seconds, 5m, 5min, 5mins, 5minutes, 2h, 2hours, 1d, 1day, 1days
	const match = raw.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
	if (!match) return null;

	const num = Number(match[1]);
	if (!Number.isFinite(num) || num < 0) return null;

	const unit = match[2];
	if (unit.startsWith('s')) return num;
	if (unit.startsWith('m') && !unit.startsWith('mi')) return num * 60;
	if (unit.startsWith('mi')) return num * 60;
	if (unit.startsWith('h')) return num * 3600;
	if (unit.startsWith('d')) return num * 86400;

	return null;
}

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');
const TEST_USERS_FILE = path.join(FIXTURES_DIR, 'users.cfg');

describe('Parsing Functions', () => {
	describe('parseBasicAuthHeader', () => {
		it('extracts credentials from valid header', () => {
			const encoded = Buffer.from('testuser:testpassword').toString('base64');
			const [user, pass] = parseBasicAuthHeader(`Basic ${encoded}`);
			assert.strictEqual(user, 'testuser');
			assert.strictEqual(pass, 'testpassword');
		});

		it('handles colon in password', () => {
			const encoded = Buffer.from('user:pass:word:here').toString('base64');
			const [user, pass] = parseBasicAuthHeader(`Basic ${encoded}`);
			assert.strictEqual(user, 'user');
			assert.strictEqual(pass, 'pass:word:here');
		});

		it('returns [null, null] for invalid format', () => {
			const [user, pass] = parseBasicAuthHeader('NotBasic xyz');
			assert.strictEqual(user, null);
			assert.strictEqual(pass, null);
		});

		it('returns [null, null] for empty value', () => {
			const [user, pass] = parseBasicAuthHeader('');
			assert.strictEqual(user, null);
			assert.strictEqual(pass, null);
		});

		it('returns [null, null] for null value', () => {
			const [user, pass] = parseBasicAuthHeader(null);
			assert.strictEqual(user, null);
			assert.strictEqual(pass, null);
		});

		it('handles missing password (no colon)', () => {
			const encoded = Buffer.from('useronly').toString('base64');
			const [user, pass] = parseBasicAuthHeader(`Basic ${encoded}`);
			assert.strictEqual(user, 'useronly');
			assert.strictEqual(pass, '');
		});

		it('is case-insensitive for Basic prefix', () => {
			const encoded = Buffer.from('user:pass').toString('base64');
			const [user1, pass1] = parseBasicAuthHeader(`basic ${encoded}`);
			const [user2, pass2] = parseBasicAuthHeader(`BASIC ${encoded}`);
			const [user3, pass3] = parseBasicAuthHeader(`BaSiC ${encoded}`);
			assert.strictEqual(user1, 'user');
			assert.strictEqual(user2, 'user');
			assert.strictEqual(user3, 'user');
		});

		it('handles empty encoded part', () => {
			const [user, pass] = parseBasicAuthHeader('Basic ');
			assert.strictEqual(user, null);
			assert.strictEqual(pass, null);
		});

		it('handles invalid base64', () => {
			const [user, pass] = parseBasicAuthHeader('Basic !!!invalid!!!');
			// Invalid base64 should be handled gracefully - returns decoded garbage or nulls
			// The function should not throw
			assert.ok(true, 'Should not throw on invalid base64');
		});

		it('handles unicode in credentials', () => {
			const encoded = Buffer.from('用户:密码').toString('base64');
			const [user, pass] = parseBasicAuthHeader(`Basic ${encoded}`);
			assert.strictEqual(user, '用户');
			assert.strictEqual(pass, '密码');
		});
	});

	describe('getBasicAuthCredentials', () => {
		it('extracts from Authorization header', () => {
			const encoded = Buffer.from('user:pass').toString('base64');
			const req = { headers: { authorization: `Basic ${encoded}` } };
			const [user, pass] = getBasicAuthCredentials(req);
			assert.strictEqual(user, 'user');
			assert.strictEqual(pass, 'pass');
		});

		it('handles capitalized Authorization header', () => {
			const encoded = Buffer.from('user:pass').toString('base64');
			const req = { headers: { Authorization: `Basic ${encoded}` } };
			const [user, pass] = getBasicAuthCredentials(req);
			assert.strictEqual(user, 'user');
			assert.strictEqual(pass, 'pass');
		});

		it('returns [null, null] for missing header', () => {
			const req = { headers: {} };
			const [user, pass] = getBasicAuthCredentials(req);
			assert.strictEqual(user, null);
			assert.strictEqual(pass, null);
		});

		it('returns [null, null] for null request', () => {
			const [user, pass] = getBasicAuthCredentials(null);
			assert.strictEqual(user, null);
			assert.strictEqual(pass, null);
		});

		it('returns [null, null] for missing headers object', () => {
			const [user, pass] = getBasicAuthCredentials({});
			assert.strictEqual(user, null);
			assert.strictEqual(pass, null);
		});
	});

	describe('loadAuthUsers', () => {
		it('parses user:pass format', () => {
			const users = loadAuthUsers(TEST_USERS_FILE);
			assert.ok(users);
			assert.strictEqual(users.testuser, 'testpassword');
		});

		it('parses multiple users', () => {
			const users = loadAuthUsers(TEST_USERS_FILE);
			assert.ok(users);
			assert.ok('testuser' in users);
			assert.ok('admin' in users);
		});

		it('ignores comment lines starting with #', () => {
			// Our test file has a comment line
			const users = loadAuthUsers(TEST_USERS_FILE);
			// Should not have keys starting with #
			for (const key of Object.keys(users)) {
				assert.ok(!key.startsWith('#'));
			}
		});

		it('returns null for missing file', () => {
			const users = loadAuthUsers('/nonexistent/path/users.cfg');
			assert.strictEqual(users, null);
		});

		it('returns null for empty path', () => {
			const users = loadAuthUsers('');
			assert.strictEqual(users, null);
		});

		it('handles user with colon in password', () => {
			const users = loadAuthUsers(TEST_USERS_FILE);
			assert.ok(users);
			assert.strictEqual(users['user_with_colon'], 'pass:word:here');
		});
	});

	describe('parseTimeString', () => {
		it('parses seconds (10s)', () => {
			assert.strictEqual(parseTimeString('10s'), 10);
		});

		it('parses seconds (10secs)', () => {
			assert.strictEqual(parseTimeString('10secs'), 10);
		});

		it('parses seconds (10seconds)', () => {
			assert.strictEqual(parseTimeString('10seconds'), 10);
		});

		it('parses minutes (5m)', () => {
			assert.strictEqual(parseTimeString('5m'), 300);
		});

		it('parses minutes (5min)', () => {
			assert.strictEqual(parseTimeString('5min'), 300);
		});

		it('parses minutes (5mins)', () => {
			assert.strictEqual(parseTimeString('5mins'), 300);
		});

		it('parses minutes (5minutes)', () => {
			assert.strictEqual(parseTimeString('5minutes'), 300);
		});

		it('parses hours (2h)', () => {
			assert.strictEqual(parseTimeString('2h'), 7200);
		});

		it('parses hours (2hours)', () => {
			assert.strictEqual(parseTimeString('2hours'), 7200);
		});

		it('parses days (1d)', () => {
			assert.strictEqual(parseTimeString('1d'), 86400);
		});

		it('parses days (1day)', () => {
			assert.strictEqual(parseTimeString('1day'), 86400);
		});

		it('parses days (2days)', () => {
			assert.strictEqual(parseTimeString('2days'), 172800);
		});

		it('handles singular (1min)', () => {
			assert.strictEqual(parseTimeString('1min'), 60);
		});

		it('handles singular (1hour)', () => {
			assert.strictEqual(parseTimeString('1hour'), 3600);
		});

		it('returns null for invalid format', () => {
			assert.strictEqual(parseTimeString('abc'), null);
		});

		it('returns null for empty string', () => {
			assert.strictEqual(parseTimeString(''), null);
		});

		it('is case-insensitive', () => {
			assert.strictEqual(parseTimeString('10S'), 10);
			assert.strictEqual(parseTimeString('5MIN'), 300);
			assert.strictEqual(parseTimeString('2HOURS'), 7200);
		});

		it('handles zero', () => {
			assert.strictEqual(parseTimeString('0s'), 0);
		});

		it('returns null for negative', () => {
			assert.strictEqual(parseTimeString('-5s'), null);
		});
	});
});
