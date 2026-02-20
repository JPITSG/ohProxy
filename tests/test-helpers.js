'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// Test database path
const TEST_DB_PATH = path.join(__dirname, 'database.db.test');

// Generate Basic Auth header
function basicAuthHeader(username, password) {
	const credentials = Buffer.from(`${username}:${password}`).toString('base64');
	return `Basic ${credentials}`;
}

// Base64url encode helper (used internally by generateTestAuthCookie)
function base64UrlEncode(value) {
	return Buffer.from(String(value), 'utf8')
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
}

// Generate a test auth cookie
function generateTestAuthCookie(username, password, key, days = 365) {
	const expiry = Math.floor(Date.now() / 1000) + Math.round(days * 86400);
	const userEncoded = base64UrlEncode(username);
	const payload = `${userEncoded}|${expiry}`;
	const sig = crypto.createHmac('sha256', key).update(`${payload}|${password}`).digest('hex');
	return base64UrlEncode(`${payload}|${sig}`);
}

// Clean up test database
function cleanupTestDb() {
	try {
		if (fs.existsSync(TEST_DB_PATH)) {
			fs.unlinkSync(TEST_DB_PATH);
		}
		// Also clean up WAL and SHM files
		const walPath = TEST_DB_PATH + '-wal';
		const shmPath = TEST_DB_PATH + '-shm';
		if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
		if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
	} catch (e) {
		// Ignore errors
	}
}

// Wait helper
function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Test user data
const TEST_USERS = {
	testuser: 'testpassword',
	admin: 'adminpass123',
	'user_with_colon': 'pass:word:here',
};

const TEST_COOKIE_KEY = 'test-cookie-key-32-bytes-exactly';

module.exports = {
	TEST_USERS,
	TEST_COOKIE_KEY,
	basicAuthHeader,
	base64UrlEncode,
	generateTestAuthCookie,
	cleanupTestDb,
	wait,
};
