'use strict';

const express = require('express');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { execFile, spawn } = require('child_process');
const http = require('http');
const https = require('https');
const http2 = require('http2');
const crypto = require('crypto');
const { createProxyMiddleware } = require('http-proxy-middleware');
const WebSocket = require('ws');
const net = require('net');
const mysql = require('mysql2');
const sessions = require('./sessions');

const CONFIG_PATH = path.join(__dirname, 'config.js');
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function authHeader() {
	// Prefer API token (Bearer) for OH 3.x, fall back to Basic Auth for OH 1.x/2.x
	if (liveConfig.ohApiToken) {
		return `Bearer ${liveConfig.ohApiToken}`;
	}
	if (!liveConfig.ohUser || !liveConfig.ohPass) return null;
	const token = Buffer.from(`${liveConfig.ohUser}:${liveConfig.ohPass}`).toString('base64');
	return `Basic ${token}`;
}

function stripIconVersion(pathname) {
	let out = pathname;
	out = out.replace(/\/v\d+\//i, '/');
	out = out.replace(/\.v\d+(?=\.)/i, '');
	return out;
}

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function formatLogTimestamp(date) {
	const pad = (value) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatLogLine(message) {
	const text = safeText(message).replace(/[\r\n]+/g, ' ').trim();
	if (!text) return '';
	return `${formatLogTimestamp(new Date())} | ${text}\n`;
}

function writeLogLine(filePath, message) {
	const line = formatLogLine(message);
	if (!line) return;
	process.stdout.write(line);
	if (!filePath) return;
	try {
		fs.appendFileSync(filePath, line);
	} catch (err) {
		const fallback = formatLogLine(`Failed to write log file ${filePath}: ${err.message || err}`);
		if (fallback) process.stdout.write(fallback);
	}
}

function describeValue(value) {
	if (value === undefined) return '<undefined>';
	if (value === null) return '<null>';
	if (typeof value === 'string') {
		const text = value.replace(/[\r\n]+/g, ' ');
		return text === '' ? "''" : `'${text}'`;
	}
	try {
		const json = JSON.stringify(value);
		if (json !== undefined) return json;
	} catch {
		// ignore
	}
	return String(value);
}

function escapeHtml(value) {
	const text = safeText(value);
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function configNumber(value, fallback) {
	const num = Number(value);
	return Number.isFinite(num) ? num : fallback;
}

function setAuthResponseHeaders(res, authInfo) {
	const authenticated = authInfo && authInfo.auth === 'authenticated';
	res.setHeader('X-OhProxy-Authenticated', authenticated ? 'true' : 'false');
	const safeUser = authenticated ? safeText(authInfo.user).replace(/[\r\n]/g, '').trim() : '';
	if (safeUser) res.setHeader('X-OhProxy-Username', safeUser);
	else res.removeHeader('X-OhProxy-Username');
}

const BOOT_LOG_FILE = safeText(process.env.LOG_FILE || '');
function bootLog(message) {
	writeLogLine(BOOT_LOG_FILE, message);
}

function loadUserConfig() {
	try {
		if (!fs.existsSync(CONFIG_PATH)) return {};
		delete require.cache[require.resolve(CONFIG_PATH)];
		const cfg = require(CONFIG_PATH);
		return cfg && typeof cfg === 'object' ? cfg : {};
	} catch (err) {
		if (err && err.code !== 'MODULE_NOT_FOUND') {
			bootLog(`Failed to load ${CONFIG_PATH}: ${err.message || err}`);
		}
		return {};
	}
}

function parseProxyAllowEntry(value) {
	const raw = safeText(value).trim();
	if (!raw) return null;
	// Reject non-http/https/rtsp schemes (must have :// to be a scheme)
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^(https?|rtsp):\/\//i.test(raw)) return null;
	const candidate = /^(https?|rtsp):\/\//i.test(raw) ? raw : `http://${raw}`;
	try {
		const url = new URL(candidate);
		let host = safeText(url.hostname).toLowerCase();
		if (!host) return null;
		// Strip brackets from IPv6 for consistent matching
		if (host.startsWith('[') && host.endsWith(']')) {
			host = host.slice(1, -1);
		}
		return { host, port: safeText(url.port) };
	} catch {
		return null;
	}
}

function normalizeProxyAllowlist(list) {
	if (!Array.isArray(list)) return [];
	const out = [];
	for (const entry of list) {
		const parsed = parseProxyAllowEntry(entry);
		if (parsed) out.push(parsed);
	}
	return out;
}

function targetPortForUrl(url) {
	if (url.port) return url.port;
	if (url.protocol === 'https:') return '443';
	if (url.protocol === 'rtsp:') return '554';
	return '80';
}

function isProxyTargetAllowed(url, allowlist) {
	if (!allowlist.length) return false;
	const host = safeText(url.hostname).toLowerCase();
	const port = targetPortForUrl(url);
	for (const entry of allowlist) {
		if (entry.host !== host) continue;
		if (!entry.port) return true;
		if (entry.port === port) return true;
	}
	return false;
}

function hashString(value) {
	return crypto.createHash('sha1').update(value).digest('hex');
}

const USER_CONFIG = loadUserConfig();
const SERVER_CONFIG = USER_CONFIG.server || {};
const HTTP_CONFIG = SERVER_CONFIG.http || {};
const HTTPS_CONFIG = SERVER_CONFIG.https || {};
const SERVER_AUTH = SERVER_CONFIG.auth || {};
const SECURITY_HEADERS = SERVER_CONFIG.securityHeaders || {};
const CLIENT_CONFIG = USER_CONFIG.client || {};
const PROXY_ALLOWLIST = normalizeProxyAllowlist(SERVER_CONFIG.proxyAllowlist);
const WEBVIEW_NO_PROXY = normalizeProxyAllowlist(SERVER_CONFIG.webviewNoProxy);

const HTTP_ENABLED = typeof HTTP_CONFIG.enabled === 'boolean' ? HTTP_CONFIG.enabled : false;
const HTTPS_ENABLED = typeof HTTPS_CONFIG.enabled === 'boolean' ? HTTPS_CONFIG.enabled : false;
const HTTP_HOST = safeText(HTTP_CONFIG.host);
const HTTP_PORT = configNumber(HTTP_CONFIG.port);
const HTTPS_HOST = safeText(HTTPS_CONFIG.host);
const HTTPS_PORT = configNumber(HTTPS_CONFIG.port);
const HTTPS_CERT_FILE = safeText(HTTPS_CONFIG.certFile);
const HTTPS_KEY_FILE = safeText(HTTPS_CONFIG.keyFile);
const HTTPS_HTTP2 = typeof HTTPS_CONFIG.http2 === 'boolean' ? HTTPS_CONFIG.http2 : false;
const ALLOW_SUBNETS = SERVER_CONFIG.allowSubnets;
const TRUST_PROXY = SERVER_CONFIG.trustProxy === true;
const DENY_XFF_SUBNETS = SERVER_CONFIG.denyXFFSubnets;
const OH_TARGET = safeText(process.env.OH_TARGET || SERVER_CONFIG.openhab?.target);
const OH_USER = safeText(process.env.OH_USER || SERVER_CONFIG.openhab?.user || '');
const OH_PASS = safeText(process.env.OH_PASS || SERVER_CONFIG.openhab?.pass || '');
const OH_API_TOKEN = safeText(process.env.OH_API_TOKEN || SERVER_CONFIG.openhab?.apiToken || '');
const OPENHAB_REQUEST_TIMEOUT_MS = configNumber(SERVER_CONFIG.openhab?.timeoutMs, 15000);
const ICON_VERSION = safeText(process.env.ICON_VERSION || SERVER_CONFIG.assets?.iconVersion);
const USER_AGENT = safeText(process.env.USER_AGENT || SERVER_CONFIG.userAgent);
const ASSET_VERSION = safeText(SERVER_CONFIG.assets?.assetVersion);
const APPLE_TOUCH_VERSION_RAW = safeText(SERVER_CONFIG.assets?.appleTouchIconVersion);
const APPLE_TOUCH_VERSION = APPLE_TOUCH_VERSION_RAW
	? (APPLE_TOUCH_VERSION_RAW.startsWith('v')
		? APPLE_TOUCH_VERSION_RAW
		: `v${APPLE_TOUCH_VERSION_RAW}`)
	: '';
const ICON_SIZE = configNumber(SERVER_CONFIG.iconSize);
const ICON_CACHE_CONCURRENCY = Math.max(1, Math.floor(configNumber(SERVER_CONFIG.iconCacheConcurrency, 5)));
const DELTA_CACHE_LIMIT = configNumber(SERVER_CONFIG.deltaCacheLimit);
const GROUP_ITEMS = Array.isArray(SERVER_CONFIG.groupItems) ? SERVER_CONFIG.groupItems.map(safeText).filter(Boolean) : [];
const PROXY_LOG_LEVEL = safeText(process.env.PROXY_LOG_LEVEL || SERVER_CONFIG.proxyMiddlewareLogLevel);
const LOG_FILE = safeText(process.env.LOG_FILE || SERVER_CONFIG.logFile);
const ACCESS_LOG = safeText(process.env.ACCESS_LOG || SERVER_CONFIG.accessLog);
const ACCESS_LOG_LEVEL = safeText(process.env.ACCESS_LOG_LEVEL || SERVER_CONFIG.accessLogLevel || 'all')
	.trim()
	.toLowerCase();
const JS_LOG_FILE = safeText(process.env.JS_LOG_FILE || SERVER_CONFIG.jsLogFile || '');
const SLOW_QUERY_MS = configNumber(SERVER_CONFIG.slowQueryMs, 0);
const AUTH_REALM = safeText(SERVER_AUTH.realm || 'openHAB Proxy');
const AUTH_COOKIE_NAME = safeText(SERVER_AUTH.cookieName || 'AuthStore');
const AUTH_COOKIE_DAYS = configNumber(SERVER_AUTH.cookieDays, 0);
const AUTH_COOKIE_KEY = safeText(SERVER_AUTH.cookieKey || '');
const AUTH_FAIL_NOTIFY_CMD = safeText(SERVER_AUTH.authFailNotifyCmd || '');
const AUTH_MODE = safeText(SERVER_AUTH.mode || 'basic');
const AUTH_FAIL_NOTIFY_INTERVAL_MINS = configNumber(SERVER_AUTH.authFailNotifyIntervalMins, 15);
const AUTH_LOCKOUT_THRESHOLD = 3;
const SESSION_COOKIE_NAME = 'ohSession';
const SESSION_COOKIE_DAYS = 3650; // 10 years
const SESSION_MAX_AGE_DAYS = (() => {
	const val = configNumber(SERVER_CONFIG.sessionMaxAgeDays, 14);
	if (val < 1) {
		console.warn(`sessionMaxAgeDays must be >= 1, got ${val}; using default 14`);
		return 14;
	}
	return val;
})();
const AUTH_LOCKOUT_MS = 15 * 60 * 1000;
const AUTH_LOCKOUT_PRUNE_MS = 60 * 1000;
const AUTH_LOCKOUT_STALE_MS = Math.max(AUTH_LOCKOUT_MS, 15 * 60 * 1000);
const SECURITY_HEADERS_ENABLED = SECURITY_HEADERS.enabled !== false;
const SECURITY_HSTS = SECURITY_HEADERS.hsts || {};
const SECURITY_CSP = SECURITY_HEADERS.csp || {};
const SECURITY_REFERRER_POLICY = safeText(SECURITY_HEADERS.referrerPolicy || '');
const TASK_CONFIG = SERVER_CONFIG.backgroundTasks || {};
const SITEMAP_REFRESH_MS = configNumber(
	process.env.SITEMAP_REFRESH_MS || TASK_CONFIG.sitemapRefreshMs
);
const WEBSOCKET_CONFIG = SERVER_CONFIG.websocket || {};
const WS_MODE = ['atmosphere', 'sse'].includes(WEBSOCKET_CONFIG.mode) ? WEBSOCKET_CONFIG.mode : 'polling';
const WS_POLLING_INTERVAL_MS = configNumber(WEBSOCKET_CONFIG.pollingIntervalMs) || 500;
const WS_POLLING_INTERVAL_BG_MS = configNumber(WEBSOCKET_CONFIG.pollingIntervalBgMs) || 2000;
const WS_ATMOSPHERE_NO_UPDATE_WARN_MS = Math.max(
	0,
	configNumber(WEBSOCKET_CONFIG.atmosphereNoUpdateWarnMs, 5000)
);
const BACKEND_RECOVERY_DELAY_MS = Math.max(
	0,
	configNumber(WEBSOCKET_CONFIG.backendRecoveryDelayMs, 0)
);
const PREVIEW_CONFIG = SERVER_CONFIG.videoPreview || {};
const VIDEO_PREVIEW_INTERVAL_MS = configNumber(PREVIEW_CONFIG.intervalMs, 900000);
const VIDEO_PREVIEW_PRUNE_HOURS = configNumber(PREVIEW_CONFIG.pruneAfterHours, 24);
const VIDEO_PREVIEW_DIR = path.join(__dirname, 'video-previews');
const BINARIES_CONFIG = SERVER_CONFIG.binaries || {};
const BIN_FFMPEG = safeText(BINARIES_CONFIG.ffmpeg) || '/usr/bin/ffmpeg';
const BIN_CONVERT = safeText(BINARIES_CONFIG.convert) || '/usr/bin/convert';
const BIN_SHELL = safeText(BINARIES_CONFIG.shell) || '/bin/sh';
const PATHS_CONFIG = SERVER_CONFIG.paths || {};
const RRD_PATH = safeText(PATHS_CONFIG.rrd) || '';
const CHART_CACHE_DIR = path.join(__dirname, 'cache', 'chart');
const CHART_PERIOD_TTL = {
	h: 60 * 1000,           // 1 minute
	D: 10 * 60 * 1000,      // 10 minutes
	W: 60 * 60 * 1000,      // 1 hour
	M: 60 * 60 * 1000,      // 1 hour
	Y: 24 * 60 * 60 * 1000, // 1 day
};
const AI_CACHE_DIR = path.join(__dirname, 'cache', 'ai');
const AI_STRUCTURE_MAP_WRITABLE = path.join(AI_CACHE_DIR, 'structuremap-writable.json');
const ANTHROPIC_API_KEY = safeText(SERVER_CONFIG.apiKeys?.anthropic) || '';
const WEATHERBIT_CONFIG = SERVER_CONFIG.weatherbit || {};
const WEATHERBIT_API_KEY = safeText(WEATHERBIT_CONFIG.apiKey) || '';
const WEATHERBIT_LATITUDE = safeText(WEATHERBIT_CONFIG.latitude) || '';
const WEATHERBIT_LONGITUDE = safeText(WEATHERBIT_CONFIG.longitude) || '';
const WEATHERBIT_UNITS = safeText(WEATHERBIT_CONFIG.units) || 'M';
const WEATHERBIT_REFRESH_MS = configNumber(WEATHERBIT_CONFIG.refreshIntervalMs, 3600000);
const WEATHERBIT_CACHE_DIR = path.join(__dirname, 'cache', 'weatherbit');
const WEATHERBIT_FORECAST_FILE = path.join(WEATHERBIT_CACHE_DIR, 'forecast.json');
const WEATHERBIT_ICONS_DIR = path.join(WEATHERBIT_CACHE_DIR, 'icons');
const PROXY_CACHE_DIR = path.join(__dirname, 'cache', 'proxy');
const MYSQL_CONFIG = SERVER_CONFIG.mysql || {};
const MYSQL_RECONNECT_DELAY_MS = 5000;
const CMDAPI_CONFIG = SERVER_CONFIG.cmdapi || {};
const CMDAPI_ENABLED = CMDAPI_CONFIG.enabled === true;
const CMDAPI_ALLOWED_SUBNETS = Array.isArray(CMDAPI_CONFIG.allowedSubnets)
	? CMDAPI_CONFIG.allowedSubnets
	: [];
const CMDAPI_ALLOWED_ITEMS = Array.isArray(CMDAPI_CONFIG.allowedItems)
	? CMDAPI_CONFIG.allowedItems
	: [];
const CMDAPI_TIMEOUT_MS = 10000;
let mysqlConnection = null;
let mysqlConnecting = false;
let videoPreviewInitialCaptureDone = false;
const activeRtspStreams = new Map(); // Track active RTSP streams: id -> { url, user, ip, startTime }
let rtspStreamIdCounter = 0;
const authLockouts = new Map();

function logMessage(message) {
	writeLogLine(LOG_FILE, message);
}

function logJsError(message) {
	if (!JS_LOG_FILE) return;
	writeLogLine(JS_LOG_FILE, message);
}

function getLockoutKey(ip) {
	return ip || 'unknown';
}

function getAuthLockout(key) {
	if (!key) return null;
	const entry = authLockouts.get(key);
	if (!entry) return null;
	const now = Date.now();
	if (entry.lockUntil && entry.lockUntil <= now) {
		authLockouts.delete(key);
		return null;
	}
	return entry;
}

function recordAuthFailure(key) {
	if (!key) return null;
	const now = Date.now();
	let entry = authLockouts.get(key);
	if (!entry || (entry.lockUntil && entry.lockUntil <= now)) {
		entry = { count: 1, lockUntil: 0, lastFailAt: now };
		authLockouts.set(key, entry);
		return entry;
	}
	entry.count += 1;
	entry.lastFailAt = now;
	if (entry.count >= AUTH_LOCKOUT_THRESHOLD) {
		entry.lockUntil = now + AUTH_LOCKOUT_MS;
	}
	authLockouts.set(key, entry);
	return entry;
}

function clearAuthFailures(key) {
	if (!key) return;
	authLockouts.delete(key);
}

function pruneAuthLockouts() {
	const now = Date.now();
	for (const [key, entry] of authLockouts) {
		if (!entry) {
			authLockouts.delete(key);
			continue;
		}
		if (entry.lockUntil && entry.lockUntil <= now) {
			authLockouts.delete(key);
			continue;
		}
		const lastFailAt = entry.lastFailAt || 0;
		if (!entry.lockUntil && lastFailAt && now - lastFailAt > AUTH_LOCKOUT_STALE_MS) {
			authLockouts.delete(key);
		}
	}
}

function logAccess(message) {
	if (ACCESS_LOG_LEVEL === '400+') {
		const match = safeText(message).match(/\s(\d{3})\s/);
		const status = match ? Number(match[1]) : NaN;
		if (Number.isFinite(status) && status < 400) return;
	}
	const line = safeText(message);
	if (!line || !ACCESS_LOG) return;
	const text = line.endsWith('\n') ? line : `${line}\n`;
	try {
		fs.appendFileSync(ACCESS_LOG, text);
	} catch (err) {
		const fallback = formatLogLine(`Failed to write log file ${ACCESS_LOG}: ${err.message || err}`);
		if (fallback) process.stdout.write(fallback);
	}
}

function shouldSkipAccessLog(res) {
	if (ACCESS_LOG_LEVEL === 'all') return false;
	if (ACCESS_LOG_LEVEL === '400+') return (res?.statusCode || 0) < 400;
	return false;
}

function isPlainObject(value) {
	return value && typeof value === 'object' && !Array.isArray(value);
}

function ensureString(value, name, { allowEmpty = false } = {}, errors) {
	if (typeof value !== 'string') {
		errors.push(`${name} must be a string but currently is ${describeValue(value)}`);
		return;
	}
	if (!allowEmpty && value.trim() === '') {
		errors.push(`${name} is required but currently is ${describeValue(value)}`);
	}
}

function ensureNumber(value, name, { min, max, integer = true } = {}, errors) {
	if (!Number.isFinite(value)) {
		errors.push(`${name} must be a number but currently is ${describeValue(value)}`);
		return;
	}
	if (integer && !Number.isInteger(value)) {
		errors.push(`${name} must be an integer but currently is ${describeValue(value)}`);
		return;
	}
	if (min !== undefined && value < min) {
		errors.push(`${name} must be >= ${min} but currently is ${describeValue(value)}`);
	}
	if (max !== undefined && value > max) {
		errors.push(`${name} must be <= ${max} but currently is ${describeValue(value)}`);
	}
}

function ensureBoolean(value, name, errors) {
	if (typeof value !== 'boolean') {
		errors.push(`${name} must be true/false but currently is ${describeValue(value)}`);
	}
}

function ensureArray(value, name, { allowEmpty = false } = {}, errors) {
	if (!Array.isArray(value)) {
		errors.push(`${name} must be an array but currently is ${describeValue(value)}`);
		return false;
	}
	if (!allowEmpty && value.length === 0) {
		errors.push(`${name} must not be empty but currently is ${describeValue(value)}`);
		return false;
	}
	return true;
}

function ensureObject(value, name, errors) {
	if (!isPlainObject(value)) {
		errors.push(`${name} must be an object but currently is ${describeValue(value)}`);
		return false;
	}
	return true;
}

function isValidIpv4(value) {
	const parts = safeText(value).split('.');
	if (parts.length !== 4) return false;
	return parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isValidCidr(value) {
	const raw = safeText(value).trim();
	const parts = raw.split('/');
	if (parts.length !== 2) return false;
	if (!isValidIpv4(parts[0])) return false;
	const mask = Number(parts[1]);
	return Number.isInteger(mask) && mask >= 0 && mask <= 32;
}

function isAllowAllSubnet(value) {
	return safeText(value).trim() === '0.0.0.0';
}

function isValidAllowSubnet(value) {
	if (isAllowAllSubnet(value)) return true;
	return isValidCidr(value);
}

function ensureCidrList(value, name, { allowEmpty = false } = {}, errors) {
	if (!ensureArray(value, name, { allowEmpty }, errors)) return;
	value.forEach((entry, index) => {
		if (!isValidCidr(entry)) {
			errors.push(`${name}[${index}] must be IPv4 CIDR but currently is ${describeValue(entry)}`);
		}
	});
}

function ensureAllowSubnets(value, name, errors, options = {}) {
	const allowEmpty = options.allowEmpty === true;
	if (!ensureArray(value, name, { allowEmpty }, errors)) return;
	value.forEach((entry, index) => {
		if (!isValidAllowSubnet(entry)) {
			errors.push(`${name}[${index}] must be IPv4 CIDR or 0.0.0.0 but currently is ${describeValue(entry)}`);
		}
	});
}

function ensureUrl(value, name, errors) {
	ensureString(value, name, { allowEmpty: false }, errors);
	if (typeof value !== 'string' || value.trim() === '') return;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			errors.push(`${name} must use http or https but currently is ${describeValue(value)}`);
		}
	} catch {
		errors.push(`${name} must be a valid URL but currently is ${describeValue(value)}`);
	}
}

function ensureVersion(value, name, errors) {
	ensureString(value, name, { allowEmpty: false }, errors);
	if (typeof value !== 'string' || value.trim() === '') return;
	if (!/^v?\d+$/i.test(value.trim())) {
		errors.push(`${name} must be digits or v123 but currently is ${describeValue(value)}`);
	}
}

function ensureLogPath(value, name, errors) {
	ensureString(value, name, { allowEmpty: true }, errors); // Empty disables logging
	if (typeof value !== 'string' || value.trim() === '') return;
	if (!path.isAbsolute(value)) {
		errors.push(`${name} must be an absolute path but currently is ${describeValue(value)}`);
		return;
	}
	const dir = path.dirname(value);
	if (!fs.existsSync(dir)) {
		errors.push(`${name} directory does not exist for ${describeValue(value)}`);
		return;
	}
	try {
		fs.accessSync(dir, fs.constants.W_OK);
	} catch {
		errors.push(`${name} directory is not writable for ${describeValue(value)}`);
	}
}

function ensureReadableFile(value, name, errors) {
	ensureString(value, name, { allowEmpty: false }, errors);
	if (typeof value !== 'string' || value.trim() === '') return;
	if (!path.isAbsolute(value)) {
		errors.push(`${name} must be an absolute path but currently is ${describeValue(value)}`);
		return;
	}
	if (!fs.existsSync(value)) {
		errors.push(`${name} does not exist for ${describeValue(value)}`);
		return;
	}
	try {
		fs.accessSync(value, fs.constants.R_OK);
	} catch {
		errors.push(`${name} is not readable for ${describeValue(value)}`);
	}
}

function validateConfig() {
	const errors = [];

	if (ensureObject(SERVER_CONFIG.http, 'server.http', errors)) {
		ensureBoolean(HTTP_CONFIG.enabled, 'server.http.enabled', errors);
		if (HTTP_ENABLED) {
			ensureString(HTTP_HOST, 'server.http.host', { allowEmpty: false }, errors);
			ensureNumber(HTTP_PORT, 'server.http.port', { min: 1, max: 65535 }, errors);
		}
	}

	if (ensureObject(SERVER_CONFIG.https, 'server.https', errors)) {
		ensureBoolean(HTTPS_CONFIG.enabled, 'server.https.enabled', errors);
		if (HTTPS_ENABLED) {
			ensureString(HTTPS_HOST, 'server.https.host', { allowEmpty: false }, errors);
			ensureNumber(HTTPS_PORT, 'server.https.port', { min: 1, max: 65535 }, errors);
			ensureReadableFile(HTTPS_CERT_FILE, 'server.https.certFile', errors);
			ensureReadableFile(HTTPS_KEY_FILE, 'server.https.keyFile', errors);
		}
	}

	if (!HTTP_ENABLED && !HTTPS_ENABLED) {
		errors.push('At least one of server.http.enabled or server.https.enabled must be true');
	}

	ensureAllowSubnets(ALLOW_SUBNETS, 'server.allowSubnets', errors);
	if (typeof TRUST_PROXY !== 'boolean') {
		errors.push(`server.trustProxy must be true or false but currently is ${describeValue(SERVER_CONFIG.trustProxy)}`);
	}
	ensureAllowSubnets(DENY_XFF_SUBNETS, 'server.denyXFFSubnets', errors, { allowEmpty: true });

	if (ensureObject(SERVER_CONFIG.openhab, 'server.openhab', errors)) {
		ensureUrl(OH_TARGET, 'server.openhab.target', errors);
		ensureString(OH_USER, 'server.openhab.user', { allowEmpty: true }, errors);
		ensureString(OH_PASS, 'server.openhab.pass', { allowEmpty: true }, errors);
	}

	if (ensureObject(SERVER_CONFIG.assets, 'server.assets', errors)) {
		ensureVersion(ASSET_VERSION, 'server.assets.assetVersion', errors);
		const appleRaw = safeText(APPLE_TOUCH_VERSION_RAW);
		if (!appleRaw) {
			errors.push(`server.assets.appleTouchIconVersion is required but currently is ${describeValue(APPLE_TOUCH_VERSION_RAW)}`);
		} else if (!/^(v\d+|\d+)$/i.test(appleRaw.trim())) {
			errors.push(`server.assets.appleTouchIconVersion must be digits or v123 but currently is ${describeValue(APPLE_TOUCH_VERSION_RAW)}`);
		}
		ensureVersion(ICON_VERSION, 'server.assets.iconVersion', errors);
	}

	ensureString(USER_AGENT, 'server.userAgent', { allowEmpty: false }, errors);
	ensureNumber(ICON_SIZE, 'server.iconSize', { min: 1 }, errors);
	ensureNumber(SERVER_CONFIG.iconCacheConcurrency, 'server.iconCacheConcurrency', { min: 1 }, errors);
	ensureNumber(DELTA_CACHE_LIMIT, 'server.deltaCacheLimit', { min: 1 }, errors);
	ensureString(PROXY_LOG_LEVEL, 'server.proxyMiddlewareLogLevel', { allowEmpty: false }, errors);
	ensureLogPath(LOG_FILE, 'server.logFile', errors);
	ensureLogPath(ACCESS_LOG, 'server.accessLog', errors);
	ensureString(ACCESS_LOG_LEVEL, 'server.accessLogLevel', { allowEmpty: false }, errors);
	if (ACCESS_LOG_LEVEL !== 'all' && ACCESS_LOG_LEVEL !== '400+') {
		errors.push(`server.accessLogLevel must be "all" or "400+" but currently is ${describeValue(ACCESS_LOG_LEVEL)}`);
	}
	ensureNumber(SLOW_QUERY_MS, 'server.slowQueryMs', { min: 0 }, errors);

	if (ensureObject(SERVER_CONFIG.auth, 'server.auth', errors)) {
		ensureString(AUTH_REALM, 'server.auth.realm', { allowEmpty: false }, errors);
		ensureString(AUTH_COOKIE_NAME, 'server.auth.cookieName', { allowEmpty: true }, errors);
		ensureNumber(AUTH_COOKIE_DAYS, 'server.auth.cookieDays', { min: 0 }, errors);
		ensureString(AUTH_COOKIE_KEY, 'server.auth.cookieKey', { allowEmpty: true }, errors);
		ensureString(SERVER_AUTH.authFailNotifyCmd, 'server.auth.authFailNotifyCmd', { allowEmpty: true }, errors);
		ensureNumber(AUTH_FAIL_NOTIFY_INTERVAL_MINS, 'server.auth.authFailNotifyIntervalMins', { min: 1 }, errors);
		if (AUTH_COOKIE_KEY) {
			if (!AUTH_COOKIE_NAME) {
				errors.push(`server.auth.cookieName is required when cookieKey is set but currently is ${describeValue(AUTH_COOKIE_NAME)}`);
			}
			if (!Number.isFinite(AUTH_COOKIE_DAYS) || AUTH_COOKIE_DAYS <= 0) {
				errors.push(`server.auth.cookieDays must be > 0 when cookieKey is set but currently is ${describeValue(AUTH_COOKIE_DAYS)}`);
			}
		}
	}

	if (ensureObject(SERVER_CONFIG.securityHeaders, 'server.securityHeaders', errors)) {
		ensureBoolean(SECURITY_HEADERS.enabled, 'server.securityHeaders.enabled', errors);
		if (ensureObject(SECURITY_HEADERS.hsts, 'server.securityHeaders.hsts', errors)) {
			ensureBoolean(SECURITY_HSTS.enabled, 'server.securityHeaders.hsts.enabled', errors);
			ensureNumber(SECURITY_HSTS.maxAge, 'server.securityHeaders.hsts.maxAge', { min: 0 }, errors);
			ensureBoolean(SECURITY_HSTS.includeSubDomains, 'server.securityHeaders.hsts.includeSubDomains', errors);
			ensureBoolean(SECURITY_HSTS.preload, 'server.securityHeaders.hsts.preload', errors);
		}
		if (ensureObject(SECURITY_HEADERS.csp, 'server.securityHeaders.csp', errors)) {
			ensureBoolean(SECURITY_CSP.enabled, 'server.securityHeaders.csp.enabled', errors);
			ensureBoolean(SECURITY_CSP.reportOnly, 'server.securityHeaders.csp.reportOnly', errors);
			ensureString(SECURITY_CSP.policy, 'server.securityHeaders.csp.policy', { allowEmpty: true }, errors);
			if (SECURITY_CSP.enabled && !safeText(SECURITY_CSP.policy).trim()) {
				errors.push(`server.securityHeaders.csp.policy must be set when CSP is enabled but currently is ${describeValue(SECURITY_CSP.policy)}`);
			}
		}
		ensureString(SECURITY_HEADERS.referrerPolicy, 'server.securityHeaders.referrerPolicy', { allowEmpty: true }, errors);
		const ref = safeText(SECURITY_HEADERS.referrerPolicy).trim();
		if (ref) {
			const allowed = new Set([
				'no-referrer',
				'no-referrer-when-downgrade',
				'origin',
				'origin-when-cross-origin',
				'same-origin',
				'strict-origin',
				'strict-origin-when-cross-origin',
				'unsafe-url',
			]);
			if (!allowed.has(ref)) {
				errors.push(`server.securityHeaders.referrerPolicy must be a supported value but currently is ${describeValue(SECURITY_HEADERS.referrerPolicy)}`);
			}
		}
	}

	if (ensureObject(SERVER_CONFIG.backgroundTasks, 'server.backgroundTasks', errors)) {
		ensureNumber(SITEMAP_REFRESH_MS, 'server.backgroundTasks.sitemapRefreshMs', { min: 1000 }, errors);
	}

	if (ensureObject(SERVER_CONFIG.videoPreview, 'server.videoPreview', errors)) {
		ensureNumber(VIDEO_PREVIEW_INTERVAL_MS, 'server.videoPreview.intervalMs', { min: 0 }, errors);
		ensureNumber(VIDEO_PREVIEW_PRUNE_HOURS, 'server.videoPreview.pruneAfterHours', { min: 1 }, errors);
	}

	if (ensureObject(SERVER_CONFIG.cmdapi, 'server.cmdapi', errors)) {
		ensureBoolean(CMDAPI_CONFIG.enabled, 'server.cmdapi.enabled', errors);
		ensureCidrList(CMDAPI_ALLOWED_SUBNETS, 'server.cmdapi.allowedSubnets', { allowEmpty: true }, errors);
		if (ensureArray(CMDAPI_ALLOWED_ITEMS, 'server.cmdapi.allowedItems', { allowEmpty: true }, errors)) {
			CMDAPI_ALLOWED_ITEMS.forEach((entry, index) => {
				if (typeof entry !== 'string' || (!entry.trim() && entry !== '*')) {
					errors.push(`server.cmdapi.allowedItems[${index}] must be a non-empty string or '*'`);
				}
			});
		}
	}

	if (ensureArray(SERVER_CONFIG.proxyAllowlist, 'server.proxyAllowlist', { allowEmpty: false }, errors)) {
		SERVER_CONFIG.proxyAllowlist.forEach((entry, index) => {
			if (!parseProxyAllowEntry(entry)) {
				errors.push(`server.proxyAllowlist[${index}] is not a valid host or host:port`);
			}
		});
	}

	if (ensureObject(CLIENT_CONFIG, 'client', errors)) {
		ensureNumber(CLIENT_CONFIG.pageFadeOutMs, 'client.pageFadeOutMs', { min: 0 }, errors);
		ensureNumber(CLIENT_CONFIG.pageFadeInMs, 'client.pageFadeInMs', { min: 0 }, errors);
		ensureNumber(CLIENT_CONFIG.loadingDelayMs, 'client.loadingDelayMs', { min: 0 }, errors);
		ensureNumber(CLIENT_CONFIG.minImageRefreshMs, 'client.minImageRefreshMs', { min: 0 }, errors);
		ensureNumber(CLIENT_CONFIG.imageLoadTimeoutMs, 'client.imageLoadTimeoutMs', { min: 0 }, errors);

		if (ensureObject(CLIENT_CONFIG.pollIntervalsMs, 'client.pollIntervalsMs', errors)) {
			ensureNumber(CLIENT_CONFIG.pollIntervalsMs?.default?.active, 'client.pollIntervalsMs.default.active', { min: 1 }, errors);
			ensureNumber(CLIENT_CONFIG.pollIntervalsMs?.default?.idle, 'client.pollIntervalsMs.default.idle', { min: 1 }, errors);
			ensureNumber(CLIENT_CONFIG.pollIntervalsMs?.slim?.active, 'client.pollIntervalsMs.slim.active', { min: 1 }, errors);
			ensureNumber(CLIENT_CONFIG.pollIntervalsMs?.slim?.idle, 'client.pollIntervalsMs.slim.idle', { min: 1 }, errors);
		}

		if (ensureObject(CLIENT_CONFIG.searchDebounceMs, 'client.searchDebounceMs', errors)) {
			ensureNumber(CLIENT_CONFIG.searchDebounceMs?.default, 'client.searchDebounceMs.default', { min: 0 }, errors);
			ensureNumber(CLIENT_CONFIG.searchDebounceMs?.slim, 'client.searchDebounceMs.slim', { min: 0 }, errors);
		}

		if (ensureObject(CLIENT_CONFIG.searchStateMinIntervalMs, 'client.searchStateMinIntervalMs', errors)) {
			ensureNumber(CLIENT_CONFIG.searchStateMinIntervalMs?.default, 'client.searchStateMinIntervalMs.default', { min: 0 }, errors);
			ensureNumber(CLIENT_CONFIG.searchStateMinIntervalMs?.slim, 'client.searchStateMinIntervalMs.slim', { min: 0 }, errors);
		}

		if (ensureObject(CLIENT_CONFIG.searchStateConcurrency, 'client.searchStateConcurrency', errors)) {
			ensureNumber(CLIENT_CONFIG.searchStateConcurrency?.default, 'client.searchStateConcurrency.default', { min: 1 }, errors);
			ensureNumber(CLIENT_CONFIG.searchStateConcurrency?.slim, 'client.searchStateConcurrency.slim', { min: 1 }, errors);
		}

		ensureNumber(CLIENT_CONFIG.sliderDebounceMs, 'client.sliderDebounceMs', { min: 0 }, errors);
		ensureNumber(CLIENT_CONFIG.idleAfterMs, 'client.idleAfterMs', { min: 0 }, errors);
		ensureNumber(CLIENT_CONFIG.activityThrottleMs, 'client.activityThrottleMs', { min: 0 }, errors);

		if (ensureArray(CLIENT_CONFIG.hideTitleItems, 'client.hideTitleItems', { allowEmpty: true }, errors)) {
			CLIENT_CONFIG.hideTitleItems.forEach((entry, index) => {
				if (typeof entry !== 'string' || entry.trim() === '') {
					errors.push(`client.hideTitleItems[${index}] must be a string`);
				}
			});
		}
	}

	return errors;
}

function normalizeRemoteIp(value) {
	const raw = safeText(value).trim();
	if (!raw) return '';
	// Convert IPv4-mapped IPv6 (::ffff:192.168.1.1) to plain IPv4
	if (raw.startsWith('::ffff:')) return raw.slice(7);
	// Preserve IPv6 addresses (subnet checks will fail but lockouts will be per-IP)
	return raw;
}

// Returns the direct socket connection IP (for allowSubnets checks)
function getSocketIp(req) {
	return normalizeRemoteIp(req?.socket?.remoteAddress || '');
}

// Returns X-Forwarded-For client IP when trustProxy enabled (for logging, auth tracking)
function getRemoteIp(req) {
	if (liveConfig.trustProxy) {
		const xff = req?.headers?.['x-forwarded-for'];
		if (xff) {
			// X-Forwarded-For: "client, proxy1, proxy2" - take first IP
			const clientIp = safeText(xff).split(',')[0].trim();
			if (clientIp) return normalizeRemoteIp(clientIp);
		}
	}
	return getSocketIp(req);
}

function ipToLong(ip) {
	if (!isValidIpv4(ip)) return null;
	return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0);
}

function ipInSubnet(ip, cidr) {
	const parts = safeText(cidr).split('/');
	if (parts.length !== 2) return false;
	const subnet = parts[0];
	const mask = Number(parts[1]);
	if (!Number.isInteger(mask) || mask < 0 || mask > 32) return false;
	const ipLong = ipToLong(ip);
	const subnetLong = ipToLong(subnet);
	if (ipLong === null || subnetLong === null) return false;
	const maskLong = mask === 0 ? 0 : (0xffffffff << (32 - mask)) >>> 0;
	return (ipLong & maskLong) === (subnetLong & maskLong);
}

function ipInAnySubnet(ip, subnets) {
	if (!Array.isArray(subnets) || !subnets.length) return false;
	for (const cidr of subnets) {
		if (isAllowAllSubnet(cidr)) return true;
		if (ipInSubnet(ip, cidr)) return true;
	}
	return false;
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

function loadAuthUsers() {
	// Return users from database: { users: {username: password}, disabledUsers: Set }
	const allUsers = sessions.getAllUsers();
	const users = {};
	const disabledUsers = new Set();
	for (const u of allUsers) {
		const fullUser = sessions.getUser(u.username);
		if (fullUser) {
			users[u.username] = fullUser.password;
			if (fullUser.disabled) {
				disabledUsers.add(u.username);
			}
		}
	}
	return { users, disabledUsers };
}

function base64UrlEncode(value) {
	return Buffer.from(String(value), 'utf8')
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
}

function base64UrlDecode(value) {
	const raw = safeText(value).replace(/-/g, '+').replace(/_/g, '/');
	if (!raw) return null;
	const pad = raw.length % 4;
	const padded = pad ? raw + '='.repeat(4 - pad) : raw;
	try {
		return Buffer.from(padded, 'base64').toString('utf8');
	} catch {
		return null;
	}
}

function getCookieValue(req, name) {
	const header = safeText(req?.headers?.cookie || '').trim();
	if (!header || !name) return '';
	for (const part of header.split(';')) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		if (key !== name) continue;
		return trimmed.slice(eq + 1).trim();
	}
	return '';
}

function isSecureRequest(req) {
	if (req?.secure) return true;
	return false;
}

function buildHstsHeader() {
	const hsts = liveConfig.securityHsts;
	const maxAge = Number.isFinite(Number(hsts.maxAge))
		? Math.max(0, Math.floor(Number(hsts.maxAge)))
		: 0;
	const parts = [`max-age=${maxAge}`];
	if (hsts.includeSubDomains) parts.push('includeSubDomains');
	if (hsts.preload) parts.push('preload');
	return parts.join('; ');
}

function applySecurityHeaders(req, res) {
	if (!liveConfig.securityHeadersEnabled) return;
	if (liveConfig.securityHsts.enabled && isSecureRequest(req)) {
		res.setHeader('Strict-Transport-Security', buildHstsHeader());
	}
	if (liveConfig.securityCsp.enabled) {
		const policy = safeText(liveConfig.securityCsp.policy).trim();
		if (policy) {
			const headerName = liveConfig.securityCsp.reportOnly
				? 'Content-Security-Policy-Report-Only'
				: 'Content-Security-Policy';
			res.setHeader(headerName, policy);
		}
	}
	if (liveConfig.securityReferrerPolicy) {
		res.setHeader('Referrer-Policy', liveConfig.securityReferrerPolicy);
	}
}

function appendSetCookie(res, value) {
	if (!value) return;
	const existing = res.getHeader('Set-Cookie');
	if (!existing) {
		res.setHeader('Set-Cookie', value);
		return;
	}
	if (Array.isArray(existing)) {
		res.setHeader('Set-Cookie', existing.concat(value));
		return;
	}
	res.setHeader('Set-Cookie', [existing, value]);
}

function buildAuthCookieValue(user, sessionId, pass, key, expiry) {
	const userEncoded = base64UrlEncode(user);
	const payload = `${userEncoded}|${sessionId}|${expiry}`;
	const sig = crypto.createHmac('sha256', key).update(`${payload}|${pass}`).digest('hex');
	return base64UrlEncode(`${payload}|${sig}`);
}

function getAuthCookieUser(req, users, key) {
	if (!key) return null;
	const raw = getCookieValue(req, liveConfig.authCookieName);
	if (!raw) return null;
	const decoded = base64UrlDecode(raw);
	if (!decoded) return null;
	const parts = decoded.split('|');

	// Handle both legacy (3-part) and new (4-part) formats
	if (parts.length === 3) {
		// Legacy format: userEncoded|expiry|sig
		const [userEncoded, expiryRaw, sig] = parts;
		if (!/^\d+$/.test(expiryRaw)) return null;
		const expiry = Number(expiryRaw);
		if (!Number.isFinite(expiry) || expiry <= Math.floor(Date.now() / 1000)) return null;
		const user = base64UrlDecode(userEncoded);
		if (!user || !Object.prototype.hasOwnProperty.call(users, user)) return null;
		const expected = crypto.createHmac('sha256', key).update(`${userEncoded}|${expiryRaw}|${users[user]}`).digest('hex');
		const sigBuf = Buffer.from(sig, 'hex');
		const expectedBuf = Buffer.from(expected, 'hex');
		if (sigBuf.length !== expectedBuf.length) return null;
		if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
		return { user, sessionId: null, isLegacy: true };
	} else if (parts.length === 4) {
		// New format: userEncoded|sessionId|expiry|sig
		const [userEncoded, sessionId, expiryRaw, sig] = parts;
		if (!/^\d+$/.test(expiryRaw)) return null;
		const expiry = Number(expiryRaw);
		if (!Number.isFinite(expiry) || expiry <= Math.floor(Date.now() / 1000)) return null;
		const user = base64UrlDecode(userEncoded);
		if (!user || !Object.prototype.hasOwnProperty.call(users, user)) return null;
		const expected = crypto.createHmac('sha256', key).update(`${userEncoded}|${sessionId}|${expiryRaw}|${users[user]}`).digest('hex');
		const sigBuf = Buffer.from(sig, 'hex');
		const expectedBuf = Buffer.from(expected, 'hex');
		if (sigBuf.length !== expectedBuf.length) return null;
		if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
		return { user, sessionId, isLegacy: false };
	}

	return null;
}

function setAuthCookie(res, user, sessionId, pass) {
	if (!liveConfig.authCookieKey || !liveConfig.authCookieName || liveConfig.authCookieDays <= 0) return;
	const expiry = Math.floor(Date.now() / 1000) + Math.round(liveConfig.authCookieDays * 86400);
	const value = buildAuthCookieValue(user, sessionId, pass, liveConfig.authCookieKey, expiry);
	const expires = new Date(expiry * 1000).toUTCString();
	const maxAge = Math.round(liveConfig.authCookieDays * 86400);
	const secure = isSecureRequest(res.req);
	const parts = [
		`${liveConfig.authCookieName}=${value}`,
		'Path=/',
		`Expires=${expires}`,
		`Max-Age=${maxAge}`,
		'HttpOnly',
		'SameSite=Lax',
	];
	if (secure) parts.push('Secure');
	appendSetCookie(res, parts.join('; '));
}

function clearAuthCookie(res) {
	if (!liveConfig.authCookieName) return;
	const secure = isSecureRequest(res.req);
	const parts = [
		`${liveConfig.authCookieName}=`,
		'Path=/',
		'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
		'Max-Age=0',
		'HttpOnly',
		'SameSite=Lax',
	];
	if (secure) parts.push('Secure');
	appendSetCookie(res, parts.join('; '));
}

function getSessionCookie(req) {
	return getCookieValue(req, SESSION_COOKIE_NAME);
}

function clearSessionCookie(res) {
	const secure = isSecureRequest(res.req);
	const parts = [
		`${SESSION_COOKIE_NAME}=`,
		'Path=/',
		'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
		'Max-Age=0',
		'HttpOnly',
		'SameSite=Lax',
	];
	if (secure) parts.push('Secure');
	appendSetCookie(res, parts.join('; '));
}

// CSRF protection for HTML auth mode
const CSRF_COOKIE_NAME = 'ohCSRF';

function generateCsrfToken() {
	return crypto.randomBytes(32).toString('hex');
}

function setCsrfCookie(res, token) {
	const secure = isSecureRequest(res.req);
	const parts = [
		`${CSRF_COOKIE_NAME}=${token}`,
		'Path=/',
		'SameSite=Strict',
	];
	// Not HttpOnly - JS needs to read it for the header
	if (secure) parts.push('Secure');
	appendSetCookie(res, parts.join('; '));
}

function getCsrfTokenFromRequest(req) {
	const headerToken = safeText(req?.headers?.['x-csrf-token'] || '').trim();
	if (headerToken) return headerToken;
	const bodyToken = safeText(req?.body?.csrfToken || '').trim();
	if (bodyToken) return bodyToken;
	return safeText(req?.query?.csrfToken || '').trim();
}

function validateCsrfToken(req) {
	const cookieToken = getCookieValue(req, CSRF_COOKIE_NAME);
	const reqToken = getCsrfTokenFromRequest(req);
	if (!cookieToken || !reqToken) return false;
	// Use timing-safe comparison
	const cookieBuf = Buffer.from(cookieToken);
	const headerBuf = Buffer.from(reqToken);
	if (cookieBuf.length !== headerBuf.length) return false;
	return crypto.timingSafeEqual(cookieBuf, headerBuf);
}

function normalizeNotifyIp(value) {
	const raw = safeText(value).trim();
	if (!raw) return 'unknown';
	const cleaned = raw.replace(/[^0-9a-fA-F:.]/g, '');
	return cleaned || 'unknown';
}

function maybeNotifyAuthFailure(ip) {
	if (!liveConfig.authFailNotifyCmd) return;
	const now = Date.now();
	const intervalMs = (liveConfig.authFailNotifyIntervalMins || 15) * 60 * 1000;
	const lastNotify = Number(sessions.getServerSetting('lastAuthFailNotifyAt')) || 0;
	if (lastNotify && now - lastNotify < intervalMs) return;
	const safeIp = normalizeNotifyIp(ip);
	const command = liveConfig.authFailNotifyCmd.replace(/\{IP\}/g, safeIp).trim();
	if (!command) return;
	sessions.setServerSetting('lastAuthFailNotifyAt', String(now));
	try {
		const child = execFile(BIN_SHELL, ['-c', command], { detached: true, stdio: 'ignore' });
		child.unref();
		logMessage(`Auth failure notify command executed for ${safeIp}`);
	} catch (err) {
		logMessage(`Failed to run auth failure notify command: ${err.message || err}`);
	}
}

function sendAuthRequired(res) {
	res.setHeader('X-OhProxy-Authenticated', 'false');
	res.setHeader('WWW-Authenticate', `Basic realm="${liveConfig.authRealm}"`);
	res.status(401).type('text/plain').send('Unauthorized');
}

function getRequestPath(req) {
	const direct = safeText(req?.path || '').trim();
	if (direct) return direct;
	const raw = safeText(req?.originalUrl || '').trim();
	if (!raw) return '';
	const q = raw.indexOf('?');
	return q === -1 ? raw : raw.slice(0, q);
}

function isAuthExemptPath(req) {
	const pathname = getRequestPath(req);
	if (!pathname) return false;
	if (pathname === '/manifest.webmanifest') return true;
	return false;
}

function hasMatchingReferrer(req) {
	const ref = safeText(req?.headers?.referer || req?.headers?.referrer || '').trim();
	const host = safeText(req?.headers?.host || '').trim().toLowerCase();
	if (!ref || !host) return false;
	let refUrl;
	try {
		refUrl = new URL(ref);
	} catch {
		return false;
	}
	return safeText(refUrl.host).trim().toLowerCase() === host;
}

function getAuthInfo(req) {
	const authState = safeText(req?.ohProxyAuth || '').trim().toLowerCase();
	const authUser = safeText(req?.ohProxyUser || '').trim();
	if (authState === 'authenticated' && authUser) {
		return { auth: 'authenticated', user: authUser };
	}
	return { auth: 'unauthenticated', user: '' };
}

function inlineJson(value) {
	const json = JSON.stringify(value);
	return json ? json.replace(/</g, '\\u003c') : 'null';
}

const configErrors = validateConfig();
if (configErrors.length) {
	configErrors.forEach((msg) => logMessage(`Config error: ${msg}`));
	process.exit(1);
}

logMessage('[Startup] Starting ohProxy instance...');

const LOCAL_CONFIG_PATH = path.join(__dirname, 'config.local.js');
let lastConfigMtime = 0;
let configRestartScheduled = false;
let configRestartTriggered = false;

// Live config - values that can be hot-reloaded without restart
const liveConfig = {
	allowSubnets: ALLOW_SUBNETS,
	trustProxy: TRUST_PROXY,
	denyXFFSubnets: DENY_XFF_SUBNETS,
	proxyAllowlist: PROXY_ALLOWLIST,
	webviewNoProxy: WEBVIEW_NO_PROXY,
	ohTarget: OH_TARGET,
	ohUser: OH_USER,
	ohPass: OH_PASS,
	ohApiToken: OH_API_TOKEN,
	iconVersion: ICON_VERSION,
	userAgent: USER_AGENT,
	assetVersion: ASSET_VERSION,
	appleTouchVersion: APPLE_TOUCH_VERSION,
	iconSize: ICON_SIZE,
	iconCacheConcurrency: ICON_CACHE_CONCURRENCY,
	deltaCacheLimit: DELTA_CACHE_LIMIT,
	groupItems: GROUP_ITEMS,
	slowQueryMs: SLOW_QUERY_MS,
	authRealm: AUTH_REALM,
	authCookieName: AUTH_COOKIE_NAME,
	authCookieDays: AUTH_COOKIE_DAYS,
	authCookieKey: AUTH_COOKIE_KEY,
	authFailNotifyCmd: AUTH_FAIL_NOTIFY_CMD,
	authFailNotifyIntervalMins: AUTH_FAIL_NOTIFY_INTERVAL_MINS,
	authMode: AUTH_MODE,
	securityHeadersEnabled: SECURITY_HEADERS_ENABLED,
	securityHsts: SECURITY_HSTS,
	securityCsp: SECURITY_CSP,
	securityReferrerPolicy: SECURITY_REFERRER_POLICY,
	sitemapRefreshMs: SITEMAP_REFRESH_MS,
	clientConfig: CLIENT_CONFIG,
	wsMode: WS_MODE,
	wsPollingIntervalMs: WS_POLLING_INTERVAL_MS,
	wsPollingIntervalBgMs: WS_POLLING_INTERVAL_BG_MS,
	wsAtmosphereNoUpdateWarnMs: WS_ATMOSPHERE_NO_UPDATE_WARN_MS,
	backendRecoveryDelayMs: BACKEND_RECOVERY_DELAY_MS,
	rrdPath: RRD_PATH,
	cmdapiEnabled: CMDAPI_ENABLED,
	cmdapiAllowedSubnets: CMDAPI_ALLOWED_SUBNETS,
	cmdapiAllowedItems: CMDAPI_ALLOWED_ITEMS,
};

// Widget glow rules - migrate from JSON to SQLite on first run
const GLOW_RULES_LOCAL_PATH = path.join(__dirname, 'widgetGlowRules.local.json');
const GLOW_RULES_MIGRATED_PATH = GLOW_RULES_LOCAL_PATH + '.migrated';

function migrateGlowRulesToDb() {
	// Skip if already migrated or no file exists
	if (fs.existsSync(GLOW_RULES_MIGRATED_PATH) || !fs.existsSync(GLOW_RULES_LOCAL_PATH)) return;

	try {
		const raw = fs.readFileSync(GLOW_RULES_LOCAL_PATH, 'utf8');
		const rules = JSON.parse(raw);
		if (!Array.isArray(rules)) return;

		let count = 0;
		for (const entry of rules) {
			if (entry && entry.widgetId && Array.isArray(entry.rules) && entry.rules.length > 0) {
				sessions.setGlowRules(entry.widgetId, entry.rules);
				count++;
			}
		}
		fs.renameSync(GLOW_RULES_LOCAL_PATH, GLOW_RULES_MIGRATED_PATH);
		logMessage(`Migrated ${count} widget glow rules to database`);
	} catch (err) {
		logMessage(`Failed to migrate glow rules: ${err.message || err}`, 'error');
	}
}

// Run migration on startup
migrateGlowRulesToDb();

// Values that require restart if changed
const restartRequiredKeys = [
	'http.enabled', 'http.host', 'http.port',
	'https.enabled', 'https.host', 'https.port', 'https.certFile', 'https.keyFile', 'https.http2',
	'logFile', 'accessLog',
];

function getNestedValue(obj, path) {
	return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

function readConfigLocalMtime() {
	try {
		const stat = fs.statSync(LOCAL_CONFIG_PATH);
		const mtime = stat.mtimeMs || stat.mtime.getTime();
		return Number.isFinite(mtime) ? mtime : 0;
	} catch (err) {
		if (err && err.code === 'ENOENT') return 0;
		logMessage(`Failed to stat ${LOCAL_CONFIG_PATH}: ${err.message || err}`);
		return 0;
	}
}

function reloadLiveConfig() {
	// Re-read config file
	let newConfig;
	try {
		delete require.cache[require.resolve('./config.local.js')];
		delete require.cache[require.resolve('./config.js')];
		newConfig = loadUserConfig();
	} catch (err) {
		logMessage(`Hot reload failed to load config: ${err.message || err}`);
		return false;
	}

	const newServer = newConfig.server || {};
	const oldServer = SERVER_CONFIG;

	// Check if restart is required
	for (const key of restartRequiredKeys) {
		const oldVal = getNestedValue(oldServer, key);
		const newVal = getNestedValue(newServer, key);
		if (oldVal !== newVal) {
			logMessage(`Config change requires restart: server.${key} changed`);
			return true; // Restart required
		}
	}

	// Hot reload - update live config values
	const newAuth = newServer.auth || {};
	const newSecurityHeaders = newServer.securityHeaders || {};
	const newAssets = newServer.assets || {};
	const newTasks = newServer.backgroundTasks || {};
	const newWsConfig = newServer.websocket || {};

	liveConfig.allowSubnets = newServer.allowSubnets;
	liveConfig.trustProxy = newServer.trustProxy === true;
	liveConfig.denyXFFSubnets = newServer.denyXFFSubnets;
	liveConfig.proxyAllowlist = normalizeProxyAllowlist(newServer.proxyAllowlist);
	liveConfig.webviewNoProxy = normalizeProxyAllowlist(newServer.webviewNoProxy);
	liveConfig.ohTarget = safeText(newServer.openhab?.target);
	liveConfig.ohUser = safeText(newServer.openhab?.user || '');
	liveConfig.ohPass = safeText(newServer.openhab?.pass || '');
	liveConfig.ohApiToken = safeText(newServer.openhab?.apiToken || '');
	const oldIconVersion = liveConfig.iconVersion;
	const oldIconSize = liveConfig.iconSize;
	const oldAssetVersion = liveConfig.assetVersion;
	liveConfig.iconVersion = safeText(newAssets.iconVersion);
	liveConfig.userAgent = safeText(newServer.userAgent);
	liveConfig.assetVersion = safeText(newAssets.assetVersion);
	if (liveConfig.assetVersion && liveConfig.assetVersion !== oldAssetVersion) {
		logMessage(`[Config] Asset version changed: ${oldAssetVersion} -> ${liveConfig.assetVersion}`);
		wsBroadcast('assetVersionChanged', { version: liveConfig.assetVersion });
	}
	const appleTouchRaw = safeText(newAssets.appleTouchIconVersion);
	liveConfig.appleTouchVersion = appleTouchRaw
		? (appleTouchRaw.startsWith('v') ? appleTouchRaw : `v${appleTouchRaw}`)
		: '';
	liveConfig.iconSize = configNumber(newServer.iconSize);
	liveConfig.iconCacheConcurrency = Math.max(1, Math.floor(configNumber(newServer.iconCacheConcurrency, 5)));
	liveConfig.deltaCacheLimit = configNumber(newServer.deltaCacheLimit);
	liveConfig.groupItems = Array.isArray(newServer.groupItems) ? newServer.groupItems.map(safeText).filter(Boolean) : [];
	liveConfig.slowQueryMs = configNumber(newServer.slowQueryMs, 0);
	liveConfig.authRealm = safeText(newAuth.realm || 'openHAB Proxy');
	liveConfig.authCookieName = safeText(newAuth.cookieName || 'AuthStore');
	liveConfig.authCookieDays = configNumber(newAuth.cookieDays, 0);
	liveConfig.authCookieKey = safeText(newAuth.cookieKey || '');
	liveConfig.authFailNotifyCmd = safeText(newAuth.authFailNotifyCmd || '');
	liveConfig.authFailNotifyIntervalMins = configNumber(newAuth.authFailNotifyIntervalMins, 15);
	liveConfig.authMode = safeText(newAuth.mode || 'basic');
	liveConfig.securityHeadersEnabled = newSecurityHeaders.enabled !== false;
	liveConfig.securityHsts = newSecurityHeaders.hsts || {};
	liveConfig.securityCsp = newSecurityHeaders.csp || {};
	liveConfig.securityReferrerPolicy = safeText(newSecurityHeaders.referrerPolicy || '');
	const prevSitemapRefreshMs = liveConfig.sitemapRefreshMs;
	liveConfig.sitemapRefreshMs = configNumber(newTasks.sitemapRefreshMs);
	liveConfig.clientConfig = newConfig.client || {};

	// WebSocket config - handle mode changes
	const oldWsMode = liveConfig.wsMode;
	liveConfig.wsMode = ['atmosphere', 'sse'].includes(newWsConfig.mode) ? newWsConfig.mode : 'polling';
	liveConfig.wsPollingIntervalMs = configNumber(newWsConfig.pollingIntervalMs) || 500;
	liveConfig.wsPollingIntervalBgMs = configNumber(newWsConfig.pollingIntervalBgMs) || 2000;
	liveConfig.wsAtmosphereNoUpdateWarnMs = Math.max(
		0,
		configNumber(newWsConfig.atmosphereNoUpdateWarnMs, WS_ATMOSPHERE_NO_UPDATE_WARN_MS)
	);
	liveConfig.backendRecoveryDelayMs = Math.max(
		0,
		configNumber(newWsConfig.backendRecoveryDelayMs, 0)
	);
	const newPaths = newServer.paths || {};
	liveConfig.rrdPath = safeText(newPaths.rrd) || '';

	// CMD API config
	liveConfig.cmdapiEnabled = newServer.cmdapi?.enabled === true;
	liveConfig.cmdapiAllowedSubnets = Array.isArray(newServer.cmdapi?.allowedSubnets)
		? newServer.cmdapi.allowedSubnets
		: [];
	liveConfig.cmdapiAllowedItems = Array.isArray(newServer.cmdapi?.allowedItems)
		? newServer.cmdapi.allowedItems
		: [];

	const iconVersionChanged = liveConfig.iconVersion !== oldIconVersion;
	const iconSizeChanged = liveConfig.iconSize !== oldIconSize;
	if (iconVersionChanged || iconSizeChanged) {
		purgeOldIconCache();
		if (iconSizeChanged && !iconVersionChanged) {
			try {
				const currentDir = getIconCacheDir();
				if (fs.rmSync) fs.rmSync(currentDir, { recursive: true, force: true });
				else fs.rmdirSync(currentDir, { recursive: true });
			} catch (err) {
				logMessage(`Failed to reset icon cache dir: ${err.message || err}`);
			}
		}
		ensureDir(getIconCacheDir());
	}

	if (liveConfig.sitemapRefreshMs !== prevSitemapRefreshMs) {
		updateBackgroundTaskInterval('sitemap-cache', liveConfig.sitemapRefreshMs);
	}

	// If mode changed and clients are connected, switch modes
	if (oldWsMode !== liveConfig.wsMode && wss.clients.size > 0) {
		logMessage(`[WS] Mode changed from ${oldWsMode} to ${liveConfig.wsMode}, switching...`);
		if (oldWsMode === 'atmosphere') {
			stopAllAtmosphereConnections();
		} else if (oldWsMode === 'sse') {
			stopSSE();
		} else {
			stopPolling();
		}
		startWsPushIfNeeded();
	}

	syncAtmosphereNoUpdateMonitor();
	logMessage('[Config] Hot-reloaded successfully');
	return false; // No restart required
}

lastConfigMtime = readConfigLocalMtime();

function scheduleConfigRestart() {
	if (configRestartScheduled) return;
	configRestartScheduled = true;
	logMessage('[Config] Detected config.local.js change, scheduling restart.');
}

function handleConfigChange() {
	const needsRestart = reloadLiveConfig();
	if (needsRestart) {
		scheduleConfigRestart();
		return true;
	}
	return false;
}

function maybeTriggerRestart() {
	if (configRestartTriggered) return;
	configRestartTriggered = true;
	setTimeout(() => {
		process.exit(0);
	}, 50);
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const APP_BUNDLE_PATH = path.join(PUBLIC_DIR, 'app.js');
const STYLE_BUNDLE_PATH = path.join(PUBLIC_DIR, 'styles.css');
const TAILWIND_BUNDLE_PATH = path.join(PUBLIC_DIR, 'tailwind.css');
const CHART_JS_PATH = path.join(PUBLIC_DIR, 'chart.js');
const CHART_CSS_PATH = path.join(PUBLIC_DIR, 'chart.css');
const LOGIN_JS_PATH = path.join(PUBLIC_DIR, 'login.js');
const LOGIN_HTML_PATH = path.join(PUBLIC_DIR, 'login.html');
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, 'index.html');
const SERVICE_WORKER_PATH = path.join(PUBLIC_DIR, 'sw.js');
const ICON_CACHE_ROOT = path.join(__dirname, 'cache', 'icon');
function getIconCacheDir() {
	return path.join(ICON_CACHE_ROOT, liveConfig.iconVersion);
}
const iconInflight = new Map();
const deltaCache = new Map();
let indexTemplate = null;
let serviceWorkerTemplate = null;
let loginTemplate = null;
const backgroundTasks = [];
const TASK_LAST_RUN_KEY = 'task_last_run_times';

function loadTaskLastRunTimes() {
	try {
		const json = sessions.getServerSetting(TASK_LAST_RUN_KEY);
		return json ? JSON.parse(json) : {};
	} catch {
		return {};
	}
}

function saveTaskLastRunTime(taskName, timestamp) {
	try {
		const times = loadTaskLastRunTimes();
		times[taskName] = timestamp;
		sessions.setServerSetting(TASK_LAST_RUN_KEY, JSON.stringify(times));
	} catch {
		// Ignore save errors
	}
}

function registerBackgroundTask(name, intervalMs, run) {
	const task = {
		name,
		intervalMs: configNumber(intervalMs, 0),
		run,
		timer: null,
		running: false,
		lastRun: 0,
	};
	backgroundTasks.push(task);
	return task;
}

function updateBackgroundTaskInterval(name, intervalMs) {
	if (!name) return false;
	const task = backgroundTasks.find((entry) => entry.name === name);
	if (!task) return false;
	const prevInterval = task.intervalMs;
	task.intervalMs = configNumber(intervalMs, 0);
	if (task.timer) {
		clearTimeout(task.timer);
		task.timer = null;
	}
	if (task.intervalMs > 0) {
		if (prevInterval <= 0) {
			runBackgroundTask(task);
		} else if (!task.running) {
			scheduleBackgroundTask(task);
		}
	}
	return true;
}

function scheduleBackgroundTask(task, delayMs) {
	if (!task || !task.intervalMs || task.intervalMs <= 0) return;
	if (task.timer) clearTimeout(task.timer);
	const delay = typeof delayMs === 'number' ? delayMs : task.intervalMs;
	task.timer = setTimeout(() => runBackgroundTask(task), delay);
}

const TASK_LOG_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

async function runBackgroundTask(task) {
	if (!task || task.running) return;
	task.running = true;
	if (task.intervalMs >= TASK_LOG_THRESHOLD_MS) {
		logMessage(`[Tasks] ${task.name}: running`);
	}
	try {
		await task.run();
		task.lastRun = Date.now();
		saveTaskLastRunTime(task.name, task.lastRun);
	} catch (err) {
		logMessage(`[Tasks] ${task.name} failed: ${err.message || err}`);
	} finally {
		task.running = false;
		scheduleBackgroundTask(task);
	}
}

function formatInterval(ms) {
	if (ms <= 0) return 'disabled';
	if (ms < 1000) return `${ms}ms`;
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hrs = Math.floor(min / 60);
	const remMin = min % 60;
	if (hrs < 24) return remMin > 0 ? `${hrs}h ${remMin}m` : `${hrs}h`;
	const days = Math.floor(hrs / 24);
	const remHrs = hrs % 24;
	return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}

function startBackgroundTasks() {
	const enabled = backgroundTasks.filter((t) => t.intervalMs > 0);
	const disabled = backgroundTasks.filter((t) => t.intervalMs <= 0);
	if (enabled.length > 0) {
		const summary = enabled.map((t) => `${t.name} (${formatInterval(t.intervalMs)})`).join(', ');
		logMessage(`[Startup] Scheduled tasks: ${summary}`);
	}
	if (disabled.length > 0) {
		const summary = disabled.map((t) => t.name).join(', ');
		logMessage(`[Startup] Disabled tasks: ${summary}`);
	}

	// Load persisted last run times
	const persistedTimes = loadTaskLastRunTimes();
	const now = Date.now();

	for (const task of enabled) {
		const lastRun = persistedTimes[task.name] || 0;
		task.lastRun = lastRun;
		const elapsed = now - lastRun;
		const remaining = task.intervalMs - elapsed;

		if (remaining > 0) {
			// Task ran recently, schedule for remaining time
			logMessage(`[Tasks] ${task.name}: next run in ${formatInterval(remaining)}`);
			scheduleBackgroundTask(task, remaining);
		} else {
			// Task is due, run immediately
			runBackgroundTask(task);
		}
	}
}

const backgroundState = {
	sitemap: {
		name: '',
		title: '',
		homepage: '',
		updatedAt: 0,
		ok: false,
	},
};

const DEFAULT_PAGE_TITLE = 'openHAB';

// --- Backend Connection Status ---
const backendStatus = {
	ok: true,
	lastError: '',
	lastChange: 0,
};

// --- WebSocket Push Infrastructure ---
const wss = new WebSocket.Server({
	noServer: true,
	perMessageDeflate: false,
	skipUTF8Validation: false,
	clientTracking: true,
});

// Strip any compression extension from response headers (safety measure)
wss.on('headers', (headers) => {
	for (let i = headers.length - 1; i >= 0; i--) {
		if (headers[i].toLowerCase().startsWith('sec-websocket-extensions')) {
			headers.splice(i, 1);
		}
	}
});

function handleWsConnection(ws, req) {
	const clientIp = getRemoteIp(req) || 'unknown';
	logMessage(`[WS] Client connected from ${clientIp}, total: ${wss.clients.size}`);

	ws.isAlive = true;
	ws.clientState = { focused: true };  // Assume focused on connect; client will send actual state
	ws.ohProxyUser = req.ohProxyUser || null;  // Track authenticated username

	// Send welcome message and current backend status
	try {
		ws.send(JSON.stringify({ event: 'connected', data: { time: Date.now() } }));
		ws.send(JSON.stringify({
			event: 'backendStatus',
			data: { ok: backendStatus.ok, error: backendStatus.lastError },
		}));
	} catch (e) {
		logMessage(`[WS] Send error for ${clientIp}: ${e.message}`);
	}

	startWsPushIfNeeded();

	ws.on('pong', () => { ws.isAlive = true; });

	ws.on('message', async (data) => {
		try {
			const msg = JSON.parse(data);
			if (msg.event === 'clientState' && msg.data) {
				if (typeof msg.data.focused === 'boolean') {
					const prevState = ws.clientState.focused;
					const prevLabel = prevState === null ? 'uninitialized' : (prevState ? 'focused' : 'unfocused');
					const newLabel = msg.data.focused ? 'focused' : 'unfocused';
					const changed = prevState !== msg.data.focused;
					logMessage(`[WS] Client ${clientIp} focus: ${prevLabel} -> ${newLabel}${changed ? '' : ' (no change)'}`);
					if (changed) {
						ws.clientState.focused = msg.data.focused;
					}
					// Always verify interval is correct (handles edge cases where interval doesn't match state)
					adjustPollingForFocus();
				}
			} else if (msg.event === 'fetchDelta' && msg.data) {
				// Handle delta fetch over WS instead of XHR
				const { url, since, requestId } = msg.data;
				try {
					const result = await computeDeltaResponse(url, since || '');
					ws.send(JSON.stringify({
						event: 'deltaResponse',
						data: { requestId, ...result },
					}));
				} catch (err) {
					ws.send(JSON.stringify({
						event: 'deltaResponse',
						data: { requestId, error: err.message || 'Delta fetch failed' },
					}));
				}
			}
		} catch (err) {
			// Only log non-parse errors (parse errors are expected for invalid/malformed messages)
			if (!(err instanceof SyntaxError)) {
				logMessage(`[WS] Message handler error from ${clientIp}: ${err.message || err}`);
			}
		}
	});

	ws.on('close', (code) => {
		logMessage(`[WS] Client disconnected from ${clientIp}, code: ${code}, remaining: ${wss.clients.size}`);
		// Clear focus state before adjusting (ensures not counted if still in wss.clients)
		ws.clientState.focused = null;
		stopWsPushIfUnneeded();
		adjustPollingForFocus();
	});

	ws.on('error', (err) => {
		logMessage(`[WS] Client error from ${clientIp}: ${err.message || err}`);
		stopWsPushIfUnneeded();
	});
}

// Attach connection handler
wss.on('connection', handleWsConnection);
const ATMOSPHERE_RECONNECT_MS = 5000;
const WS_PING_INTERVAL_MS = 30000;

function wsBroadcast(event, data) {
	const payload = JSON.stringify({ event, data });
	let sent = 0;
	for (const client of wss.clients) {
		if (client.readyState === WebSocket.OPEN) {
			try {
				client.send(payload, { compress: false });
				sent++;
			} catch {}
		}
	}
}

let backendRecoveryTimer = null;

function setBackendStatus(ok, errorMessage) {
	// If going to failed state, cancel any pending recovery and set immediately
	if (!ok) {
		if (backendRecoveryTimer) {
			clearTimeout(backendRecoveryTimer);
			backendRecoveryTimer = null;
			logMessage('[Backend] Recovery cancelled - backend failed again');
		}
		if (backendStatus.ok === false) return; // Already failed
		backendStatus.ok = false;
		backendStatus.lastError = errorMessage || 'OpenHAB unreachable';
		backendStatus.lastChange = Date.now();
		logMessage(`[Backend] Status: FAILED - ${backendStatus.lastError}`);
		wsBroadcast('backendStatus', {
			ok: backendStatus.ok,
			error: backendStatus.lastError,
		});
		return;
	}

	// Going to OK state - apply recovery delay if configured
	if (backendStatus.ok === true) return; // Already OK
	if (backendRecoveryTimer) return; // Recovery already pending

	const delayMs = liveConfig.backendRecoveryDelayMs || 0;
	if (delayMs > 0) {
		logMessage(`[Backend] Recovery detected, waiting ${delayMs}ms before marking OK...`);
		backendRecoveryTimer = setTimeout(() => {
			backendRecoveryTimer = null;
			backendStatus.ok = true;
			backendStatus.lastError = '';
			backendStatus.lastChange = Date.now();
			logMessage('[Backend] Status: OK (after recovery delay)');
			wsBroadcast('backendStatus', {
				ok: backendStatus.ok,
				error: backendStatus.lastError,
			});
		}, delayMs);
	} else {
		// No delay configured - set immediately
		backendStatus.ok = true;
		backendStatus.lastError = '';
		backendStatus.lastChange = Date.now();
		logMessage('[Backend] Status: OK');
		wsBroadcast('backendStatus', {
			ok: backendStatus.ok,
			error: backendStatus.lastError,
		});
	}
}

function parseAtmosphereUpdate(body) {
	try {
		const data = JSON.parse(body);
		// Support both OH 1.x 'widget' and OH 3.x 'widgets' formats
		const widgetSource = data?.widgets || data?.widget;
		if (!data || !widgetSource) return null;
		const changes = [];
		function extractItems(widget) {
			if (widget.item && widget.item.name && widget.item.state !== undefined) {
				changes.push({ name: widget.item.name, state: widget.item.state });
			}
			// Support both 'widget' (OH 1.x) and 'widgets' (OH 3.x)
			const children = widget.widgets || widget.widget;
			if (Array.isArray(children)) {
				children.forEach(extractItems);
			} else if (children) {
				extractItems(children);
			}
		}
		if (Array.isArray(widgetSource)) {
			widgetSource.forEach(extractItems);
		} else if (widgetSource) {
			extractItems(widgetSource);
		}
		if (changes.length === 0) return null;
		return { type: 'items', changes };
	} catch {
		return null;
	}
}

function getAtmosphereNoUpdateWarnMs() {
	return Math.max(
		0,
		configNumber(liveConfig.wsAtmosphereNoUpdateWarnMs, WS_ATMOSPHERE_NO_UPDATE_WARN_MS)
	);
}

function stopAtmosphereNoUpdateMonitor() {
	if (atmosphereNoUpdateTimer) {
		clearInterval(atmosphereNoUpdateTimer);
		atmosphereNoUpdateTimer = null;
	}
	atmosphereNoUpdateWarned = false;
	atmosphereLastItemUpdateAt = 0;
	atmosphereMonitorStartedAt = 0;
}

function startAtmosphereNoUpdateMonitor() {
	if (atmosphereNoUpdateTimer) return;
	if (liveConfig.wsMode !== 'atmosphere' || wss.clients.size === 0) return;
	const warnMs = getAtmosphereNoUpdateWarnMs();
	if (!warnMs) return;

	atmosphereNoUpdateTimer = setInterval(() => {
		const thresholdMs = getAtmosphereNoUpdateWarnMs();
		if (!thresholdMs) {
			stopAtmosphereNoUpdateMonitor();
			return;
		}
		if (liveConfig.wsMode !== 'atmosphere' || wss.clients.size === 0) {
			stopAtmosphereNoUpdateMonitor();
			return;
		}
		const now = Date.now();
		const last = atmosphereLastItemUpdateAt || atmosphereMonitorStartedAt || now;
		const ageMs = now - last;
		if (ageMs >= thresholdMs && !atmosphereNoUpdateWarned) {
			const ageSec = Math.round(ageMs / 1000);
			const thresholdSec = Math.round(thresholdMs / 1000);
			logMessage(`[Atmosphere] No item updates received in ${ageSec}s (threshold: ${thresholdSec}s)`);
			atmosphereNoUpdateWarned = true;
		}
	}, 1000);
}

function resetAtmosphereNoUpdateMonitor() {
	const now = Date.now();
	atmosphereLastItemUpdateAt = now;
	atmosphereMonitorStartedAt = now;
	atmosphereNoUpdateWarned = false;
	startAtmosphereNoUpdateMonitor();
}

function noteAtmosphereItemUpdate() {
	atmosphereLastItemUpdateAt = Date.now();
	atmosphereNoUpdateWarned = false;
}

function syncAtmosphereNoUpdateMonitor() {
	const warnMs = getAtmosphereNoUpdateWarnMs();
	if (liveConfig.wsMode !== 'atmosphere' || wss.clients.size === 0 || warnMs <= 0) {
		stopAtmosphereNoUpdateMonitor();
		return;
	}
	if (!atmosphereNoUpdateTimer) {
		resetAtmosphereNoUpdateMonitor();
	}
}

function scheduleAtmosphereResubscribe(reason) {
	if (liveConfig.wsMode !== 'atmosphere' || wss.clients.size === 0) return;
	if (atmosphereResubscribeTimer) return;
	logMessage(`[Atmosphere] Resubscribing (${reason})`);
	atmosphereResubscribeTimer = setTimeout(() => {
		atmosphereResubscribeTimer = null;
		connectAtmosphere();
	}, 250);
}

// Track multiple page subscriptions
const atmospherePages = new Map(); // pageId -> { connection, trackingId, reconnectTimer }
let atmosphereConnectInFlight = false;
let atmosphereResubscribeTimer = null;
let atmosphereResubscribeRequested = false;
let atmosphereNeedsSitemapRefresh = false;
let lastAtmosphereSitemapName = '';
let atmosphereNoUpdateTimer = null;
let atmosphereNoUpdateWarned = false;
let atmosphereLastItemUpdateAt = 0;
let atmosphereMonitorStartedAt = 0;

// SSE (Server-Sent Events) state for openHAB 3.x real-time updates
let sseConnection = null;
let sseReconnectTimer = null;
const SSE_RECONNECT_MS = 5000;

// Track item states to detect actual changes (not just openHAB reporting unchanged items)
const itemStates = new Map(); // itemName -> state
const groupItemCalculatedStates = new Map(); // groupName -> calculated count (for groupItems config)
let lastSeenItems = new Set(); // Item names from most recent full poll
let itemStateCleanupTimer = null;
const ITEM_STATE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function cleanupStaleItemStates() {
	if (lastSeenItems.size === 0) return; // No poll data yet
	let removed = 0;
	for (const name of itemStates.keys()) {
		if (!lastSeenItems.has(name)) {
			itemStates.delete(name);
			removed++;
		}
	}
	if (removed > 0) {
		logMessage(`[Polling] Cleaned up ${removed} stale item states (${itemStates.size} remaining)`);
	}
}

function startItemStateCleanup() {
	if (itemStateCleanupTimer) return;
	itemStateCleanupTimer = setInterval(cleanupStaleItemStates, ITEM_STATE_CLEANUP_INTERVAL_MS);
}

function stopItemStateCleanup() {
	if (itemStateCleanupTimer) {
		clearInterval(itemStateCleanupTimer);
		itemStateCleanupTimer = null;
	}
}

function filterChangedItems(changes) {
	const actualChanges = [];
	for (const item of changes) {
		const prevState = itemStates.get(item.name);
		if (prevState !== item.state) {
			itemStates.set(item.name, item.state);
			actualChanges.push(item);
		}
	}
	return actualChanges;
}

function connectAtmospherePage(pageId) {
	const existing = atmospherePages.get(pageId);
	if (existing) {
		if (existing.connection) {
			try { existing.connection.destroy(); } catch {}
		}
		if (existing.reconnectTimer) {
			clearTimeout(existing.reconnectTimer);
		}
	}

	const sitemapName = backgroundState.sitemap.name || 'default';
	const target = new URL(liveConfig.ohTarget);
	const isHttps = target.protocol === 'https:';
	const client = isHttps ? https : http;
	const basePath = target.pathname && target.pathname !== '/' ? target.pathname.replace(/\/$/, '') : '';
	const reqPath = `${basePath}/rest/sitemaps/${sitemapName}/${pageId}?type=json`;

	const pageState = atmospherePages.get(pageId) || { connection: null, trackingId: null, reconnectTimer: null };

	const headers = {
		Accept: 'application/json',
		'User-Agent': liveConfig.userAgent,
		'X-Atmosphere-Transport': 'long-polling',
	};
	if (pageState.trackingId) {
		headers['X-Atmosphere-tracking-id'] = pageState.trackingId;
	}
	const ah = authHeader();
	if (ah) headers.Authorization = ah;

	const req = client.request({
		method: 'GET',
		hostname: target.hostname,
		port: target.port || (isHttps ? 443 : 80),
		path: reqPath,
		headers,
		timeout: 120000,
	}, (res) => {
		const newTrackingId = res.headers['x-atmosphere-tracking-id'];
		if (newTrackingId) pageState.trackingId = newTrackingId;

		let body = '';
		res.setEncoding('utf8');
		res.on('data', (chunk) => { body += chunk; });
		res.on('end', async () => {
			pageState.connection = null;
			if (res.statusCode === 200 && body.trim()) {
				const update = parseAtmosphereUpdate(body);
				if (update && update.changes.length > 0) {
					// Only mark backend OK when we receive actual item data
					// (during OpenHAB startup, responses may be empty/malformed)
					setBackendStatus(true);
					// Filter to only items that actually changed
					const actualChanges = filterChangedItems(update.changes);

					// Check configured group items for calculated state changes
					const groupChanges = [];
					if (liveConfig.groupItems && liveConfig.groupItems.length > 0) {
						for (const groupName of liveConfig.groupItems) {
							if (actualChanges.some(c => c.name === groupName)) continue;
							const calculatedState = await calculateGroupState(groupName);
							if (calculatedState !== null) {
								const prevCalculated = groupItemCalculatedStates.get(groupName);
								if (prevCalculated !== calculatedState) {
									groupItemCalculatedStates.set(groupName, calculatedState);
									groupChanges.push({ name: groupName, state: calculatedState });
								}
							}
						}
					}

					const allChanges = [...actualChanges, ...groupChanges];
					if (allChanges.length > 0) {
						noteAtmosphereItemUpdate();
						if (wss.clients.size > 0) {
							// Apply group state overrides before broadcasting
							const transformedChanges = await applyGroupStateToItems(allChanges);
							wsBroadcast('update', { type: 'items', changes: transformedChanges });
						}
					}
				}
			} else if (res.statusCode >= 400) {
				setBackendStatus(false, `HTTP ${res.statusCode}`);
			}
			// Reconnect for next update
			if (wss.clients.size > 0) {
				scheduleAtmospherePageReconnect(pageId, 100);
			}
		});
	});

	req.on('error', (err) => {
		pageState.connection = null;
		// socket hang up and ECONNRESET are expected for long-polling, silently reconnect
		const msg = err.message || err;
		const isExpectedClose = msg === 'socket hang up' || err.code === 'ECONNRESET';
		if (!isExpectedClose) {
			logMessage(`[Atmosphere:${pageId}] Error: ${msg}`);
			setBackendStatus(false, msg);
		}
		scheduleAtmospherePageReconnect(pageId, ATMOSPHERE_RECONNECT_MS);
	});

	req.on('timeout', () => {
		req.destroy();
		pageState.connection = null;
		scheduleAtmospherePageReconnect(pageId, 0);
	});

	req.end();
	pageState.connection = req;
	atmospherePages.set(pageId, pageState);
}

function scheduleAtmospherePageReconnect(pageId, delay) {
	const pageState = atmospherePages.get(pageId);
	if (!pageState) return;
	if (pageState.reconnectTimer) clearTimeout(pageState.reconnectTimer);
	pageState.reconnectTimer = setTimeout(() => {
		pageState.reconnectTimer = null;
		if (wss.clients.size > 0) {
			connectAtmospherePage(pageId);
		}
	}, delay);
}

// Extract all page IDs from sitemap data
function extractPageIds(data, pages = new Set()) {
	if (!data) return pages;
	// Get this page's ID
	if (data.id) pages.add(data.id);
	// Check linkedPage for subpages
	if (data.linkedPage && data.linkedPage.id) {
		pages.add(data.linkedPage.id);
		extractPageIds(data.linkedPage, pages);
	}
	// Recurse into widgets - support both 'widget' (OH 1.x) and 'widgets' (OH 3.x)
	const widgetSource = data.widgets || data.widget;
	const widgets = Array.isArray(widgetSource) ? widgetSource : (widgetSource ? [widgetSource] : []);
	for (const w of widgets) {
		extractPageIds(w, pages);
	}
	// Check homepage
	if (data.homepage) {
		extractPageIds(data.homepage, pages);
	}
	return pages;
}

// Extract all RTSP URLs from Video widgets in sitemap data
function extractRtspUrls(data, urls = new Set()) {
	if (!data) return urls;
	// Check if this is a Video widget with rtsp:// label
	const type = (data.type || '').toLowerCase();
	if (type === 'video') {
		const label = data.label || '';
		if (label.startsWith('rtsp://')) {
			urls.add(label);
		}
	}
	// Recurse into widgets - support both 'widget' (OH 1.x) and 'widgets' (OH 3.x)
	const widgetSource = data.widgets || data.widget;
	const widgets = Array.isArray(widgetSource) ? widgetSource : (widgetSource ? [widgetSource] : []);
	for (const w of widgets) {
		extractRtspUrls(w, urls);
	}
	// Recurse into linkedPage
	if (data.linkedPage) {
		extractRtspUrls(data.linkedPage, urls);
	}
	// Recurse into homepage
	if (data.homepage) {
		extractRtspUrls(data.homepage, urls);
	}
	return urls;
}

// Hash RTSP URL to generate filename
function rtspUrlHash(url) {
	return crypto.createHash('md5').update(url).digest('hex').substring(0, 16);
}

// Chart cache helpers
function chartCacheKey(item, period, mode) {
	const assetVersion = liveConfig.assetVersion || 'v1';
	return crypto.createHash('md5')
		.update(`${item}|${period}|${mode || 'dark'}|${assetVersion}`)
		.digest('hex')
		.substring(0, 16);
}

function getChartCachePath(item, period, mode) {
	const hash = chartCacheKey(item, period, mode);
	return path.join(CHART_CACHE_DIR, `${hash}.html`);
}

function isChartCacheValid(cachePath, period) {
	if (!fs.existsSync(cachePath)) return false;
	const ttl = CHART_PERIOD_TTL[period];
	if (!ttl) return false;
	try {
		const stat = fs.statSync(cachePath);
		return (Date.now() - stat.mtimeMs) < ttl;
	} catch {
		return false;
	}
}

// Proxy cache helpers
function getProxyCachePath(url) {
	const hash = crypto.createHash('md5').update(url).digest('hex').substring(0, 16);
	return path.join(PROXY_CACHE_DIR, hash);
}

function isProxyCacheValid(cachePath, maxAgeSeconds) {
	try {
		const stat = fs.statSync(cachePath);
		return (Date.now() - stat.mtimeMs) < maxAgeSeconds * 1000;
	} catch {
		return false;
	}
}

// Chart generation (ported from genchart.py)
function deduceUnit(title) {
	if (/\skwh(\s|$)/i.test(title)) return 'kWh';
	if (/\s%%?(\s|$)/.test(title)) return '%';
	// Match various degree-like characters: ° (U+00B0), º (U+00BA), ˚ (U+02DA), or just C
	if (/\s[°º˚]?c(\s|$)/i.test(title)) return '°C';
	if (/\smbar(\s|$)/i.test(title)) return 'mbar';
	if (/\sl\/min(\s|$)/i.test(title)) return 'l/min';
	if (/\sm3(\s|$)/i.test(title)) return 'm³';
	if (/\sv(\s|$)/i.test(title)) return 'V';
	if (/\sw(\s|$)/i.test(title)) return 'W';
	if (/\slm\/m2(\s|$)/i.test(title)) return 'lm/m²';
	return '?';
}

function parseRrd4jFile(rrdPath, period = 'D') {
	try {
		const data = fs.readFileSync(rrdPath);
		if (data.length < 100) return null;

		// Parse header (skip 40-byte signature)
		let offset = 40;
		const step = Number(data.readBigUInt64BE(offset)); offset += 8;
		const dsCount = data.readUInt32BE(offset); offset += 4;
		const arcCount = data.readUInt32BE(offset); offset += 4;
		const lastUpdate = Number(data.readBigUInt64BE(offset)); offset += 8;

		const safeStep = (step < 1 || step > 86400) ? 60 : step;
		const now = Date.now() / 1000;
		const safeLastUpdate = (lastUpdate < 1577836800 || lastUpdate > 2000000000) ? now : lastUpdate;

		// Skip datasources (128 bytes each)
		offset += dsCount * 128;

		// Parse archives
		const archives = [];
		for (let arc = 0; arc < arcCount; arc++) {
			// Archive definition: consolFun(40) + xff(8) + steps(4) + rows(4)
			const arcSteps = data.readUInt32BE(offset + 48);
			const arcRows = data.readUInt32BE(offset + 52);
			offset += 56;

			// Skip ArcState (16 bytes per datasource)
			offset += dsCount * 16;

			// Robin: pointer(4) + values(8 * rows)
			const pointer = data.readUInt32BE(offset);
			offset += 4;

			const values = [];
			for (let i = 0; i < arcRows; i++) {
				values.push(data.readDoubleBE(offset));
				offset += 8;
			}

			// Skip remaining datasources
			for (let ds = 1; ds < dsCount; ds++) {
				offset += 4 + arcRows * 8;
			}

			// Reorder circular buffer
			let ordered;
			if (pointer > 0 && pointer < values.length) {
				ordered = values.slice(pointer).concat(values.slice(0, pointer));
			} else {
				ordered = values;
			}

			archives.push({ steps: arcSteps, rows: arcRows, values: ordered });
		}

		// Select archive based on period
		const periodDuration = { h: 3600, D: 86400, W: 604800, M: 2592000, Y: 31536000 };
		const required = periodDuration[period] || 86400;

		let selected = null;
		for (const arc of archives) {
			const arcStep = safeStep * arc.steps;
			const arcDuration = arc.rows * arcStep;
			if (arcDuration >= required * 0.8) {
				selected = arc;
				break;
			}
		}
		if (!selected) {
			selected = archives.reduce((a, b) =>
				(a.rows * safeStep * a.steps > b.rows * safeStep * b.steps) ? a : b
			);
		}

		// Build timestamp-value pairs
		const arcStep = safeStep * selected.steps;
		const pairs = [];
		for (let i = 0; i < selected.values.length; i++) {
			const val = selected.values[i];
			if (!isNaN(val) && isFinite(val)) {
				const ts = safeLastUpdate - (selected.values.length - i - 1) * arcStep;
				pairs.push([ts, val]);
			}
		}

		return pairs.length > 0 ? pairs : null;
	} catch (err) {
		return null;
	}
}

function processChartData(data, period, maxPoints = 500) {
	if (!data || data.length === 0) return { data: [], yMin: 0, yMax: 100 };

	const now = Date.now() / 1000;
	const periodSeconds = { h: 3600, D: 86400, W: 604800, M: 2592000, Y: 31536000 };
	const duration = periodSeconds[period] || 86400;
	const cutoff = now - duration;

	// Filter and track min/max
	let filtered = [];
	let dataMin = Infinity, dataMax = -Infinity;

	for (const [ts, val] of data) {
		if (ts >= cutoff) {
			filtered.push([ts, val]);
			if (val < dataMin) dataMin = val;
			if (val > dataMax) dataMax = val;
		}
	}

	// Fallback if no data in period
	if (filtered.length === 0 && data.length > 0) {
		const fallbackN = { h: 60, D: 1440, W: 2016, M: 4320, Y: 8760 };
		const n = fallbackN[period] || 1440;
		filtered = data.slice(-n);
		dataMin = Infinity; dataMax = -Infinity;
		for (const [, val] of filtered) {
			if (val < dataMin) dataMin = val;
			if (val > dataMax) dataMax = val;
		}
	}

	// Downsample if needed
	if (filtered.length > maxPoints) {
		const step = filtered.length / maxPoints;
		const result = [];
		dataMin = Infinity; dataMax = -Infinity;
		for (let i = 0; i < maxPoints; i++) {
			const idx = Math.floor(i * step);
			if (idx < filtered.length) {
				const [ts, val] = filtered[idx];
				result.push([ts, val]);
				if (val < dataMin) dataMin = val;
				if (val > dataMax) dataMax = val;
			}
		}
		// Always include last point
		if (result.length > 0 && filtered.length > 0) {
			const last = filtered[filtered.length - 1];
			if (result[result.length - 1][0] !== last[0]) {
				result.push(last);
				if (last[1] < dataMin) dataMin = last[1];
				if (last[1] > dataMax) dataMax = last[1];
			}
		}
		filtered = result;
	}

	// Calculate nice Y-range
	if (!isFinite(dataMin)) return { data: filtered, yMin: 0, yMax: 100 };

	let range = dataMax - dataMin;
	if (range === 0) range = Math.abs(dataMax) * 0.1 || 1;

	const padding = range * 0.15;
	let yMin = dataMin - padding;
	let yMax = dataMax + padding;

	if (range > 0) {
		const magnitude = Math.pow(10, Math.floor(Math.log10(range)));
		const step = Math.max(magnitude / 10, 0.01);
		yMin = Math.floor(yMin / step) * step;
		yMax = Math.ceil(yMax / step) * step;
	}

	if (yMin === yMax) { yMin -= 1; yMax += 1; }

	return { data: filtered, yMin, yMax, dataMin, dataMax };
}

function generateXLabels(data, period) {
	if (!data || data.length === 0) return [];

	const startTs = data[0][0];
	const endTs = data[data.length - 1][0];
	const duration = endTs - startTs;

	const config = {
		h: { interval: duration < 3600 ? 600 : 900, fmt: 'time' },
		D: { interval: 7200, fmt: 'time' },
		W: { interval: 86400, fmt: { weekday: 'short' } },
		M: { interval: 432000, fmt: { month: 'short', day: 'numeric' } },
		Y: { interval: 2592000, fmt: { month: 'short' } }
	};

	const { interval, fmt } = config[period] || config.D;
	const labels = [];
	const formatLabel = fmt === 'time'
		? (d) => { const h = d.getHours(), m = d.getMinutes(); return h + ':' + (m < 10 ? '0' : '') + m; }
		: (d) => new Intl.DateTimeFormat('en', fmt).format(d);

	for (let ts = startTs; ts <= endTs; ts += interval) {
		const pos = duration > 0 ? ((ts - startTs) / duration) * 100 : 50;
		labels.push({ text: formatLabel(new Date(ts * 1000)), pos });
	}

	// Ensure end label
	if (labels.length > 0 && labels[labels.length - 1].pos < 95) {
		labels.push({ text: formatLabel(new Date(endTs * 1000)), pos: 100 });
	}

	return labels;
}

function generateChartPoints(data) {
	if (!data || data.length === 0) return [];

	const startTs = data[0][0];
	const endTs = data[data.length - 1][0];
	const duration = endTs - startTs;

	return data.map(([ts, val], i) => ({
		x: Math.round((duration > 0 ? ((ts - startTs) / duration) * 100 : 50) * 100) / 100,
		y: Math.round(val * 1000) / 1000,
		t: ts * 1000,
		index: i
	}));
}

function computeChartDataHash(rawData, period) {
	if (!rawData || rawData.length === 0) return null;

	// Sample rate and rounding based on period for stable hashing
	const hashConfig = {
		h: { sample: 1, decimals: 2, tsRound: 60 },
		D: { sample: 4, decimals: 1, tsRound: 3600 },
		W: { sample: 8, decimals: 1, tsRound: 86400 },
		M: { sample: 16, decimals: 0, tsRound: 86400 },
		Y: { sample: 32, decimals: 0, tsRound: 604800 },
	};
	const cfg = hashConfig[period] || hashConfig.D;

	const sampled = rawData.filter((_, i) => i % cfg.sample === 0);
	const dataStr = sampled.map(([ts, val]) => {
		const roundedTs = Math.floor(ts / cfg.tsRound) * cfg.tsRound;
		const roundedVal = Number(val.toFixed(cfg.decimals));
		return `${roundedTs}:${roundedVal}`;
	}).join('|');

	return crypto.createHash('md5').update(dataStr).digest('hex').substring(0, 16);
}

function formatChartValue(n) {
	var result;
	if (n === 0) {
		return '0.0';
	} else if (Number.isInteger(n) || Math.abs(n - Math.round(n)) < 0.0001) {
		var r = Math.round(n);
		result = Math.abs(r) >= 100 ? r.toFixed(0) : r.toFixed(1);
	} else if (Math.abs(n) >= 100) {
		result = n.toFixed(0);
	} else if (Math.abs(n) >= 1) {
		result = n.toFixed(1);
	} else {
		result = n.toFixed(2);
	}
	// Normalize negative zero to positive zero
	if (result.charAt(0) === '-' && parseFloat(result) === 0) {
		return result.substring(1);
	}
	return result;
}

function generateChartHtml(chartData, xLabels, yMin, yMax, dataMin, dataMax, title, unit, mode, dataHash, dataAvg, dataCur, period) {
	const theme = mode === 'dark' ? 'dark' : 'light';
	const safeTitle = escapeHtml(title);
	const unitDisplay = unit !== '?' ? escapeHtml(unit) : '';
	const legendHtml = unitDisplay ? `<div class="chart-legend"><span class="legend-line"></span><span>${unitDisplay}</span></div>` : '';
	const assetVersion = liveConfig.assetVersion || 'v1';
	const dataHashAttr = dataHash ? ` data-hash="${dataHash}"` : '';

	// Format stats values with unit
	const statUnit = unitDisplay ? ' ' + unitDisplay : '';
	const fmtAvg = typeof dataAvg === 'number' ? formatChartValue(dataAvg) + statUnit : '';
	const fmtMin = typeof dataMin === 'number' ? formatChartValue(dataMin) + statUnit : '';
	const fmtMax = typeof dataMax === 'number' ? formatChartValue(dataMax) + statUnit : '';
	const fmtCur = (period === 'h' && typeof dataCur === 'number') ? formatChartValue(dataCur) + statUnit : '';
	const curHtml = fmtCur ? `<span class="stat-item" id="statCur"><span class="stat-label">Cur</span> <span class="stat-value">${fmtCur}</span></span>` : '';
	const statsHtml = fmtAvg ? `<div class="chart-stats" id="chartStats">${curHtml}<span class="stat-item"><span class="stat-label">Avg</span> <span class="stat-value">${fmtAvg}</span></span><span class="stat-item" id="statMin"><span class="stat-label">Min</span> <span class="stat-value">${fmtMin}</span></span><span class="stat-item" id="statMax"><span class="stat-label">Max</span> <span class="stat-value">${fmtMax}</span></span></div>` : '';

	return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}"${dataHashAttr}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle}</title>
<link rel="stylesheet" href="/chart.${assetVersion}.css">
</head>
<body>
<div class="container">
<div class="chart-card">
<div class="chart-header">
<div class="chart-title-group"><h2 class="chart-title" id="chartTitle">${safeTitle}</h2></div>
<div class="chart-header-right">${statsHtml}${legendHtml}</div>
</div>
<div class="chart-container" id="chartContainer">
<svg class="chart-svg" id="chartSvg"></svg>
<div class="tooltip" id="tooltip"><div class="tooltip-value" id="tooltipValue"></div><div class="tooltip-label" id="tooltipLabel"></div></div>
</div>
</div>
</div>
<script>
window._chartData=${JSON.stringify(chartData)};
window._chartXLabels=${JSON.stringify(xLabels)};
window._chartYMin=${yMin};
window._chartYMax=${yMax};
window._chartDataMin=${dataMin};
window._chartDataMax=${dataMax};
window._chartUnit=${JSON.stringify(unit)};
</script>
<script src="/chart.${assetVersion}.js"></script>
</body>
</html>`;
}

function generateChart(item, period, mode, title) {
	const rrdDir = liveConfig.rrdPath || '';
	if (!rrdDir) return null;

	const rrdPath = path.join(rrdDir, `${item}.rrd`);
	if (!fs.existsSync(rrdPath)) return null;

	// Parse RRD file
	const rawData = parseRrd4jFile(rrdPath, period);
	if (!rawData) return null;

	// Process data
	const { data, yMin, yMax, dataMin, dataMax } = processChartData(rawData, period, 500);
	if (!data || data.length === 0) return null;

	// Deduce unit from title
	let unit = deduceUnit(title);
	let cleanTitle = title;
	if (unit !== '?') {
		// Remove unit pattern(s) from end of title - handles variations like "Humidity %" and "Humidity %%"
		const unitPatterns = {
			'%': /\s*%%?\s*$/,
			'°C': /\s*[°º˚]?c\s*$/i,
			'kWh': /\s*kwh\s*$/i,
			'mbar': /\s*mbar\s*$/i,
			'l/min': /\s*l\/min\s*$/i,
			'm³': /\s*m3\s*$/i,
			'V': /\s*v\s*$/i,
			'W': /\s*w\s*$/i,
			'lm/m²': /\s*lm\/m2\s*$/i,
		};
		const pattern = unitPatterns[unit];
		if (pattern) {
			cleanTitle = cleanTitle.replace(pattern, '').trim();
		}
	}

	// Generate chart components
	const chartData = generateChartPoints(data);
	const xLabels = generateXLabels(data, period);

	// Compute average from chart data
	const dataAvg = chartData.length > 0
		? chartData.reduce((sum, pt) => sum + pt.y, 0) / chartData.length
		: null;

	// Get current (latest) value from chart data
	const dataCur = chartData.length > 0 ? chartData[chartData.length - 1].y : null;

	// Compute data hash for cache invalidation
	const dataHash = computeChartDataHash(rawData, period);

	// Generate HTML
	return generateChartHtml(chartData, xLabels, yMin, yMax, dataMin, dataMax, cleanTitle, unit, mode, dataHash, dataAvg, dataCur, period);
}

async function fetchAllPages() {
	let sitemapName = backgroundState.sitemap.name || '';
	let needsSitemapRefresh = false;

	if (!sitemapName) {
		await refreshSitemapCache({ skipAtmosphereResubscribe: true });
		sitemapName = backgroundState.sitemap.name || '';
	}

	if (!sitemapName) {
		sitemapName = 'default';
		needsSitemapRefresh = true;
	}
	try {
		const result = await fetchOpenhab(`/rest/sitemaps/${sitemapName}?type=json`);
		if (!result.ok) {
			throw new Error(`HTTP ${result.status}`);
		}
		const data = JSON.parse(result.body);
		const pages = extractPageIds(data);
		return {
			pages: Array.from(pages),
			sitemapName,
			needsSitemapRefresh,
		};
	} catch (e) {
		logMessage(`[Atmosphere] Failed to fetch pages: ${e.message}`);
		return {
			pages: [sitemapName], // fallback to just the sitemap name
			sitemapName,
			needsSitemapRefresh: true,
		};
	}
}

async function connectAtmosphere() {
	if (atmosphereConnectInFlight) {
		atmosphereResubscribeRequested = true;
		return;
	}
	atmosphereConnectInFlight = true;
	try {
		// Stop all existing connections
		stopAllAtmosphereConnections();
		resetAtmosphereNoUpdateMonitor();

		// Fetch all pages and subscribe to each
		const { pages, sitemapName, needsSitemapRefresh } = await fetchAllPages();

		// If no pages found, OpenHAB may still be starting - retry later
		if (pages.length === 0) {
			logMessage(`[Atmosphere] No pages found in sitemap, will retry in ${ATMOSPHERE_RECONNECT_MS}ms`);
			setTimeout(() => connectAtmosphere(), ATMOSPHERE_RECONNECT_MS);
			return;
		}

		atmosphereNeedsSitemapRefresh = needsSitemapRefresh;
		lastAtmosphereSitemapName = sitemapName || '';

		logMessage(`[Atmosphere] Subscribing to ${pages.length} pages: ${pages.join(', ')}`);
		for (const pageId of pages) {
			connectAtmospherePage(pageId);
		}
	} finally {
		atmosphereConnectInFlight = false;
		if (atmosphereResubscribeRequested) {
			atmosphereResubscribeRequested = false;
			setTimeout(() => connectAtmosphere(), 0);
		}
	}
}

function stopAllAtmosphereConnections() {
	for (const [pageId, state] of atmospherePages) {
		if (state.connection) {
			try { state.connection.destroy(); } catch {}
		}
		if (state.reconnectTimer) {
			clearTimeout(state.reconnectTimer);
		}
	}
	atmospherePages.clear();
	if (atmosphereResubscribeTimer) {
		clearTimeout(atmosphereResubscribeTimer);
		atmosphereResubscribeTimer = null;
	}
	atmosphereResubscribeRequested = false;
	atmosphereNeedsSitemapRefresh = false;
	lastAtmosphereSitemapName = '';
	stopAtmosphereNoUpdateMonitor();
}

// --- SSE Mode (openHAB 3.x) ---

function handleSSEEvent(eventData) {
	// Parse OH 3.x SSE event format:
	// {"topic":"openhab/items/ItemName/statechanged","payload":"{\"type\":\"Decimal\",\"value\":\"123\",\"oldType\":\"Decimal\",\"oldValue\":\"456\"}","type":"ItemStateChangedEvent"}
	try {
		const data = JSON.parse(eventData);
		if (!data.topic || !data.payload) return null;

		// Extract item name from topic: openhab/items/{itemName}/statechanged
		const topicMatch = data.topic.match(/^openhab\/items\/([^/]+)\/(statechanged|stateupdate)$/);
		if (!topicMatch) return null;

		const itemName = topicMatch[1];

		// Parse the payload (which is a JSON string)
		const payload = JSON.parse(data.payload);
		const newState = payload.value;

		if (newState === undefined) return null;

		return { name: itemName, state: String(newState) };
	} catch {
		return null;
	}
}

function connectSSE() {
	if (sseConnection) {
		try { sseConnection.destroy(); } catch {}
		sseConnection = null;
	}
	if (sseReconnectTimer) {
		clearTimeout(sseReconnectTimer);
		sseReconnectTimer = null;
	}

	if (liveConfig.wsMode !== 'sse' || wss.clients.size === 0) return;

	const target = new URL(liveConfig.ohTarget);
	const isHttps = target.protocol === 'https:';
	const client = isHttps ? https : http;
	const basePath = target.pathname && target.pathname !== '/' ? target.pathname.replace(/\/$/, '') : '';

	// Subscribe to item state changes via SSE
	const reqPath = `${basePath}/rest/events?topics=openhab/items/*/statechanged`;

	const headers = {
		Accept: 'text/event-stream',
		'Cache-Control': 'no-cache',
		'User-Agent': liveConfig.userAgent,
	};
	const ah = authHeader();
	if (ah) headers.Authorization = ah;

	logMessage('[SSE] Connecting to openHAB 3.x event stream...');

	const req = client.request({
		method: 'GET',
		hostname: target.hostname,
		port: target.port || (isHttps ? 443 : 80),
		path: reqPath,
		headers,
	}, (res) => {
		if (res.statusCode !== 200) {
			logMessage(`[SSE] Connection failed: HTTP ${res.statusCode}`);
			setBackendStatus(false, `SSE HTTP ${res.statusCode}`);
			scheduleSSEReconnect();
			return;
		}

		logMessage('[SSE] Connected to event stream');
		setBackendStatus(true);

		// Disable socket timeout for long-lived SSE connection
		if (res.socket) res.socket.setTimeout(0);

		let buffer = '';
		res.setEncoding('utf8');

		res.on('data', async (chunk) => {
			buffer += chunk;

			// Process complete SSE events (data: ... \n\n)
			const lines = buffer.split('\n');
			buffer = lines.pop() || ''; // Keep incomplete line in buffer

			for (const line of lines) {
				if (line.startsWith('data:')) {
					const eventData = line.substring(5).trim();
					if (!eventData) continue;

					const change = handleSSEEvent(eventData);
					if (change) {
						// Check if state actually changed
						const prevState = itemStates.get(change.name);
						if (prevState !== change.state) {
							itemStates.set(change.name, change.state);

							// Check configured group items for calculated state changes
							const groupChanges = [];
							if (liveConfig.groupItems && liveConfig.groupItems.length > 0) {
								for (const groupName of liveConfig.groupItems) {
									if (change.name === groupName) continue;
									const calculatedState = await calculateGroupState(groupName);
									if (calculatedState !== null) {
										const prevCalculated = groupItemCalculatedStates.get(groupName);
										if (prevCalculated !== calculatedState) {
											groupItemCalculatedStates.set(groupName, calculatedState);
											groupChanges.push({ name: groupName, state: calculatedState });
										}
									}
								}
							}

							const allChanges = [change, ...groupChanges];
							if (wss.clients.size > 0) {
								const transformedChanges = await applyGroupStateToItems(allChanges);
								wsBroadcast('update', { type: 'items', changes: transformedChanges });
							}
						}
					}
				}
			}
		});

		res.on('end', () => {
			logMessage('[SSE] Connection closed by server');
			sseConnection = null;
			scheduleSSEReconnect();
		});

		res.on('error', (err) => {
			logMessage(`[SSE] Stream error: ${err.message || err}`);
			setBackendStatus(false, err.message || String(err));
		});
	});

	req.on('error', (err) => {
		const msg = err.message || err;
		// ECONNRESET is common during server restarts
		if (err.code !== 'ECONNRESET') {
			logMessage(`[SSE] Connection error: ${msg}`);
		}
		setBackendStatus(false, msg);
		sseConnection = null;
		scheduleSSEReconnect();
	});

	req.on('timeout', () => {
		logMessage('[SSE] Connection timeout');
		req.destroy();
		sseConnection = null;
		scheduleSSEReconnect();
	});

	// SSE connections are long-lived, disable request timeout
	req.setTimeout(0);
	req.end();
	sseConnection = req;
}

function scheduleSSEReconnect() {
	if (sseReconnectTimer) return;
	if (liveConfig.wsMode !== 'sse' || wss.clients.size === 0) return;

	sseReconnectTimer = setTimeout(() => {
		sseReconnectTimer = null;
		if (liveConfig.wsMode === 'sse' && wss.clients.size > 0) {
			connectSSE();
		}
	}, SSE_RECONNECT_MS);
}

function stopSSE() {
	if (sseReconnectTimer) {
		clearTimeout(sseReconnectTimer);
		sseReconnectTimer = null;
	}
	if (sseConnection) {
		try { sseConnection.destroy(); } catch {}
		sseConnection = null;
	}
}

// --- Polling Mode ---
let pollingTimer = null;
let pollingActive = false;
let pollingGeneration = 0;  // Incremented on each start to detect stale poll callbacks
let currentPollingIntervalMs = null;

function countFocusedClients() {
	let count = 0;
	for (const client of wss.clients) {
		if (client.clientState?.focused === true) count++;
	}
	return count;
}

function getEffectivePollingInterval() {
	const focused = countFocusedClients();
	return focused > 0 ? liveConfig.wsPollingIntervalMs : liveConfig.wsPollingIntervalBgMs;
}

function adjustPollingForFocus() {
	if (liveConfig.wsMode !== 'polling' || !pollingActive) return;
	const newInterval = getEffectivePollingInterval();
	if (newInterval !== currentPollingIntervalMs) {
		const oldInterval = currentPollingIntervalMs;
		currentPollingIntervalMs = newInterval;
		logMessage(`[Polling] Interval changed: ${oldInterval}ms -> ${newInterval}ms (${countFocusedClients()} focused clients)`);
		// Reschedule immediately with new interval
		if (pollingTimer) {
			clearTimeout(pollingTimer);
			pollingTimer = setTimeout(pollItems, newInterval);
		}
	}
}

async function fetchAllItems() {
	try {
		const result = await fetchOpenhab('/rest/items');
		if (!result.ok) {
			throw new Error(`HTTP ${result.status}`);
		}
		const data = JSON.parse(result.body);
		// openHAB 1.x returns {"item":[...]}, openHAB 2.x+ returns [...]
		const items = Array.isArray(data) ? data : (data.item || []);
		if (!Array.isArray(items) || items.length === 0) {
			// OpenHAB responded but has no items - still starting up
			return [];
		}
		setBackendStatus(true);
		return items.map(item => ({ name: item.name, state: item.state }));
	} catch (e) {
		logMessage(`[Polling] Failed to fetch items: ${e.message}`);
		setBackendStatus(false, e.message);
		return [];
	}
}

async function pollItems() {
	if (!pollingActive || wss.clients.size === 0) return;

	// Capture generation to detect if polling was stopped/restarted during await
	const gen = pollingGeneration;

	const startTime = Date.now();
	const items = await fetchAllItems();
	const elapsed = Date.now() - startTime;

	// If polling was stopped/restarted during fetch, abort to prevent duplicate chains
	if (gen !== pollingGeneration) return;

	// Log slow polling requests
	if (liveConfig.slowQueryMs > 0 && elapsed > liveConfig.slowQueryMs) {
		logMessage(`[Polling] Slow request: ${elapsed}ms (threshold: ${liveConfig.slowQueryMs}ms)`);
	}

	if (items.length > 0) {
		// Track seen items for stale state cleanup
		lastSeenItems = new Set(items.map(i => i.name));
		const actualChanges = filterChangedItems(items);

		// Check configured group items for calculated state changes
		// (their native state may not change even when member counts do)
		const groupChanges = [];
		if (liveConfig.groupItems && liveConfig.groupItems.length > 0) {
			for (const groupName of liveConfig.groupItems) {
				// Skip if already in actualChanges
				if (actualChanges.some(c => c.name === groupName)) continue;

				const calculatedState = await calculateGroupState(groupName);
				if (calculatedState !== null) {
					const prevCalculated = groupItemCalculatedStates.get(groupName);
					if (prevCalculated !== calculatedState) {
						groupItemCalculatedStates.set(groupName, calculatedState);
						// Find the item from the poll to get its full data
						const itemData = items.find(i => i.name === groupName);
						if (itemData) {
							groupChanges.push({ ...itemData, state: calculatedState });
						} else {
							groupChanges.push({ name: groupName, state: calculatedState });
						}
					}
				}
			}
		}

		const allChanges = [...actualChanges, ...groupChanges];
		if (allChanges.length > 0) {
			// Apply group state overrides before broadcasting
			const transformedChanges = await applyGroupStateToItems(allChanges);
			wsBroadcast('update', { type: 'items', changes: transformedChanges });
		}
	}

	// Schedule next poll with dynamic interval
	if (pollingActive && wss.clients.size > 0) {
		pollingTimer = setTimeout(pollItems, currentPollingIntervalMs || getEffectivePollingInterval());
	}
}

function startPolling() {
	if (pollingActive) return;
	pollingActive = true;
	pollingGeneration++;  // Invalidate any in-flight poll callbacks
	const newInterval = getEffectivePollingInterval();
	if (currentPollingIntervalMs !== null && currentPollingIntervalMs !== newInterval) {
		logMessage(`[Polling] Interval changed: ${currentPollingIntervalMs}ms -> ${newInterval}ms (${countFocusedClients()} focused clients)`);
	}
	currentPollingIntervalMs = newInterval;
	logMessage(`[Polling] Starting item polling (interval: ${currentPollingIntervalMs}ms)`);
	startItemStateCleanup();
	pollItems();
}

function stopPolling() {
	pollingActive = false;
	// Don't reset currentPollingIntervalMs - keep it for change detection on restart
	if (pollingTimer) {
		clearTimeout(pollingTimer);
		pollingTimer = null;
	}
	stopItemStateCleanup();
	// Clear state maps to free memory when no clients connected
	itemStates.clear();
	lastSeenItems.clear();
}

// --- Generic WS Push Control ---
function startWsPushIfNeeded() {
	if (wss.clients.size === 0) return;

	if (liveConfig.wsMode === 'atmosphere') {
		if (atmospherePages.size === 0) {
			connectAtmosphere();
		}
	} else if (liveConfig.wsMode === 'sse') {
		if (!sseConnection && !sseReconnectTimer) {
			connectSSE();
		}
	} else {
		if (!pollingActive) {
			startPolling();
		}
	}
}

function stopWsPushIfUnneeded() {
	if (wss.clients.size > 0) return;

	if (liveConfig.wsMode === 'atmosphere') {
		stopAllAtmosphereConnections();
	} else if (liveConfig.wsMode === 'sse') {
		stopSSE();
	} else {
		stopPolling();
	}
}

// Native WebSocket ping for connection health monitoring
setInterval(() => {
	for (const ws of wss.clients) {
		if (ws.isAlive === false) {
			ws.terminate();
			continue;
		}
		ws.isAlive = false;
		ws.ping();
	}
}, WS_PING_INTERVAL_MS);

function sendWsUpgradeError(socket, statusCode, statusText) {
	const body = statusText;
	const response = [
		`HTTP/1.1 ${statusCode} ${statusText}`,
		'Content-Type: text/plain',
		`Content-Length: ${Buffer.byteLength(body)}`,
		'Connection: close',
		'',
		body,
	].join('\r\n');
	socket.write(response);
	socket.destroy();
}

function handleWsUpgrade(req, socket, head) {
	const pathname = new URL(req.url, 'http://localhost').pathname;
	const socketIp = getSocketIp(req);
	const clientIp = getRemoteIp(req);
	const clientExts = req.headers['sec-websocket-extensions'] || 'none';
	logMessage(`[WS] Upgrade request from ${clientIp || 'unknown'} for ${pathname}, extensions: ${clientExts}`);

	if (pathname !== '/ws') {
		logMessage(`[WS] Rejected upgrade for ${pathname} from ${clientIp || 'unknown'}`);
		socket.destroy();
		return;
	}

	// Check allowSubnets using socket IP (unless allow-all configured)
	const allowAll = Array.isArray(liveConfig.allowSubnets) && liveConfig.allowSubnets.some((entry) => isAllowAllSubnet(entry));
	if (!allowAll && (!socketIp || !ipInAnySubnet(socketIp, liveConfig.allowSubnets))) {
		logMessage(`[WS] Blocked upgrade from ${clientIp || 'unknown'} (socket: ${socketIp || 'unknown'}) - not in allowSubnets`);
		sendWsUpgradeError(socket, 403, 'Forbidden');
		return;
	}

	// Check denyXFFSubnets - only when X-Forwarded-For header is present
	if (liveConfig.trustProxy && Array.isArray(liveConfig.denyXFFSubnets) && liveConfig.denyXFFSubnets.length > 0) {
		const xff = req.headers?.['x-forwarded-for'];
		if (xff) {
			const xffIp = normalizeRemoteIp(safeText(xff).split(',')[0].trim());
			if (xffIp && ipInAnySubnet(xffIp, liveConfig.denyXFFSubnets)) {
				logMessage(`[WS] Blocked upgrade from denied XFF subnet ${xffIp}`);
				sendWsUpgradeError(socket, 403, 'Forbidden');
				return;
			}
		}
	}

	// Always require authentication
	{
		// Check lockout
		const lockKey = getLockoutKey(clientIp);
		const lockout = getAuthLockout(lockKey);
		if (lockout && lockout.lockUntil) {
			const remaining = Math.max(0, Math.ceil((lockout.lockUntil - Date.now()) / 1000));
			logMessage(`[WS] Auth lockout active for ${lockKey} (${remaining}s remaining)`);
			sendWsUpgradeError(socket, 429, 'Too many authentication attempts');
			return;
		}

		// Load users
		const { users, disabledUsers } = loadAuthUsers();
		if (!users || Object.keys(users).length === 0) {
			logMessage('[WS] Auth config unavailable');
			sendWsUpgradeError(socket, 500, 'Auth config unavailable');
			return;
		}

		// Try Basic auth
		let authenticatedUser = null;
		const [user, pass] = getBasicAuthCredentials(req);
		if (user) {
			if (!Object.prototype.hasOwnProperty.call(users, user) || users[user] !== pass) {
				maybeNotifyAuthFailure(clientIp || '');
				const entry = recordAuthFailure(lockKey);
				if (entry && entry.lockUntil) {
					logMessage(`[WS] Auth lockout triggered for ${lockKey} after ${entry.count} failures`);
					sendWsUpgradeError(socket, 429, 'Too many authentication attempts');
					return;
				}
				logMessage(`[WS] Invalid credentials from ${clientIp || 'unknown'}`);
				sendWsUpgradeError(socket, 401, 'Unauthorized');
				return;
			}
			authenticatedUser = user;
		} else if (liveConfig.authCookieKey && liveConfig.authCookieName) {
			// Try cookie auth
			const cookieResult = getAuthCookieUser(req, users, liveConfig.authCookieKey);
			if (cookieResult) {
				authenticatedUser = cookieResult.user;
			}
		}

		if (!authenticatedUser) {
			logMessage(`[WS] No valid auth from ${clientIp || 'unknown'}`);
			sendWsUpgradeError(socket, 401, 'Unauthorized');
			return;
		}

		// Check if user is disabled
		if (disabledUsers.has(authenticatedUser)) {
			logMessage(`[WS] Disabled user ${authenticatedUser} rejected`);
			sendWsUpgradeError(socket, 500, '');
			return;
		}

		clearAuthFailures(lockKey);
		logMessage(`[WS] Authenticated user ${authenticatedUser} from ${clientIp || 'unknown'}`);
		req.ohProxyUser = authenticatedUser;
	}

	// Create a new headers object without extensions
	// This ensures ws library doesn't see the extension request
	const cleanHeaders = {};
	for (const [key, value] of Object.entries(req.headers)) {
		if (key.toLowerCase() !== 'sec-websocket-extensions') {
			cleanHeaders[key] = value;
		}
	}
	req.headers = cleanHeaders;

	wss.handleUpgrade(req, socket, head, (ws) => {
		wss.emit('connection', ws, req);
	});
}

function getInitialPageTitle() {
	const cached = safeText(backgroundState.sitemap.title);
	return cached || DEFAULT_PAGE_TITLE;
}

function getInitialDocumentTitle() {
	const site = safeText(backgroundState.sitemap.title || '');
	const normalized = site.trim();
	if (!normalized || normalized.toLowerCase() === DEFAULT_PAGE_TITLE.toLowerCase()) {
		return `${DEFAULT_PAGE_TITLE} · Home`;
	}
	return `${DEFAULT_PAGE_TITLE} · ${normalized} · Home`;
}

function getInitialPageTitleHtml() {
	const site = escapeHtml(getInitialPageTitle());
	const home = 'Home';
	return `<span class="font-semibold">${site}</span>` +
		`<span class="font-extralight text-slate-300"> · ${escapeHtml(home)}</span>`;
}

function getInitialStatusLabel(req) {
	const info = getAuthInfo(req);
	if (info.auth === 'authenticated' && info.user) {
		return `Connected · ${info.user}`;
	}
	return 'Connected';
}

function getInitialStatusInfo(req) {
	return {
		statusText: getInitialStatusLabel(req),
		statusClass: 'status-ok',
	};
}

function renderIndexHtml(options) {
	if (!indexTemplate) indexTemplate = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
	const opts = options || {};
	let html = indexTemplate;
	html = html.replace(/__CSS_VERSION__/g, liveConfig.assetVersion);
	html = html.replace(/__JS_VERSION__/g, liveConfig.assetVersion);
	html = html.replace(/__SW_VERSION__/g, liveConfig.assetVersion);
	html = html.replace(/__APPLE_TOUCH_VERSION__/g, liveConfig.appleTouchVersion);
	html = html.replace(/__PAGE_TITLE__/g, getInitialPageTitleHtml());
	html = html.replace(/__DOC_TITLE__/g, escapeHtml(getInitialDocumentTitle()));
	html = html.replace(/__STATUS_TEXT__/g, escapeHtml(opts.statusText || 'Connected'));
	html = html.replace(/__STATUS_CLASS__/g, escapeHtml(opts.statusClass || 'status-pending'));
	html = html.replace(/__AUTH_INFO__/g, inlineJson(opts.authInfo || {}));
	html = html.replace(/__SESSION_SETTINGS__/g, inlineJson(opts.sessionSettings || {}));
	const themeClass = opts.sessionSettings?.darkMode === false ? 'theme-light' : 'theme-dark';
	html = html.replace(/__THEME_CLASS__/g, themeClass);
	return html;
}

function renderServiceWorker() {
	if (!serviceWorkerTemplate) serviceWorkerTemplate = fs.readFileSync(SERVICE_WORKER_PATH, 'utf8');
	let script = serviceWorkerTemplate;
	script = script.replace(/__CSS_VERSION__/g, liveConfig.assetVersion);
	script = script.replace(/__JS_VERSION__/g, liveConfig.assetVersion);
	script = script.replace(/__SW_VERSION__/g, liveConfig.assetVersion);
	script = script.replace(/__APPLE_TOUCH_VERSION__/g, liveConfig.appleTouchVersion);
	return script;
}

function renderLoginHtml() {
	if (!loginTemplate) loginTemplate = fs.readFileSync(LOGIN_HTML_PATH, 'utf8');
	let html = loginTemplate;
	html = html.replace(/__JS_VERSION__/g, liveConfig.assetVersion);
	return html;
}

function renderWeatherWidget(forecastData, mode) {
	const isDark = mode === 'dark';
	const textColor = isDark ? '#ffffff' : '#000000';
	const rainColor = '#3498db';

	const days = Array.isArray(forecastData?.data) ? forecastData.data.slice(0, 7) : [];
	const cityName = safeText(forecastData?.city_name || '');
	const unitSymbol = WEATHERBIT_UNITS === 'I' ? 'F' : 'C';

	const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

	const forecastCards = days.map((day) => {
		const date = new Date(day.datetime);
		const dayName = dayNames[date.getDay()];
		const icon = safeText(day.weather?.icon || 'c01d');
		const highTemp = Math.round(day.high_temp || 0);
		const lowTemp = Math.round(day.low_temp || 0);
		const pop = day.pop || 0;
		const rainOpacity = pop > 0 ? '0.9' : '0.3';
		const rainTextColor = pop > 0 ? rainColor : 'inherit';

		return `
			<div class="forecast-day">
				<div class="day-name">${dayName}</div>
				<img class="weather-icon" src="/weather/icons/${icon}.png" alt="${safeText(day.weather?.description || '')}">
				<div class="temps">
					<div class="temp-high">${highTemp}°</div>
					<div class="temp-low">${lowTemp}°</div>
				</div>
				<div class="rain-chance" style="opacity:${rainOpacity};color:${rainTextColor}">
					<svg class="rain-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2c0-3.32-2.67-7.25-8-11.8z"/></svg>
					<span>${pop}%</span>
				</div>
			</div>`;
	}).join('');

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Weather Forecast${cityName ? ` - ${cityName}` : ''}</title>
<style>
@font-face {
	font-family: 'Rubik';
	font-style: normal;
	font-weight: 300;
	font-display: swap;
	src: url('/fonts/rubik-300.woff2') format('woff2');
}
@font-face {
	font-family: 'Rubik';
	font-style: normal;
	font-weight: 400;
	font-display: swap;
	src: url('/fonts/rubik-400.woff2') format('woff2');
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
	height: 100%;
	font-family: 'Rubik', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
	font-weight: 300;
	background: transparent;
	color: ${textColor};
}
.weather-card {
	height: 100%;
	display: flex;
	flex-direction: column;
	padding: 15px;
}
.forecast-container {
	display: flex;
	gap: 10px;
	overflow-x: auto;
	padding: 5px;
	-webkit-overflow-scrolling: touch;
	scrollbar-width: none;
	flex: 1;
}
.forecast-container::-webkit-scrollbar { display: none; }
.forecast-day {
	flex: 1;
	min-width: 70px;
	background: transparent;
	border-radius: 15px;
	padding: 15px 10px;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 5px;
}
.day-name {
	font-size: 1.125rem;
	font-weight: 400;
	opacity: 0.7;
}
.weather-icon {
	width: 45px;
	height: 45px;
}
.temps {
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	margin-top: 5px;
}
.temp-high {
	font-size: .75rem;
	font-weight: 300;
}
.temp-low {
	font-size: .75rem;
	opacity: 0.6;
}
.rain-chance {
	display: flex;
	align-items: center;
	gap: 2px;
	font-size: 11px;
	margin-top: 8px;
}
.rain-icon {
	width: 10px;
	height: 10px;
}
@media (max-width: 560px) {
	.forecast-day:nth-child(7) { display: none; }
}
@media (max-width: 480px) {
	.forecast-day:nth-child(6) { display: none; }
}
@media (max-width: 400px) {
	.forecast-day:nth-child(5) { display: none; }
}
</style>
</head>
<body>
<div class="weather-card">
	<div class="forecast-container">
		${forecastCards}
	</div>
</div>
</body>
</html>`;
}

function sendIndex(req, res) {
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Content-Type', 'text/html; charset=utf-8');
	const status = getInitialStatusInfo(req);
	status.authInfo = getAuthInfo(req);
	status.sessionSettings = req.ohProxySession?.settings || sessions.getDefaultSettings();
	res.send(renderIndexHtml(status));
}

function sendServiceWorker(res) {
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
	res.send(renderServiceWorker());
}

function sendVersionedAsset(res, filePath, contentType) {
	if (!fs.existsSync(filePath)) {
		res.status(404).send('Not found');
		return;
	}
	res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
	if (contentType) res.setHeader('Content-Type', contentType);
	res.sendFile(filePath);
}

function normalizeWidgets(page) {
	// Support both OH 1.x 'widget' and OH 3.x 'widgets'
	let w = page?.widgets || page?.widget;
	if (!w) return [];
	if (!Array.isArray(w)) {
		if (w && Array.isArray(w.item)) w = w.item;
		else w = [w];
	}

	const out = [];
	const walk = (list) => {
		for (const item of list) {
			if (item?.type === 'Frame') {
				const label = safeText(item?.label || item?.item?.label || item?.item?.name || '');
				out.push({ __frame: true, label });
				// Support both 'widget' (OH 1.x) and 'widgets' (OH 3.x)
				let kids = item.widgets || item.widget;
				if (kids) {
					if (!Array.isArray(kids)) {
						if (Array.isArray(kids.item)) kids = kids.item;
						else kids = [kids];
					}
					walk(kids);
				}
				continue;
			}
			out.push(item);
		}
	};

	walk(w);
	return out;
}

function ensureJsonParam(url) {
	if (!url) return url;
	if (url.includes('type=json')) return url;
	return url + (url.includes('?') ? '&' : '?') + 'type=json';
}

function normalizeOpenhabPath(link) {
	const text = safeText(link);
	if (!text) return '';
	try {
		const base = new URL(liveConfig.ohTarget);
		const u = new URL(text, base);
		let out = u.pathname || '/';
		const basePath = base.pathname && base.pathname !== '/' ? base.pathname.replace(/\/$/, '') : '';
		if (basePath && out.startsWith(basePath)) out = out.slice(basePath.length) || '/';
		return `${out}${u.search || ''}`;
	} catch {
		let out = text.startsWith('/') ? text : `/${text}`;
		try {
			const base = new URL(liveConfig.ohTarget);
			const basePath = base.pathname && base.pathname !== '/' ? base.pathname.replace(/\/$/, '') : '';
			if (basePath && out.startsWith(basePath)) out = out.slice(basePath.length) || '/';
		} catch {}
		return out;
	}
}

function sectionLabel(widget) {
	return safeText(widget?.label || widget?.item?.label || widget?.item?.name || '');
}

function widgetLabel(widget) {
	if (widget?.label) return safeText(widget.label);
	if (widget?.item?.label) return safeText(widget.item.label);
	return safeText(widget?.item?.name || widget?.name || '');
}

function splitLabelState(label) {
	const raw = safeText(label);
	// Strip trailing empty brackets [] (openHAB 3.x+ sends these when no state)
	const cleaned = raw.replace(/\s*\[\]\s*$/, '');
	const match = cleaned.match(/^(.*)\s*\[(.+)\]\s*$/);
	if (!match) return { title: cleaned, state: '' };
	return { title: match[1].trim(), state: match[2].trim() };
}

function labelPathSegments(label) {
	const parts = splitLabelState(label);
	const segs = [];
	if (parts.title) segs.push(parts.title);
	if (parts.state) segs.push(parts.state);
	return segs;
}

function widgetPageLink(widget) {
	const link = widget?.linkedPage?.link || widget?.link;
	if (typeof link !== 'string') return null;
	if (!link.includes('/rest/sitemaps/')) return null;
	return link;
}

function normalizeSearchWidgets(page, ctx) {
	// Support both OH 1.x 'widget' and OH 3.x 'widgets' formats
	let w = page?.widgets || page?.widget;
	if (!w) return [];

	if (!Array.isArray(w)) {
		if (w && Array.isArray(w.item)) w = w.item;
		else w = [w];
	}

	const out = [];
	const path = Array.isArray(ctx?.path) ? ctx.path : null;
	const walk = (list, frameLabel) => {
		for (const item of list) {
			if (item?.type === 'Frame') {
				const label = sectionLabel(item);
				if (label) out.push({ __section: true, label });
				// Support both 'widget' (OH 1.x) and 'widgets' (OH 3.x)
				let kids = item.widgets || item.widget;
				if (kids) {
					if (!Array.isArray(kids)) {
						if (Array.isArray(kids.item)) kids = kids.item;
						else kids = [kids];
					}
					walk(kids, label || frameLabel);
				}
				continue;
			}
			if (path) item.__path = path.slice();
			if (frameLabel) item.__frame = frameLabel;
			out.push(item);
		}
	};

	walk(w, '');
	return out;
}

function extractSitemaps(data) {
	if (!data) return [];
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.sitemaps)) return data.sitemaps;
	if (Array.isArray(data?.sitemaps?.sitemap)) return data.sitemaps.sitemap;
	if (Array.isArray(data?.sitemap)) return data.sitemap;
	if (data?.sitemap && typeof data.sitemap === 'object') return [data.sitemap];
	if (data?.sitemaps && typeof data.sitemaps === 'object') return [data.sitemaps];
	return [];
}

function widgetType(widget) {
	return safeText(widget?.type || widget?.widgetType || widget?.item?.type || '');
}

function widgetLink(widget) {
	return safeText(widget?.linkedPage?.link || widget?.link || '');
}

function deltaKey(widget) {
	const id = safeText(widget?.widgetId || widget?.id || '');
	if (id) return `id:${id}`;
	const itemName = safeText(widget?.item?.name || widget?.itemName || '');
	const type = widgetType(widget);
	const link = widgetLink(widget);
	if (itemName) return `item:${itemName}|${type}|${link}`;
	const label = safeText(widget?.label || widget?.item?.label || widget?.item?.name || '');
	return `label:${label}|${type}|${link}`;
}

function serverWidgetKey(widget) {
	if (widget?.__section) return `section:${safeText(widget.label)}`;
	const item = safeText(widget?.item?.name || '');
	const fullLabel = safeText(widget?.label || '');
	const { title } = splitLabelState(fullLabel);
	const label = title || fullLabel;
	const type = widgetType(widget);
	const link = safeText(widgetPageLink(widget) || '');
	return `widget:${item}|${label}|${type}|${link}`;
}

function normalizeMappings(mapping) {
	if (!mapping) return [];
	if (Array.isArray(mapping)) {
		return mapping
			.map((m) => {
				if (!m || typeof m !== 'object') return null;
				const command = safeText(m.command ?? '');
				const label = safeText(m.label ?? m.command ?? '');
				if (!command && !label) return null;
				return { command, label: label || command };
			})
			.filter(Boolean);
	}
	if (typeof mapping === 'object') {
		if ('command' in mapping || 'label' in mapping) {
			const command = safeText(mapping.command ?? '');
			const label = safeText(mapping.label ?? mapping.command ?? '');
			if (!command && !label) return [];
			return [{ command, label: label || command }];
		}
		return Object.entries(mapping).map(([command, label]) => ({
			command: safeText(command),
			label: safeText(label),
		}));
	}
	return [];
}

function mappingsSignature(mapping) {
	const normalized = normalizeMappings(mapping);
	return normalized.map((m) => `${m.command}:${m.label}`).join('|');
}

function widgetSnapshot(widget) {
	// Support both OH 1.x 'mapping' and OH 3.x 'mappings'
	const widgetMapping = widget?.mappings || widget?.mapping;
	const mappingSig = mappingsSignature(widgetMapping);
	return {
		key: deltaKey(widget),
		id: safeText(widget?.widgetId || widget?.id || ''),
		itemName: safeText(widget?.item?.name || widget?.itemName || ''),
		label: safeText(widget?.label || widget?.item?.label || widget?.item?.name || ''),
		state: safeText(widget?.item?.state ?? widget?.state ?? ''),
		valuecolor: safeText(
			widget?.valuecolor ||
			widget?.valueColor ||
			widget?.item?.valuecolor ||
			widget?.item?.valueColor ||
			''
		),
		icon: safeText(widget?.icon || widget?.item?.icon || widget?.item?.category || ''),
		mappings: mappingSig,
		mapping: mappingSig ? normalizeMappings(widgetMapping) : [],
	};
}

function buildSnapshot(page) {
	const list = normalizeWidgets(page);
	const entryMap = new Map();
	const entryOrder = [];
	const structureParts = [];

	for (const w of list) {
		if (w && w.__frame) {
			structureParts.push(`frame:${safeText(w.label)}`);
			continue;
		}
		if (!w) continue;
		const snap = widgetSnapshot(w);
		if (!snap.key) continue;
		structureParts.push(snap.key);
		entryOrder.push(snap);
		entryMap.set(snap.key, snap);
	}

	const structureHash = hashString(structureParts.join('|'));
	const hash = hashString(JSON.stringify({
		title: safeText(page?.title || ''),
		entries: entryOrder.map((e) => ({
			key: e.key,
			label: e.label,
			state: e.state,
			valuecolor: e.valuecolor,
			icon: e.icon,
			mappings: e.mappings,
		})),
	}));

	return {
		hash,
		structureHash,
		entryMap,
		title: safeText(page?.title || ''),
	};
}

const DELTA_HASH_HISTORY = 5; // Keep last N snapshots per cache key

function setDeltaCache(key, value) {
	let entry = deltaCache.get(key);
	if (!entry) {
		entry = { history: [] };
		deltaCache.set(key, entry);
	}
	// Add new snapshot to history
	entry.history.push(value);
	// Keep only last N entries
	if (entry.history.length > DELTA_HASH_HISTORY) {
		entry.history.shift();
	}
	// Prune old cache keys if needed
	const limit = configNumber(liveConfig.deltaCacheLimit, DELTA_CACHE_LIMIT);
	if (deltaCache.size <= limit) return;
	const oldestKey = deltaCache.keys().next().value;
	if (oldestKey) deltaCache.delete(oldestKey);
}

function findDeltaMatch(key, since) {
	const entry = deltaCache.get(key);
	if (!entry || !entry.history.length || !since) return null;
	// Search history for matching hash (most recent first)
	for (let i = entry.history.length - 1; i >= 0; i--) {
		if (entry.history[i].hash === since) {
			return entry.history[i];
		}
	}
	return null;
}

// Cache for group member data (structure only, states fetched fresh)
const groupMemberCache = new Map();
const GROUP_MEMBER_CACHE_TTL_MS = 60000; // 1 minute TTL for member structure

// Fetch group members and calculate count of OPEN states
async function calculateGroupState(groupName) {
	if (!groupName) return null;
	try {
		const body = await fetchOpenhab(`/rest/items/${encodeURIComponent(groupName)}`);
		if (!body.ok) {
			logMessage(`[GroupState] Failed to fetch ${groupName}: ${body.status}`);
			return null;
		}
		const data = JSON.parse(body.body);
		if (!data || !Array.isArray(data.members)) {
			logMessage(`[GroupState] No members array for ${groupName}`);
			return null;
		}
		const count = data.members.filter(m => m && m.state === 'OPEN').length;
		return String(count);
	} catch (err) {
		logMessage(`[GroupState] Error for ${groupName}: ${err.message}`);
		return null;
	}
}

// Apply group state overrides to item changes (for WebSocket broadcasts)
async function applyGroupStateToItems(items) {
	if (!items || !items.length || !liveConfig.groupItems || !liveConfig.groupItems.length) {
		return items;
	}
	const groupSet = new Set(liveConfig.groupItems);
	const result = [];
	for (const item of items) {
		if (item && item.name && groupSet.has(item.name)) {
			const calculatedState = await calculateGroupState(item.name);
			if (calculatedState !== null) {
				result.push({ ...item, state: calculatedState });
				continue;
			}
		}
		result.push(item);
	}
	return result;
}

// Apply group state overrides to widgets in a page
async function applyGroupStateOverrides(page) {
	if (!page || !liveConfig.groupItems || !liveConfig.groupItems.length) {
		return;
	}
	const groupSet = new Set(liveConfig.groupItems);

	const processWidgets = async (widgets) => {
		if (!widgets) return;
		const list = Array.isArray(widgets) ? widgets : (Array.isArray(widgets.item) ? widgets.item : (widgets.item ? [widgets.item] : [widgets]));
		for (const w of list) {
			if (!w) continue;
			const itemName = w?.item?.name || w?.name || '';
			if (itemName && groupSet.has(itemName)) {
				const calculatedState = await calculateGroupState(itemName);
				if (calculatedState !== null) {
					if (w.item) w.item.state = calculatedState;
					w.state = calculatedState;
					// Also update label if it contains a value in brackets like "Motion [1]"
					if (w.label && w.label.includes('[')) {
						w.label = w.label.replace(/\[[^\]]*\]/, `[${calculatedState}]`);
					}
				}
			}
			// Recurse into nested widgets (Frames)
			if (w.widget) await processWidgets(w.widget);
			if (w.widgets) await processWidgets(w.widgets);
		}
	};

	// Support both OH 1.x 'widget' and OH 3.x 'widgets'
	await processWidgets(page?.widgets || page?.widget);
}

// Compute delta response for a sitemap URL (used by both HTTP and WS)
async function computeDeltaResponse(url, since) {
	// Parse the URL to extract path and query params
	// url format: /rest/sitemaps/home/0100?type=json or similar
	const parsed = new URL(url, 'http://localhost');
	const sitemapPath = parsed.pathname.replace(/^\/rest/, '');

	if (!sitemapPath.startsWith('/sitemaps/')) {
		throw new Error('Invalid sitemap path');
	}

	const params = parsed.searchParams;
	params.delete('delta');
	params.delete('since');
	if (!params.has('type')) params.set('type', 'json');

	const upstreamPath = `/rest${sitemapPath}${params.toString() ? `?${params.toString()}` : ''}`;

	const body = await fetchOpenhab(upstreamPath);
	if (!body.ok) {
		throw new Error(`Upstream error: ${body.status}`);
	}

	let page;
	try {
		page = JSON.parse(body.body);
	} catch {
		throw new Error('Non-JSON response from openHAB');
	}

	// Apply group state overrides (calculate state from member items)
	await applyGroupStateOverrides(page);

	const cacheKey = `${sitemapPath}?${params.toString()}`;
	const snapshot = buildSnapshot(page);
	const cached = findDeltaMatch(cacheKey, since);
	const canDelta = cached && cached.structureHash === snapshot.structureHash;

	if (!canDelta) {
		setDeltaCache(cacheKey, snapshot);
		return { delta: false, hash: snapshot.hash, page };
	}

	const changes = [];
	for (const [key, current] of snapshot.entryMap.entries()) {
		const prev = cached.entryMap.get(key);
		if (!prev) {
			setDeltaCache(cacheKey, snapshot);
			return { delta: false, hash: snapshot.hash, page };
		}
		if (
			prev.label !== current.label ||
			prev.state !== current.state ||
			prev.valuecolor !== current.valuecolor ||
			prev.icon !== current.icon ||
			prev.mappings !== current.mappings
		) {
			changes.push(current);
		}
	}

	setDeltaCache(cacheKey, snapshot);
	return { delta: true, hash: snapshot.hash, title: snapshot.title, changes };
}

function ensureDir(dirPath) {
	if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function purgeOldIconCache() {
	if (!fs.existsSync(ICON_CACHE_ROOT)) return;
	const entries = fs.readdirSync(ICON_CACHE_ROOT, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name === liveConfig.iconVersion) continue;
		const target = path.join(ICON_CACHE_ROOT, entry.name);
		try {
			if (fs.rmSync) fs.rmSync(target, { recursive: true, force: true });
			else fs.rmdirSync(target, { recursive: true });
		} catch (err) {
			logMessage(`Failed to purge icon cache ${target}: ${err.message || err}`);
		}
	}
}

function execFileAsync(cmd, args) {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, (err, stdout, stderr) => {
			if (err) {
				const msg = stderr ? stderr.toString() : '';
				err.message = msg || err.message;
				reject(err);
				return;
			}
			resolve(stdout);
		});
	});
}

let iconConvertActive = 0;
const iconConvertQueue = [];

function enqueueIconConvert(task) {
	return new Promise((resolve, reject) => {
		iconConvertQueue.push({ task, resolve, reject });
		drainIconConvertQueue();
	});
}

function drainIconConvertQueue() {
	const concurrency = Math.max(1, Math.floor(
		configNumber(liveConfig.iconCacheConcurrency, ICON_CACHE_CONCURRENCY)
	));
	while (iconConvertActive < concurrency && iconConvertQueue.length) {
		const next = iconConvertQueue.shift();
		if (!next) return;
		iconConvertActive += 1;
		Promise.resolve()
			.then(next.task)
			.then(next.resolve, next.reject)
			.finally(() => {
				iconConvertActive -= 1;
				drainIconConvertQueue();
			});
	}
}

function buildTargetUrl(baseUrl, pathname) {
	const base = new URL(baseUrl);
	const basePath = base.pathname && base.pathname !== '/' ? base.pathname.replace(/\/$/, '') : '';
	const [pathOnly, search = ''] = pathname.split('?');
	const url = new URL(baseUrl);
	url.pathname = `${basePath}${pathOnly}`;
	url.search = search ? `?${search}` : '';
	return url.toString();
}

function decodeCompressedBody(body, encoding) {
	if (!encoding) return body;
	if (encoding === 'gzip') return zlib.gunzipSync(body);
	if (encoding === 'deflate') return zlib.inflateSync(body);
	if (encoding === 'br' && zlib.brotliDecompressSync) return zlib.brotliDecompressSync(body);
	return body;
}

function isImageContentType(contentType) {
	if (!contentType) return false;
	const lower = contentType.toLowerCase();
	return lower.startsWith('image/') || lower.includes('svg+xml') || lower.includes('application/octet-stream');
}

function fetchBinaryFromUrl(targetUrl, headers, redirectsLeft = 3) {
	return new Promise((resolve, reject) => {
		let url;
		try {
			url = new URL(targetUrl);
		} catch (err) {
			reject(err);
			return;
		}

		const isHttps = url.protocol === 'https:';
		const client = isHttps ? https : http;
		const requestHeaders = { ...headers, 'User-Agent': liveConfig.userAgent };
		const req = client.request({
			method: 'GET',
			hostname: url.hostname,
			port: url.port || (isHttps ? 443 : 80),
			path: `${url.pathname}${url.search}`,
			headers: requestHeaders,
		}, (res) => {
			const status = res.statusCode || 500;
			const location = res.headers.location;
			if (location && redirectsLeft > 0 && REDIRECT_STATUS.has(status)) {
				res.resume();
				const nextUrl = new URL(location, url);
				resolve(fetchBinaryFromUrl(nextUrl.toString(), headers, redirectsLeft - 1));
				return;
			}

			const chunks = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => {
				let body = Buffer.concat(chunks);
				const encoding = safeText(res.headers['content-encoding']).toLowerCase();
				try {
					body = decodeCompressedBody(body, encoding);
				} catch (err) {
					reject(err);
					return;
				}
				resolve({
					status,
					ok: status >= 200 && status < 300,
					body,
					contentType: safeText(res.headers['content-type']),
					contentEncoding: encoding,
					url: url.toString(),
				});
			});
		});

		req.on('error', reject);
		req.end();
	});
}

function pipeStreamingProxy(targetUrl, expressRes, headers = {}) {
	return new Promise((resolve, reject) => {
		let url;
		try {
			url = new URL(targetUrl);
		} catch (err) {
			reject(err);
			return;
		}

		const isHttps = url.protocol === 'https:';
		const client = isHttps ? https : http;
		const requestHeaders = { ...headers, 'User-Agent': liveConfig.userAgent };

		const req = client.request({
			method: 'GET',
			hostname: url.hostname,
			port: url.port || (isHttps ? 443 : 80),
			path: `${url.pathname}${url.search}`,
			headers: requestHeaders,
		}, (upstreamRes) => {
			const status = upstreamRes.statusCode || 502;
			const contentType = safeText(upstreamRes.headers['content-type']);

			expressRes.status(status);
			if (contentType) expressRes.setHeader('Content-Type', contentType);
			expressRes.setHeader('Cache-Control', 'no-store');
			expressRes.setHeader('Connection', 'close');

			upstreamRes.pipe(expressRes);

			upstreamRes.on('end', () => resolve({ streamed: true }));
			upstreamRes.on('error', (err) => {
				logMessage(`Stream error: ${err.message}`);
				resolve({ streamed: true, error: err });
			});
		});

		req.on('error', reject);

		expressRes.on('close', () => {
			req.destroy();
		});

		req.end();
	});
}

function fetchOpenhab(pathname) {
	return new Promise((resolve, reject) => {
		const target = new URL(liveConfig.ohTarget);
		const isHttps = target.protocol === 'https:';
		const basePath = target.pathname && target.pathname !== '/' ? target.pathname.replace(/\/$/, '') : '';
		const reqPath = `${basePath}${pathname}`;
		const client = isHttps ? https : http;
		const headers = { Accept: 'application/json', 'User-Agent': liveConfig.userAgent };
		const ah = authHeader();
		if (ah) headers.Authorization = ah;

		const req = client.request({
			method: 'GET',
			hostname: target.hostname,
			port: target.port || (isHttps ? 443 : 80),
			path: reqPath,
			headers,
		}, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { body += chunk; });
			res.on('end', () => resolve({
				status: res.statusCode || 500,
				ok: res.statusCode && res.statusCode >= 200 && res.statusCode < 300,
				body,
			}));
		});

		if (OPENHAB_REQUEST_TIMEOUT_MS > 0) {
			req.setTimeout(OPENHAB_REQUEST_TIMEOUT_MS, () => {
				req.destroy(new Error('openHAB request timed out'));
			});
		}
		req.on('error', reject);
		req.end();
	});
}

function sendOpenhabCommand(itemName, command) {
	return new Promise((resolve, reject) => {
		const target = new URL(liveConfig.ohTarget);
		const isHttps = target.protocol === 'https:';
		const basePath = target.pathname && target.pathname !== '/' ? target.pathname.replace(/\/$/, '') : '';
		const reqPath = `${basePath}/rest/items/${encodeURIComponent(itemName)}`;
		const client = isHttps ? https : http;
		const headers = {
			'Content-Type': 'text/plain',
			'Accept': 'application/json',
			'User-Agent': liveConfig.userAgent,
		};
		const ah = authHeader();
		if (ah) headers.Authorization = ah;

		const req = client.request({
			method: 'POST',
			hostname: target.hostname,
			port: target.port || (isHttps ? 443 : 80),
			path: reqPath,
			headers,
		}, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { body += chunk; });
			res.on('end', () => resolve({
				status: res.statusCode || 500,
				ok: res.statusCode && res.statusCode >= 200 && res.statusCode < 300,
				body,
			}));
		});

		req.on('error', reject);
		req.write(String(command));
		req.end();
	});
}

function sendCmdApiCommand(itemName, command) {
	return new Promise((resolve, reject) => {
		const target = new URL(liveConfig.ohTarget);
		const isHttps = target.protocol === 'https:';
		const basePath = target.pathname && target.pathname !== '/' ? target.pathname.replace(/\/$/, '') : '';
		const reqPath = `${basePath}/rest/items/${encodeURIComponent(itemName)}`;
		const client = isHttps ? https : http;
		const headers = {
			'Content-Type': 'text/plain',
			'Accept': 'application/json',
			'User-Agent': liveConfig.userAgent,
		};
		const ah = authHeader();
		if (ah) headers.Authorization = ah;

		const req = client.request({
			method: 'POST',
			hostname: target.hostname,
			port: target.port || (isHttps ? 443 : 80),
			path: reqPath,
			headers,
		}, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { body += chunk; });
			res.on('end', () => resolve({
				status: res.statusCode || 500,
				ok: res.statusCode && res.statusCode >= 200 && res.statusCode < 300,
				body,
			}));
		});

		req.setTimeout(CMDAPI_TIMEOUT_MS, () => {
			req.destroy(new Error('CMD API request timed out'));
		});
		req.on('error', reject);
		req.write(String(command));
		req.end();
	});
}

function callAnthropicApi(requestBody) {
	return new Promise((resolve, reject) => {
		if (!ANTHROPIC_API_KEY) {
			reject(new Error('Anthropic API key not configured'));
			return;
		}

		const postData = JSON.stringify(requestBody);

		const req = https.request({
			hostname: 'api.anthropic.com',
			port: 443,
			path: '/v1/messages',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': ANTHROPIC_API_KEY,
				'anthropic-version': '2023-06-01',
				'Content-Length': Buffer.byteLength(postData),
			},
		}, (res) => {
			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', () => {
				if (res.statusCode >= 200 && res.statusCode < 300) {
					try {
						resolve(JSON.parse(data));
					} catch {
						reject(new Error('Invalid JSON response from Anthropic'));
					}
				} else {
					reject(new Error(`Anthropic API error ${res.statusCode}`));
				}
			});
		});

		req.on('error', reject);
		req.setTimeout(30000, () => {
			req.destroy();
			reject(new Error('Anthropic API timeout'));
		});
		req.write(postData);
		req.end();
	});
}

let aiStructureMapCache = null;
let aiStructureMapMtime = 0;

function getAiStructureMap() {
	try {
		if (!fs.existsSync(AI_STRUCTURE_MAP_WRITABLE)) return null;
		const stat = fs.statSync(AI_STRUCTURE_MAP_WRITABLE);
		if (aiStructureMapCache && stat.mtimeMs === aiStructureMapMtime) {
			return aiStructureMapCache;
		}
		const data = JSON.parse(fs.readFileSync(AI_STRUCTURE_MAP_WRITABLE, 'utf8'));
		aiStructureMapCache = data;
		aiStructureMapMtime = stat.mtimeMs;
		return data;
	} catch {
		return null;
	}
}

async function refreshSitemapCache(options = {}) {
	let body;
	try {
		body = await fetchOpenhab('/rest/sitemaps?type=json');
	} catch (err) {
		logMessage(`[Sitemap] Cache refresh failed: ${err.message || err}`);
		return false;
	}

	if (!body || !body.ok) {
		logMessage('[Sitemap] Cache refresh failed: upstream error');
		return false;
	}

	let data;
	try {
		data = JSON.parse(body.body);
	} catch {
		logMessage('[Sitemap] Cache refresh failed: non-JSON response');
		return false;
	}

	const sitemaps = extractSitemaps(data);
	const first = Array.isArray(sitemaps) ? sitemaps[0] : null;
	if (!first) return false;

	const name = safeText(first?.name || first?.id || first?.homepage?.link?.split('/').pop() || '');
	if (!name) return false;
	const title = safeText(first?.label || first?.title || name);
	const homepage = safeText(first?.homepage?.link || first?.link || '');

	backgroundState.sitemap = {
		name,
		title,
		homepage,
		updatedAt: Date.now(),
		ok: true,
	};

	if (!options.skipAtmosphereResubscribe) {
		const nameChanged = lastAtmosphereSitemapName
			&& backgroundState.sitemap.name
			&& lastAtmosphereSitemapName !== backgroundState.sitemap.name;
		if (liveConfig.wsMode === 'atmosphere' && wss.clients.size > 0) {
			if (atmosphereNeedsSitemapRefresh || nameChanged) {
				const reason = nameChanged ? 'sitemap changed' : 'sitemap cache refreshed';
				atmosphereNeedsSitemapRefresh = false;
				scheduleAtmosphereResubscribe(reason);
			}
		} else {
			atmosphereNeedsSitemapRefresh = false;
		}
	}

	// Trigger initial video preview capture on first successful sitemap pull
	if (!videoPreviewInitialCaptureDone && VIDEO_PREVIEW_INTERVAL_MS > 0) {
		videoPreviewInitialCaptureDone = true;
		captureVideoPreviewsTask().catch((err) => {
			logMessage(`Initial video preview capture failed: ${err.message || err}`);
		});
	}

	return true;
}

function fetchOpenhabBinary(pathname, options = {}) {
	const baseUrl = options.baseUrl || liveConfig.ohTarget;
	const headers = { Accept: 'image/*,*/*;q=0.8', 'User-Agent': liveConfig.userAgent };
	const ah = authHeader();
	if (ah) headers.Authorization = ah;
	return fetchBinaryFromUrl(buildTargetUrl(baseUrl, pathname), headers);
}

async function buildIconCache(cachePath, sourcePath, sourceExt) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-icon-'));
	const srcPath = path.join(tmpDir, `src${sourceExt || '.img'}`);
	const iconSize = configNumber(liveConfig.iconSize, ICON_SIZE);
	try {
		const res = await fetchOpenhabBinary(sourcePath);
		if (!res.ok || !isImageContentType(res.contentType)) {
			const reason = !res.ok ? `status ${res.status}` : `content-type ${res.contentType || 'unknown'}`;
			throw new Error(`openHAB icon fetch failed (${reason})`);
		}
		fs.writeFileSync(srcPath, res.body);
		ensureDir(path.dirname(cachePath));
		await enqueueIconConvert(() => execFileAsync(BIN_CONVERT, [
			srcPath,
			'-resize', `${iconSize}x${iconSize}`,
			'-background', 'none',
			'-gravity', 'center',
			'-extent', `${iconSize}x${iconSize}`,
			`PNG32:${cachePath}`,
		]));
	} finally {
		try {
			if (fs.rmSync) fs.rmSync(tmpDir, { recursive: true, force: true });
			else fs.rmdirSync(tmpDir, { recursive: true });
		} catch {}
	}
}

