'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'database.db');
const DEFAULT_SETTINGS = { darkMode: true };

function setDefaultTheme(theme) {
	DEFAULT_SETTINGS.darkMode = theme !== 'light';
}

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
			created_at INTEGER DEFAULT (strftime('%s','now')),
			disabled INTEGER DEFAULT 0,
			trackgps INTEGER DEFAULT 0,
			voice_preference TEXT DEFAULT 'system'
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

	// Create widget video config table
	db.exec(`
		CREATE TABLE IF NOT EXISTS widget_video_config (
			widget_id TEXT PRIMARY KEY,
			default_muted INTEGER DEFAULT 1,
			updated_at INTEGER DEFAULT (strftime('%s','now'))
		);
	`);

	// Create widget iframe config table (for custom heights on iframe cards)
	db.exec(`
		CREATE TABLE IF NOT EXISTS widget_iframe_config (
			widget_id TEXT PRIMARY KEY,
			height INTEGER,
			updated_at INTEGER DEFAULT (strftime('%s','now'))
		);
	`);

	// Create widget proxy cache config table (for caching proxied images)
	db.exec(`
		CREATE TABLE IF NOT EXISTS widget_proxy_cache (
			widget_id TEXT PRIMARY KEY,
			cache_seconds INTEGER NOT NULL,
			updated_at INTEGER DEFAULT (strftime('%s','now'))
		);
	`);

	// Create widget card width config table (for full-width cards)
	db.exec(`
		CREATE TABLE IF NOT EXISTS widget_card_width (
			widget_id TEXT PRIMARY KEY,
			width TEXT NOT NULL DEFAULT 'standard',
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

const WIDGET_CONFIG_TARGETS = Object.freeze({
	widget_glow_rules: 'rules',
	widget_visibility: 'visibility',
	widget_video_config: 'default_muted',
	widget_iframe_config: 'height',
	widget_proxy_cache: 'cache_seconds',
	widget_card_width: 'width',
});

/**
 * Upsert or delete a widget-scoped config row while keeping updated_at in sync.
 * Table/column are allowlisted to avoid dynamic SQL injection.
 * @param {object} options
 * @param {string} options.table
 * @param {string} options.column
 * @param {string} options.widgetId
 * @param {any} options.value
 * @param {boolean} options.shouldDelete
 */
function upsertOrDeleteWidgetConfig({ table, column, widgetId, value, shouldDelete }) {
	if (!db) initDb();
	if (WIDGET_CONFIG_TARGETS[table] !== column) {
		throw new Error(`Invalid widget config target: ${table}.${column}`);
	}

	if (shouldDelete) {
		db.prepare(`DELETE FROM ${table} WHERE widget_id = ?`).run(widgetId);
		return;
	}

	const now = Math.floor(Date.now() / 1000);
	db.prepare(`
		INSERT INTO ${table} (widget_id, ${column}, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(widget_id) DO UPDATE SET ${column} = excluded.${column}, updated_at = excluded.updated_at
	`).run(widgetId, value, now);
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
	const shouldDelete = !Array.isArray(rules) || rules.length === 0;
	upsertOrDeleteWidgetConfig({
		table: 'widget_glow_rules',
		column: 'rules',
		widgetId,
		value: shouldDelete ? null : JSON.stringify(rules),
		shouldDelete,
	});
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
	if (!VALID_VISIBILITIES.includes(visibility)) return false;
	upsertOrDeleteWidgetConfig({
		table: 'widget_visibility',
		column: 'visibility',
		widgetId,
		value: visibility,
		shouldDelete: visibility === 'all',
	});
	return true;
}

// ============================================
// Widget Video Config Functions
// ============================================

/**
 * Get all video configs.
 * @returns {Array} - Array of {widgetId, defaultMuted} objects
 */
function getAllVideoConfigs() {
	if (!db) initDb();
	const rows = db.prepare('SELECT widget_id, default_muted FROM widget_video_config').all();
	return rows.map(row => ({
		widgetId: row.widget_id,
		defaultMuted: row.default_muted === 1
	}));
}

/**
 * Set video config for a widget. If defaultMuted is true (default), deletes the entry.
 * @param {string} widgetId - The widget ID
 * @param {boolean} defaultMuted - Whether video should start muted
 * @returns {boolean} - True if successful
 */
function setVideoConfig(widgetId, defaultMuted) {
	upsertOrDeleteWidgetConfig({
		table: 'widget_video_config',
		column: 'default_muted',
		widgetId,
		value: defaultMuted ? 1 : 0,
		shouldDelete: defaultMuted === true,
	});
	return true;
}

// ============================================
// Widget Iframe Config Functions
// ============================================

/**
 * Get all iframe configs.
 * @returns {Array} - Array of {widgetId, height} objects
 */
function getAllIframeConfigs() {
	if (!db) initDb();
	const rows = db.prepare('SELECT widget_id, height FROM widget_iframe_config').all();
	return rows.map(row => ({
		widgetId: row.widget_id,
		height: row.height
	}));
}

/**
 * Set iframe config for a widget. If height is null/undefined/0, deletes the entry.
 * @param {string} widgetId - The widget ID
 * @param {number|null} height - Custom height in pixels, or null/0 to use default
 * @returns {boolean} - True if successful
 */
function setIframeConfig(widgetId, height) {
	upsertOrDeleteWidgetConfig({
		table: 'widget_iframe_config',
		column: 'height',
		widgetId,
		value: height,
		shouldDelete: !height || height <= 0,
	});
	return true;
}

// ============================================
// Widget Proxy Cache Config Functions
// ============================================

/**
 * Get all proxy cache configs.
 * @returns {Array} - Array of {widgetId, cacheSeconds} objects
 */
function getAllProxyCacheConfigs() {
	if (!db) initDb();
	const rows = db.prepare('SELECT widget_id, cache_seconds FROM widget_proxy_cache').all();
	return rows.map(row => ({
		widgetId: row.widget_id,
		cacheSeconds: row.cache_seconds
	}));
}

/**
 * Set proxy cache config for a widget. If cacheSeconds is 0/null/undefined, deletes the entry.
 * @param {string} widgetId - The widget ID
 * @param {number|null} cacheSeconds - Cache duration in seconds, or 0/null to disable
 * @returns {boolean} - True if successful
 */
function setProxyCacheConfig(widgetId, cacheSeconds) {
	upsertOrDeleteWidgetConfig({
		table: 'widget_proxy_cache',
		column: 'cache_seconds',
		widgetId,
		value: cacheSeconds,
		shouldDelete: !cacheSeconds || cacheSeconds <= 0,
	});
	return true;
}

// ============================================
// Widget Card Width Functions
// ============================================

/**
 * Get all card width configs.
 * @returns {Array} - Array of {widgetId, width} objects
 */
function getAllCardWidths() {
	if (!db) initDb();
	const rows = db.prepare('SELECT widget_id, width FROM widget_card_width').all();
	return rows.map(r => ({ widgetId: r.widget_id, width: r.width }));
}

/**
 * Set card width for a widget. If width is 'standard' (default), deletes the entry.
 * @param {string} widgetId - The widget ID
 * @param {string} width - 'standard' or 'full'
 * @returns {boolean} - True if successful
 */
function setCardWidth(widgetId, width) {
	upsertOrDeleteWidgetConfig({
		table: 'widget_card_width',
		column: 'width',
		widgetId,
		value: width,
		shouldDelete: width === 'standard',
	});
	return true;
}

// ============================================
// User Management Functions
// ============================================

const VALID_ROLES = ['admin', 'normal', 'readonly'];
const USERNAME_REGEX = /^[a-zA-Z0-9_-]{1,20}$/;
const VALID_VOICE_PREFERENCES = new Set(['system', 'browser', 'vosk']);

/**
 * Get all users.
 * @returns {Array} - Array of {username, role, createdAt, disabled, lastActive} (no passwords)
 */
function getAllUsers() {
	if (!db) initDb();
	const rows = db.prepare(`
		SELECT u.username, u.role, u.created_at, u.disabled, u.trackgps, u.voice_preference, MAX(s.last_seen) as last_active
		FROM users u
		LEFT JOIN sessions s ON u.username = s.username
		GROUP BY u.username
	`).all();
	return rows.map(row => ({
		username: row.username,
		role: row.role,
		createdAt: row.created_at,
		disabled: row.disabled === 1,
		trackgps: row.trackgps === 1,
		voicePreference: VALID_VOICE_PREFERENCES.has(row.voice_preference) ? row.voice_preference : 'system',
		lastActive: row.last_active
	}));
}

/**
 * Get a user by username.
 * @param {string} username
 * @returns {object|null} - {username, password, role, createdAt, disabled} or null
 */
function getUser(username) {
	if (!db) initDb();
	const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
	if (!row) return null;
	return {
		username: row.username,
		password: row.password,
		role: row.role,
		createdAt: row.created_at,
		disabled: row.disabled === 1,
		trackgps: row.trackgps === 1,
		voicePreference: VALID_VOICE_PREFERENCES.has(row.voice_preference) ? row.voice_preference : 'system'
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
		db.prepare('INSERT INTO users (username, password, role, created_at, voice_preference) VALUES (?, ?, ?, ?, ?)')
			.run(username, password, role, now, 'system');
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

/**
 * Disable a user.
 * @param {string} username
 * @returns {boolean} - True if user was found and disabled
 */
function disableUser(username) {
	if (!db) initDb();
	const result = db.prepare('UPDATE users SET disabled = 1 WHERE username = ?').run(username);
	return result.changes > 0;
}

/**
 * Enable a user.
 * @param {string} username
 * @returns {boolean} - True if user was found and enabled
 */
function enableUser(username) {
	if (!db) initDb();
	const result = db.prepare('UPDATE users SET disabled = 0 WHERE username = ?').run(username);
	return result.changes > 0;
}

/**
 * Disable all users.
 * @returns {number} - Number of users disabled
 */
function disableAllUsers() {
	if (!db) initDb();
	const result = db.prepare('UPDATE users SET disabled = 1').run();
	return result.changes;
}

/**
 * Enable all users.
 * @returns {number} - Number of users enabled
 */
function enableAllUsers() {
	if (!db) initDb();
	const result = db.prepare('UPDATE users SET disabled = 0').run();
	return result.changes;
}

/**
 * Update GPS tracking flag for a user.
 * @param {string} username
 * @param {boolean} enabled
 * @returns {boolean} - True if user was found and updated
 */
function updateUserTrackGps(username, enabled) {
	if (!db) initDb();
	const result = db.prepare('UPDATE users SET trackgps = ? WHERE username = ?')
		.run(enabled ? 1 : 0, username);
	return result.changes > 0;
}

/**
 * Update voice preference for a user.
 * @param {string} username
 * @param {string} preference - 'system', 'browser', or 'vosk'
 * @returns {boolean} - True if user was found and updated
 */
function updateUserVoicePreference(username, preference) {
	if (!db) initDb();
	if (!VALID_VOICE_PREFERENCES.has(preference)) return false;
	const result = db.prepare('UPDATE users SET voice_preference = ? WHERE username = ?')
		.run(preference, username);
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
	touchSession,
	cleanupSessions,
	closeDb,
	getDefaultSettings,
	setMaxAgeDays,
	setDefaultTheme,
	// Glow rules
	getAllGlowRules,
	getGlowRules,
	setGlowRules,
	// Visibility
	getAllVisibilityRules,
	setVisibility,
	// Video config
	getAllVideoConfigs,
	setVideoConfig,
	// Iframe config
	getAllIframeConfigs,
	setIframeConfig,
	// Proxy cache config
	getAllProxyCacheConfigs,
	setProxyCacheConfig,
	// Card width
	getAllCardWidths,
	setCardWidth,
	// User management
	getAllUsers,
	getUser,
	createUser,
	updateUserPassword,
	updateUserRole,
	deleteUser,
	disableUser,
	enableUser,
	disableAllUsers,
	enableAllUsers,
	updateUserTrackGps,
	updateUserVoicePreference,
	// Server settings
	getServerSetting,
	setServerSetting,
};
