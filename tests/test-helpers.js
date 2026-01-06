'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PROJECT_ROOT = path.join(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Test database path
const TEST_DB_PATH = path.join(__dirname, 'sessions.db.test');

// Mock request object
function mockRequest(options = {}) {
	const headers = options.headers || {};
	return {
		headers,
		socket: {
			remoteAddress: options.ip || '192.168.1.100',
		},
		secure: options.secure || false,
		path: options.path || '/',
		originalUrl: options.originalUrl || options.path || '/',
		method: options.method || 'GET',
		query: options.query || {},
		body: options.body || {},
	};
}

// Mock response object
function mockResponse() {
	const res = {
		statusCode: 200,
		headers: {},
		body: null,
		headersSent: false,
		_sentStatus: null,
		_sentBody: null,
		req: mockRequest(),
	};

	res.status = function(code) {
		res.statusCode = code;
		res._sentStatus = code;
		return res;
	};

	res.setHeader = function(name, value) {
		res.headers[name.toLowerCase()] = value;
		return res;
	};

	res.getHeader = function(name) {
		return res.headers[name.toLowerCase()];
	};

	res.removeHeader = function(name) {
		delete res.headers[name.toLowerCase()];
		return res;
	};

	res.type = function(contentType) {
		res.setHeader('Content-Type', contentType);
		return res;
	};

	res.send = function(body) {
		res._sentBody = body;
		res.body = body;
		res.headersSent = true;
		return res;
	};

	res.json = function(obj) {
		res.setHeader('Content-Type', 'application/json');
		res._sentBody = JSON.stringify(obj);
		res.body = obj;
		res.headersSent = true;
		return res;
	};

	res.end = function(body) {
		if (body !== undefined) res._sentBody = body;
		res.headersSent = true;
		return res;
	};

	res.redirect = function(url) {
		res.statusCode = 302;
		res.setHeader('Location', url);
		res.headersSent = true;
		return res;
	};

	return res;
}

// Generate Basic Auth header
function basicAuthHeader(username, password) {
	const credentials = Buffer.from(`${username}:${password}`).toString('base64');
	return `Basic ${credentials}`;
}

// Base64url encode/decode helpers
function base64UrlEncode(value) {
	return Buffer.from(String(value), 'utf8')
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
}

function base64UrlDecode(value) {
	const raw = String(value).replace(/-/g, '+').replace(/_/g, '/');
	const pad = raw.length % 4;
	const padded = pad ? raw + '='.repeat(4 - pad) : raw;
	return Buffer.from(padded, 'base64').toString('utf8');
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

// Generate random string
function randomString(length = 16) {
	return crypto.randomBytes(length).toString('hex').slice(0, length);
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
	PROJECT_ROOT,
	FIXTURES_DIR,
	TEST_DB_PATH,
	TEST_USERS,
	TEST_COOKIE_KEY,
	mockRequest,
	mockResponse,
	basicAuthHeader,
	base64UrlEncode,
	base64UrlDecode,
	generateTestAuthCookie,
	cleanupTestDb,
	randomString,
	wait,
};