async function getCachedIcon(cachePath, sourcePath, sourceExt) {
	if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath);
	if (iconInflight.has(cachePath)) return iconInflight.get(cachePath);
	const promise = (async () => {
		await buildIconCache(cachePath, sourcePath, sourceExt);
		return fs.readFileSync(cachePath);
	})();
	iconInflight.set(cachePath, promise);
	try {
		return await promise;
	} finally {
		iconInflight.delete(cachePath);
	}
}

const app = express();
app.disable('x-powered-by');
app.use(morgan('combined', {
	skip: (req, res) => shouldSkipAccessLog(res),
	stream: {
		write: (line) => logAccess(line),
	},
}));

// Slow query logging middleware (threshold checked dynamically for hot reload)
app.use((req, res, next) => {
	const threshold = liveConfig.slowQueryMs;
	if (threshold > 0) {
		const start = Date.now();
		res.once('finish', () => {
			const duration = Date.now() - start;
			if (duration >= threshold) {
				logMessage(`[Perf] Slow request (${duration}ms): ${req.method} ${req.originalUrl}`);
			}
		});
	}
	next();
});

app.use((req, res, next) => {
	if (!configRestartScheduled) {
		const currentMtime = readConfigLocalMtime();
		if (currentMtime !== lastConfigMtime) {
			lastConfigMtime = currentMtime;
			const needsRestart = handleConfigChange();
			if (needsRestart) {
				res.once('finish', maybeTriggerRestart);
				res.once('close', maybeTriggerRestart);
			}
		}
	}
	next();
});
app.use((req, res, next) => {
	// Check allowSubnets using socket IP
	const allowAll = Array.isArray(liveConfig.allowSubnets) && liveConfig.allowSubnets.some((entry) => isAllowAllSubnet(entry));
	if (!allowAll) {
		const socketIp = getSocketIp(req);
		if (!socketIp || !ipInAnySubnet(socketIp, liveConfig.allowSubnets)) {
			const clientIp = getRemoteIp(req);
			logMessage(`Blocked request from ${clientIp || 'unknown'} (socket: ${socketIp || 'unknown'}) for ${req.method} ${req.originalUrl}`);
			res.status(403).type('text/plain').send('Forbidden');
			return;
		}
	}
	// Check denyXFFSubnets - only when X-Forwarded-For header is present
	if (liveConfig.trustProxy && Array.isArray(liveConfig.denyXFFSubnets) && liveConfig.denyXFFSubnets.length > 0) {
		const xff = req.headers?.['x-forwarded-for'];
		if (xff) {
			const xffIp = normalizeRemoteIp(safeText(xff).split(',')[0].trim());
			if (xffIp && ipInAnySubnet(xffIp, liveConfig.denyXFFSubnets)) {
				logMessage(`Blocked request from denied XFF subnet ${xffIp} for ${req.method} ${req.originalUrl}`);
				res.status(403).type('text/plain').send('Forbidden');
				return;
			}
		}
	}
	next();
});

