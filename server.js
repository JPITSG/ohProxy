'use strict';

const express = require('express');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { execFile } = require('child_process');
const http = require('http');
const https = require('https');
const spdy = require('spdy');
const crypto = require('crypto');
const { createProxyMiddleware } = require('http-proxy-middleware');
const WebSocket = require('ws');

const CONFIG_PATH = path.join(__dirname, 'config.js');
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function authHeader() {
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
	res.setHeader('X-OhProxy-Lan', authInfo && authInfo.lan ? 'true' : 'false');
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
	const candidate = /^(https?:)?\/\//i.test(raw) ? raw : `http://${raw}`;
	try {
		const url = new URL(candidate);
		const host = safeText(url.hostname).toLowerCase();
		if (!host) return null;
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
	return url.protocol === 'https:' ? '443' : '80';
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
const LAN_SUBNETS = Array.isArray(SERVER_CONFIG.lanSubnets) ? SERVER_CONFIG.lanSubnets : [];
const OH_TARGET = safeText(process.env.OH_TARGET || SERVER_CONFIG.openhab?.target);
const OH_USER = safeText(process.env.OH_USER || SERVER_CONFIG.openhab?.user || '');
const OH_PASS = safeText(process.env.OH_PASS || SERVER_CONFIG.openhab?.pass || '');
const ICON_VERSION = safeText(process.env.ICON_VERSION || SERVER_CONFIG.assets?.iconVersion);
const USER_AGENT = safeText(process.env.USER_AGENT || SERVER_CONFIG.userAgent);
const ASSET_JS_VERSION = safeText(SERVER_CONFIG.assets?.jsVersion);
const ASSET_CSS_VERSION = safeText(SERVER_CONFIG.assets?.cssVersion);
const APPLE_TOUCH_VERSION_RAW = safeText(SERVER_CONFIG.assets?.appleTouchIconVersion);
const APPLE_TOUCH_VERSION = APPLE_TOUCH_VERSION_RAW
	? (APPLE_TOUCH_VERSION_RAW.startsWith('v')
		? APPLE_TOUCH_VERSION_RAW
		: `v${APPLE_TOUCH_VERSION_RAW}`)
	: '';
const ICON_SIZE = configNumber(SERVER_CONFIG.iconSize);
const ICON_CACHE_CONCURRENCY = Math.max(1, Math.floor(configNumber(SERVER_CONFIG.iconCacheConcurrency, 5)));
const DELTA_CACHE_LIMIT = configNumber(SERVER_CONFIG.deltaCacheLimit);
const PROXY_LOG_LEVEL = safeText(process.env.PROXY_LOG_LEVEL || SERVER_CONFIG.proxyMiddlewareLogLevel);
const LOG_FILE = safeText(process.env.LOG_FILE || SERVER_CONFIG.logFile);
const ACCESS_LOG = safeText(process.env.ACCESS_LOG || SERVER_CONFIG.accessLog);
const ACCESS_LOG_LEVEL = safeText(process.env.ACCESS_LOG_LEVEL || SERVER_CONFIG.accessLogLevel || 'all')
	.trim()
	.toLowerCase();
const SLOW_QUERY_MS = configNumber(SERVER_CONFIG.slowQueryMs, 0);
const AUTH_USERS_FILE = safeText(SERVER_AUTH.usersFile);
const AUTH_WHITELIST = SERVER_AUTH.whitelistSubnets;
const AUTH_REALM = safeText(SERVER_AUTH.realm || 'openHAB Proxy');
const AUTH_COOKIE_NAME = safeText(SERVER_AUTH.cookieName || 'AuthStore');
const AUTH_COOKIE_DAYS = configNumber(SERVER_AUTH.cookieDays, 0);
const AUTH_COOKIE_KEY = safeText(SERVER_AUTH.cookieKey || '');
const AUTH_FAIL_NOTIFY_CMD = safeText(SERVER_AUTH.authFailNotifyCmd || '');
const AUTH_FAIL_NOTIFY_INTERVAL_MS = 15 * 60 * 1000;
const AUTH_LOCKOUT_THRESHOLD = 3;
const AUTH_LOCKOUT_MS = 15 * 60 * 1000;
const SECURITY_HEADERS_ENABLED = SECURITY_HEADERS.enabled !== false;
const SECURITY_HSTS = SECURITY_HEADERS.hsts || {};
const SECURITY_CSP = SECURITY_HEADERS.csp || {};
const SECURITY_REFERRER_POLICY = safeText(SECURITY_HEADERS.referrerPolicy || '');
const TASK_CONFIG = SERVER_CONFIG.backgroundTasks || {};
const SITEMAP_REFRESH_MS = configNumber(
	process.env.SITEMAP_REFRESH_MS || TASK_CONFIG.sitemapRefreshMs
);
let lastAuthFailNotifyAt = 0;
const authLockouts = new Map();

function logMessage(message) {
	writeLogLine(LOG_FILE, message);
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

function ensureAllowSubnets(value, name, errors) {
	if (!ensureArray(value, name, { allowEmpty: false }, errors)) return;
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
	ensureString(value, name, { allowEmpty: false }, errors);
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

	if (ensureObject(SERVER_CONFIG.openhab, 'server.openhab', errors)) {
		ensureUrl(OH_TARGET, 'server.openhab.target', errors);
		ensureString(OH_USER, 'server.openhab.user', { allowEmpty: true }, errors);
		ensureString(OH_PASS, 'server.openhab.pass', { allowEmpty: true }, errors);
	}

	if (ensureObject(SERVER_CONFIG.assets, 'server.assets', errors)) {
		ensureVersion(ASSET_JS_VERSION, 'server.assets.jsVersion', errors);
		ensureVersion(ASSET_CSS_VERSION, 'server.assets.cssVersion', errors);
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
		ensureReadableFile(SERVER_AUTH.usersFile, 'server.auth.usersFile', errors);
		ensureCidrList(SERVER_AUTH.whitelistSubnets, 'server.auth.whitelistSubnets', { allowEmpty: true }, errors);
		ensureString(AUTH_REALM, 'server.auth.realm', { allowEmpty: false }, errors);
		ensureString(AUTH_COOKIE_NAME, 'server.auth.cookieName', { allowEmpty: true }, errors);
		ensureNumber(AUTH_COOKIE_DAYS, 'server.auth.cookieDays', { min: 0 }, errors);
		ensureString(AUTH_COOKIE_KEY, 'server.auth.cookieKey', { allowEmpty: true }, errors);
		ensureString(SERVER_AUTH.authFailNotifyCmd, 'server.auth.authFailNotifyCmd', { allowEmpty: true }, errors);
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

	if (ensureArray(SERVER_CONFIG.proxyAllowlist, 'server.proxyAllowlist', { allowEmpty: false }, errors)) {
		SERVER_CONFIG.proxyAllowlist.forEach((entry, index) => {
			if (!parseProxyAllowEntry(entry)) {
				errors.push(`server.proxyAllowlist[${index}] is not a valid host or host:port`);
			}
		});
	}

	if (ensureObject(CLIENT_CONFIG, 'client', errors)) {
		if (ensureArray(CLIENT_CONFIG.glowSections, 'client.glowSections', { allowEmpty: true }, errors)) {
			CLIENT_CONFIG.glowSections.forEach((entry, index) => {
				if (typeof entry !== 'string' || entry.trim() === '') {
					errors.push(`client.glowSections[${index}] must be a string`);
				}
			});
		}
		if (ensureArray(CLIENT_CONFIG.stateGlowSections, 'client.stateGlowSections', { allowEmpty: true }, errors)) {
			CLIENT_CONFIG.stateGlowSections.forEach((entry, index) => {
				if (!isPlainObject(entry)) {
					errors.push(`client.stateGlowSections[${index}] must be an object`);
					return;
				}
				if (typeof entry.section !== 'string' || entry.section.trim() === '') {
					errors.push(`client.stateGlowSections[${index}].section must be a string`);
				}
				if (!isPlainObject(entry.states)) {
					errors.push(`client.stateGlowSections[${index}].states must be an object`);
					return;
				}
				for (const [stateKey, colorValue] of Object.entries(entry.states)) {
					if (typeof stateKey !== 'string' || stateKey.trim() === '') {
						errors.push(`client.stateGlowSections[${index}].states must use non-empty string keys`);
						break;
					}
					if (typeof colorValue !== 'string' || colorValue.trim() === '') {
						errors.push(`client.stateGlowSections[${index}].states["${stateKey}"] must be a string`);
					}
				}
			});
		}
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
	if (raw.startsWith('::ffff:')) return raw.slice(7);
	if (raw.includes(':')) return '';
	return raw;
}

function getRemoteIp(req) {
	return normalizeRemoteIp(req?.socket?.remoteAddress || '');
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

let authUsersCache = null;
let authUsersMtime = 0;

function loadAuthUsers(pathname) {
	const filePath = safeText(pathname).trim();
	if (!filePath) return null;
	let stat;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return null;
	}
	const mtime = stat.mtimeMs || stat.mtime.getTime();
	if (authUsersCache && authUsersMtime === mtime) return authUsersCache;
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
	authUsersCache = users;
	authUsersMtime = mtime;
	return users;
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
	if (res.statusCode === 401) return;
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

function buildAuthCookieValue(user, pass, key, expiry) {
	const userEncoded = base64UrlEncode(user);
	const payload = `${userEncoded}|${expiry}`;
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
	if (parts.length !== 3) return null;
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
	return user;
}

function setAuthCookie(res, user, pass) {
	if (!liveConfig.authCookieKey || !liveConfig.authCookieName || liveConfig.authCookieDays <= 0) return;
	const expiry = Math.floor(Date.now() / 1000) + Math.round(liveConfig.authCookieDays * 86400);
	const value = buildAuthCookieValue(user, pass, liveConfig.authCookieKey, expiry);
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

function normalizeNotifyIp(value) {
	const raw = safeText(value).trim();
	if (!raw) return 'unknown';
	const cleaned = raw.replace(/[^0-9a-fA-F:.]/g, '');
	return cleaned || 'unknown';
}

function maybeNotifyAuthFailure(ip) {
	if (!liveConfig.authFailNotifyCmd) return;
	const now = Date.now();
	if (lastAuthFailNotifyAt && now - lastAuthFailNotifyAt < AUTH_FAIL_NOTIFY_INTERVAL_MS) return;
	const safeIp = normalizeNotifyIp(ip);
	const command = liveConfig.authFailNotifyCmd.replace(/\{IP\}/g, safeIp).trim();
	if (!command) return;
	lastAuthFailNotifyAt = now;
	try {
		const child = execFile('/bin/sh', ['-c', command], { detached: true, stdio: 'ignore' });
		child.unref();
		logMessage(`Auth failure notify command executed for ${safeIp}`);
	} catch (err) {
		logMessage(`Failed to run auth failure notify command: ${err.message || err}`);
	}
}

function sendAuthRequired(res) {
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
	if (pathname === '/sw.js') return true;
	if (pathname === '/favicon.ico') return true;
	if (pathname.startsWith('/icons/')) return true;
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
		return { auth: 'authenticated', user: authUser, lan: false };
	}
	const clientIp = normalizeRequestIp(req?.ohProxyClientIp || '');
	const remote = normalizeRequestIp(req?.socket?.remoteAddress || '');
	const isLan = (clientIp && ipInAnySubnet(clientIp, liveConfig.lanSubnets))
		|| (remote && ipInAnySubnet(remote, liveConfig.lanSubnets));
	return { auth: 'unauthenticated', user: '', lan: isLan };
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

logMessage('Starting ohProxy instance...');

const LOCAL_CONFIG_PATH = path.join(__dirname, 'config.local.js');
let lastConfigMtime = 0;
let configRestartScheduled = false;
let configRestartTriggered = false;

// Live config - values that can be hot-reloaded without restart
const liveConfig = {
	allowSubnets: ALLOW_SUBNETS,
	lanSubnets: LAN_SUBNETS,
	proxyAllowlist: PROXY_ALLOWLIST,
	ohTarget: OH_TARGET,
	ohUser: OH_USER,
	ohPass: OH_PASS,
	iconVersion: ICON_VERSION,
	userAgent: USER_AGENT,
	assetJsVersion: ASSET_JS_VERSION,
	assetCssVersion: ASSET_CSS_VERSION,
	appleTouchVersion: APPLE_TOUCH_VERSION,
	iconSize: ICON_SIZE,
	iconCacheConcurrency: ICON_CACHE_CONCURRENCY,
	deltaCacheLimit: DELTA_CACHE_LIMIT,
	slowQueryMs: SLOW_QUERY_MS,
	authWhitelist: AUTH_WHITELIST,
	authRealm: AUTH_REALM,
	authCookieName: AUTH_COOKIE_NAME,
	authCookieDays: AUTH_COOKIE_DAYS,
	authCookieKey: AUTH_COOKIE_KEY,
	authFailNotifyCmd: AUTH_FAIL_NOTIFY_CMD,
	securityHeadersEnabled: SECURITY_HEADERS_ENABLED,
	securityHsts: SECURITY_HSTS,
	securityCsp: SECURITY_CSP,
	securityReferrerPolicy: SECURITY_REFERRER_POLICY,
	sitemapRefreshMs: SITEMAP_REFRESH_MS,
	clientConfig: CLIENT_CONFIG,
};

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

	liveConfig.allowSubnets = newServer.allowSubnets;
	liveConfig.lanSubnets = Array.isArray(newServer.lanSubnets) ? newServer.lanSubnets : [];
	liveConfig.proxyAllowlist = normalizeProxyAllowlist(newServer.proxyAllowlist);
	liveConfig.ohTarget = safeText(newServer.openhab?.target);
	liveConfig.ohUser = safeText(newServer.openhab?.user || '');
	liveConfig.ohPass = safeText(newServer.openhab?.pass || '');
	const oldIconVersion = liveConfig.iconVersion;
	liveConfig.iconVersion = safeText(newAssets.iconVersion);
	if (liveConfig.iconVersion !== oldIconVersion) {
		purgeOldIconCache();
		ensureDir(getIconCacheDir());
	}
	liveConfig.userAgent = safeText(newServer.userAgent);
	liveConfig.assetJsVersion = safeText(newAssets.jsVersion);
	liveConfig.assetCssVersion = safeText(newAssets.cssVersion);
	const appleTouchRaw = safeText(newAssets.appleTouchIconVersion);
	liveConfig.appleTouchVersion = appleTouchRaw
		? (appleTouchRaw.startsWith('v') ? appleTouchRaw : `v${appleTouchRaw}`)
		: '';
	liveConfig.iconSize = configNumber(newServer.iconSize);
	liveConfig.iconCacheConcurrency = Math.max(1, Math.floor(configNumber(newServer.iconCacheConcurrency, 5)));
	liveConfig.deltaCacheLimit = configNumber(newServer.deltaCacheLimit);
	liveConfig.slowQueryMs = configNumber(newServer.slowQueryMs, 0);
	liveConfig.authWhitelist = newAuth.whitelistSubnets;
	liveConfig.authRealm = safeText(newAuth.realm || 'openHAB Proxy');
	liveConfig.authCookieName = safeText(newAuth.cookieName || 'AuthStore');
	liveConfig.authCookieDays = configNumber(newAuth.cookieDays, 0);
	liveConfig.authCookieKey = safeText(newAuth.cookieKey || '');
	liveConfig.authFailNotifyCmd = safeText(newAuth.authFailNotifyCmd || '');
	liveConfig.securityHeadersEnabled = newSecurityHeaders.enabled !== false;
	liveConfig.securityHsts = newSecurityHeaders.hsts || {};
	liveConfig.securityCsp = newSecurityHeaders.csp || {};
	liveConfig.securityReferrerPolicy = safeText(newSecurityHeaders.referrerPolicy || '');
	liveConfig.sitemapRefreshMs = configNumber(newTasks.sitemapRefreshMs);
	liveConfig.clientConfig = newConfig.client || {};

	logMessage('Config hot-reloaded successfully');
	return false; // No restart required
}

lastConfigMtime = readConfigLocalMtime();

function scheduleConfigRestart() {
	if (configRestartScheduled) return;
	configRestartScheduled = true;
	logMessage('Detected config.local.js change, scheduling restart.');
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
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, 'index.html');
const SERVICE_WORKER_PATH = path.join(PUBLIC_DIR, 'sw.js');
const ICON_CACHE_ROOT = path.join(__dirname, '.icon-cache');
function getIconCacheDir() {
	return path.join(ICON_CACHE_ROOT, liveConfig.iconVersion);
}
const iconInflight = new Map();
const deltaCache = new Map();
let indexTemplate = null;
let serviceWorkerTemplate = null;
const backgroundTasks = [];

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

function scheduleBackgroundTask(task) {
	if (!task || !task.intervalMs || task.intervalMs <= 0) return;
	if (task.timer) clearTimeout(task.timer);
	task.timer = setTimeout(() => runBackgroundTask(task), task.intervalMs);
}

async function runBackgroundTask(task) {
	if (!task || task.running) return;
	task.running = true;
	try {
		await task.run();
		task.lastRun = Date.now();
	} catch (err) {
		logMessage(`Background task ${task.name} failed: ${err.message || err}`);
	} finally {
		task.running = false;
		scheduleBackgroundTask(task);
	}
}

function startBackgroundTasks() {
	for (const task of backgroundTasks) {
		if (task.intervalMs <= 0) continue;
		runBackgroundTask(task);
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
	const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
	logMessage(`[WS] Client connected from ${clientIp}, total: ${wss.clients.size}`);

	ws.isAlive = true;

	// Send welcome message
	try {
		ws.send(JSON.stringify({ event: 'connected', data: { time: Date.now() } }));
	} catch (e) {
		logMessage(`[WS] Send error for ${clientIp}: ${e.message}`);
	}

	startAtmosphereIfNeeded();

	ws.on('pong', () => { ws.isAlive = true; });

	ws.on('close', (code, reason) => {
		logMessage(`[WS] Client disconnected from ${clientIp}, code: ${code}, reason: ${reason || 'none'}, remaining: ${wss.clients.size}`);
		stopAtmosphereIfUnneeded();
	});

	ws.on('error', (err) => {
		logMessage(`[WS] Client error from ${clientIp}: ${err.message || err}`);
		stopAtmosphereIfUnneeded();
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
	logMessage(`[WS] Broadcast '${event}' to ${sent}/${wss.clients.size} clients, payload: ${payload.length} bytes`);
}

function parseAtmosphereUpdate(body) {
	try {
		const data = JSON.parse(body);
		if (!data || !data.widget) return null;
		const changes = [];
		function extractItems(widget) {
			if (widget.item && widget.item.name && widget.item.state !== undefined) {
				changes.push({ name: widget.item.name, state: widget.item.state });
			}
			if (Array.isArray(widget.widget)) {
				widget.widget.forEach(extractItems);
			} else if (widget.widget) {
				extractItems(widget.widget);
			}
		}
		if (Array.isArray(data.widget)) {
			data.widget.forEach(extractItems);
		} else if (data.widget) {
			extractItems(data.widget);
		}
		if (changes.length === 0) return null;
		return { type: 'items', changes };
	} catch {
		return null;
	}
}

// Track multiple page subscriptions
const atmospherePages = new Map(); // pageId -> { connection, trackingId, reconnectTimer }

// Track item states to detect actual changes (not just openHAB reporting unchanged items)
const itemStates = new Map(); // itemName -> state

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
		res.on('end', () => {
			pageState.connection = null;
			if (res.statusCode === 200 && body.trim()) {
				const update = parseAtmosphereUpdate(body);
				if (update && update.changes.length > 0) {
					// Filter to only items that actually changed
					const actualChanges = filterChangedItems(update.changes);
					if (actualChanges.length > 0) {
						logMessage(`[Atmosphere:${pageId}] ${actualChanges.length} items changed (${update.changes.length} reported)`);
						if (wss.clients.size > 0) {
							wsBroadcast('update', { type: 'items', changes: actualChanges });
						}
					}
				}
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
		if (msg !== 'socket hang up' && err.code !== 'ECONNRESET') {
			logMessage(`[Atmosphere:${pageId}] Error: ${msg}`);
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
	// Recurse into widgets
	const widgets = Array.isArray(data.widget) ? data.widget : (data.widget ? [data.widget] : []);
	for (const w of widgets) {
		extractPageIds(w, pages);
	}
	// Check homepage
	if (data.homepage) {
		extractPageIds(data.homepage, pages);
	}
	return pages;
}

async function fetchAllPages() {
	const sitemapName = backgroundState.sitemap.name || 'default';
	try {
		const result = await fetchOpenhab(`/rest/sitemaps/${sitemapName}?type=json`);
		if (!result.ok) {
			throw new Error(`HTTP ${result.status}`);
		}
		const data = JSON.parse(result.body);
		const pages = extractPageIds(data);
		return Array.from(pages);
	} catch (e) {
		logMessage(`[Atmosphere] Failed to fetch pages: ${e.message}`);
		return [sitemapName]; // fallback to just the sitemap name
	}
}

async function connectAtmosphere() {
	// Stop all existing connections
	stopAllAtmosphereConnections();

	// Fetch all pages and subscribe to each
	const pages = await fetchAllPages();
	logMessage(`[Atmosphere] Subscribing to ${pages.length} pages: ${pages.join(', ')}`);

	for (const pageId of pages) {
		connectAtmospherePage(pageId);
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
}

function startAtmosphereIfNeeded() {
	if (wss.clients.size > 0 && atmospherePages.size === 0) {
		connectAtmosphere();
	}
}

function stopAtmosphereIfUnneeded() {
	if (wss.clients.size === 0) {
		stopAllAtmosphereConnections();
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

function handleWsUpgrade(req, socket, head) {
	const pathname = new URL(req.url, 'http://localhost').pathname;
	const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
	const clientExts = req.headers['sec-websocket-extensions'] || 'none';
	logMessage(`[WS] Upgrade request from ${clientIp} for ${pathname}, extensions: ${clientExts}`);

	if (pathname !== '/ws') {
		logMessage(`[WS] Rejected upgrade for ${pathname} from ${clientIp}`);
		socket.destroy();
		return;
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

function normalizeRequestIp(raw) {
	const text = safeText(raw).trim();
	if (!text) return '';
	if (text.startsWith('::ffff:')) return text.slice(7);
	return text;
}

function extractHostIp(host) {
	const text = safeText(host).trim();
	if (!text) return '';
	if (text[0] === '[') {
		const end = text.indexOf(']');
		if (end > 0) return text.slice(1, end);
	}
	return text.split(':')[0];
}

function getInitialStatusLabel(req) {
	const info = getAuthInfo(req);
	if (info.auth === 'authenticated' && info.user) {
		return `Connected · ${info.user}`;
	}
	if (info.lan) return 'Connected · LAN';
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
	html = html.replace(/__CSS_VERSION__/g, liveConfig.assetCssVersion);
	html = html.replace(/__JS_VERSION__/g, liveConfig.assetJsVersion);
	html = html.replace(/__APPLE_TOUCH_VERSION__/g, liveConfig.appleTouchVersion);
	html = html.replace(/__PAGE_TITLE__/g, getInitialPageTitleHtml());
	html = html.replace(/__DOC_TITLE__/g, escapeHtml(getInitialDocumentTitle()));
	html = html.replace(/__STATUS_TEXT__/g, escapeHtml(opts.statusText || 'Connected'));
	html = html.replace(/__STATUS_CLASS__/g, escapeHtml(opts.statusClass || 'status-pending'));
	html = html.replace(/__AUTH_INFO__/g, inlineJson(opts.authInfo || {}));
	return html;
}

function renderServiceWorker() {
	if (!serviceWorkerTemplate) serviceWorkerTemplate = fs.readFileSync(SERVICE_WORKER_PATH, 'utf8');
	let script = serviceWorkerTemplate;
	script = script.replace(/__CSS_VERSION__/g, liveConfig.assetCssVersion);
	script = script.replace(/__JS_VERSION__/g, liveConfig.assetJsVersion);
	script = script.replace(/__APPLE_TOUCH_VERSION__/g, liveConfig.appleTouchVersion);
	return script;
}

function sendIndex(req, res) {
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Content-Type', 'text/html; charset=utf-8');
	const status = getInitialStatusInfo(req);
	status.authInfo = getAuthInfo(req);
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
	let w = page?.widget;
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
				let kids = item.widget;
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
	const match = raw.match(/^(.*)\s*\[(.+)\]\s*$/);
	if (!match) return { title: raw, state: '' };
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
	let w = page?.widget;
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
				let kids = item.widget;
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

function widgetSnapshot(widget) {
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
		})),
	}));

	return {
		hash,
		structureHash,
		entryMap,
		title: safeText(page?.title || ''),
	};
}

function setDeltaCache(key, value) {
	deltaCache.set(key, value);
	if (deltaCache.size <= DELTA_CACHE_LIMIT) return;
	const oldestKey = deltaCache.keys().next().value;
	if (oldestKey) deltaCache.delete(oldestKey);
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
	while (iconConvertActive < ICON_CACHE_CONCURRENCY && iconConvertQueue.length) {
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

		req.on('error', reject);
		req.end();
	});
}

async function refreshSitemapCache() {
	let body;
	try {
		body = await fetchOpenhab('/rest/sitemaps?type=json');
	} catch (err) {
		logMessage(`Sitemap cache refresh failed: ${err.message || err}`);
		return false;
	}

	if (!body || !body.ok) {
		logMessage('Sitemap cache refresh failed: upstream error');
		return false;
	}

	let data;
	try {
		data = JSON.parse(body.body);
	} catch {
		logMessage('Sitemap cache refresh failed: non-JSON response');
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
	try {
		const res = await fetchOpenhabBinary(sourcePath);
		if (!res.ok || !isImageContentType(res.contentType)) {
			const reason = !res.ok ? `status ${res.status}` : `content-type ${res.contentType || 'unknown'}`;
			throw new Error(`openHAB icon fetch failed (${reason})`);
		}
		fs.writeFileSync(srcPath, res.body);
		ensureDir(path.dirname(cachePath));
		await enqueueIconConvert(() => execFileAsync('convert', [
			srcPath,
			'-resize', `${ICON_SIZE}x${ICON_SIZE}`,
			'-background', 'none',
			'-gravity', 'center',
			'-extent', `${ICON_SIZE}x${ICON_SIZE}`,
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
				logMessage(`Slow request (${duration}ms): ${req.method} ${req.originalUrl}`);
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
	if (Array.isArray(liveConfig.allowSubnets) && liveConfig.allowSubnets.some((entry) => isAllowAllSubnet(entry))) return next();
	const ip = getRemoteIp(req);
	if (!ip || !ipInAnySubnet(ip, liveConfig.allowSubnets)) {
		logMessage(`Blocked request from ${ip || 'unknown'} for ${req.method} ${req.originalUrl}`);
		res.status(403).type('text/plain').send('Forbidden');
		return;
	}
	next();
});
app.use((req, res, next) => {
	const clientIp = getRemoteIp(req);
	if (clientIp) req.ohProxyClientIp = clientIp;
	if (isAuthExemptPath(req) && hasMatchingReferrer(req)) {
		req.ohProxyAuth = 'unauthenticated';
		req.ohProxyUser = '';
		return next();
	}
	let requiresAuth = !clientIp;
	if (clientIp) {
		const inWhitelist = ipInAnySubnet(clientIp, liveConfig.authWhitelist);
		const inLan = ipInAnySubnet(clientIp, liveConfig.lanSubnets);
		requiresAuth = !inWhitelist && !inLan;
	}
	if (!requiresAuth) {
		req.ohProxyAuth = 'unauthenticated';
		req.ohProxyUser = '';
		return next();
	}
	const lockKey = getLockoutKey(clientIp);
	const lockout = getAuthLockout(lockKey);
	if (lockout && lockout.lockUntil) {
		const remaining = Math.max(0, Math.ceil((lockout.lockUntil - Date.now()) / 1000));
		logMessage(`Auth lockout active for ${lockKey} (${remaining}s remaining)`);
		res.status(429).type('text/plain').send('Too many authentication attempts');
		return;
	}
	const users = loadAuthUsers(AUTH_USERS_FILE);
	if (!users || Object.keys(users).length === 0) {
		res.status(500).type('text/plain').send('Auth config unavailable');
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
	} else if (liveConfig.authCookieKey && liveConfig.authCookieName) {
		const cookieUser = getAuthCookieUser(req, users, liveConfig.authCookieKey);
		if (cookieUser) {
			authenticatedUser = cookieUser;
		} else if (getCookieValue(req, liveConfig.authCookieName)) {
			clearAuthCookie(res);
		}
	}
	if (!authenticatedUser) {
		sendAuthRequired(res);
		return;
	}
	clearAuthFailures(lockKey);
	setAuthCookie(res, authenticatedUser, users[authenticatedUser]);
	req.ohProxyAuth = 'authenticated';
	req.ohProxyUser = authenticatedUser;
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
	res.send(`window.__OH_CONFIG__=${JSON.stringify({
		iconVersion: liveConfig.iconVersion,
		server: {
			lanSubnets: Array.isArray(liveConfig.lanSubnets) ? liveConfig.lanSubnets : [],
		},
		client: clientConfig,
	})};`);
});

app.get('/sw.js', (req, res) => {
	sendServiceWorker(res);
});

app.get('/manifest.webmanifest', (req, res) => {
	const manifestPath = path.join(PUBLIC_DIR, 'manifest.webmanifest');
	res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	const theme = safeText(req.query?.theme).toLowerCase();
	if (theme !== 'light' && theme !== 'dark') {
		res.sendFile(manifestPath);
		return;
	}
	try {
		const raw = fs.readFileSync(manifestPath, 'utf8');
		const manifest = JSON.parse(raw);
		const color = theme === 'light' ? '#f8fafc' : '#0f172a';
		manifest.theme_color = color;
		manifest.background_color = color;
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

	res.setHeader('Cache-Control', 'no-store');
	return res.json({ widgets, frames });
});

app.get(/^\/icons\/apple-touch-icon\.v[\w.-]+\.png$/i, (req, res) => {
	const iconPath = path.join(PUBLIC_DIR, 'icons', 'apple-touch-icon.png');
	res.setHeader('Content-Type', 'image/png');
	res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
	res.sendFile(iconPath);
});

app.get(['/', '/index.html'], (req, res) => {
	sendIndex(req, res);
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
	const rawRel = match[2];
	const parsed = path.parse(rawRel);
	const cacheRel = path.join(parsed.dir, `${parsed.name}.png`);
	const cachePath = path.join(getIconCacheDir(), cacheRel);
	const sourcePath = `/openhab.app/images/${rawRel}`;
	const sourceExt = parsed.ext || '.png';

	try {
		const buffer = await getCachedIcon(cachePath, sourcePath, sourceExt);
		res.setHeader('Content-Type', 'image/png');
		res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
		res.send(buffer);
	} catch (err) {
		logMessage(`Icon cache failed for ${rawRel}: ${err.message || err}`);
		next();
	}
});

app.use('/rest', async (req, res, next) => {
	if (req.method !== 'GET') return next();
	const delta = safeText(req.query?.delta || '');
	if (delta !== '1' && delta !== 'true') return next();
	if (!req.path.startsWith('/sitemaps/')) return next();

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

	const cacheKey = `${req.path}?${params.toString()}`;
	const snapshot = buildSnapshot(page);
	const cached = deltaCache.get(cacheKey);
	const canDelta = cached && since && since === cached.hash && cached.structureHash === snapshot.structureHash;

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
			prev.icon !== current.icon
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
app.use('/chart', createProxyMiddleware({
	...proxyCommon,
	pathRewrite: (path) => `/openhab.app${path}`,
}));
app.use('/images', createProxyMiddleware({
	...proxyCommon,
	pathRewrite: (path) => `/openhab.app${stripIconVersion(path)}`,
}));
app.get('/proxy', async (req, res, next) => {
	const raw = req.query?.url;

	// External URL proxy (url= parameter)
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

		if (!['http:', 'https:'].includes(target.protocol)) {
			return res.status(400).send('Invalid proxy target');
		}
		if (!isProxyTargetAllowed(target, liveConfig.proxyAllowlist)) {
			return res.status(403).send('Proxy target not allowed');
		}

		const headers = {};
		const accept = safeText(req.headers.accept);
		if (accept) headers.Accept = accept;

		try {
			const result = await fetchBinaryFromUrl(target.toString(), headers);
			res.status(result.status || 502);
			if (result.contentType) res.setHeader('Content-Type', result.contentType);
			res.setHeader('Cache-Control', 'no-store');
			res.send(result.body);
		} catch (err) {
			logMessage(`Direct proxy failed for ${target.toString()}: ${err.message || err}`);
			res.status(502).send('Proxy error');
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

// SPA fallback
app.use((req, res) => {
	sendIndex(req, res);
});

if (SITEMAP_REFRESH_MS > 0) {
	registerBackgroundTask('sitemap-cache', SITEMAP_REFRESH_MS, refreshSitemapCache);
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
		logMessage(`ohProxy listening (HTTP): http://${host}:${HTTP_PORT}`);
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
		? spdy.createServer(tlsOptions, app)
		: https.createServer(tlsOptions, app);
	server.on('error', (err) => {
		logMessage(`HTTPS server error: ${err.message || err}`);
		process.exit(1);
	});
	server.on('upgrade', handleWsUpgrade);
	server.listen(HTTPS_PORT, HTTPS_HOST || undefined, () => {
		const host = HTTPS_HOST || '0.0.0.0';
		const proto = HTTPS_HTTP2 ? 'h2' : 'https';
		logMessage(`ohProxy listening (HTTPS${HTTPS_HTTP2 ? '+HTTP/2' : ''}): ${proto}://${host}:${HTTPS_PORT}`);
	});
}

if (HTTP_ENABLED) startHttpServer();
if (HTTPS_ENABLED) startHttpsServer();

logMessage(`Proxying openHAB from: ${OH_TARGET}`);
