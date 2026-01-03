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
const crypto = require('crypto');
const { createProxyMiddleware } = require('http-proxy-middleware');

const CONFIG_PATH = path.join(__dirname, 'config.js');
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function authHeader() {
	if (!OH_USER || !OH_PASS) return null;
	const token = Buffer.from(`${OH_USER}:${OH_PASS}`).toString('base64');
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
const SERVER_AUTH = SERVER_CONFIG.auth || {};
const CLIENT_CONFIG = USER_CONFIG.client || {};
const RELAY_CONFIG = USER_CONFIG.relay || {};
const PROXY_ALLOWLIST = normalizeProxyAllowlist(USER_CONFIG.proxyAllowlist);

const LISTEN_HOST = safeText(process.env.LISTEN_HOST || SERVER_CONFIG.listenHost);
const LISTEN_PORT = configNumber(process.env.LISTEN_PORT || SERVER_CONFIG.listenPort);
const ALLOW_SUBNETS = SERVER_CONFIG.allowSubnets;
const OH_TARGET = safeText(process.env.OH_TARGET || SERVER_CONFIG.openhab?.target);
const OH_USER = safeText(process.env.OH_USER || SERVER_CONFIG.openhab?.user || '');
const OH_PASS = safeText(process.env.OH_PASS || SERVER_CONFIG.openhab?.pass || '');
const ICON_VERSION = safeText(process.env.ICON_VERSION || SERVER_CONFIG.iconVersion);
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
const DELTA_CACHE_LIMIT = configNumber(SERVER_CONFIG.deltaCacheLimit);
const PROXY_LOG_LEVEL = safeText(process.env.PROXY_LOG_LEVEL || SERVER_CONFIG.proxyLogLevel);
const LOG_FILE = safeText(process.env.LOG_FILE || SERVER_CONFIG.logFile);
const ACCESS_LOG = safeText(process.env.ACCESS_LOG || SERVER_CONFIG.accessLog);
const AUTH_USERS_FILE = safeText(SERVER_AUTH.usersFile);
const AUTH_WHITELIST = SERVER_AUTH.whitelistSubnets;
const AUTH_REALM = safeText(SERVER_AUTH.realm || 'openHAB Proxy');
const RELAY_VERSION = safeText(RELAY_CONFIG.version);
const TASK_CONFIG = SERVER_CONFIG.backgroundTasks || {};
const SITEMAP_REFRESH_MS = configNumber(
	process.env.SITEMAP_REFRESH_MS || TASK_CONFIG.sitemapRefreshMs
);

function logMessage(message) {
	writeLogLine(LOG_FILE, message);
}

function logAccess(message) {
	writeLogLine(ACCESS_LOG, message);
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

	ensureString(LISTEN_HOST, 'server.listenHost', { allowEmpty: false }, errors);
	ensureNumber(LISTEN_PORT, 'server.listenPort', { min: 1, max: 65535 }, errors);
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
	}

	ensureVersion(ICON_VERSION, 'server.iconVersion', errors);
	ensureString(USER_AGENT, 'server.userAgent', { allowEmpty: false }, errors);
	ensureNumber(ICON_SIZE, 'server.iconSize', { min: 1 }, errors);
	ensureNumber(DELTA_CACHE_LIMIT, 'server.deltaCacheLimit', { min: 1 }, errors);
	ensureString(PROXY_LOG_LEVEL, 'server.proxyLogLevel', { allowEmpty: false }, errors);
	ensureLogPath(LOG_FILE, 'server.logFile', errors);
	ensureLogPath(ACCESS_LOG, 'server.accessLog', errors);

	if (ensureObject(SERVER_CONFIG.auth, 'server.auth', errors)) {
		ensureReadableFile(SERVER_AUTH.usersFile, 'server.auth.usersFile', errors);
		ensureCidrList(SERVER_AUTH.whitelistSubnets, 'server.auth.whitelistSubnets', { allowEmpty: true }, errors);
		ensureString(AUTH_REALM, 'server.auth.realm', { allowEmpty: false }, errors);
	}

	if (ensureObject(SERVER_CONFIG.backgroundTasks, 'server.backgroundTasks', errors)) {
		ensureNumber(SITEMAP_REFRESH_MS, 'server.backgroundTasks.sitemapRefreshMs', { min: 1000 }, errors);
	}

	if (ensureObject(USER_CONFIG.relay, 'relay', errors)) {
		const relay = USER_CONFIG.relay;
		ensureVersion(relay.version, 'relay.version', errors);
		ensureNumber(relay.configTtlSeconds, 'relay.configTtlSeconds', { min: 1 }, errors);
		ensureNumber(relay.connectTimeout, 'relay.connectTimeout', { min: 1 }, errors);
		ensureNumber(relay.requestTimeout, 'relay.requestTimeout', { min: 1 }, errors);
		ensureReadableFile(relay.usersFile, 'relay.usersFile', errors);
		ensureCidrList(relay.whitelistSubnets, 'relay.whitelistSubnets', { allowEmpty: false }, errors);
		ensureString(relay.authCookieName, 'relay.authCookieName', { allowEmpty: false }, errors);
		ensureNumber(relay.authCookieDays, 'relay.authCookieDays', { min: 1 }, errors);
		ensureString(relay.authCookieKey, 'relay.authCookieKey', { allowEmpty: false }, errors);
		ensureString(relay.authFailNotifyCmd, 'relay.authFailNotifyCmd', { allowEmpty: true }, errors);
		ensureNumber(relay.authFailNotifyCooldown, 'relay.authFailNotifyCooldown', { min: 0 }, errors);
	}

	if (ensureArray(USER_CONFIG.proxyAllowlist, 'proxyAllowlist', { allowEmpty: false }, errors)) {
		USER_CONFIG.proxyAllowlist.forEach((entry, index) => {
			if (!parseProxyAllowEntry(entry)) {
				errors.push(`proxyAllowlist[${index}] is not a valid host or host:port`);
			}
		});
	}

	if (ensureObject(CLIENT_CONFIG, 'client', errors)) {
		ensureCidrList(CLIENT_CONFIG.lanSubnets, 'client.lanSubnets', { allowEmpty: false }, errors);
		if (ensureArray(CLIENT_CONFIG.glowSections, 'client.glowSections', { allowEmpty: true }, errors)) {
			CLIENT_CONFIG.glowSections.forEach((entry, index) => {
				if (typeof entry !== 'string' || entry.trim() === '') {
					errors.push(`client.glowSections[${index}] must be a string`);
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

function getClientIps(req) {
	const ips = [];
	const forwarded = safeText(req?.headers?.['x-forwarded-for'] || '').trim();
	if (forwarded) {
		for (const part of forwarded.split(',')) {
			const ip = part.trim();
			if (ip) ips.push(ip);
		}
	}
	const real = safeText(req?.headers?.['x-real-ip'] || '').trim();
	if (real) ips.push(real);
	const remote = normalizeRemoteIp(req?.socket?.remoteAddress || '');
	if (remote) ips.push(remote);
	const unique = [];
	for (const ip of ips) {
		if (!unique.includes(ip)) unique.push(ip);
	}
	return unique;
}

function sendAuthRequired(res) {
	res.setHeader('WWW-Authenticate', `Basic realm="${AUTH_REALM}"`);
	res.status(401).type('text/plain').send('Unauthorized');
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

lastConfigMtime = readConfigLocalMtime();

function scheduleConfigRestart() {
	if (configRestartScheduled) return;
	configRestartScheduled = true;
	logMessage('Detected config.local.js change, scheduling restart.');
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
const ICON_CACHE_DIR = path.join(ICON_CACHE_ROOT, ICON_VERSION);
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

const DEFAULT_PAGE_TITLE = 'OpenHAB';
const LAN_SUBNETS = Array.isArray(CLIENT_CONFIG.lanSubnets) ? CLIENT_CONFIG.lanSubnets : [];

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

function ipv4ToLong(ip) {
	const raw = safeText(ip).trim();
	if (!raw) return null;
	const parts = raw.split('.');
	if (parts.length != 4) return null;
	let num = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const val = Number(part);
		if (!Number.isInteger(val) || val < 0 || val > 255) return null;
		num = (num * 256) + val;
	}
	return num >>> 0;
}

function ipInSubnet(ip, cidr) {
	const ipLong = ipv4ToLong(ip);
	if (ipLong === null) return false;
	const parts = safeText(cidr).trim().split('/');
	if (parts.length != 2) return false;
	const subnetLong = ipv4ToLong(parts[0]);
	const mask = Number(parts[1]);
	if (subnetLong === null) return false;
	if (!Number.isInteger(mask) || mask < 0 || mask > 32) return false;
	if (mask === 0) return true;
	const maskLong = (0xFFFFFFFF << (32 - mask)) >>> 0;
	return ((ipLong & maskLong) >>> 0) === ((subnetLong & maskLong) >>> 0);
}

function ipInAnySubnet(ip, subnets) {
	if (!Array.isArray(subnets) || !subnets.length) return false;
	for (const cidr of subnets) {
		if (ipInSubnet(ip, cidr)) return true;
	}
	return false;
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
	const authState = safeText(req?.ohProxyAuth || '').trim().toLowerCase();
	const authUser = safeText(req?.ohProxyUser || '').trim();
	if (authState === 'authenticated' && authUser) {
		return `Connected · ${authUser}`;
	}

	const clientIp = normalizeRequestIp(req?.ohProxyClientIp || '');
	if (clientIp && ipInAnySubnet(clientIp, LAN_SUBNETS)) return 'Connected · LAN';

	const remote = normalizeRequestIp(req?.socket?.remoteAddress || '');
	if (remote && ipInAnySubnet(remote, LAN_SUBNETS)) return 'Connected · LAN';

	return 'Connected · LAN';
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
	html = html.replace(/__CSS_VERSION__/g, ASSET_CSS_VERSION);
	html = html.replace(/__JS_VERSION__/g, ASSET_JS_VERSION);
	html = html.replace(/__APPLE_TOUCH_VERSION__/g, APPLE_TOUCH_VERSION);
	html = html.replace(/__PAGE_TITLE__/g, getInitialPageTitleHtml());
	html = html.replace(/__DOC_TITLE__/g, escapeHtml(getInitialDocumentTitle()));
	html = html.replace(/__STATUS_TEXT__/g, escapeHtml(opts.statusText || 'Connected'));
	html = html.replace(/__STATUS_CLASS__/g, escapeHtml(opts.statusClass || 'status-pending'));
	return html;
}

function renderServiceWorker() {
	if (!serviceWorkerTemplate) serviceWorkerTemplate = fs.readFileSync(SERVICE_WORKER_PATH, 'utf8');
	let script = serviceWorkerTemplate;
	script = script.replace(/__CSS_VERSION__/g, ASSET_CSS_VERSION);
	script = script.replace(/__JS_VERSION__/g, ASSET_JS_VERSION);
	script = script.replace(/__APPLE_TOUCH_VERSION__/g, APPLE_TOUCH_VERSION);
	return script;
}

function sendIndex(req, res) {
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Content-Type', 'text/html; charset=utf-8');
	res.send(renderIndexHtml(getInitialStatusInfo(req)));
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
		const base = new URL(OH_TARGET);
		const u = new URL(text, base);
		let out = u.pathname || '/';
		const basePath = base.pathname && base.pathname !== '/' ? base.pathname.replace(/\/$/, '') : '';
		if (basePath && out.startsWith(basePath)) out = out.slice(basePath.length) || '/';
		return `${out}${u.search || ''}`;
	} catch {
		let out = text.startsWith('/') ? text : `/${text}`;
		try {
			const base = new URL(OH_TARGET);
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
		if (entry.name === ICON_VERSION) continue;
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
		const requestHeaders = { ...headers, 'User-Agent': USER_AGENT };
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
		const target = new URL(OH_TARGET);
		const isHttps = target.protocol === 'https:';
		const basePath = target.pathname && target.pathname !== '/' ? target.pathname.replace(/\/$/, '') : '';
		const reqPath = `${basePath}${pathname}`;
		const client = isHttps ? https : http;
		const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
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
	const baseUrl = options.baseUrl || OH_TARGET;
	const headers = { Accept: 'image/*,*/*;q=0.8', 'User-Agent': USER_AGENT };
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
		await execFileAsync('convert', [
			srcPath,
			'-resize', `${ICON_SIZE}x${ICON_SIZE}`,
			'-background', 'none',
			'-gravity', 'center',
			'-extent', `${ICON_SIZE}x${ICON_SIZE}`,
			`PNG32:${cachePath}`,
		]);
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
	stream: {
		write: (line) => logAccess(line),
	},
}));
app.use((req, res, next) => {
	if (!configRestartScheduled) {
		const currentMtime = readConfigLocalMtime();
		if (currentMtime !== lastConfigMtime) {
			lastConfigMtime = currentMtime;
			scheduleConfigRestart();
			res.once('finish', maybeTriggerRestart);
			res.once('close', maybeTriggerRestart);
		}
	}
	if (RELAY_VERSION && req.get('X-OhProxy-ClientIP')) {
		res.setHeader('X-Config-Version', RELAY_VERSION);
	}
	next();
});
app.use((req, res, next) => {
	if (Array.isArray(ALLOW_SUBNETS) && ALLOW_SUBNETS.some((entry) => isAllowAllSubnet(entry))) return next();
	const ip = normalizeRemoteIp(req.ip || req.socket?.remoteAddress || '');
	if (!ip || !ipInAnySubnet(ip, ALLOW_SUBNETS)) {
		logMessage(`Blocked request from ${ip || 'unknown'} for ${req.method} ${req.originalUrl}`);
		res.status(403).type('text/plain').send('Forbidden');
		return;
	}
	next();
});
app.use((req, res, next) => {
	const clientIps = getClientIps(req);
	const clientIpHeader = clientIps[0] || normalizeRemoteIp(req.ip || req.socket?.remoteAddress || '');
	if (clientIpHeader) {
		res.setHeader('X-OhProxy-ClientIP', clientIpHeader);
		req.ohProxyClientIp = clientIpHeader;
	}
	let requiresAuth = clientIps.length === 0;
	for (const ip of clientIps) {
		if (!ipInAnySubnet(ip, AUTH_WHITELIST)) {
			requiresAuth = true;
			break;
		}
	}
	if (!requiresAuth) {
		res.setHeader('X-OhProxy-Auth', 'unauthenticated');
		req.ohProxyAuth = 'unauthenticated';
		req.ohProxyUser = '';
		return next();
	}
	const users = loadAuthUsers(AUTH_USERS_FILE);
	if (!users || Object.keys(users).length === 0) {
		res.status(500).type('text/plain').send('Auth config unavailable');
		return;
	}
	const [user, pass] = getBasicAuthCredentials(req);
	if (!user || !Object.prototype.hasOwnProperty.call(users, user) || users[user] !== pass) {
		sendAuthRequired(res);
		return;
	}
	res.setHeader('X-OhProxy-Auth', 'authenticated');
	req.ohProxyAuth = 'authenticated';
	req.ohProxyUser = user;
	res.setHeader('X-OhProxy-User', safeText(user).replace(/[\r\n]/g, ''));
	next();
});
app.use(compression());

app.get('/config.js', (req, res) => {
	res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	const clientConfig = CLIENT_CONFIG && typeof CLIENT_CONFIG === 'object' ? CLIENT_CONFIG : {};
	res.send(`window.__OH_CONFIG__=${JSON.stringify({
		iconVersion: ICON_VERSION,
		client: clientConfig,
	})};`);
});

app.get('/ohproxy-config', (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store');
	if (RELAY_VERSION) {
		res.setHeader('X-Config-Version', RELAY_VERSION);
	}
	res.send(JSON.stringify({
		version: 1,
		settings: RELAY_CONFIG && typeof RELAY_CONFIG === 'object' ? RELAY_CONFIG : {},
		generatedAt: Date.now(),
	}));
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

// --- Proxy FIRST (so bodies aren’t eaten by any parsers) ---
const proxyCommon = {
	target: OH_TARGET,
	changeOrigin: true,
	ws: true,
	logLevel: PROXY_LOG_LEVEL,
	onProxyReq(proxyReq) {
		proxyReq.setHeader('User-Agent', USER_AGENT);
		const ah = authHeader();
		if (ah) proxyReq.setHeader('Authorization', ah);
	},
};

purgeOldIconCache();
ensureDir(ICON_CACHE_DIR);

app.get(/^\/(?:openhab\.app\/)?images\/(v\d+)\/(.+)$/i, async (req, res, next) => {
	const match = req.path.match(/^\/(?:openhab\.app\/)?images\/(v\d+)\/(.+)$/i);
	if (!match) return next();
	const version = match[1];
	if (version !== ICON_VERSION) return next();
	const rawRel = match[2];
	const parsed = path.parse(rawRel);
	const cacheRel = path.join(parsed.dir, `${parsed.name}.png`);
	const cachePath = path.join(ICON_CACHE_DIR, cacheRel);
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
	if (!raw) return next();
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
	if (!isProxyTargetAllowed(target, PROXY_ALLOWLIST)) {
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
});
app.use('/proxy', createProxyMiddleware({
	...proxyCommon,
	pathRewrite: (path) => `/proxy${path}`,
}));

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

app.listen(LISTEN_PORT, LISTEN_HOST, () => {
logMessage(`Modern openHAB wrapper: http://${LISTEN_HOST}:${LISTEN_PORT}`);
logMessage(`Proxying openHAB from: ${OH_TARGET}`);
});