// /CMD endpoint - send commands to OpenHAB items (restricted to cmdapi.allowedSubnets)
app.get('/CMD', async (req, res) => {
	// Check if cmdapi is enabled
	if (!liveConfig.cmdapiEnabled) {
		res.status(404).json({ result: 'failed', error: 'CMD API not enabled' });
		return;
	}

	// Check IP allowlist (separate from main allowSubnets)
	const clientIp = getRemoteIp(req);
	if (!clientIp || !ipInAnySubnet(clientIp, liveConfig.cmdapiAllowedSubnets)) {
		logMessage(`[CMD] Blocked request from ${clientIp || 'unknown'} - not in allowed subnets`);
		res.status(403).json({ result: 'failed', error: 'IP not allowed' });
		return;
	}

	// Parse query string: /CMD?Item=state
	const queryKeys = Object.keys(req.query);
	if (queryKeys.length !== 1) {
		res.status(400).json({ result: 'failed', error: 'Invalid query format - expected ?Item=state' });
		return;
	}

	const itemName = queryKeys[0];
	const state = safeText(req.query[itemName]);

	// Validate item name (alphanumeric, underscore, hyphen, 1-100 chars)
	if (!itemName || !/^[a-zA-Z0-9_-]{1,100}$/.test(itemName)) {
		res.status(400).json({ result: 'failed', error: 'Invalid item name' });
		return;
	}

	// Check if item is in allowlist
	const allowedItems = liveConfig.cmdapiAllowedItems;
	const itemAllowed = Array.isArray(allowedItems) && allowedItems.length > 0 &&
		(allowedItems.includes('*') || allowedItems.includes(itemName));
	if (!itemAllowed) {
		logMessage(`[CMD] Blocked request for item ${itemName} - not in allowed items`);
		res.status(403).json({ result: 'failed', error: 'Item not allowed' });
		return;
	}

	// Validate state (non-empty, max 500 chars, no control characters)
	if (!state || state.length > 500) {
		res.status(400).json({ result: 'failed', error: 'Invalid state value' });
		return;
	}
	if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(state)) {
		res.status(400).json({ result: 'failed', error: 'Invalid characters in state' });
		return;
	}

	try {
		const result = await sendCmdApiCommand(itemName, state);
		if (result.ok) {
			logMessage(`[CMD] ${clientIp} -> ${itemName}=${state} -> success`);
			res.json({ result: 'success' });
		} else {
			logMessage(`[CMD] ${clientIp} -> ${itemName}=${state} -> failed (${result.status})`);
			res.json({ result: 'failed', error: `OpenHAB returned ${result.status}` });
		}
	} catch (err) {
		logMessage(`[CMD] ${clientIp} -> ${itemName}=${state} -> error: ${err.message}`);
		res.json({ result: 'failed', error: 'Request failed' });
	}
});

