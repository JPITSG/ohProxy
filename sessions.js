'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'sessions.db');
const DEFAULT_SETTINGS = { darkMode: true };

let sessionMaxAgeDays = 14; // Default, can be overridden via setMaxAgeDays()

let db = null;

/**
 * Initialize the database connection and create tables if needed.
 * Also runs cleanup of expired sessions.
 */
function initDb() {
	if (db) return db;

	db = new Database(DB_PATH);
	db.pragma('journal_mode = WAL');

	// Create sessions table
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

	// Migration: add IP columns if they don't exist
	try {
		db.exec(`ALTER TABLE sessions ADD COLUMN created_ip TEXT DEFAULT NULL`);
	} catch (e) { /* column already exists */ }
	try {
		db.exec(`ALTER TABLE sessions ADD COLUMN last_ip TEXT DEFAULT NULL`);
	} catch (e) { /* column already exists */ }

	// Run cleanup on startup
	cleanupSessions();

	return db;
}

/**
 * Generate a new random session ID.
 */
function generateSessionId() {
	return crypto.randomUUID();
}

/**
 * Get a session by client ID.
 * @param {string} clientId - The session ID
 * @returns {object|null} - Session object or null if not found
 */
function getSession(clientId) {
	if (!db) initDb();
	const row = db.prepare('SELECT * FROM sessions WHERE client_id = ?').get(clientId);
	if (!row) return null;
	return {
		clientId: row.client_id,
		username: row.username,
		settings: JSON.parse(row.settings || '{}'),
		createdAt: row.created_at,
		lastSeen: row.last_seen,
		createdIp: row.created_ip,
		lastIp: row.last_ip,
	};
}

/**
 * Create a new session.
 * @param {string} clientId - The session ID
 * @param {string|null} username - Username (null for LAN users)
 * @param {object} settings - Initial settings (defaults to DEFAULT_SETTINGS)
 * @param {string|null} ip - Client IP address
 * @returns {object} - The created session
 */
function createSession(clientId, username = null, settings = DEFAULT_SETTINGS, ip = null) {
	if (!db) initDb();
	const now = Math.floor(Date.now() / 1000);
	const settingsJson = JSON.stringify(settings);

	db.prepare(`
		INSERT INTO sessions (client_id, username, settings, created_at, last_seen, created_ip, last_ip)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(clientId, username, settingsJson, now, now, ip, ip);

	return {
		clientId,
		username,
		settings,
		createdAt: now,
		lastSeen: now,
		createdIp: ip,
		lastIp: ip,
	};
}

/**
 * Update session settings.
 * @param {string} clientId - The session ID
 * @param {object} settings - New settings object
 * @returns {boolean} - True if updated, false if session not found
 */
function updateSettings(clientId, settings) {
	if (!db) initDb();
	const settingsJson = JSON.stringify(settings);
	const now = Math.floor(Date.now() / 1000);

	const result = db.prepare(`
		UPDATE sessions SET settings = ?, last_seen = ? WHERE client_id = ?
	`).run(settingsJson, now, clientId);

	return result.changes > 0;
}

/**
 * Update session username (for LAN user who later authenticates).
 * @param {string} clientId - The session ID
 * @param {string} username - The username to set
 * @returns {boolean} - True if updated, false if session not found
 */
function updateUsername(clientId, username) {
	if (!db) initDb();
	const now = Math.floor(Date.now() / 1000);

	const result = db.prepare(`
		UPDATE sessions SET username = ?, last_seen = ? WHERE client_id = ?
	`).run(username, now, clientId);

	return result.changes > 0;
}

/**
 * Update last_seen timestamp and last IP for a session.
 * @param {string} clientId - The session ID
 * @param {string|null} ip - Client IP address
 * @returns {boolean} - True if updated, false if session not found
 */
function touchSession(clientId, ip = null) {
	if (!db) initDb();
	const now = Math.floor(Date.now() / 1000);

	const result = db.prepare(`
		UPDATE sessions SET last_seen = ?, last_ip = COALESCE(?, last_ip) WHERE client_id = ?
	`).run(now, ip, clientId);

	return result.changes > 0;
}

/**
 * Set the session max age in days.
 * @param {number} days - Max age in days (must be >= 1)
 */
function setMaxAgeDays(days) {
	if (typeof days === 'number' && days >= 1) {
		sessionMaxAgeDays = days;
	}
}

/**
 * Delete sessions older than sessionMaxAgeDays.
 * @returns {number} - Number of sessions deleted
 */
function cleanupSessions() {
	if (!db) initDb();
	const cutoff = Math.floor(Date.now() / 1000) - (sessionMaxAgeDays * 24 * 60 * 60);

	const result = db.prepare(`
		DELETE FROM sessions WHERE last_seen < ?
	`).run(cutoff);

	if (result.changes > 0) {
		console.log(`[sessions] Cleaned up ${result.changes} expired session(s)`);
	}

	return result.changes;
}

/**
 * Close the database connection.
 */
function closeDb() {
	if (db) {
		db.close();
		db = null;
	}
}

/**
 * Get the default settings object.
 */
function getDefaultSettings() {
	return { ...DEFAULT_SETTINGS };
}

module.exports = {
	initDb,
	generateSessionId,
	getSession,
	createSession,
	updateSettings,
	updateUsername,
	touchSession,
	cleanupSessions,
	closeDb,
	getDefaultSettings,
	setMaxAgeDays,
};
