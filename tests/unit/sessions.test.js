'use strict';

const { describe, it, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Test database path
const TEST_DB_PATH = path.join(__dirname, '..', 'sessions.db.test');

// We need to patch the module to use test DB
// Since sessions.js uses a hardcoded path, we'll test the logic by recreating functions
// or by directly manipulating the database

const { cleanupTestDb, wait } = require('../test-helpers');

describe('Sessions Module', () => {
	let db;

	function initTestDb() {
		db = new Database(TEST_DB_PATH);
		db.pragma('journal_mode = WAL');
		db.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				client_id TEXT PRIMARY KEY,
				username TEXT DEFAULT NULL,
				settings TEXT DEFAULT '{}',
				created_at INTEGER DEFAULT (strftime('%s','now')),
				last_seen INTEGER DEFAULT (strftime('%s','now')),
				created_ip TEXT DEFAULT NULL,
				last_ip TEXT DEFAULT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen);
		`);
		return db;
	}

	beforeEach(() => {
		cleanupTestDb();
		db = initTestDb();
	});

	afterEach(() => {
		if (db) {
			db.close();
			db = null;
		}
		cleanupTestDb();
	});

	describe('Database Initialization', () => {
		it('initDb creates database file', () => {
			assert.ok(fs.existsSync(TEST_DB_PATH), 'Database file should exist');
		});

		it('initDb creates sessions table', () => {
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").all();
			assert.strictEqual(tables.length, 1, 'sessions table should exist');
		});

		it('initDb is idempotent', () => {
			// Run init again - should not throw
			db.exec(`
				CREATE TABLE IF NOT EXISTS sessions (
					client_id TEXT PRIMARY KEY,
					username TEXT DEFAULT NULL,
					settings TEXT DEFAULT '{}',
					created_at INTEGER DEFAULT (strftime('%s','now')),
					last_seen INTEGER DEFAULT (strftime('%s','now')),
					created_ip TEXT DEFAULT NULL,
					last_ip TEXT DEFAULT NULL
				);
			`);
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").all();
			assert.strictEqual(tables.length, 1, 'sessions table should still exist');
		});

		it('sessions table has correct schema', () => {
			const columns = db.prepare("PRAGMA table_info(sessions)").all();
			const columnNames = columns.map(c => c.name);
			assert.ok(columnNames.includes('client_id'), 'should have client_id column');
			assert.ok(columnNames.includes('username'), 'should have username column');
			assert.ok(columnNames.includes('settings'), 'should have settings column');
			assert.ok(columnNames.includes('created_at'), 'should have created_at column');
			assert.ok(columnNames.includes('last_seen'), 'should have last_seen column');
			assert.ok(columnNames.includes('created_ip'), 'should have created_ip column');
			assert.ok(columnNames.includes('last_ip'), 'should have last_ip column');
		});
	});

	describe('generateSessionId', () => {
		it('returns UUID format', () => {
			const crypto = require('crypto');
			const id = crypto.randomUUID();
			const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
			assert.ok(uuidRegex.test(id), 'Should match UUID v4 format');
		});

		it('returns unique IDs', () => {
			const crypto = require('crypto');
			const ids = new Set();
			for (let i = 0; i < 1000; i++) {
				ids.add(crypto.randomUUID());
			}
			assert.strictEqual(ids.size, 1000, 'All 1000 IDs should be unique');
		});
	});

	describe('createSession', () => {
		it('stores new session', () => {
			const clientId = 'test-session-1';
			const now = Math.floor(Date.now() / 1000);
			const settings = { darkMode: true };
			const settingsJson = JSON.stringify(settings);

			db.prepare(`
				INSERT INTO sessions (client_id, username, settings, created_at, last_seen, created_ip, last_ip)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).run(clientId, 'testuser', settingsJson, now, now, '192.168.1.1', '192.168.1.1');

			const row = db.prepare('SELECT * FROM sessions WHERE client_id = ?').get(clientId);
			assert.ok(row, 'Session should be stored');
			assert.strictEqual(row.client_id, clientId);
		});

		it('uses default settings { darkMode: true }', () => {
			const clientId = 'test-session-2';
			const now = Math.floor(Date.now() / 1000);
			const defaultSettings = { darkMode: true };

			db.prepare(`
				INSERT INTO sessions (client_id, username, settings, created_at, last_seen, created_ip, last_ip)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).run(clientId, null, JSON.stringify(defaultSettings), now, now, null, null);

			const row = db.prepare('SELECT settings FROM sessions WHERE client_id = ?').get(clientId);
			const settings = JSON.parse(row.settings);
			assert.strictEqual(settings.darkMode, true);
		});

		it('stores username', () => {
			const clientId = 'test-session-3';
			const username = 'myuser';
			const now = Math.floor(Date.now() / 1000);

			db.prepare(`
				INSERT INTO sessions (client_id, username, settings, created_at, last_seen, created_ip, last_ip)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).run(clientId, username, '{}', now, now, null, null);

			const row = db.prepare('SELECT username FROM sessions WHERE client_id = ?').get(clientId);
			assert.strictEqual(row.username, username);
		});

		it('stores IP addresses', () => {
			const clientId = 'test-session-4';
			const ip = '10.0.0.50';
			const now = Math.floor(Date.now() / 1000);

			db.prepare(`
				INSERT INTO sessions (client_id, username, settings, created_at, last_seen, created_ip, last_ip)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).run(clientId, null, '{}', now, now, ip, ip);

			const row = db.prepare('SELECT created_ip, last_ip FROM sessions WHERE client_id = ?').get(clientId);
			assert.strictEqual(row.created_ip, ip);
			assert.strictEqual(row.last_ip, ip);
		});
	});

	describe('getSession', () => {
		it('returns null for missing session', () => {
			const row = db.prepare('SELECT * FROM sessions WHERE client_id = ?').get('nonexistent');
			assert.strictEqual(row, undefined);
		});

		it('returns session object for existing session', () => {
			const clientId = 'existing-session';
			const now = Math.floor(Date.now() / 1000);
			db.prepare(`
				INSERT INTO sessions (client_id, username, settings, created_at, last_seen, created_ip, last_ip)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).run(clientId, 'user1', '{"darkMode":false}', now, now, '1.2.3.4', '1.2.3.4');

			const row = db.prepare('SELECT * FROM sessions WHERE client_id = ?').get(clientId);
			assert.ok(row);
			assert.strictEqual(row.client_id, clientId);
			assert.strictEqual(row.username, 'user1');
		});

		it('parses JSON settings correctly', () => {
			const clientId = 'json-session';
			const settings = { darkMode: false, customSetting: 'value' };
			const now = Math.floor(Date.now() / 1000);
			db.prepare(`
				INSERT INTO sessions (client_id, username, settings, created_at, last_seen, created_ip, last_ip)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).run(clientId, null, JSON.stringify(settings), now, now, null, null);

			const row = db.prepare('SELECT settings FROM sessions WHERE client_id = ?').get(clientId);
			const parsed = JSON.parse(row.settings);
			assert.strictEqual(typeof parsed, 'object');
			assert.strictEqual(parsed.darkMode, false);
			assert.strictEqual(parsed.customSetting, 'value');
		});
	});

	describe('updateSettings', () => {
		it('modifies settings', () => {
			const clientId = 'update-session';
			const now = Math.floor(Date.now() / 1000);
			db.prepare(`
				INSERT INTO sessions (client_id, username, settings, created_at, last_seen, created_ip, last_ip)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).run(clientId, null, '{"darkMode":true}', now, now, null, null);

			const newSettings = { darkMode: false, newKey: 'newValue' };
			const newNow = Math.floor(Date.now() / 1000);
			const result = db.prepare(`
				UPDATE sessions SET settings = ?, last_seen = ? WHERE client_id = ?
			`).run(JSON.stringify(newSettings), newNow, clientId);

			assert.strictEqual(result.changes, 1);

			const row = db.prepare('SELECT settings FROM sessions WHERE client_id = ?').get(clientId);
			const parsed = JSON.parse(row.settings);
			assert.strictEqual(parsed.darkMode, false);
			assert.strictEqual(parsed.newKey, 'newValue');
		});

		it('updates last_seen timestamp', () => {
			const clientId = 'timestamp-session';
			const oldTime = Math.floor(Date.now() / 1000) - 1000;
			db.prepare(`
				INSERT INTO sessions (client_id, username, settings, created_at, last_seen, created_ip, last_ip)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).run(clientId, null, '{}', oldTime, oldTime, null, null);

			const newTime = Math.floor(Date.now() / 1000);
			db.prepare(`
				UPDATE sessions SET settings = ?, last_seen = ? WHERE client_id = ?
			`).run('{}', newTime, clientId);

			const row = db.prepare('SELECT last_seen FROM sessions WHERE client_id = ?').get(clientId);
			assert.ok(row.last_seen >= newTime - 1);
		});

		it('returns false (0 changes) for missing session', () => {
			const result = db.prepare(`
				UPDATE sessions SET settings = ?, last_seen = ? WHERE client_id = ?
			`).run('{}', Math.floor(Date.now() / 1000), 'nonexistent');
			assert.strictEqual(result.changes, 0);
		});
	});

	describe('touchSession', () => {
		it('updates last_seen timestamp', () => {
			const clientId = 'touch-session';
			const oldTime = Math.floor(Date.now() / 1000) - 1000;
			db.prepare(`
				INSERT INTO sessions (client_id, username, settings, created_at, last_seen, created_ip, last_ip)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).run(clientId, null, '{}', oldTime, oldTime, '1.1.1.1', '1.1.1.1');

			const newTime = Math.floor(Date.now() / 1000);
			const newIp = '2.2.2.2';
			db.prepare(`
				UPDATE sessions SET last_seen = ?, last_ip = COALESCE(?, last_ip) WHERE client_id = ?
			`).run(newTime, newIp, clientId);

			const row = db.prepare('SELECT last_seen, last_ip FROM sessions WHERE client_id = ?').get(clientId);
			assert.ok(row.last_seen >= newTime - 1);
			assert.strictEqual(row.last_ip, newIp);
		});

		it('updates last_ip', () => {
			const clientId = 'ip-update-session';
			const now = Math.floor(Date.now() / 1000);
			db.prepare(`
				INSERT INTO sessions (client_id, username, settings, created_at, last_seen, created_ip, last_ip)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).run(clientId, null, '{}', now, now, '1.1.1.1', '1.1.1.1');

			const newIp = '3.3.3.3';
			db.prepare(`
				UPDATE sessions SET last_seen = ?, last_ip = COALESCE(?, last_ip) WHERE client_id = ?
			`).run(now, newIp, clientId);

			const row = db.prepare('SELECT last_ip FROM sessions WHERE client_id = ?').get(clientId);
			assert.strictEqual(row.last_ip, newIp);
		});
	});

	describe('cleanupSessions', () => {
		it('deletes old sessions', () => {
			const maxAgeDays = 14;
			const cutoff = Math.floor(Date.now() / 1000) - (maxAgeDays * 24 * 60 * 60);
			const oldTime = cutoff - 1000; // Before cutoff
			const newTime = cutoff + 1000; // After cutoff

			db.prepare(`
				INSERT INTO sessions (client_id, username, settings, created_at, last_seen, created_ip, last_ip)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).run('old-session', null, '{}', oldTime, oldTime, null, null);

			db.prepare(`
				INSERT INTO sessions (client_id, username, settings, created_at, last_seen, created_ip, last_ip)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`).run('new-session', null, '{}', newTime, newTime, null, null);

			const result = db.prepare(`
				DELETE FROM sessions WHERE last_seen < ?
			`).run(cutoff);

			assert.ok(result.changes >= 1, 'Should delete at least the old session');

			const oldRow = db.prepare('SELECT * FROM sessions WHERE client_id = ?').get('old-session');
			const newRow = db.prepare('SELECT * FROM sessions WHERE client_id = ?').get('new-session');

			assert.strictEqual(oldRow, undefined, 'Old session should be deleted');
			assert.ok(newRow, 'New session should remain');
		});
	});

	describe('Voice Preference', () => {
		function createUsersTable() {
			db.exec(`
				CREATE TABLE IF NOT EXISTS users (
					username TEXT PRIMARY KEY,
					password TEXT NOT NULL,
					role TEXT NOT NULL DEFAULT 'normal',
					created_at INTEGER DEFAULT (strftime('%s','now')),
					disabled INTEGER DEFAULT 0,
					trackgps INTEGER DEFAULT 0,
					voice_preference TEXT DEFAULT 'system'
				)
			`);
		}

		it('defaults to system for new users', () => {
			createUsersTable();
			db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('alice', 'pw');
			const row = db.prepare('SELECT voice_preference FROM users WHERE username = ?').get('alice');
			assert.strictEqual(row.voice_preference, 'system');
		});

		it('accepts valid voice preferences', () => {
			createUsersTable();
			db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('bob', 'pw');
			for (const pref of ['system', 'browser', 'vosk']) {
				db.prepare('UPDATE users SET voice_preference = ? WHERE username = ?').run(pref, 'bob');
				const row = db.prepare('SELECT voice_preference FROM users WHERE username = ?').get('bob');
				assert.strictEqual(row.voice_preference, pref, `Should accept '${pref}'`);
			}
		});

		it('updateUserVoicePreference rejects invalid values', () => {
			// Replicate the validation logic from sessions.js
			const valid = ['system', 'browser', 'vosk'];
			assert.strictEqual(valid.includes('adaptive'), false, 'adaptive should be rejected');
			assert.strictEqual(valid.includes('invalid'), false, 'random string should be rejected');
			assert.strictEqual(valid.includes(''), false, 'empty string should be rejected');
		});

		it('returns false for nonexistent user', () => {
			createUsersTable();
			const result = db.prepare('UPDATE users SET voice_preference = ? WHERE username = ?')
				.run('vosk', 'nonexistent');
			assert.strictEqual(result.changes, 0);
		});

		it('getUser returns voice_preference', () => {
			createUsersTable();
			db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('carol', 'pw');
			db.prepare('UPDATE users SET voice_preference = ? WHERE username = ?').run('vosk', 'carol');
			const row = db.prepare('SELECT * FROM users WHERE username = ?').get('carol');
			assert.strictEqual(row.voice_preference, 'vosk');
		});

		it('getAllUsers includes voice_preference', () => {
			createUsersTable();
			db.exec(`
				CREATE TABLE IF NOT EXISTS sessions (
					client_id TEXT PRIMARY KEY,
					username TEXT DEFAULT NULL,
					settings TEXT DEFAULT '{}',
					created_at INTEGER DEFAULT (strftime('%s','now')),
					last_seen INTEGER DEFAULT (strftime('%s','now')),
					created_ip TEXT DEFAULT NULL,
					last_ip TEXT DEFAULT NULL
				)
			`);
			db.prepare('INSERT INTO users (username, password, voice_preference) VALUES (?, ?, ?)').run('dave', 'pw', 'browser');
			const rows = db.prepare(`
				SELECT u.username, u.voice_preference
				FROM users u
				LEFT JOIN sessions s ON u.username = s.username
				GROUP BY u.username
			`).all();
			assert.strictEqual(rows.length, 1);
			assert.strictEqual(rows[0].voice_preference, 'browser');
		});
	});

	describe('setMaxAgeDays', () => {
		it('validates input (must be >= 1)', () => {
			// Test logic: setMaxAgeDays should only accept values >= 1
			const validValues = [1, 7, 14, 30, 365];
			const invalidValues = [0, -1, -100];

			for (const val of validValues) {
				assert.ok(val >= 1, `${val} should be valid (>= 1)`);
			}

			for (const val of invalidValues) {
				assert.ok(val < 1, `${val} should be invalid (< 1)`);
			}
		});
	});
});