// HTML auth login endpoint - must be before auth middleware
app.post('/api/auth/login', express.json(), (req, res) => {
	// Only available in HTML auth mode
	if (liveConfig.authMode !== 'html') {
		res.status(404).type('text/plain').send('Not found');
		return;
	}

	// Validate CSRF token
	if (!validateCsrfToken(req)) {
		res.status(403).json({ error: 'Invalid CSRF token' });
		return;
	}

	const { username, password } = req.body || {};

	// Validate username format (alphanumeric, underscore, dash, 1-50 chars)
	if (!username || typeof username !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(username)) {
		res.status(400).json({ error: 'Invalid username format' });
		return;
	}

	// Validate password is a string with reasonable length
	if (!password || typeof password !== 'string' || password.length > 200) {
		res.status(400).json({ error: 'Invalid password format' });
		return;
	}

	const clientIp = getRemoteIp(req);
	const lockKey = getLockoutKey(clientIp);

	// Check lockout
	const lockout = getAuthLockout(lockKey);
	if (lockout && lockout.lockUntil) {
		const remaining = Math.max(0, Math.ceil((lockout.lockUntil - Date.now()) / 1000));
		res.status(429).json({
			error: 'Too many failed attempts',
			lockedOut: true,
			remainingSeconds: remaining,
		});
		return;
	}

	// Validate credentials
	const { users, disabledUsers } = loadAuthUsers();
	if (!users || Object.keys(users).length === 0) {
		res.status(500).json({ error: 'Auth config unavailable' });
		return;
	}

	if (!username || !password || !Object.prototype.hasOwnProperty.call(users, username) || users[username] !== password) {
		const notifyIp = clientIp || '';
		maybeNotifyAuthFailure(notifyIp);
		const entry = recordAuthFailure(lockKey);
		if (entry && entry.lockUntil) {
			logMessage(`Auth lockout triggered for ${lockKey} after ${entry.count} failures (HTML login)`);
			res.status(429).json({
				error: 'Too many failed attempts',
				lockedOut: true,
				remainingSeconds: Math.max(0, Math.ceil((entry.lockUntil - Date.now()) / 1000)),
			});
			return;
		}
		res.status(401).json({ error: 'Invalid credentials' });
		return;
	}

	// Check if user is disabled
	if (disabledUsers.has(username)) {
		res.status(500).end();
		return;
	}

	// Success - clear failed attempts and set auth cookie
	clearAuthFailures(lockKey);
	// Create or reuse session
	let sessionId = getSessionCookie(req);
	if (!sessionId || !sessions.getSession(sessionId)) {
		sessionId = sessions.generateSessionId();
		sessions.createSession(sessionId, username, sessions.getDefaultSettings(), clientIp);
	} else {
		sessions.updateUsername(sessionId, username);
	}
	setAuthCookie(res, username, sessionId, users[username]);
	clearSessionCookie(res); // Remove legacy ohSession cookie
	logMessage(`[Auth] Login success for user: ${username} from ${clientIp || 'unknown'}`);
	res.json({ success: true });
});

