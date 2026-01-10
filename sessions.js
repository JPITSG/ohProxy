'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'sessions.db');
const DEFAULT_SETTINGS = { darkMode: true, paused: false };

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

	// Create widget glow rules table
	db.exec(`
		CREATE TABLE IF NOT EXISTS widget_glow_rules (
			widget_id TEXT PRIMARY KEY,
			rules TEXT NOT NULL,
			updated_at INTEGER DEFAULT (strftime('%s','now'))
		);
	`);

	// Create users table
	db.exec(`
		CREATE TABLE IF NOT EXISTS users (
			username TEXT PRIMARY KEY,
			password TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'normal',
			created_at INTEGER DEFAULT (strftime('%s','now'))
		);
	`);

	// Create widget visibility table
	db.exec(`
		CREATE TABLE IF NOT EXISTS widget_visibility (
			widget_id TEXT PRIMARY KEY,
			visibility TEXT NOT NULL DEFAULT 'all',
			updated_at INTEGER DEFAULT (strftime('%s','now'))
		);
	`);

	// Create server settings table (key-value store for persistent server state)
	db.exec(`
		CREATE TABLE IF NOT EXISTS server_settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
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
 * @param {string|null} username - Username
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
 * Update session username.
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

// ============================================
// Widget Glow Rules Functions
// ============================================

/**
 * Get all glow rules.
 * @returns {Array} - Array of {widgetId, rules} objects
 */
function getAllGlowRules() {
	if (!db) initDb();
	const rows = db.prepare('SELECT widget_id, rules FROM widget_glow_rules').all();
	return rows.map(row => ({
		widgetId: row.widget_id,
		rules: JSON.parse(row.rules)
	}));
}

/**
 * Get rules for a specific widget.
 * @param {string} widgetId - The widget ID
 * @returns {Array} - Rules array or empty array if not found
 */
function getGlowRules(widgetId) {
	if (!db) initDb();
	const row = db.prepare('SELECT rules FROM widget_glow_rules WHERE widget_id = ?').get(widgetId);
	return row ? JSON.parse(row.rules) : [];
}

/**
 * Set rules for a widget. Empty rules array deletes the entry.
 * @param {string} widgetId - The widget ID
 * @param {Array} rules - Rules array
 * @returns {boolean} - True if successful
 */
function setGlowRules(widgetId, rules) {
	if (!db) initDb();
	const now = Math.floor(Date.now() / 1000);

	if (!Array.isArray(rules) || rules.length === 0) {
		db.prepare('DELETE FROM widget_glow_rules WHERE widget_id = ?').run(widgetId);
	} else {
		db.prepare(`
			INSERT INTO widget_glow_rules (widget_id, rules, updated_at)
			VALUES (?, ?, ?)
			ON CONFLICT(widget_id) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at
		`).run(widgetId, JSON.stringify(rules), now);
	}
	return true;
}

// ============================================
// Widget Visibility Functions
// ============================================

const VALID_VISIBILITIES = ['all', 'normal', 'admin'];

/**
 * Get all visibility rules.
 * @returns {Array} - Array of {widgetId, visibility} objects
 */
function getAllVisibilityRules() {
	if (!db) initDb();
	const rows = db.prepare('SELECT widget_id, visibility FROM widget_visibility').all();
	return rows.map(row => ({
		widgetId: row.widget_id,
		visibility: row.visibility
	}));
}

/**
 * Set visibility for a widget. 'all' deletes the entry (default).
 * @param {string} widgetId - The widget ID
 * @param {string} visibility - 'all', 'normal', or 'admin'
 * @returns {boolean} - True if successful
 */
function setVisibility(widgetId, visibility) {
	if (!db) initDb();
	if (!VALID_VISIBILITIES.includes(visibility)) return false;
	const now = Math.floor(Date.now() / 1000);

	if (visibility === 'all') {
		db.prepare('DELETE FROM widget_visibility WHERE widget_id = ?').run(widgetId);
	} else {
		db.prepare(`
			INSERT INTO widget_visibility (widget_id, visibility, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(widget_id) DO UPDATE SET visibility = excluded.visibility, updated_at = excluded.updated_at
		`).run(widgetId, visibility, now);
	}
	return true;
}

// ============================================
// User Management Functions
// ============================================

const VALID_ROLES = ['admin', 'normal', 'readonly'];
const USERNAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Get all users.
 * @returns {Array} - Array of {username, role, createdAt} (no passwords)
 */
function getAllUsers() {
	if (!db) initDb();
	const rows = db.prepare('SELECT username, role, created_at FROM users').all();
	return rows.map(row => ({
		username: row.username,
		role: row.role,
		createdAt: row.created_at
	}));
}

/**
 * Get a user by username.
 * @param {string} username
 * @returns {object|null} - {username, password, role, createdAt} or null
 */
function getUser(username) {
	if (!db) initDb();
	const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
	if (!row) return null;
	return {
		username: row.username,
		password: row.password,
		role: row.role,
		createdAt: row.created_at
	};
}

/**
 * Create a new user.
 * @param {string} username
 * @param {string} password
 * @param {string} role - 'admin', 'normal', or 'readonly'
 * @returns {boolean} - True if created
 */
function createUser(username, password, role = 'normal') {
	if (!db) initDb();
	if (!USERNAME_REGEX.test(username)) return false;
	if (!VALID_ROLES.includes(role)) return false;

	const now = Math.floor(Date.now() / 1000);
	try {
		db.prepare('INSERT INTO users (username, password, role, created_at) VALUES (?, ?, ?, ?)')
			.run(username, password, role, now);
		return true;
	} catch (err) {
		return false; // Duplicate username
	}
}

/**
 * Update user password.
 * @param {string} username
 * @param {string} newPassword
 * @returns {boolean} - True if updated
 */
function updateUserPassword(username, newPassword) {
	if (!db) initDb();
	const result = db.prepare('UPDATE users SET password = ? WHERE username = ?')
		.run(newPassword, username);
	return result.changes > 0;
}

/**
 * Update user role.
 * @param {string} username
 * @param {string} newRole
 * @returns {boolean} - True if updated
 */
function updateUserRole(username, newRole) {
	if (!db) initDb();
	if (!VALID_ROLES.includes(newRole)) return false;
	const result = db.prepare('UPDATE users SET role = ? WHERE username = ?')
		.run(newRole, username);
	return result.changes > 0;
}

/**
 * Delete a user and their sessions.
 * @param {string} username
 * @returns {boolean} - True if deleted
 */
function deleteUser(username) {
	if (!db) initDb();
	// Delete sessions first
	db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
	// Delete user
	const result = db.prepare('DELETE FROM users WHERE username = ?').run(username);
	return result.changes > 0;
}

// ============================================
// Server Settings Functions (Key-Value Store)
// ============================================

/**
 * Get a server setting by key.
 * @param {string} key - The setting key
 * @returns {string|null} - The value or null if not found
 */
function getServerSetting(key) {
	if (!db) initDb();
	const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key);
	return row ? row.value : null;
}

/**
 * Set a server setting.
 * @param {string} key - The setting key
 * @param {string} value - The value to store
 */
function setServerSetting(key, value) {
	if (!db) initDb();
	db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run(key, String(value));
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
	// Glow rules
	getAllGlowRules,
	getGlowRules,
	setGlowRules,
	// Visibility
	getAllVisibilityRules,
	setVisibility,
	// User management
	getAllUsers,
	getUser,
	createUser,
	updateUserPassword,
	updateUserRole,
	deleteUser,
	// Server settings
	getServerSetting,
	setServerSetting,
};