app.use((req, res, next) => {
	const clientIp = getRemoteIp(req);
	if (clientIp) req.ohProxyClientIp = clientIp;
	// Manifest requires matching referrer for PWA install
	if (isAuthExemptPath(req) && hasMatchingReferrer(req)) {
		req.ohProxyAuth = 'unauthenticated';
		req.ohProxyUser = '';
		return next();
	}

	// Auth is always required - handle based on auth mode
	const { users, disabledUsers } = loadAuthUsers();
	if (!users || Object.keys(users).length === 0) {
		res.status(500).type('text/plain').send('Auth config unavailable');
		return;
	}

	// HTML auth mode
	if (liveConfig.authMode === 'html') {
		// Check if already authenticated via cookie
		if (liveConfig.authCookieKey && liveConfig.authCookieName) {
			const cookieResult = getAuthCookieUser(req, users, liveConfig.authCookieKey);
			if (cookieResult) {
				// Check if user is disabled
				if (disabledUsers.has(cookieResult.user)) {
					res.status(500).end();
					return;
				}
				req.ohProxyAuth = 'authenticated';
				req.ohProxyUser = cookieResult.user;
				req._cookieResult = cookieResult; // Store for session middleware
				// Handle legacy cookie upgrade
				if (cookieResult.isLegacy) {
					const clientIp = req.ohProxyClientIp || null;
					const oldSessionId = getSessionCookie(req);
					let sessionId;
					if (oldSessionId && sessions.getSession(oldSessionId)) {
						sessionId = oldSessionId;
						sessions.updateUsername(sessionId, cookieResult.user);
					} else {
						sessionId = sessions.generateSessionId();
						sessions.createSession(sessionId, cookieResult.user, sessions.getDefaultSettings(), clientIp);
					}
					setAuthCookie(res, cookieResult.user, sessionId, users[cookieResult.user]);
					clearSessionCookie(res);
				}
				return next();
			}
			// Clear invalid cookie if present
			if (getCookieValue(req, liveConfig.authCookieName)) {
				clearAuthCookie(res);
			}
		}

		// Allow login.js (versioned) and fonts to load (needed by login page)
		if (/^\/login\.v[\w.-]+\.js$/i.test(req.path) || req.path.startsWith('/fonts/')) {
			req.ohProxyAuth = 'unauthenticated';
			req.ohProxyUser = '';
			return next();
		}

		// Not authenticated - check request type
		const acceptHeader = req.headers.accept || '';
		const reqPath = req.path.toLowerCase();

		// Serve login page only for HTML page requests (not static assets)
		// Browser page loads typically send Accept: text/html as first preference
		const isHtmlPageRequest = acceptHeader.includes('text/html') &&
			!reqPath.endsWith('.js') &&
			!reqPath.endsWith('.css') &&
			!reqPath.endsWith('.png') &&
			!reqPath.endsWith('.jpg') &&
			!reqPath.endsWith('.ico') &&
			!reqPath.endsWith('.svg') &&
			!reqPath.endsWith('.woff') &&
			!reqPath.endsWith('.woff2');

		if (isHtmlPageRequest) {
			// Redirect all paths to / for login
			if (req.path !== '/') {
				res.redirect('/');
				return;
			}
			// Set CSRF cookie for login page
			const csrfToken = generateCsrfToken();
			setCsrfCookie(res, csrfToken);
			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			res.send(renderLoginHtml());
			return;
		}

		// Static assets and API requests without auth - return 401
		res.status(401).json({ error: 'Authentication required' });
		return;
	}

	// Basic auth mode (default)
	const lockKey = getLockoutKey(clientIp);
	const lockout = getAuthLockout(lockKey);
	if (lockout && lockout.lockUntil) {
		const remaining = Math.max(0, Math.ceil((lockout.lockUntil - Date.now()) / 1000));
		logMessage(`Auth lockout active for ${lockKey} (${remaining}s remaining)`);
		res.status(429).type('text/plain').send('Too many authentication attempts');
		return;
	}
	const [user, pass] = getBasicAuthCredentials(req);
	let authenticatedUser = null;
	if (user) {
		if (!Object.prototype.hasOwnProperty.call(users, user) || users[user] !== pass) {
			const notifyIp = clientIp || '';
			maybeNotifyAuthFailure(notifyIp);
			const entry = recordAuthFailure(lockKey);
			if (entry && entry.lockUntil) {
				logMessage(`Auth lockout triggered for ${lockKey} after ${entry.count} failures`);
				res.status(429).type('text/plain').send('Too many authentication attempts');
				return;
			}
			sendAuthRequired(res);
			return;
		}
		authenticatedUser = user;
		req._basicAuthUsed = true;
	} else if (liveConfig.authCookieKey && liveConfig.authCookieName) {
		const cookieResult = getAuthCookieUser(req, users, liveConfig.authCookieKey);
		if (cookieResult) {
			authenticatedUser = cookieResult.user;
			req._cookieResult = cookieResult;
		} else if (getCookieValue(req, liveConfig.authCookieName)) {
			clearAuthCookie(res);
		}
	}
	if (!authenticatedUser) {
		sendAuthRequired(res);
		return;
	}
	// Check if user is disabled
	if (disabledUsers.has(authenticatedUser)) {
		res.status(500).end();
		return;
	}
	clearAuthFailures(lockKey);
	// Create or reuse session
	const cookieResult = req._cookieResult;
	const oldSessionId = getSessionCookie(req);
	let sessionId;
	if (cookieResult && !cookieResult.isLegacy) {
		// Already has new format cookie with embedded sessionId
		sessionId = cookieResult.sessionId;
	} else if (oldSessionId && sessions.getSession(oldSessionId)) {
		// Reuse existing session
		sessionId = oldSessionId;
		sessions.updateUsername(sessionId, authenticatedUser);
	} else {
		// Create new session
		sessionId = sessions.generateSessionId();
		sessions.createSession(sessionId, authenticatedUser, sessions.getDefaultSettings(), clientIp);
	}
	setAuthCookie(res, authenticatedUser, sessionId, users[authenticatedUser]);
	if (req._basicAuthUsed || (cookieResult && cookieResult.isLegacy)) {
		clearSessionCookie(res);
	}
	req.ohProxyAuth = 'authenticated';
	req.ohProxyUser = authenticatedUser;
	next();
});
// User validation middleware - verify authenticated user still exists
app.use((req, res, next) => {
	// Only check authenticated users
	if (req.ohProxyAuth !== 'authenticated' || !req.ohProxyUser) {
		return next();
	}
	// Verify user still exists in database
	const user = sessions.getUser(req.ohProxyUser);
	if (!user) {
		// User was deleted - clear auth and redirect to login
		clearAuthCookie(res);
		req.ohProxyAuth = 'unauthenticated';
		req.ohProxyUser = '';
		// For API requests, return 401
		if (req.path.startsWith('/api/')) {
			res.status(401).json({ error: 'account-deleted' });
			return;
		}
		// For page requests, redirect to /
		res.redirect('/');
		return;
	}
	next();
});
// Session middleware - runs after auth, assigns/loads session for all authorized users
app.use((req, res, next) => {
	try {
		const clientIp = req.ohProxyClientIp || null;
		// Get sessionId from consolidated cookie (new format) or legacy ohSession cookie
		const cookieResult = req._cookieResult;
		let sessionId = (cookieResult && !cookieResult.isLegacy) ? cookieResult.sessionId : getSessionCookie(req);

		if (sessionId) {
			let session = sessions.getSession(sessionId);
			if (!session && req.ohProxyAuth === 'authenticated' && req.ohProxyUser) {
				// Session missing but user authenticated - recreate session
				sessions.createSession(sessionId, req.ohProxyUser, sessions.getDefaultSettings(), clientIp);
				session = sessions.getSession(sessionId);
			}
			if (session) {
				// Valid session found - touch it and attach to request
				sessions.touchSession(sessionId, clientIp);
				req.ohProxySession = session;
				req.ohProxySession.lastIp = clientIp || session.lastIp;
			} else {
				req.ohProxySession = null;
			}
		} else {
			// No session available
			req.ohProxySession = null;
		}
	} catch (err) {
		logMessage(`Session error: ${err.message}`);
		// Continue without session on error
	}
	next();
});
app.use((req, res, next) => {
	const info = getAuthInfo(req);
	setAuthResponseHeaders(res, info);
	next();
});
app.use((req, res, next) => {
	applySecurityHeaders(req, res);
	next();
});
app.use(compression());

app.get('/config.js', (req, res) => {
	res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	const clientConfig = liveConfig.clientConfig && typeof liveConfig.clientConfig === 'object' ? liveConfig.clientConfig : {};

	// Get user role if authenticated
	let userRole = null;
	if (req.ohProxyUser) {
		const user = sessions.getUser(req.ohProxyUser);
		userRole = user?.role || null;
	}

	res.send(`window.__OH_CONFIG__=${JSON.stringify({
		iconVersion: liveConfig.iconVersion,
		client: clientConfig,
		webviewNoProxy: liveConfig.webviewNoProxy,
		widgetGlowRules: sessions.getAllGlowRules(),
		widgetVisibilityRules: sessions.getAllVisibilityRules(),
		widgetVideoConfigs: sessions.getAllVideoConfigs(),
		widgetIframeConfigs: sessions.getAllIframeConfigs(),
		widgetProxyCacheConfigs: sessions.getAllProxyCacheConfigs(),
		widgetSectionGlowConfigs: sessions.getAllSectionGlowConfigs(),
		userRole: userRole,
	})};`);
});

// Session settings API
app.get('/api/settings', (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	const session = req.ohProxySession;
	if (!session) {
		res.json(sessions.getDefaultSettings());
		return;
	}
	res.json(session.settings || sessions.getDefaultSettings());
});

app.post('/api/settings', express.json(), (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	const session = req.ohProxySession;
	if (!session) {
		res.status(400).json({ error: 'No session' });
		return;
	}
	const newSettings = req.body;
	if (!newSettings || typeof newSettings !== 'object' || Array.isArray(newSettings)) {
		res.status(400).json({ error: 'Invalid settings' });
		return;
	}
	// Whitelist allowed settings keys
	const allowedKeys = ['slimMode', 'theme', 'fontSize', 'compactView', 'showLabels', 'darkMode', 'paused'];
	const sanitized = {};
	for (const key of allowedKeys) {
		if (key in newSettings) {
			const val = newSettings[key];
			// Only allow primitive values (string, number, boolean)
			if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
				sanitized[key] = val;
			}
		}
	}
	// Merge with existing settings
	const merged = { ...session.settings, ...sanitized };
	const updated = sessions.updateSettings(session.clientId, merged);
	if (!updated) {
		res.status(500).json({ error: 'Failed to update settings' });
		return;
	}
	res.json({ ok: true, settings: merged });
});

// Heartbeat endpoint for connection liveness check
app.get('/api/heartbeat', (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache, no-store');
	res.json({ ok: true, ts: Date.now() });
});

// Ping endpoint for latency measurement
app.get('/api/ping', (req, res) => {
	res.setHeader('Content-Type', 'text/plain');
	res.setHeader('Cache-Control', 'no-cache, no-store');
	res.send('pong');
});

// JavaScript error logging endpoint (auth required)
app.post('/api/jslog', express.json(), (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache, no-store');
	// Require authentication
	const session = req.ohProxySession;
	if (!session) {
		res.status(401).json({ error: 'Unauthorized' });
		return;
	}
	// Check if JS logging is enabled
	if (!JS_LOG_FILE) {
		res.json({ ok: true, logged: false });
		return;
	}
	// Sanitize and validate input
	const body = req.body;
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		res.status(400).json({ error: 'Invalid request body' });
		return;
	}
	const message = typeof body.message === 'string' ? body.message.slice(0, 2000) : '';
	const url = typeof body.url === 'string' ? body.url.slice(0, 500) : '';
	const line = typeof body.line === 'number' ? Math.floor(body.line) : 0;
	const col = typeof body.col === 'number' ? Math.floor(body.col) : 0;
	const stack = typeof body.stack === 'string' ? body.stack.slice(0, 5000) : '';
	const userAgent = typeof body.userAgent === 'string' ? body.userAgent.slice(0, 300) : '';
	if (!message && !stack) {
		res.status(400).json({ error: 'No error message or stack provided' });
		return;
	}
	// Build log entry
	const ip = getRemoteIp(req) || 'unknown';
	const user = session.username || 'anonymous';
	const logParts = [`[JS] ${ip} ${user}`];
	if (message) logParts.push(`msg="${message.replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`);
	if (url) logParts.push(`url="${url}"`);
	if (line) logParts.push(`line=${line}`);
	if (col) logParts.push(`col=${col}`);
	if (userAgent) logParts.push(`ua="${userAgent.replace(/"/g, '\\"')}"`);
	if (stack) logParts.push(`stack="${stack.replace(/"/g, '\\"').replace(/[\r\n]+/g, '\\n')}"`);
	logJsError(logParts.join(' '));
	res.json({ ok: true, logged: true });
});

// Widget card config API (admin only)
app.get('/api/card-config/:widgetId', (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	// Admin only
	const user = req.ohProxyUser ? sessions.getUser(req.ohProxyUser) : null;
	if (user?.role !== 'admin') {
		res.status(403).json({ error: 'Admin access required' });
		return;
	}
	const widgetId = safeText(req.params.widgetId);
	if (!widgetId) {
		res.status(400).json({ error: 'Missing widgetId' });
		return;
	}
	const rules = sessions.getGlowRules(widgetId);
	res.json({ widgetId, rules });
});

app.post('/api/card-config', express.json(), (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	// Admin only
	const user = req.ohProxyUser ? sessions.getUser(req.ohProxyUser) : null;
	if (user?.role !== 'admin') {
		res.status(403).json({ error: 'Admin access required' });
		return;
	}

	const { widgetId, rules, visibility, defaultMuted, iframeHeight, proxyCacheSeconds, sectionGlow } = req.body || {};
	if (!widgetId || typeof widgetId !== 'string' || widgetId.length > 200) {
		res.status(400).json({ error: 'Missing or invalid widgetId' });
		return;
	}

	// Validate rules if provided
	if (rules !== undefined) {
		if (!Array.isArray(rules)) {
			res.status(400).json({ error: 'Rules must be an array' });
			return;
		}

		const validOperators = ['=', '!=', '>', '<', '>=', '<=', 'contains', '!contains', 'startsWith', 'endsWith', '*'];
		const validColors = ['green', 'orange', 'red'];
		for (const rule of rules) {
			if (!rule || typeof rule !== 'object') {
				res.status(400).json({ error: 'Each rule must be an object' });
				return;
			}
			if (!validOperators.includes(rule.operator)) {
				res.status(400).json({ error: `Invalid operator: ${rule.operator}` });
				return;
			}
			if (!validColors.includes(rule.color)) {
				res.status(400).json({ error: `Invalid color: ${rule.color}` });
				return;
			}
			if (rule.operator !== '*' && (rule.value === undefined || rule.value === null)) {
				res.status(400).json({ error: 'Value required for non-wildcard operator' });
				return;
			}
		}
	}

	// Validate visibility if provided
	if (visibility !== undefined) {
		const validVisibilities = ['all', 'normal', 'admin'];
		if (!validVisibilities.includes(visibility)) {
			res.status(400).json({ error: `Invalid visibility: ${visibility}` });
			return;
		}
	}

	// Validate defaultMuted if provided
	if (defaultMuted !== undefined && typeof defaultMuted !== 'boolean') {
		res.status(400).json({ error: 'defaultMuted must be a boolean' });
		return;
	}

	// Validate iframeHeight if provided (must be null, empty string, or positive integer)
	if (iframeHeight !== undefined && iframeHeight !== null && iframeHeight !== '') {
		const heightNum = parseInt(iframeHeight, 10);
		if (isNaN(heightNum) || heightNum < 0 || heightNum > 10000) {
			res.status(400).json({ error: 'iframeHeight must be empty or a positive integer (max 10000)' });
			return;
		}
	}

	// Validate proxyCacheSeconds if provided (must be null, empty string, or positive integer 0-86400)
	if (proxyCacheSeconds !== undefined && proxyCacheSeconds !== null && proxyCacheSeconds !== '') {
		const cacheNum = parseInt(proxyCacheSeconds, 10);
		if (isNaN(cacheNum) || cacheNum < 0 || cacheNum > 86400) {
			res.status(400).json({ error: 'proxyCacheSeconds must be empty or an integer 0-86400' });
			return;
		}
	}

	// Validate sectionGlow if provided
	if (sectionGlow !== undefined && typeof sectionGlow !== 'boolean') {
		res.status(400).json({ error: 'sectionGlow must be a boolean' });
		return;
	}

	// Save to database
	try {
		if (rules !== undefined) {
			sessions.setGlowRules(widgetId, rules);
		}
		if (visibility !== undefined) {
			sessions.setVisibility(widgetId, visibility);
		}
		if (defaultMuted !== undefined) {
			sessions.setVideoConfig(widgetId, defaultMuted);
		}
		if (iframeHeight !== undefined) {
			// Convert to integer (0 or empty string means clear the config)
			const heightNum = (iframeHeight === '' || iframeHeight === null) ? 0 : parseInt(iframeHeight, 10);
			sessions.setIframeConfig(widgetId, heightNum);
		}
		if (proxyCacheSeconds !== undefined) {
			// Convert to integer (0 or empty string means disable caching)
			const cacheNum = (proxyCacheSeconds === '' || proxyCacheSeconds === null) ? 0 : parseInt(proxyCacheSeconds, 10);
			sessions.setProxyCacheConfig(widgetId, cacheNum);
		}
		if (sectionGlow !== undefined) {
			sessions.setSectionGlowConfig(widgetId, sectionGlow);
		}
		res.json({ ok: true, widgetId, rules, visibility, defaultMuted, iframeHeight, proxyCacheSeconds, sectionGlow });
	} catch (err) {
		logMessage(`Failed to save card config: ${err.message || err}`, 'error');
		res.status(500).json({ error: 'Failed to save config' });
	}
});

app.post('/api/voice', express.json(), async (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');

	const { command } = req.body || {};
	if (!command || typeof command !== 'string' || command.length > 500) {
		res.status(400).json({ error: 'Missing or invalid command' });
		return;
	}

	const trimmed = command.trim();
	if (!trimmed || trimmed.length > 500) {
		res.status(400).json({ error: 'Empty or too long command' });
		return;
	}

	const user = req.ohProxyUser ? sessions.getUser(req.ohProxyUser) : null;
	const username = user?.username || 'anonymous';

	// Check if AI is configured
	if (!ANTHROPIC_API_KEY) {
		logMessage(`[Voice] [${username}] "${trimmed}" - AI not configured`);
		res.status(503).json({ error: 'Voice AI not configured' });
		return;
	}

	// Load structure map
	const structureMap = getAiStructureMap();
	if (!structureMap) {
		logMessage(`[Voice] [${username}] "${trimmed}" - structure map not found`);
		res.status(503).json({ error: 'Voice AI structure map not found. Run ai-cli.js genstructuremap first.' });
		return;
	}

	const itemList = structureMap.request?.messages?.[0]?.content;
	if (!itemList) {
		logMessage(`[Voice] [${username}] "${trimmed}" - invalid structure map`);
		res.status(503).json({ error: 'Invalid structure map format' });
		return;
	}

	try {
		const aiResponse = await callAnthropicApi({
			model: 'claude-3-haiku-20240307',
			max_tokens: 1024,
			system: `You are a home automation voice command interpreter. Your job is to match voice commands to the available smart home items and determine what actions to take.

You will receive a list of controllable items organized by room/section (## headers). Each item shows:
- Item name (technical ID to use in commands)
- Item type
- Label (human-readable name)
- Available commands

Respond with a JSON object:
{
  "understood": true,
  "actions": [
    { "item": "ItemName", "command": "ON", "description": "Turn on kitchen light" }
  ],
  "response": "Turning on the kitchen lights"
}

If the command is unclear or no matching items found:
{
  "understood": false,
  "actions": [],
  "response": "I couldn't find any lights in the kitchen"
}

Rules:
- CRITICAL: When user specifies a room/location, ONLY match items under that room's ## section header. The section hierarchy (e.g. "## Floors / Upstairs / Office") tells you exactly where each item is located. Never pick items from other rooms.
- Match by label first, then item name. Labels are what users call things.
- "all lights" means all Switch/Dimmer items with "light" or "lamp" in label within the specified room
- "turn on" = ON, "turn off" = OFF for switches
- For dimmers, "dim" = 30, "bright" = 100
- For items with numeric commands like [commands: 0="Off", 1="On"], use the number (0, 1) not the label
- Be helpful but only control items that clearly match the request
- Response should be natural, conversational
- ONLY output valid JSON, no markdown or extra text`,
			messages: [
				{
					role: 'user',
					content: `Available items:\n\n${itemList}\n\n---\n\nVoice command: "${trimmed}"`
				}
			]
		});

		// Extract text content
		const textContent = aiResponse.content?.find(c => c.type === 'text');
		if (!textContent?.text) {
			logMessage(`[Voice] [${username}] "${trimmed}" - empty AI response`);
			res.status(502).json({ error: 'Empty response from AI' });
			return;
		}

		// Parse JSON response
		let parsed;
		try {
			parsed = JSON.parse(textContent.text);
		} catch {
			logMessage(`[Voice] [${username}] "${trimmed}" - invalid AI JSON`);
			res.status(502).json({ error: 'Invalid response from AI' });
			return;
		}

		// Execute actions
		const results = [];
		if (parsed.understood && Array.isArray(parsed.actions)) {
			for (const action of parsed.actions) {
				if (action.item && action.command !== undefined) {
					try {
						const cmdResult = await sendOpenhabCommand(action.item, action.command);
						results.push({
							item: action.item,
							command: action.command,
							success: cmdResult.ok,
						});
					} catch (err) {
						results.push({
							item: action.item,
							command: action.command,
							success: false,
							error: err.message,
						});
					}
				}
			}
		}

		// Log summary with cost
		const actionSummary = results.length > 0
			? results.map(r => `${r.item}=${r.command}(${r.success ? 'ok' : 'fail'})`).join(', ')
			: 'none';
		const inputTokens = aiResponse.usage?.input_tokens || 0;
		const outputTokens = aiResponse.usage?.output_tokens || 0;
		const inputCost = (inputTokens / 1000000) * 0.25;  // Haiku: $0.25/1M input
		const outputCost = (outputTokens / 1000000) * 1.25; // Haiku: $1.25/1M output
		const totalCost = inputCost + outputCost;
		logMessage(`[Voice] [${username}] "${trimmed}" -> understood=${parsed.understood}, actions=[${actionSummary}], tokens=${inputTokens}+${outputTokens}, cost=$${totalCost.toFixed(6)}`);

		res.json({
			success: true,
			understood: parsed.understood,
			response: parsed.response || '',
			actions: results,
		});

	} catch (err) {
		logMessage(`[Voice] [${username}] "${trimmed}" - error: ${err.message}`);
		res.status(502).json({ error: 'AI processing failed' });
	}
});

app.get(/^\/sw\.v[\w.-]+\.js$/i, (req, res) => {
	sendServiceWorker(res);
});

app.get('/manifest.webmanifest', (req, res) => {
	const manifestPath = path.join(PUBLIC_DIR, 'manifest.webmanifest');
	res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	try {
		const raw = fs.readFileSync(manifestPath, 'utf8');
		const manifest = JSON.parse(raw);
		const theme = safeText(req.query?.theme).toLowerCase();
		if (theme === 'light' || theme === 'dark') {
			const color = theme === 'light' ? '#f8fafc' : '#0f172a';
			manifest.theme_color = color;
			manifest.background_color = color;
		}
		res.send(JSON.stringify(manifest));
	} catch {
		res.sendFile(manifestPath);
	}
});

app.get('/search-index', async (req, res) => {
	const rawRoot = safeText(req.query?.root || '');
	const rawSitemap = safeText(req.query?.sitemap || '');
	let rootPath = '';

	if (rawRoot) {
		const normalized = normalizeOpenhabPath(rawRoot);
		if (normalized && normalized.includes('/rest/sitemaps/')) {
			rootPath = normalized;
		}
	}

	if (!rootPath && rawSitemap) {
		const nameEnc = encodeURIComponent(rawSitemap);
		rootPath = `/rest/sitemaps/${nameEnc}/${nameEnc}`;
	}

	if (!rootPath) return res.status(400).send('Missing sitemap');
	rootPath = ensureJsonParam(rootPath);

	const queue = [{ url: rootPath, path: [] }];
	const seenPages = new Set();
	const seenWidgets = new Set();
	const seenFrames = new Set();
	const widgets = [];
	const frames = [];

	while (queue.length) {
		const next = queue.shift();
		const pagePath = Array.isArray(next?.path) ? next.path : [];
		const rawUrl = normalizeOpenhabPath(next?.url || '');
		const url = ensureJsonParam(rawUrl);
		if (!url || !url.includes('/rest/sitemaps/')) continue;
		if (seenPages.has(url)) continue;
		seenPages.add(url);

		let page;
		try {
			const body = await fetchOpenhab(url);
			if (!body.ok) continue;
			page = JSON.parse(body.body);
		} catch {
			continue;
		}

		const normalized = normalizeSearchWidgets(page, { path: pagePath });
		for (const f of normalized) {
			if (!f || !f.__section) continue;
			const frameLabel = safeText(f.label);
			if (!frameLabel) continue;
			const frameKey = `${pagePath.join('>')}|${frameLabel}`;
			if (seenFrames.has(frameKey)) continue;
			seenFrames.add(frameKey);
			frames.push({ label: frameLabel, path: pagePath.slice() });
		}

		for (const w of normalized) {
			if (!w || w.__section) continue;
			const link = widgetPageLink(w);
			if (link) {
				const rel = normalizeOpenhabPath(link);
				if (rel && rel.includes('/rest/sitemaps/')) {
					const label = widgetLabel(w);
					const segs = labelPathSegments(label);
					const nextPath = pagePath.concat(segs.length ? segs : [label]).filter(Boolean);
					queue.push({ url: rel, path: nextPath });
				}
			}
			const key = w?.widgetId || `${safeText(w?.item?.name || '')}|${safeText(w?.label || '')}|${safeText(link || '')}`;
			if (seenWidgets.has(key)) continue;
			seenWidgets.add(key);
			widgets.push(w);
		}
	}

	// Get user role for visibility filtering
	let userRole = null;
	if (req.ohProxyUser) {
		const user = sessions.getUser(req.ohProxyUser);
		userRole = user?.role || null;
	}

	// Filter widgets by visibility (admins see everything)
	const visibilityRules = sessions.getAllVisibilityRules();
	const visibilityMap = new Map(visibilityRules.map(r => [r.widgetId, r.visibility]));

	const filteredWidgets = widgets.filter(w => {
		if (userRole === 'admin') return true;
		const wKey = serverWidgetKey(w);
		const vis = visibilityMap.get(wKey) || 'all';
		if (vis === 'all') return true;
		if (vis === 'admin') return false;
		if (vis === 'normal') return userRole === 'normal' || userRole === 'readonly';
		return true;
	});

	res.setHeader('Cache-Control', 'no-store');
	return res.json({ widgets: filteredWidgets, frames });
});

// Return full sitemap structure with all pages indexed by URL
app.get('/sitemap-full', async (req, res) => {
	try {
		const rawRoot = safeText(req.query?.root || '');
		const rawSitemap = safeText(req.query?.sitemap || '');
		let rootPath = '';

		if (rawRoot) {
			const normalized = normalizeOpenhabPath(rawRoot);
			if (normalized && normalized.includes('/rest/sitemaps/')) {
				rootPath = normalized;
			}
		}

		if (!rootPath && rawSitemap) {
			const nameEnc = encodeURIComponent(rawSitemap);
			rootPath = `/rest/sitemaps/${nameEnc}/${nameEnc}`;
		}

		if (!rootPath) return res.status(400).send('Missing sitemap');
		rootPath = ensureJsonParam(rootPath);

		const queue = [rootPath];
		const seenPages = new Set();
		const pages = {};

		while (queue.length) {
			const rawUrl = queue.shift();
			if (!rawUrl) continue;
			const normalized = normalizeOpenhabPath(rawUrl);
			if (!normalized) continue;
			const url = ensureJsonParam(normalized);
			if (!url || !url.includes('/rest/sitemaps/')) continue;
			if (seenPages.has(url)) continue;
			seenPages.add(url);

			let page;
			try {
				const body = await fetchOpenhab(url);
				if (!body.ok) continue;
				page = JSON.parse(body.body);
			} catch {
				continue;
			}

			// Apply group state overrides (calculate state from member items)
			await applyGroupStateOverrides(page);

			// Store the page data indexed by URL
			pages[url] = page;

			// Find linked pages and add to queue
			const findLinks = (widgets) => {
				if (!widgets) return;
				let list;
				if (Array.isArray(widgets)) {
					list = widgets;
				} else if (Array.isArray(widgets.item)) {
					list = widgets.item;
				} else if (widgets.item) {
					list = [widgets.item];
				} else {
					list = [widgets];
				}
				for (const w of list) {
					if (!w) continue;
					const link = w?.linkedPage?.link || w?.link;
					if (link && typeof link === 'string' && link.includes('/rest/sitemaps/')) {
						const rel = normalizeOpenhabPath(link);
						if (rel && !seenPages.has(ensureJsonParam(rel))) {
							queue.push(rel);
						}
					}
					// Recurse into nested widgets (Frames) - support both OH 1.x and 3.x
					if (w?.widget) findLinks(w.widget);
					if (w?.widgets) findLinks(w.widgets);
				}
			};
			// Support both OH 1.x 'widget' and OH 3.x 'widgets'
			findLinks(page?.widgets || page?.widget);
		}

		res.setHeader('Cache-Control', 'no-store');
		return res.json({ pages, root: rootPath });
	} catch (err) {
		console.error('[sitemap-full] Error:', err);
		return res.status(500).json({ error: err.message });
	}
});

app.get(/^\/icons\/apple-touch-icon\.v[\w.-]+\.png$/i, (req, res) => {
	const iconPath = path.join(PUBLIC_DIR, 'icons', 'apple-touch-icon.png');
	res.setHeader('Content-Type', 'image/png');
	res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
	res.sendFile(iconPath);
});

// Weather widget icons (served from cache)
app.use('/weather/icons', express.static(WEATHERBIT_ICONS_DIR, {
	maxAge: '1d',
	setHeaders(res) {
		res.setHeader('Cache-Control', 'public, max-age=86400');
	},
}));

// Weather widget page
app.get('/weather', (req, res) => {
	if (req.ohProxyAuth !== 'authenticated') {
		res.redirect('/');
		return;
	}

	const mode = safeText(req.query?.mode || '').toLowerCase() === 'dark' ? 'dark' : 'light';

	// Read cached weather data
	let weatherData = null;
	try {
		weatherData = JSON.parse(fs.readFileSync(WEATHERBIT_FORECAST_FILE, 'utf8'));
	} catch {
		res.status(503).setHeader('Content-Type', 'text/html; charset=utf-8').send(`<!DOCTYPE html>
<html><head><title>Weather</title></head>
<body style="font-family:system-ui;padding:2rem;text-align:center;">
<h1>Weather data not available</h1>
<p>Weather data has not been fetched yet. Please check the server configuration.</p>
</body></html>`);
		return;
	}

	// Handle both old format (forecast only) and new format (forecast + current)
	const forecast = weatherData.forecast || weatherData;

	res.setHeader('Content-Type', 'text/html; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	res.send(renderWeatherWidget(forecast, mode));
});

app.get(['/', '/index.html'], (req, res) => {
	sendIndex(req, res);
});

// Redirect /login to / (single entry point)
app.get('/login', (req, res) => {
	res.redirect('/');
});

// Logout endpoint - CSRF-protected for HTML auth mode
app.get('/logout', (req, res) => {
	if (liveConfig.authMode === 'html') {
		const token = generateCsrfToken();
		setCsrfCookie(res, token);
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.setHeader('Cache-Control', 'no-cache');
		res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Log out</title>
</head>
<body style="font-family: system-ui, sans-serif; padding: 2rem;">
<h1>Log out</h1>
<p>Confirm to sign out.</p>
<form method="POST" action="/logout">
<input type="hidden" name="csrfToken" value="${token}">
<button type="submit">Log out</button>
</form>
<p><a href="/">Cancel</a></p>
</body>
</html>`);
		return;
	}
	clearAuthCookie(res);
	clearSessionCookie(res);
	res.redirect('/');
});

app.post('/logout', express.urlencoded({ extended: false }), (req, res) => {
	if (liveConfig.authMode === 'html' && !validateCsrfToken(req)) {
		res.status(403).type('text/plain').send('Invalid CSRF token');
		return;
	}
	clearAuthCookie(res);
	clearSessionCookie(res);
	res.redirect('/');
});

app.get(/^\/app\.v[\w.-]+\.js$/i, (req, res) => {
	sendVersionedAsset(res, APP_BUNDLE_PATH, 'application/javascript; charset=utf-8');
});

app.get(/^\/tailwind\.v[\w.-]+\.css$/i, (req, res) => {
	sendVersionedAsset(res, TAILWIND_BUNDLE_PATH, 'text/css; charset=utf-8');
});

app.get(/^\/styles\.v[\w.-]+\.css$/i, (req, res) => {
	sendVersionedAsset(res, STYLE_BUNDLE_PATH, 'text/css; charset=utf-8');
});

app.get(/^\/chart\.v[\w.-]+\.js$/i, (req, res) => {
	sendVersionedAsset(res, CHART_JS_PATH, 'application/javascript; charset=utf-8');
});

app.get(/^\/chart\.v[\w.-]+\.css$/i, (req, res) => {
	sendVersionedAsset(res, CHART_CSS_PATH, 'text/css; charset=utf-8');
});

app.get(/^\/login\.v[\w.-]+\.js$/i, (req, res) => {
	sendVersionedAsset(res, LOGIN_JS_PATH, 'application/javascript; charset=utf-8');
});

// --- Proxy FIRST (so bodies aren't eaten by any parsers) ---
const proxyCommon = {
	target: OH_TARGET,
	router: () => liveConfig.ohTarget,
	changeOrigin: true,
	ws: false, // Disabled - we handle WebSocket ourselves via wss
	logLevel: PROXY_LOG_LEVEL,
	onProxyReq(proxyReq) {
		proxyReq.setHeader('User-Agent', liveConfig.userAgent);
		const ah = authHeader();
		if (ah) proxyReq.setHeader('Authorization', ah);
	},
};

purgeOldIconCache();
ensureDir(getIconCacheDir());

app.get(/^\/(?:openhab\.app\/)?images\/(v\d+)\/(.+)$/i, async (req, res, next) => {
	const match = req.path.match(/^\/(?:openhab\.app\/)?images\/(v\d+)\/(.+)$/i);
	if (!match) return next();
	const version = match[1];
	if (version !== liveConfig.iconVersion) return next();
	const rawRel = safeText(match[2]).replace(/\\/g, '/');
	const rel = rawRel.replace(/^\/+/, '');
	if (!rel) return res.status(400).type('text/plain').send('Invalid icon path');
	const segments = rel.split('/');
	if (segments.some((seg) => seg === '.' || seg === '..' || seg === '')) {
		return res.status(400).type('text/plain').send('Invalid icon path');
	}
	const parsed = path.posix.parse(rel);
	const cacheRel = path.posix.join(parsed.dir, `${parsed.name}.png`);
	const cacheRoot = path.resolve(getIconCacheDir());
	const cachePath = path.resolve(cacheRoot, cacheRel);
	if (cachePath !== cacheRoot && !cachePath.startsWith(cacheRoot + path.sep)) {
		return res.status(400).type('text/plain').send('Invalid icon path');
	}
	const sourcePath = `/images/${rel}`;
	const sourceExt = parsed.ext || '.png';

	try {
		const buffer = await getCachedIcon(cachePath, sourcePath, sourceExt);
		res.setHeader('Content-Type', 'image/png');
		res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
		res.send(buffer);
	} catch (err) {
		logMessage(`[Icons] Cache failed for ${rawRel}: ${err.message || err}`);
		next();
	}
});

app.use('/rest', async (req, res, next) => {
	if (req.method !== 'GET') return next();
	const delta = safeText(req.query?.delta || '');
	if (delta !== '1' && delta !== 'true') return next();
	if (!req.path.startsWith('/sitemaps/')) return next();
	res.setHeader('Cache-Control', 'no-store');

	const rawQuery = req.originalUrl.split('?')[1] || '';
	const params = new URLSearchParams(rawQuery);
	const since = params.get('since') || '';
	params.delete('delta');
	params.delete('since');
	if (!params.has('type')) params.set('type', 'json');

	const upstreamPath = `/rest${req.path}${params.toString() ? `?${params.toString()}` : ''}`;
	let body;
	try {
		body = await fetchOpenhab(upstreamPath);
	} catch (err) {
		return res.status(502).json({ delta: false, error: err.message || 'Upstream error' });
	}

	if (!body.ok) {
		return res.status(body.status).send(body.body);
	}

	let page;
	try {
		page = JSON.parse(body.body);
	} catch {
		return res.status(502).json({ delta: false, error: 'Non-JSON response from openHAB' });
	}

	// Apply group state overrides (calculate state from member items)
	await applyGroupStateOverrides(page);

	const cacheKey = `${req.path}?${params.toString()}`;
	const snapshot = buildSnapshot(page);
	const cached = findDeltaMatch(cacheKey, since);
	const canDelta = cached && cached.structureHash === snapshot.structureHash;

	if (!canDelta) {
		setDeltaCache(cacheKey, snapshot);
		return res.json({ delta: false, hash: snapshot.hash, page });
	}

	const changes = [];
	for (const [key, current] of snapshot.entryMap.entries()) {
		const prev = cached.entryMap.get(key);
		if (!prev) {
			setDeltaCache(cacheKey, snapshot);
			return res.json({ delta: false, hash: snapshot.hash, page });
		}
		if (
			prev.label !== current.label ||
			prev.state !== current.state ||
			prev.valuecolor !== current.valuecolor ||
			prev.icon !== current.icon ||
			prev.mappings !== current.mappings
		) {
			changes.push(current);
		}
	}

	setDeltaCache(cacheKey, snapshot);
	return res.json({ delta: true, hash: snapshot.hash, title: snapshot.title, changes });
});

// REST API (commands, state, sitemap JSON)
// Express strips the mount path; add /rest back when proxying to openHAB.
app.use('/rest', createProxyMiddleware({
	...proxyCommon,
	pathRewrite: (path) => `/rest${path}`,
}));

// Legacy Classic UI + its assets (openHAB 1.x classic UI)
app.use('/openhab.app', createProxyMiddleware({
	...proxyCommon,
	pathRewrite: (path) => stripIconVersion(path),
}));

// Some installs reference these directly
app.use('/icon', createProxyMiddleware({
	...proxyCommon,
	pathRewrite: (path) => `/openhab.app${stripIconVersion(path)}`,
}));
// /chart is handled by dedicated endpoint with caching (see app.get('/chart', ...))

// Serve local images from public/images/ before proxying to openHAB
app.use('/images', (req, res, next) => {
	const imagesDir = path.join(PUBLIC_DIR, 'images');
	const localPath = path.normalize(path.join(imagesDir, req.path));
	// Prevent path traversal - ensure resolved path is within images directory
	if (!localPath.startsWith(imagesDir + path.sep) && localPath !== imagesDir) {
		return next();
	}
	if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
		return res.sendFile(localPath);
	}
	next();
}, createProxyMiddleware({
	...proxyCommon,
	pathRewrite: (path) => `/openhab.app${stripIconVersion(path)}`,
}));

// Video preview endpoint
app.get('/video-preview', (req, res) => {
	const url = safeText(req.query.url).trim();
	if (!url) {
		return res.status(400).type('text/plain').send('Missing URL');
	}

	// Parse and validate RTSP URL
	let target;
	try {
		target = new URL(url);
	} catch {
		return res.status(400).type('text/plain').send('Invalid URL');
	}

	if (target.protocol !== 'rtsp:') {
		return res.status(400).type('text/plain').send('Invalid RTSP URL');
	}

	// Validate against proxy allowlist
	if (!isProxyTargetAllowed(target, liveConfig.proxyAllowlist)) {
		return res.status(403).type('text/plain').send('RTSP target not allowed');
	}

	const hash = rtspUrlHash(url);
	const filePath = path.join(VIDEO_PREVIEW_DIR, `${hash}.jpg`);

	let stats;
	try {
		stats = fs.statSync(filePath);
	} catch {
		return res.status(404).type('text/plain').send('Preview not available');
	}

	res.type('image/jpeg');
	res.set('Cache-Control', 'no-cache, must-revalidate');
	res.set('ETag', `"${stats.mtimeMs}"`);
	res.set('Last-Modified', stats.mtime.toUTCString());
	res.sendFile(filePath);
});

// Chart endpoint - generates interactive HTML charts from RRD data
app.get('/chart', (req, res) => {
	// Extract and validate parameters
	const item = safeText(req.query.item || '').trim();
	const period = safeText(req.query.period || '').trim();
	const mode = safeText(req.query.mode || '').trim().toLowerCase() || 'dark';
	const title = safeText(req.query.title || '').trim();

	// Validate item: a-zA-Z0-9_- max 50 chars
	if (!item || !/^[a-zA-Z0-9_-]{1,50}$/.test(item)) {
		return res.status(400).type('text/plain').send('Invalid item parameter');
	}

	// Validate period: h D W M Y
	if (!['h', 'D', 'W', 'M', 'Y'].includes(period)) {
		return res.status(400).type('text/plain').send('Invalid period parameter');
	}

	// Validate mode: light or dark
	if (!['light', 'dark'].includes(mode)) {
		return res.status(400).type('text/plain').send('Invalid mode parameter');
	}

	const cachePath = getChartCachePath(item, period, mode);

	// Check cache
	if (isChartCacheValid(cachePath, period)) {
		try {
			const html = fs.readFileSync(cachePath, 'utf8');
			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			res.setHeader('Cache-Control', `private, max-age=${Math.floor(CHART_PERIOD_TTL[period] / 1000)}`);
			res.setHeader('X-Chart-Cache', 'hit');
			return res.send(html);
		} catch {
			// Fall through to generate
		}
	}

	// Generate HTML chart from RRD
	try {
		const html = generateChart(item, period, mode, title || item);
		if (!html) {
			return res.status(404).type('text/plain').send('Chart data not available');
		}

		// Cache the generated HTML
		try {
			ensureDir(CHART_CACHE_DIR);
			fs.writeFileSync(cachePath, html);
		} catch {}

		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.setHeader('Cache-Control', `private, max-age=${Math.floor(CHART_PERIOD_TTL[period] / 1000)}`);
		res.setHeader('X-Chart-Cache', 'miss');
		res.send(html);
	} catch (err) {
		logMessage(`Chart generation failed: ${err.message || err}`);
		res.status(500).type('text/plain').send('Chart generation failed');
	}
});

// Chart hash endpoint - regenerates chart and returns hash for smart iframe refresh
app.get('/api/chart-hash', (req, res) => {
	const item = safeText(req.query.item || '').trim();
	const period = safeText(req.query.period || '').trim();
	const mode = safeText(req.query.mode || '').trim().toLowerCase() || 'dark';
	const title = safeText(req.query.title || '').trim() || item;

	// Validate parameters
	if (!item || !/^[a-zA-Z0-9_-]{1,50}$/.test(item)) {
		return res.status(400).json({ error: 'Invalid item' });
	}
	if (!['h', 'D', 'W', 'M', 'Y'].includes(period)) {
		return res.status(400).json({ error: 'Invalid period' });
	}
	if (!['light', 'dark'].includes(mode)) {
		return res.status(400).json({ error: 'Invalid mode' });
	}

	const cachePath = getChartCachePath(item, period, mode);

	// Get RRD data for stable hash (not affected by label positioning)
	const rrdDir = liveConfig.rrdPath || '';
	if (!rrdDir) {
		res.setHeader('Cache-Control', 'no-cache');
		return res.json({ hash: null, error: 'No RRD path' });
	}
	const rrdPath = path.join(rrdDir, `${item}.rrd`);
	if (!fs.existsSync(rrdPath)) {
		res.setHeader('Cache-Control', 'no-cache');
		return res.json({ hash: null, error: 'RRD not found' });
	}

	try {
		// Parse raw data and compute hash
		const rawData = parseRrd4jFile(rrdPath, period);
		if (!rawData || rawData.length === 0) {
			res.setHeader('Cache-Control', 'no-cache');
			return res.json({ hash: null, error: 'No data' });
		}

		const dataHash = computeChartDataHash(rawData, period);
		if (!dataHash) {
			res.setHeader('Cache-Control', 'no-cache');
			return res.json({ hash: null, error: 'Hash computation failed' });
		}

		// Check if hash changed - only regenerate HTML if needed
		const existingHash = fs.existsSync(cachePath) ? (() => {
			try {
				const html = fs.readFileSync(cachePath, 'utf8');
				const match = html.match(/data-hash="([^"]+)"/);
				return match ? match[1] : null;
			} catch { return null; }
		})() : null;

		if (existingHash === dataHash) {
			// Data unchanged, no need to regenerate
			res.setHeader('Cache-Control', 'no-cache');
			return res.json({ hash: dataHash });
		}

		// Data changed - regenerate HTML (hash is embedded by generateChart)
		const html = generateChart(item, period, mode, title);
		if (!html) {
			res.setHeader('Cache-Control', 'no-cache');
			return res.json({ hash: null, error: 'Generation failed' });
		}

		// Write to cache
		ensureDir(CHART_CACHE_DIR);
		fs.writeFileSync(cachePath, html);

		res.setHeader('Cache-Control', 'no-cache');
		res.json({ hash: dataHash });
	} catch (err) {
		logMessage(`Chart hash generation failed: ${err.message || err}`);
		res.setHeader('Cache-Control', 'no-cache');
		res.json({ hash: null, error: 'Generation failed' });
	}
});

app.get('/presence', async (req, res) => {
	const conn = getMysqlConnection();
	if (!conn) {
		return res.status(503).type('text/html').send('<!DOCTYPE html><html><head></head><body></body></html>');
	}

	const query = 'SELECT * FROM log_gps ORDER BY id DESC LIMIT 20';

	const QUERY_TIMEOUT_MS = 10000;

	let rows;
	try {
		rows = await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error('Query timeout'));
			}, QUERY_TIMEOUT_MS);

			conn.query(query, (err, results) => {
				clearTimeout(timeout);
				if (err) reject(err);
				else resolve(results);
			});
		});
	} catch (err) {
		logMessage(`[Presence] Query failed: ${err.message || err}`);
		return res.status(504).type('text/html').send('<!DOCTYPE html><html><head></head><body></body></html>');
	}

	const markers = [];
	let last = null;
	let first = true;

	for (const row of rows) {
		const current = [
			Math.round(row.lat * 10000000) / 10000000,
			Math.round(row.lon * 10000000) / 10000000,
		];
		if (last && current[0] === last[0] && current[1] === last[1]) {
			continue;
		}
		last = current;
		const ts = row.timestamp ? (() => {
			const d = new Date(row.timestamp);
			const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
			const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
			return '<div class="tt-date">' + date + '</div><div class="tt-time">' + time + '</div>';
		})() : '';
		markers.push([current[0], current[1], first ? 'red' : 'blue', ts]);
		first = false;
	}

	const zoom = 15;
	markers.reverse();
	const markersJson = JSON.stringify(markers);

	const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Map</title>
<style>
@font-face{font-family:'Rubik';src:url('/fonts/rubik-300.woff2') format('woff2');font-weight:300;font-style:normal;font-display:swap}
@font-face{font-family:'Rubik';src:url('/fonts/rubik-400.woff2') format('woff2');font-weight:400;font-style:normal;font-display:swap}
@font-face{font-family:'Rubik';src:url('/fonts/rubik-500.woff2') format('woff2');font-weight:500;font-style:normal;font-display:swap}
.olControlAttribution{display:none!important}
@media(pointer:coarse){.olControlZoom{display:none!important}}
#map{position:absolute;top:0;left:0;right:0;bottom:0}
body{margin:0;padding:0}
.tooltip{position:absolute;background:#f1f2f9;border:1px solid #ccccd1;border-radius:10px;padding:0.5rem 0.75rem;font-size:11px;line-height:1.5;font-family:'Rubik',sans-serif;color:#0f172a;pointer-events:none;z-index:100;white-space:nowrap}
.tooltip .tt-date{font-weight:500}
.tooltip .tt-time{font-weight:300;margin-top:0.125rem}
#hover-tooltip{display:none}
</style>
<script src="https://openlayers.org/api/OpenLayers.js"></script>
</head>
<body>
<div id="map"></div>
<div id="red-tooltip" class="tooltip"></div>
<div id="hover-tooltip" class="tooltip"></div>
<script>
(function(){
var markers=${markersJson};
var zoom=${zoom};
if(!markers.length)return;

var map=new OpenLayers.Map("map");
map.addLayer(new OpenLayers.Layer.OSM("OSM",["//a.tile.openstreetmap.org/\${z}/\${x}/\${y}.png","//b.tile.openstreetmap.org/\${z}/\${x}/\${y}.png","//c.tile.openstreetmap.org/\${z}/\${x}/\${y}.png"]));

var wgs84=new OpenLayers.Projection("EPSG:4326");
var proj=map.getProjectionObject();
var vector=new OpenLayers.Layer.Vector("Markers");

markers.forEach(function(m,i){
var feature=new OpenLayers.Feature.Vector(
new OpenLayers.Geometry.Point(m[1],m[0]).transform(wgs84,proj),
{timestamp:m[3],index:i,color:m[2]},{externalGraphic:'/images/marker-'+m[2]+'.png',graphicHeight:41,graphicWidth:25,graphicXOffset:-12,graphicYOffset:-41}
);
vector.addFeatures(feature);
});

map.addLayer(vector);

var red=markers[markers.length-1];
var redTooltip=document.getElementById('red-tooltip');
redTooltip.innerHTML=red[3];

function updateRedTooltip(){
var lonlat=new OpenLayers.LonLat(red[1],red[0]).transform(wgs84,proj);
var px=map.getPixelFromLonLat(lonlat);
if(px){
redTooltip.style.left=(px.x+15)+'px';
redTooltip.style.top=(px.y-60)+'px';
}
}

var hoverTooltip=document.getElementById('hover-tooltip');
var hover=new OpenLayers.Control.SelectFeature(vector,{
hover:true,
onSelect:function(f){
if(f.attributes.color==='blue'&&f.attributes.timestamp){
hoverTooltip.innerHTML=f.attributes.timestamp;
hoverTooltip.style.display='block';
}
},
onUnselect:function(){hoverTooltip.style.display='none';}
});
map.addControl(hover);
hover.activate();

map.events.register('mousemove',map,function(e){
hoverTooltip.style.left=(e.xy.x+15)+'px';
hoverTooltip.style.top=(e.xy.y+15)+'px';
});

map.events.register('move',map,updateRedTooltip);
map.events.register('moveend',map,updateRedTooltip);
map.events.register('zoomend',map,updateRedTooltip);

map.setCenter(new OpenLayers.LonLat(red[1],red[0]).transform(wgs84,proj),zoom);
setTimeout(updateRedTooltip,100);
})();
</script>
</body>
</html>`;

	res.setHeader('Content-Type', 'text/html; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store');
	res.send(html);
});

app.get('/proxy', async (req, res, next) => {
	const raw = req.query?.url;

	// External URL proxy (url= parameter) - supports regular images and MJPEG streams
	if (raw) {
		const candidate = Array.isArray(raw) ? raw[0] : raw;
		const text = safeText(candidate).trim();
		if (!text) return res.status(400).send('Invalid proxy target');

		let target;
		try {
			target = new URL(text);
		} catch {
			let decoded = text;
			try { decoded = decodeURIComponent(text); } catch {}
			try {
				target = new URL(decoded);
			} catch {
				return res.status(400).send('Invalid proxy target');
			}
		}

		if (!['http:', 'https:', 'rtsp:'].includes(target.protocol)) {
			return res.status(400).send('Invalid proxy target');
		}
		if (!isProxyTargetAllowed(target, liveConfig.proxyAllowlist)) {
			return res.status(403).send('Proxy target not allowed');
		}

		// RTSP stream - convert to MP4 via FFmpeg
		if (target.protocol === 'rtsp:') {
			const rtspUrl = target.toString();
			const clientIp = getRemoteIp(req) || 'unknown';
			const username = req.ohProxyUser || 'anonymous';
			const streamId = ++rtspStreamIdCounter;

			// Get viewport width for scaling time overlay (0-10000, invalid = 0)
			const rawWidth = parseInt(req.query.w, 10);
			const viewportWidth = (Number.isFinite(rawWidth) && rawWidth >= 0 && rawWidth <= 10000) ? rawWidth : 0;
			// Font size scales with viewport: ~2.5% of width, min 16px, max 48px
			const fontSize = viewportWidth > 0 ? Math.max(16, Math.min(48, Math.round(viewportWidth / 40))) : 24;

			// Track and log stream start
			activeRtspStreams.set(streamId, { url: rtspUrl, user: username, ip: clientIp, startTime: Date.now() });
			logMessage(`[RTSP] Starting stream ${rtspUrl} to ${username}@${clientIp} (w=${viewportWidth})`);

			// Time overlay filter: top-right, HH:MM:SS format (using strftime expansion for older ffmpeg)
			const drawtext = `drawtext=text='%H\\:%M\\:%S':expansion=strftime:x=w-tw-15:y=15:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=4`;
			// Scale to viewport width if provided - ensure even dimensions for x264
			const scaleWidth = viewportWidth > 0 ? (viewportWidth % 2 === 0 ? viewportWidth : viewportWidth + 1) : 0;
			const videoFilter = scaleWidth > 0
				? `scale=${scaleWidth}:-2,${drawtext}`
				: drawtext;

			const ffmpegArgs = [
				// Input options - minimize probing delay
				'-probesize', '100000',
				'-analyzeduration', '100000',
				'-fflags', '+nobuffer+genpts+discardcorrupt',
				'-flags', 'low_delay',
				'-rtsp_transport', 'tcp',
				'-i', rtspUrl,
				// Video encoding - low latency
				'-vf', videoFilter,
				'-c:v', 'libx264',
				'-preset', 'ultrafast',
				'-tune', 'zerolatency',
				'-g', '25',
				'-keyint_min', '25',
				// Audio
				'-c:a', 'aac',
				'-b:a', '64k',
				// Output - streaming optimized
				'-f', 'mp4',
				'-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',
				'-flush_packets', '1',
				'-reset_timestamps', '1',
				'pipe:1',
			];
			const ffmpeg = spawn(BIN_FFMPEG, ffmpegArgs, {
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			res.setHeader('Content-Type', 'video/mp4');
			res.setHeader('Cache-Control', 'no-store');
			ffmpeg.stdout.pipe(res);

			// Collect stderr to extract stream info
			let stderrData = '';
			let streamInfoLogged = false;
			ffmpeg.stderr.on('data', (chunk) => {
				if (stderrData.length < 8192) stderrData += chunk.toString();
				// Log track info once we see Output (means probing is done)
				if (!streamInfoLogged && stderrData.includes('Output #0')) {
					streamInfoLogged = true;
					try {
						const inputStreams = [];
						const outputStreams = [];
						let inOutput = false;
						for (const line of stderrData.split('\n')) {
							if (line.includes('Output #0')) inOutput = true;
							const streamMatch = line.match(/Stream #\d+:\d+.*?: (Video|Audio): (\w+)/);
							if (streamMatch) {
								const desc = `${streamMatch[1]}:${streamMatch[2]}`;
								if (inOutput) outputStreams.push(desc);
								else inputStreams.push(desc);
							}
						}
						if (inputStreams.length || outputStreams.length) {
							logMessage(`[RTSP] Stream info for ${username}@${clientIp}: in:[${inputStreams.join(', ')}] out:[${outputStreams.join(', ')}]`);
						}
					} catch {}
				}
			});

			const endStream = () => {
				if (activeRtspStreams.has(streamId)) {
					activeRtspStreams.delete(streamId);
					logMessage(`[RTSP] Ending stream ${rtspUrl} to ${username}@${clientIp}`);
				}
			};

			ffmpeg.on('error', (err) => {
				endStream();
				if (!res.headersSent) {
					res.status(502).send('RTSP proxy error');
				}
			});
			ffmpeg.on('close', () => {
				endStream();
				if (!res.writableEnded) res.end();
			});
			req.on('close', () => {
				ffmpeg.kill('SIGKILL');
			});
			return;
		}

		const headers = {};
		const accept = safeText(req.headers.accept);
		if (accept) headers.Accept = accept;

		// Check for cache parameter (seconds)
		const cacheSeconds = parseInt(req.query.cache, 10);
		const shouldCache = Number.isFinite(cacheSeconds) && cacheSeconds > 0;

		if (shouldCache) {
			// Caching mode - use buffered fetch
			const targetUrl = target.toString();
			const cachePath = getProxyCachePath(targetUrl);
			const metaPath = `${cachePath}.meta`;

			// Check if cached file exists and is valid
			if (isProxyCacheValid(cachePath, cacheSeconds)) {
				try {
					const cachedData = fs.readFileSync(cachePath);
					let contentType = 'application/octet-stream';
					try {
						contentType = fs.readFileSync(metaPath, 'utf8').trim() || contentType;
					} catch {}
					res.setHeader('Content-Type', contentType);
					res.setHeader('Cache-Control', 'no-store');
					res.setHeader('X-Proxy-Cache', 'hit');
					res.send(cachedData);
					return;
				} catch (err) {
					// Cache read failed, fall through to fetch
				}
			}

			// Cache miss or stale - fetch and cache
			try {
				const result = await fetchBinaryFromUrl(targetUrl, headers);
				if (result.ok && result.body) {
					// Ensure cache directory exists
					ensureDir(PROXY_CACHE_DIR);
					// Save to cache
					fs.writeFileSync(cachePath, result.body);
					if (result.contentType) {
						fs.writeFileSync(metaPath, result.contentType);
					}
				}
				res.status(result.status || 502);
				if (result.contentType) res.setHeader('Content-Type', result.contentType);
				res.setHeader('Cache-Control', 'no-store');
				res.setHeader('X-Proxy-Cache', 'miss');
				res.send(result.body || '');
			} catch (err) {
				logMessage(`Cached proxy fetch failed for ${targetUrl}: ${err.message || err}`);
				if (!res.headersSent) {
					res.status(502).send('Proxy error');
				}
			}
			return;
		}

		try {
			// Use streaming proxy - works for both regular images and MJPEG streams
			await pipeStreamingProxy(target.toString(), res, headers);
		} catch (err) {
			logMessage(`Direct proxy failed for ${target.toString()}: ${err.message || err}`);
			if (!res.headersSent) {
				res.status(502).send('Proxy error');
			}
		}
		return;
	}

	// openHAB internal proxy (sitemap/widgetId images, etc.)
	// Use buffered fetch to avoid HTTP/2 streaming cutoff issues with spdy
	const proxyPath = `/proxy${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;
	try {
		const result = await fetchOpenhabBinary(proxyPath);
		res.status(result.status || 502);
		if (result.contentType) res.setHeader('Content-Type', result.contentType);
		res.setHeader('Cache-Control', 'no-store');
		res.send(result.body);
	} catch (err) {
		logMessage(`openHAB proxy failed for ${proxyPath}: ${err.message || err}`);
		res.status(502).send('Proxy error');
	}
});

// --- Static modern UI ---
app.use(express.static(PUBLIC_DIR, {
	extensions: ['html'],
	setHeaders(res, filePath) {
		if (filePath && filePath.endsWith(`${path.sep}index.html`)) {
			res.setHeader('Cache-Control', 'no-cache');
			return;
		}
		const ext = filePath ? path.extname(filePath).toLowerCase() : '';
		if (ext) {
			res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
			return;
		}
		res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
	},
}));

// Convenience: legacy UI still available
app.get('/classic', (req, res) => {
	res.redirect('/openhab.app');
});

// Redirect unknown routes to homepage
app.use((req, res) => {
	res.redirect('/');
});

registerBackgroundTask('sitemap-cache', SITEMAP_REFRESH_MS, refreshSitemapCache);

// Video preview capture function
async function captureRtspPreview(rtspUrl) {
	ensureDir(VIDEO_PREVIEW_DIR);
	const hash = rtspUrlHash(rtspUrl);
	const outputPath = path.join(VIDEO_PREVIEW_DIR, `${hash}.jpg`);

	return new Promise((resolve) => {
		const ffmpeg = spawn(BIN_FFMPEG, [
			'-y',
			'-rtsp_transport', 'tcp',
			'-i', rtspUrl,
			'-vframes', '1',
			'-q:v', '2',
			outputPath,
		], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			ffmpeg.kill('SIGKILL');
		}, 10000);

		ffmpeg.on('close', (code) => {
			clearTimeout(timer);
			resolve(!killed && code === 0);
		});

		ffmpeg.on('error', () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}

// Prune old chart cache entries (older than 1 week)
function pruneChartCache() {
	if (!fs.existsSync(CHART_CACHE_DIR)) return;

	const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // 1 week
	const now = Date.now();
	let pruned = 0;

	try {
		const files = fs.readdirSync(CHART_CACHE_DIR);
		for (const file of files) {
			if (!file.endsWith('.html') && !file.endsWith('.png')) continue;
			const filePath = path.join(CHART_CACHE_DIR, file);
			try {
				const stat = fs.statSync(filePath);
				if (now - stat.mtimeMs > maxAgeMs) {
					fs.unlinkSync(filePath);
					pruned++;
				}
			} catch (err) {
				// Ignore individual file errors
			}
		}
		if (pruned > 0) {
			logMessage(`Chart cache pruned ${pruned} old entries`);
		}
	} catch (err) {
		logMessage(`Chart cache prune failed: ${err.message || err}`);
	}
}

// Prune old video preview images
function pruneVideoPreviews() {
	if (!fs.existsSync(VIDEO_PREVIEW_DIR)) return;

	const maxAgeMs = VIDEO_PREVIEW_PRUNE_HOURS * 60 * 60 * 1000;
	const now = Date.now();

	try {
		const files = fs.readdirSync(VIDEO_PREVIEW_DIR);
		for (const file of files) {
			if (!file.endsWith('.jpg')) continue;
			const filePath = path.join(VIDEO_PREVIEW_DIR, file);
			try {
				const stat = fs.statSync(filePath);
				if (now - stat.mtimeMs > maxAgeMs) {
					fs.unlinkSync(filePath);
				}
			} catch (err) {
				// Ignore individual file errors
			}
		}
	} catch (err) {
		logMessage(`[RTSP] Preview prune failed: ${err.message || err}`);
	}
}

// Video preview capture background task
async function captureVideoPreviewsTask() {
	const sitemapName = backgroundState.sitemap?.name;
	if (!sitemapName) return;

	let sitemapData;
	try {
		const response = await fetchOpenhab(`/rest/sitemaps/${sitemapName}?type=json`);
		if (!response || !response.ok) {
			logMessage(`[RTSP] Preview sitemap fetch failed (HTTP ${response?.status || 'unknown'})`);
			return;
		}
		sitemapData = JSON.parse(response.body);
	} catch (err) {
		logMessage(`[RTSP] Preview failed to fetch/parse sitemap: ${err.message || err}`);
		return;
	}

	const rtspUrls = extractRtspUrls(sitemapData);
	if (rtspUrls.size === 0) return;

	// Capture screenshots sequentially
	for (const url of rtspUrls) {
		try {
			const ok = await captureRtspPreview(url);
			if (ok) {
				logMessage(`[RTSP] Preview captured screenshot for ${url}`);
			} else {
				logMessage(`[RTSP] Preview failed to capture ${url}`);
			}
		} catch (err) {
			logMessage(`[RTSP] Preview error capturing ${url}: ${err.message || err}`);
		}
	}

	// Prune old previews
	pruneVideoPreviews();
}

// Register video preview task if enabled
if (VIDEO_PREVIEW_INTERVAL_MS > 0) {
	registerBackgroundTask('video-preview', VIDEO_PREVIEW_INTERVAL_MS, captureVideoPreviewsTask);
}

// Register chart cache prune task (every 24 hours)
registerBackgroundTask('chart-cache-prune', 24 * 60 * 60 * 1000, pruneChartCache);

// Periodic RTSP stream status logging (every 10 seconds, only if streams active)
setInterval(() => {
	const count = activeRtspStreams.size;
	if (count > 0) {
		logMessage(`[RTSP] ${count} stream${count === 1 ? '' : 's'} active`);
	}
}, 10000);

// Periodic auth lockout pruning to prevent unbounded growth
setInterval(pruneAuthLockouts, AUTH_LOCKOUT_PRUNE_MS);

// Initialize sessions database
try {
	sessions.setMaxAgeDays(SESSION_MAX_AGE_DAYS);
	sessions.initDb();
	logMessage(`[Sessions] Database initialized (max age: ${SESSION_MAX_AGE_DAYS} days)`);
} catch (err) {
	logMessage(`[Sessions] Failed to initialize database: ${err.message || err}`);
}

// Daily session cleanup (24 hours)
const SESSION_CLEANUP_MS = 24 * 60 * 60 * 1000;
registerBackgroundTask('session-cleanup', SESSION_CLEANUP_MS, () => {
	try {
		sessions.cleanupSessions();
	} catch (err) {
		logMessage(`Session cleanup failed: ${err.message || err}`);
	}
});

// Weatherbit weather data fetch
function isWeatherbitConfigured() {
	return !!(WEATHERBIT_API_KEY && WEATHERBIT_LATITUDE && WEATHERBIT_LONGITUDE);
}

function getWeatherbitCacheAgeMinutes() {
	try {
		const stats = fs.statSync(WEATHERBIT_FORECAST_FILE);
		return Math.floor((Date.now() - stats.mtimeMs) / 60000);
	} catch {
		return Infinity;
	}
}

async function fetchWeatherbitData() {
	if (!isWeatherbitConfigured()) return;

	// Check cache freshness - skip if less than 1 hour old
	const cacheAgeMinutes = getWeatherbitCacheAgeMinutes();
	if (cacheAgeMinutes < 60) {
		logMessage(`[Weather] Using cached data (${cacheAgeMinutes} minutes old)`);
		return;
	}

	// Ensure cache directories exist
	try {
		fs.mkdirSync(WEATHERBIT_CACHE_DIR, { recursive: true });
		fs.mkdirSync(WEATHERBIT_ICONS_DIR, { recursive: true });
	} catch (err) {
		logMessage(`[Weather] Failed to create cache directory: ${err.message || err}`);
		return;
	}

	logMessage('[Weather] Fetching forecast from Weatherbit API...');

	try {
		// Fetch forecast
		const forecastUrl = `https://api.weatherbit.io/v2.0/forecast/daily?lat=${encodeURIComponent(WEATHERBIT_LATITUDE)}&lon=${encodeURIComponent(WEATHERBIT_LONGITUDE)}&key=${encodeURIComponent(WEATHERBIT_API_KEY)}&units=${encodeURIComponent(WEATHERBIT_UNITS)}&days=16`;
		const forecastResponse = await fetch(forecastUrl, {
			headers: { 'User-Agent': USER_AGENT },
			signal: AbortSignal.timeout(30000),
		});

		if (!forecastResponse.ok) {
			logMessage(`[Weather] Forecast API request failed: ${forecastResponse.status} ${forecastResponse.statusText}`);
			return;
		}

		const forecast = await forecastResponse.json();
		logMessage(`[Weather] Forecast fetched (${forecast.city_name || 'unknown location'})`);

		// Fetch current weather
		let current = null;
		let currentDescription = null;
		try {
			logMessage('[Weather] Fetching current weather...');
			const currentUrl = `https://api.weatherbit.io/v2.0/current?lat=${encodeURIComponent(WEATHERBIT_LATITUDE)}&lon=${encodeURIComponent(WEATHERBIT_LONGITUDE)}&key=${encodeURIComponent(WEATHERBIT_API_KEY)}&units=${encodeURIComponent(WEATHERBIT_UNITS)}`;
			const currentResponse = await fetch(currentUrl, {
				headers: { 'User-Agent': USER_AGENT },
				signal: AbortSignal.timeout(30000),
			});

			if (currentResponse.ok) {
				const currentData = await currentResponse.json();
				if (currentData?.data?.[0]?.temp !== undefined) {
					current = Math.round(currentData.data[0].temp);
					currentDescription = currentData.data[0].weather?.description || null;
					logMessage(`[Weather] Current temperature: ${current}° (${currentDescription || 'no description'})`);
				}
			}
		} catch (currentErr) {
			logMessage(`[Weather] Failed to fetch current weather: ${currentErr.message || currentErr}`);
		}

		// Fall back to today's forecast if current fetch failed
		if (current === null && forecast?.data?.[0]?.temp !== undefined) {
			current = Math.round(forecast.data[0].temp);
			currentDescription = forecast.data[0].weather?.description || null;
			logMessage(`[Weather] Using forecast as fallback: ${current}° (${currentDescription || 'no description'})`);
		}

		// Save combined data
		const combined = { forecast, current, currentDescription };
		fs.writeFileSync(WEATHERBIT_FORECAST_FILE, JSON.stringify(combined, null, 2));
		logMessage(`[Weather] Data cached successfully`);

		// Cache weather icons
		if (Array.isArray(forecast.data)) {
			const icons = new Set(forecast.data.map((d) => d.weather?.icon).filter(Boolean));
			for (const icon of icons) {
				const iconPath = path.join(WEATHERBIT_ICONS_DIR, `${icon}.png`);
				if (fs.existsSync(iconPath)) continue;

				try {
					const iconUrl = `https://www.weatherbit.io/static/img/icons/${icon}.png`;
					const iconRes = await fetch(iconUrl, {
						headers: { 'User-Agent': USER_AGENT },
						signal: AbortSignal.timeout(10000),
					});
					if (iconRes.ok) {
						const buffer = Buffer.from(await iconRes.arrayBuffer());
						fs.writeFileSync(iconPath, buffer);
						logMessage(`[Weather] Cached icon: ${icon}.png`);
					}
				} catch (iconErr) {
					logMessage(`[Weather] Failed to cache icon ${icon}: ${iconErr.message || iconErr}`);
				}
			}
		}
	} catch (err) {
		logMessage(`[Weather] API fetch failed: ${err.message || err}`);
	}
}

// Schedule weatherbit refresh (uses WEATHERBIT_REFRESH_MS from config, 0 if not configured)
registerBackgroundTask('weatherbit', isWeatherbitConfigured() ? WEATHERBIT_REFRESH_MS : 0, fetchWeatherbitData);

// MySQL connection worker
function getMysqlConnectionTarget() {
	const socket = safeText(MYSQL_CONFIG.socket);
	const host = safeText(MYSQL_CONFIG.host);
	const port = safeText(MYSQL_CONFIG.port);
	if (socket) return socket;
	if (host && port) return `${host}:${port}`;
	if (host) return host;
	return null;
}

function isMysqlConfigured() {
	return !!(safeText(MYSQL_CONFIG.socket) || safeText(MYSQL_CONFIG.host));
}

function connectMysql() {
	if (!isMysqlConfigured()) return;
	if (mysqlConnecting) return;
	if (mysqlConnection) return;

	mysqlConnecting = true;
	const target = getMysqlConnectionTarget();
	logMessage(`[MySQL] Connecting to ${target}...`);

	const connectionConfig = {
		database: safeText(MYSQL_CONFIG.database) || undefined,
		user: safeText(MYSQL_CONFIG.username) || undefined,
		password: safeText(MYSQL_CONFIG.password) || undefined,
	};

	const socket = safeText(MYSQL_CONFIG.socket);
	if (socket) {
		connectionConfig.socketPath = socket;
	} else {
		connectionConfig.host = safeText(MYSQL_CONFIG.host);
		const port = configNumber(MYSQL_CONFIG.port);
		if (port) connectionConfig.port = port;
	}

	const connection = mysql.createConnection(connectionConfig);

	connection.connect((err) => {
		mysqlConnecting = false;
		if (err) {
			logMessage(`[MySQL] Connection to ${target} failed: ${err.message || err}`);
			mysqlConnection = null;
			scheduleMysqlReconnect();
			return;
		}
		mysqlConnection = connection;
		logMessage(`[MySQL] Connection to ${target} established`);
	});

	connection.on('error', (err) => {
		logMessage(`[MySQL] Connection error: ${err.message || err}`);
		if (err.fatal) {
			mysqlConnection = null;
			scheduleMysqlReconnect();
		}
	});

	connection.on('end', () => {
		logMessage(`[MySQL] Connection closed`);
		mysqlConnection = null;
	});
}

function scheduleMysqlReconnect() {
	if (!isMysqlConfigured()) return;
	const target = getMysqlConnectionTarget();
	logMessage(`[MySQL] Reconnecting to ${target} in ${MYSQL_RECONNECT_DELAY_MS / 1000}s...`);
	setTimeout(() => {
		connectMysql();
	}, MYSQL_RECONNECT_DELAY_MS);
}

function getMysqlConnection() {
	return mysqlConnection;
}

// Initialize MySQL connection if configured
if (isMysqlConfigured()) {
	connectMysql();
}

startBackgroundTasks();

function startHttpServer() {
	const server = http.createServer(app);
	server.on('error', (err) => {
		logMessage(`HTTP server error: ${err.message || err}`);
		process.exit(1);
	});
	server.on('upgrade', handleWsUpgrade);
	server.listen(HTTP_PORT, HTTP_HOST || undefined, () => {
		const host = HTTP_HOST || '0.0.0.0';
		logMessage(`[Startup] Listening (HTTP): http://${host}:${HTTP_PORT}`);
	});
}

function startHttpsServer() {
	let tlsOptions;
	try {
		tlsOptions = {
			key: fs.readFileSync(HTTPS_KEY_FILE),
			cert: fs.readFileSync(HTTPS_CERT_FILE),
		};
	} catch (err) {
		logMessage(`Failed to read HTTPS credentials: ${err.message || err}`);
		process.exit(1);
	}
	const server = HTTPS_HTTP2
		? http2.createSecureServer({ ...tlsOptions, allowHTTP1: true }, app)
		: https.createServer(tlsOptions, app);
	server.on('error', (err) => {
		logMessage(`HTTPS server error: ${err.message || err}`);
		process.exit(1);
	});
	server.on('upgrade', handleWsUpgrade);
	server.listen(HTTPS_PORT, HTTPS_HOST || undefined, () => {
		const host = HTTPS_HOST || '0.0.0.0';
		const proto = HTTPS_HTTP2 ? 'h2' : 'https';
		logMessage(`[Startup] Listening (HTTPS${HTTPS_HTTP2 ? '+HTTP/2' : ''}): ${proto}://${host}:${HTTPS_PORT}`);
	});
}

if (HTTP_ENABLED) startHttpServer();
if (HTTPS_ENABLED) startHttpsServer();

logMessage(`[Startup] Proxying openHAB from: ${OH_TARGET}`);

// --- IPC Socket for CLI communication ---
const IPC_SOCKET_PATH = path.join(__dirname, 'ohproxy.sock');

// Clean up stale socket file on startup
try {
	if (fs.existsSync(IPC_SOCKET_PATH)) {
		fs.unlinkSync(IPC_SOCKET_PATH);
	}
} catch (err) {
	logMessage(`[IPC] Failed to clean up stale socket: ${err.message}`);
}

const ipcServer = net.createServer((client) => {
	let buffer = '';
	client.on('data', (data) => {
		buffer += data.toString();
		// Process complete JSON messages (newline-delimited)
		const lines = buffer.split('\n');
		buffer = lines.pop(); // Keep incomplete line in buffer
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line);
				handleIpcMessage(msg, client);
			} catch (err) {
				logMessage(`[IPC] Invalid message: ${err.message}`);
				client.write(JSON.stringify({ ok: false, error: 'Invalid JSON' }) + '\n');
			}
		}
	});
	client.on('error', (err) => {
		logMessage(`[IPC] Client error: ${err.message}`);
	});
});

function handleIpcMessage(msg, client) {
	const { action, payload } = msg;
	logMessage(`[IPC] Received action: ${action}`);

	switch (action) {
		case 'user-deleted':
		case 'password-changed': {
			const { username } = payload || {};
			if (!username) {
				client.write(JSON.stringify({ ok: false, error: 'Missing username' }) + '\n');
				return;
			}
			const count = notifyUserLogout(username, action);
			client.write(JSON.stringify({ ok: true, disconnected: count }) + '\n');
			break;
		}
		case 'ping': {
			client.write(JSON.stringify({ ok: true, pong: true }) + '\n');
			break;
		}
		default:
			client.write(JSON.stringify({ ok: false, error: `Unknown action: ${action}` }) + '\n');
	}
}

function notifyUserLogout(username, reason) {
	let count = 0;
	for (const ws of wss.clients) {
		if (ws.ohProxyUser === username && ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(JSON.stringify({ event: 'account-deleted' }));
				ws.close(1000, reason || 'Account deleted');
				count++;
			} catch (err) {
				logMessage(`[IPC] Failed to notify client: ${err.message}`);
			}
		}
	}
	logMessage(`[IPC] Notified ${count} client(s) of ${reason || 'logout'}: ${username}`);
	return count;
}

ipcServer.on('error', (err) => {
	logMessage(`[IPC] Server error: ${err.message}`);
});

ipcServer.listen(IPC_SOCKET_PATH, () => {
	// Make socket accessible
	try {
		fs.chmodSync(IPC_SOCKET_PATH, 0o660);
	} catch (err) {
		logMessage(`[IPC] Failed to set socket permissions: ${err.message}`);
	}
	logMessage(`[IPC] Listening on ${IPC_SOCKET_PATH}`);
});

// Clean up socket on exit
process.on('exit', () => {
	try {
		if (fs.existsSync(IPC_SOCKET_PATH)) fs.unlinkSync(IPC_SOCKET_PATH);
	} catch (err) { /* ignore */ }
});
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());
