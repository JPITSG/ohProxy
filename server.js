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
const crypto = require('crypto');
const { createProxyMiddleware } = require('http-proxy-middleware');
const WebSocket = require('ws');
const net = require('net');
const mysql = require('mysql2');
const sessions = require('./sessions');
const { generateStructureMap } = require('./lib/structure-map');
const {
	widgetType, widgetLink, widgetPageLink, widgetIconName,
	deltaKey, splitLabelState, widgetKey, normalizeMapping, normalizeButtongridButtons,
} = require('./lib/widget-normalizer');
const {
	getCookieValueFromHeader,
	buildAuthCookieValue,
	parseAuthCookieValue,
} = require('./lib/auth-cookie');
const { buildOpenhabClient } = require('./lib/openhab-client');
const { getBackendRecoveryDelayMs } = require('./lib/backend-recovery-delay');

// Keep-alive agents for openHAB backend connections (eliminates TIME_WAIT buildup)
const ohHttpAgent = new http.Agent({ keepAlive: true });
const ohHttpsAgent = new https.Agent({ keepAlive: true });
function getOhAgent() {
	const proto = new URL(liveConfig.ohTarget).protocol;
	return proto === 'https:' ? ohHttpsAgent : ohHttpAgent;
}

const CONFIG_PATH = path.join(__dirname, 'config.js');
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const ANY_CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function authHeader() {
	// Prefer API token (Bearer) for OH 3.x+, fall back to Basic Auth for OH 1.x/2.x
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

function isPlainObject(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function hasAnyControlChars(value) {
	return ANY_CONTROL_CHARS_RE.test(value);
}

function stripControlChars(value) {
	return safeText(value).replace(CONTROL_CHARS_RE, '');
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function ordinalSuffix(n) {
	if (n >= 11 && n <= 13) return n + 'th';
	switch (n % 10) { case 1: return n + 'st'; case 2: return n + 'nd'; case 3: return n + 'rd'; default: return n + 'th'; }
}
function formatDT(date, fmt) {
	const pad = (n) => String(n).padStart(2, '0');
	const h24 = date.getHours();
	const h12 = h24 % 12 || 12;
	const tokens = { YYYY: date.getFullYear(), MMM: MONTHS_SHORT[date.getMonth()], Do: ordinalSuffix(date.getDate()), DD: pad(date.getDate()), HH: pad(h24), H: h24, hh: pad(h12), h: h12, mm: pad(date.getMinutes()), ss: pad(date.getSeconds()), A: h24 < 12 ? 'AM' : 'PM' };
	return fmt.replace(/YYYY|MMM|Do|DD|HH|H|hh|h|mm|ss|A/g, (m) => tokens[m]);
}

function normalizeHeaderValue(value, maxLen = 1000) {
	if (typeof value !== 'string') return '';
	const cleaned = value.replace(/[\r\n]+/g, '').trim();
	if (!cleaned) return '';
	return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function formatPermissionMode(mode) {
	return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

function parseOptionalInt(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
	if (value === '' || value === null || value === undefined) return null;
	if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
		if (value < min || value > max) return NaN;
		return value;
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!/^\d+$/.test(trimmed)) return NaN;
		const num = Number(trimmed);
		if (!Number.isFinite(num) || num < min || num > max) return NaN;
		return num;
	}
	return NaN;
}

function isValidSha1(value) {
	return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function isValidSitemapName(value) {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
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

function bootLog(message) {
	writeLogLine('', message);
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
	// Reject non-http/https/rtsp/rtsps schemes (must have :// to be a scheme)
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^(https?|rtsps?):\/\//i.test(raw)) return null;
	const candidate = /^(https?|rtsps?):\/\//i.test(raw) ? raw : `http://${raw}`;
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
	if (url.protocol === 'rtsps:') return '322';
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

function redactUrlCredentials(value) {
	const text = safeText(value);
	if (!text) return '';
	try {
		const url = new URL(text);
		if (!url.username && !url.password) return text;
		url.username = '';
		url.password = '';
		return url.toString();
	} catch {
		return text.replace(/\/\/[^@/]+@/g, '//');
	}
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
const ALLOW_SUBNETS = SERVER_CONFIG.allowSubnets;
const TRUST_PROXY = SERVER_CONFIG.trustProxy === true;
const DENY_XFF_SUBNETS = SERVER_CONFIG.denyXFFSubnets;
const OH_TARGET = safeText(SERVER_CONFIG.openhab?.target);
const OH_USER = safeText(SERVER_CONFIG.openhab?.user || '');
const OH_PASS = safeText(SERVER_CONFIG.openhab?.pass || '');
const OH_API_TOKEN = safeText(SERVER_CONFIG.openhab?.apiToken || '');
const OPENHAB_REQUEST_TIMEOUT_MS = configNumber(SERVER_CONFIG.openhab?.timeoutMs, 15000);
const ICON_VERSION = safeText(SERVER_CONFIG.assets?.iconVersion);
const USER_AGENT = safeText(SERVER_CONFIG.userAgent);
const ASSET_VERSION = safeText(SERVER_CONFIG.assets?.assetVersion);
const APPLE_TOUCH_VERSION_RAW = safeText(SERVER_CONFIG.assets?.appleTouchIconVersion);
const APPLE_TOUCH_VERSION = APPLE_TOUCH_VERSION_RAW || '';
const ICON_SIZE = configNumber(SERVER_CONFIG.iconSize);
const ICON_CACHE_CONCURRENCY = Math.max(1, Math.floor(configNumber(SERVER_CONFIG.iconCacheConcurrency, 5)));
const ICON_CACHE_TTL_MS = Math.max(0, Math.floor(configNumber(SERVER_CONFIG.iconCacheTtlMs, 86400000)));
const DELTA_CACHE_LIMIT = configNumber(SERVER_CONFIG.deltaCacheLimit);
const GROUP_ITEMS = Array.isArray(SERVER_CONFIG.groupItems) ? SERVER_CONFIG.groupItems.map(safeText).filter(Boolean) : [];
const PROXY_LOG_LEVEL = safeText(SERVER_CONFIG.proxyMiddlewareLogLevel);
const LOG_FILE = safeText(SERVER_CONFIG.logFile);
const ACCESS_LOG = safeText(SERVER_CONFIG.accessLog);
const ACCESS_LOG_LEVEL = safeText(SERVER_CONFIG.accessLogLevel || 'all')
	.trim()
	.toLowerCase();
const JS_LOG_FILE = safeText(SERVER_CONFIG.jsLogFile || '');
const JS_LOG_ENABLED = SERVER_CONFIG.jsLogEnabled === true;
const SLOW_QUERY_MS = configNumber(SERVER_CONFIG.slowQueryMs, 0);
const AUTH_REALM = safeText(SERVER_AUTH.realm || 'openHAB Proxy');
const AUTH_COOKIE_NAME = safeText(SERVER_AUTH.cookieName || 'AuthStore');
const AUTH_COOKIE_DAYS = configNumber(SERVER_AUTH.cookieDays, 0);
const AUTH_COOKIE_KEY = safeText(SERVER_AUTH.cookieKey || '');
const AUTH_FAIL_NOTIFY_CMD = safeText(SERVER_AUTH.authFailNotifyCmd || '');
const AUTH_MODE = safeText(SERVER_AUTH.mode || 'basic');
const AUTH_FAIL_NOTIFY_INTERVAL_MINS = configNumber(SERVER_AUTH.authFailNotifyIntervalMins, 15);
const AUTH_LOCKOUT_THRESHOLD = 3;
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
const SITEMAP_REFRESH_MS = configNumber(TASK_CONFIG.sitemapRefreshMs);
const STRUCTURE_MAP_REFRESH_MS = configNumber(TASK_CONFIG.structureMapRefreshMs);
const NPM_UPDATE_CHECK_MS = configNumber(TASK_CONFIG.npmUpdateCheckMs);
const LOG_ROTATION_ENABLED = SERVER_CONFIG.logRotationEnabled === true;
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
const CHART_CACHE_DIR = path.join(__dirname, 'cache', 'chart');
// Parse any openHAB chart period string to seconds.
// Supports simple (h, D, W, M, Y), multiplied (4h, 2D, 3W),
// ISO 8601 (P1Y6M, PT1H30M, P2W, P1DT12H), and past-future (2h-1h, D-1D, D-, -1h, PT1H-PT30M).
// Returns 0 for invalid/unrecognised input. Each period component is capped at 10 years.
const MAX_PERIOD_SEC = 10 * 365.25 * 86400; // ~10 years
const CHART_PERIOD_MAX_LEN = 64;
const CHART_SERVICE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CHART_LEGEND_MODES = new Set(['true', 'false']);
const CHART_BOOLEAN_TRUE = new Set(['true', '1', 'yes', 'on']);
const CHART_BOOLEAN_FALSE = new Set(['false', '0', 'no', 'off']);
function parseBasePeriodToSeconds(period) {
	// Simple / multiplied: e.g. h, D, 4h, 2W, 12M
	const simpleMatch = period.match(/^(\d*)([hDWMY])$/);
	if (simpleMatch) {
		const multiplier = simpleMatch[1] ? parseInt(simpleMatch[1], 10) : 1;
		const unitSec = { h: 3600, D: 86400, W: 604800, M: 2592000, Y: 31536000 };
		const sec = multiplier * unitSec[simpleMatch[2]];
		return Math.min(sec, MAX_PERIOD_SEC);
	}

	// ISO 8601 duration: P[nY][nM][nW][nD][T[nH][nM][nS]]
	const isoMatch = period.match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
	if (isoMatch) {
		const [, y, mo, w, d, h, mi, s] = isoMatch;
		const sec = (parseInt(y || 0) * 31536000)
			+ (parseInt(mo || 0) * 2592000)
			+ (parseInt(w || 0) * 604800)
			+ (parseInt(d || 0) * 86400)
			+ (parseInt(h || 0) * 3600)
			+ (parseInt(mi || 0) * 60)
			+ (parseInt(s || 0));
		return sec > 0 ? Math.min(sec, MAX_PERIOD_SEC) : 0;
	}

	return 0;
}

function parsePeriodWindow(period) {
	if (typeof period !== 'string') return null;
	const raw = period.trim();
	if (!raw) return null;

	// Past-future format: <past>-<future>, where either side may be empty (e.g. D-, -1h).
	const dashCount = (raw.match(/-/g) || []).length;
	if (dashCount > 1) return null;
	if (dashCount === 1) {
		const [past, future] = raw.split('-');
		const pastSec = past ? parseBasePeriodToSeconds(past) : 0;
		const futureSec = future ? parseBasePeriodToSeconds(future) : 0;
		if (past && !pastSec) return null;
		if (future && !futureSec) return null;
		if (!pastSec && !futureSec) return null;
		return {
			pastSec,
			futureSec,
			totalSec: pastSec + futureSec,
		};
	}

	const baseSec = parseBasePeriodToSeconds(raw);
	if (!baseSec) return null;
	return {
		pastSec: baseSec,
		futureSec: 0,
		totalSec: baseSec,
	};
}

function parsePeriodToSeconds(period) {
	const parsed = parsePeriodWindow(period);
	return parsed ? parsed.totalSec : 0;
}

function normalizePeriodWindow(periodWindow) {
	if (Number.isFinite(periodWindow) && periodWindow > 0) {
		const sec = Math.floor(periodWindow);
		return {
			pastSec: sec,
			futureSec: 0,
			totalSec: sec,
		};
	}
	if (!periodWindow || typeof periodWindow !== 'object') return null;
	const pastSec = Number.isFinite(periodWindow.pastSec) && periodWindow.pastSec >= 0
		? Math.floor(periodWindow.pastSec)
		: 0;
	const futureSec = Number.isFinite(periodWindow.futureSec) && periodWindow.futureSec >= 0
		? Math.floor(periodWindow.futureSec)
		: 0;
	if (!pastSec && !futureSec) return null;
	const totalSec = Number.isFinite(periodWindow.totalSec) && periodWindow.totalSec > 0
		? Math.floor(periodWindow.totalSec)
		: (pastSec + futureSec);
	if (!totalSec) return null;
	return {
		pastSec,
		futureSec,
		totalSec,
	};
}

function periodWindowFromPeriodString(period, fallbackSec = 86400) {
	const parsed = parsePeriodWindow(period);
	if (parsed) return parsed;
	const fallback = normalizePeriodWindow(fallbackSec);
	if (fallback) return fallback;
	return {
		pastSec: 86400,
		futureSec: 0,
		totalSec: 86400,
	};
}

function periodWindowBounds(periodWindow) {
	const window = normalizePeriodWindow(periodWindow) || periodWindowFromPeriodString('D');
	const nowSec = Date.now() / 1000;
	return {
		startSec: nowSec - window.pastSec,
		endSec: nowSec + window.futureSec,
		window,
	};
}

function periodWindowDates(periodWindow) {
	const { startSec, endSec } = periodWindowBounds(periodWindow);
	return {
		start: new Date(startSec * 1000),
		end: new Date(endSec * 1000),
	};
}

function parseChartLegendMode(rawLegend) {
	if (rawLegend === undefined) return 'auto';
	if (typeof rawLegend !== 'string') return null;
	const normalized = rawLegend.trim().toLowerCase();
	if (!normalized) return null;
	if (CHART_LEGEND_MODES.has(normalized)) return normalized;
	return null;
}

function parseChartForceAsItem(rawForceAsItem) {
	if (rawForceAsItem === undefined) return false;
	if (typeof rawForceAsItem !== 'string') return null;
	const normalized = rawForceAsItem.trim().toLowerCase();
	if (!normalized) return null;
	if (CHART_BOOLEAN_TRUE.has(normalized)) return true;
	if (CHART_BOOLEAN_FALSE.has(normalized)) return false;
	return null;
}

function shouldShowChartLegend(legendMode, seriesCount = 1) {
	if (legendMode === 'true' || legendMode === true) return true;
	if (legendMode === 'false' || legendMode === false) return false;
	return Number.isFinite(seriesCount) ? seriesCount > 1 : false;
}

// Tiered cache TTL (ms) matching original h/D/W/M/Y behaviour
function chartCacheTtl(durationSec) {
	if (durationSec <= 3600) return 60 * 1000;           // <=1h  → 1 min
	if (durationSec <= 86400) return 10 * 60 * 1000;     // <=1d  → 10 min
	if (durationSec <= 30 * 86400) return 60 * 60 * 1000; // <=30d → 1 hour
	return 24 * 60 * 60 * 1000;                           // >30d  → 1 day
}

// Snap to a "nice" x-label interval targeting ~7 labels
function chartXLabelInterval(dataDurationSec) {
	const niceIntervals = [
		300, 600, 900, 1800, 3600, 7200, 14400, 21600,
		43200, 86400, 172800, 432000, 604800, 1209600, 2592000,
	];
	const target = dataDurationSec / 7;
	for (const iv of niceIntervals) {
		if (iv >= target) return iv;
	}
	return niceIntervals[niceIntervals.length - 1];
}

// Tiered sampling/rounding config for stable data hashing
function chartHashConfig(durationSec) {
	if (durationSec <= 3600)       return { sample: 1,  decimals: 2, tsRound: 60 };
	if (durationSec <= 86400)      return { sample: 4,  decimals: 1, tsRound: 3600 };
	if (durationSec <= 604800)     return { sample: 8,  decimals: 1, tsRound: 86400 };
	if (durationSec <= 2592000)    return { sample: 16, decimals: 0, tsRound: 86400 };
	return { sample: 32, decimals: 0, tsRound: 604800 };
}

// Show "Cur" stat for short durations (<=4h)
function chartShowCurStat(durationSec) {
	return durationSec <= 14400;
}
const AI_CACHE_DIR = path.join(__dirname, 'cache', 'ai');
const STRUCTURE_MAP_ON_DEMAND_TIMEOUT_MS = 20000;
const STRUCTURE_MAP_ON_DEMAND_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const ANTHROPIC_API_KEY = safeText(SERVER_CONFIG.apiKeys?.anthropic) || '';
const AI_MODEL_IDS = [
	'claude-3-haiku-20240307',
	'claude-3-5-haiku-20241022',
	'claude-haiku-4-5-20251001',
	'claude-sonnet-4-20250514',
	'claude-sonnet-4-5-20250514',
];
const AI_MODEL_PRICING = {
	'claude-3-haiku-20240307':  { input: 0.25, output: 1.25 },
	'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00 },
	'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
	'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
	'claude-sonnet-4-5-20250514': { input: 3.00, output: 15.00 },
};
const AI_MODEL = AI_MODEL_IDS.includes(safeText(SERVER_CONFIG.apiKeys?.aiModel))
	? safeText(SERVER_CONFIG.apiKeys.aiModel) : 'claude-3-haiku-20240307';
const VOICE_CONFIG = SERVER_CONFIG.voice || {};
const VOICE_MODEL = (['browser', 'vosk'].includes((safeText(VOICE_CONFIG.model) || '').toLowerCase()))
	? safeText(VOICE_CONFIG.model).toLowerCase() : 'browser';
const VOSK_HOST = safeText(VOICE_CONFIG.voskHost) || '';
const WEATHERBIT_CONFIG = SERVER_CONFIG.weatherbit || {};
const WEATHERBIT_API_KEY = safeText(WEATHERBIT_CONFIG.apiKey).trim();
const WEATHERBIT_LATITUDE = safeText(WEATHERBIT_CONFIG.latitude).trim();
const WEATHERBIT_LONGITUDE = safeText(WEATHERBIT_CONFIG.longitude).trim();
const WEATHERBIT_UNITS = safeText(WEATHERBIT_CONFIG.units).trim() || 'metric';
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
const activeVideoStreams = new Map(); // Track active video streams: id -> { url, user, ip, startTime, encoding }
let videoStreamIdCounter = 0;
const authLockouts = new Map();

function logMessage(message) {
	writeLogLine(liveConfig.logFile, message);
}

function logJsError(message) {
	if (!liveConfig.jsLogEnabled || !liveConfig.jsLogFile) return;
	writeLogLine(liveConfig.jsLogFile, message);
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
	if (liveConfig.accessLogLevel === '400+') {
		const match = safeText(message).match(/\s(\d{3})\s/);
		const status = match ? Number(match[1]) : NaN;
		if (Number.isFinite(status) && status < 400) return;
	}
	const line = safeText(message);
	if (!line || !liveConfig.accessLog) return;
	const text = line.endsWith('\n') ? line : `${line}\n`;
	try {
		fs.appendFileSync(liveConfig.accessLog, text);
	} catch (err) {
		const fallback = formatLogLine(`Failed to write log file ${liveConfig.accessLog}: ${err.message || err}`);
		if (fallback) process.stdout.write(fallback);
	}
}

function shouldSkipAccessLog(res) {
	if (liveConfig.accessLogLevel === 'all') return false;
	if (liveConfig.accessLogLevel === '400+') return (res?.statusCode || 0) < 400;
	return false;
}

function ensureString(value, name, { allowEmpty = false, maxLen } = {}, errors) {
	if (typeof value !== 'string') {
		errors.push(`${name} must be a string but currently is ${describeValue(value)}`);
		return;
	}
	if (!allowEmpty && value.trim() === '') {
		errors.push(`${name} is required but currently is ${describeValue(value)}`);
	}
	if (maxLen !== undefined && value.length > maxLen) {
		errors.push(`${name} must be at most ${maxLen} characters but is ${value.length}`);
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

function ensureArray(value, name, { allowEmpty = false, maxItems } = {}, errors) {
	if (!Array.isArray(value)) {
		errors.push(`${name} must be an array but currently is ${describeValue(value)}`);
		return false;
	}
	if (!allowEmpty && value.length === 0) {
		errors.push(`${name} must not be empty but currently is ${describeValue(value)}`);
		return false;
	}
	if (maxItems !== undefined && value.length > maxItems) {
		errors.push(`${name} must have at most ${maxItems} items but has ${value.length}`);
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

function ensureCidrList(value, name, { allowEmpty = false, maxItems } = {}, errors) {
	if (!ensureArray(value, name, { allowEmpty, maxItems }, errors)) return;
	value.forEach((entry, index) => {
		if (!isValidCidr(entry)) {
			errors.push(`${name}[${index}] must be IPv4 CIDR but currently is ${describeValue(entry)}`);
		}
	});
}

function ensureAllowSubnets(value, name, errors, options = {}) {
	const allowEmpty = options.allowEmpty === true;
	if (!ensureArray(value, name, { allowEmpty, maxItems: options.maxItems }, errors)) return;
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

function ensureHostOrIp(value, name, errors) {
	if (typeof value !== 'string') {
		errors.push(`${name} must be a string but currently is ${describeValue(value)}`);
		return;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		errors.push(`${name} is required but currently is ${describeValue(value)}`);
		return;
	}
	if (trimmed === '0.0.0.0') return;
	if (isValidIpv4(trimmed)) return;
	// RFC 952/1123 hostname: dot-separated labels, each label alphanumeric/hyphens, max 253 chars total
	if (trimmed.length > 253) {
		errors.push(`${name} hostname must be at most 253 characters but is ${trimmed.length}`);
		return;
	}
	const labels = trimmed.split('.');
	const validLabel = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
	for (const label of labels) {
		if (!validLabel.test(label)) {
			errors.push(`${name} must be a valid IPv4 address or hostname but currently is ${describeValue(value)}`);
			return;
		}
	}
}

function ensureAbsolutePath(value, name, errors) {
	if (typeof value !== 'string') {
		errors.push(`${name} must be a string but currently is ${describeValue(value)}`);
		return;
	}
	if (value.trim() === '') {
		errors.push(`${name} is required but currently is ${describeValue(value)}`);
		return;
	}
	if (!path.isAbsolute(value)) {
		errors.push(`${name} must be an absolute path but currently is ${describeValue(value)}`);
	}
}

function ensureVersion(value, name, errors) {
	ensureString(value, name, { allowEmpty: false }, errors);
	if (typeof value !== 'string' || value.trim() === '') return;
	if (!/^v\d+$/i.test(value.trim())) {
		errors.push(`${name} must be in format v123 but currently is ${describeValue(value)}`);
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
		ensureNumber(OPENHAB_REQUEST_TIMEOUT_MS, 'server.openhab.timeoutMs', { min: 0 }, errors);
	}

	if (ensureObject(SERVER_CONFIG.assets, 'server.assets', errors)) {
		ensureVersion(ASSET_VERSION, 'server.assets.assetVersion', errors);
		ensureVersion(APPLE_TOUCH_VERSION_RAW, 'server.assets.appleTouchIconVersion', errors);
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
		if (AUTH_COOKIE_KEY && AUTH_COOKIE_KEY.length < 32) {
			errors.push(`server.auth.cookieKey must be at least 32 characters for HMAC security but is ${AUTH_COOKIE_KEY.length} characters`);
		}
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
		if (AUTH_MODE === 'html') {
			if (!AUTH_COOKIE_KEY) {
				errors.push(`server.auth.cookieKey is required when auth mode is "html" but currently is ${describeValue(AUTH_COOKIE_KEY)}`);
			}
			if (!AUTH_COOKIE_NAME) {
				errors.push(`server.auth.cookieName is required when auth mode is "html" but currently is ${describeValue(AUTH_COOKIE_NAME)}`);
			}
			if (!Number.isFinite(AUTH_COOKIE_DAYS) || AUTH_COOKIE_DAYS <= 0) {
				errors.push(`server.auth.cookieDays must be > 0 when auth mode is "html" but currently is ${describeValue(AUTH_COOKIE_DAYS)}`);
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
		ensureNumber(STRUCTURE_MAP_REFRESH_MS, 'server.backgroundTasks.structureMapRefreshMs', { min: 0 }, errors);
		ensureNumber(NPM_UPDATE_CHECK_MS, 'server.backgroundTasks.npmUpdateCheckMs', { min: 0 }, errors);
	}
	if (SERVER_CONFIG.logRotationEnabled !== undefined) {
		ensureBoolean(SERVER_CONFIG.logRotationEnabled, 'server.logRotationEnabled', errors);
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

		if (ensureObject(CLIENT_CONFIG.transport, 'client.transport', errors)) {
			ensureBoolean(CLIENT_CONFIG.transport?.sharedWorkerEnabled, 'client.transport.sharedWorkerEnabled', errors);
			ensureBoolean(CLIENT_CONFIG.transport?.swHttpEnabled, 'client.transport.swHttpEnabled', errors);
			ensureNumber(CLIENT_CONFIG.transport?.workerRpcTimeoutMs, 'client.transport.workerRpcTimeoutMs', { min: 1 }, errors);
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
		ensureBoolean(CLIENT_CONFIG.statusNotification, 'client.statusNotification', errors);
		if (CLIENT_CONFIG.defaultTheme !== undefined) {
			const validThemes = ['dark', 'light'];
			if (!validThemes.includes(CLIENT_CONFIG.defaultTheme)) {
				errors.push('client.defaultTheme must be one of: ' + validThemes.join(', '));
			}
		}
	}

	return errors;
}

function validateAdminConfig(config) {
	const errors = [];
	if (!isPlainObject(config)) {
		errors.push('Config must be an object');
		return errors;
	}
	const s = config.server || {};
	const c = config.client || {};

	// Listeners (required — defaults have both disabled, at least one must be enabled)
	if (isPlainObject(s.http)) {
		ensureBoolean(s.http.enabled, 'server.http.enabled', errors);
		if (s.http.enabled) {
			ensureHostOrIp(s.http.host, 'server.http.host', errors);
			ensureNumber(s.http.port, 'server.http.port', { min: 1, max: 65535 }, errors);
		}
	}
	if (isPlainObject(s.https)) {
		ensureBoolean(s.https.enabled, 'server.https.enabled', errors);
		if (s.https.enabled) {
			ensureHostOrIp(s.https.host, 'server.https.host', errors);
			ensureNumber(s.https.port, 'server.https.port', { min: 1, max: 65535 }, errors);
			ensureReadableFile(s.https.certFile, 'server.https.certFile', errors);
			ensureReadableFile(s.https.keyFile, 'server.https.keyFile', errors);
		}
	}
	const httpEnabled = isPlainObject(s.http) && s.http.enabled === true;
	const httpsEnabled = isPlainObject(s.https) && s.https.enabled === true;
	if (!httpEnabled && !httpsEnabled) {
		errors.push('At least one of server.http.enabled or server.https.enabled must be true');
	}

	// Upstream (required — default target is empty, startup requires valid URL)
	if (isPlainObject(s.openhab)) {
		ensureUrl(s.openhab.target, 'server.openhab.target', errors);
		ensureString(s.openhab.user || '', 'server.openhab.user', { allowEmpty: true, maxLen: 256 }, errors);
		ensureString(s.openhab.pass || '', 'server.openhab.pass', { allowEmpty: true, maxLen: 512 }, errors);
		ensureString(s.openhab.apiToken || '', 'server.openhab.apiToken', { allowEmpty: true, maxLen: 512 }, errors);
		if (s.openhab.timeoutMs !== undefined) ensureNumber(s.openhab.timeoutMs, 'server.openhab.timeoutMs', { min: 0 }, errors);
	} else {
		errors.push('server.openhab is required');
	}

	// Database
	if (isPlainObject(s.mysql)) {
		ensureString(s.mysql.socket || '', 'server.mysql.socket', { allowEmpty: true, maxLen: 4096 }, errors);
		ensureString(s.mysql.host || '', 'server.mysql.host', { allowEmpty: true, maxLen: 253 }, errors);
		const mysqlPort = s.mysql.port;
		if (mysqlPort !== undefined) {
			if (typeof mysqlPort !== 'string') {
				errors.push(`server.mysql.port must be a string but currently is ${describeValue(mysqlPort)}`);
			} else if (mysqlPort.trim() !== '') {
				const portNum = Number(mysqlPort.trim());
				if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
					errors.push(`server.mysql.port must be empty or a number 1-65535 but currently is ${describeValue(mysqlPort)}`);
				}
			}
		}
		ensureString(s.mysql.database || '', 'server.mysql.database', { allowEmpty: true, maxLen: 64 }, errors);
		ensureString(s.mysql.username || '', 'server.mysql.username', { allowEmpty: true, maxLen: 256 }, errors);
		ensureString(s.mysql.password || '', 'server.mysql.password', { allowEmpty: true, maxLen: 512 }, errors);
	}

	// Auth
	if (isPlainObject(s.auth)) {
		const authMode = s.auth.mode;
		if (typeof authMode === 'string' && authMode !== 'basic' && authMode !== 'html') {
			errors.push('server.auth.mode must be "basic" or "html"');
		}
		ensureString(s.auth.realm || '', 'server.auth.realm', { allowEmpty: false, maxLen: 256 }, errors);
		ensureString(s.auth.cookieName || '', 'server.auth.cookieName', { allowEmpty: true, maxLen: 256 }, errors);
		ensureNumber(s.auth.cookieDays, 'server.auth.cookieDays', { min: 0 }, errors);
		ensureString(s.auth.cookieKey || '', 'server.auth.cookieKey', { allowEmpty: true, maxLen: 256 }, errors);
		if (s.auth.cookieKey && typeof s.auth.cookieKey === 'string' && s.auth.cookieKey.trim() && s.auth.cookieKey.trim().length < 32) {
			errors.push('server.auth.cookieKey must be at least 32 characters for HMAC security');
		}
		ensureString(s.auth.authFailNotifyCmd || '', 'server.auth.authFailNotifyCmd', { allowEmpty: true, maxLen: 1024 }, errors);
		ensureNumber(s.auth.authFailNotifyIntervalMins, 'server.auth.authFailNotifyIntervalMins', { min: 1 }, errors);
		if (s.auth.cookieKey && typeof s.auth.cookieKey === 'string' && s.auth.cookieKey.trim()) {
			if (!s.auth.cookieName) {
				errors.push('server.auth.cookieName is required when cookieKey is set');
			}
			if (!Number.isFinite(s.auth.cookieDays) || s.auth.cookieDays <= 0) {
				errors.push('server.auth.cookieDays must be > 0 when cookieKey is set');
			}
		}
		const effectiveMode = (typeof authMode === 'string' && authMode) ? authMode : liveConfig.authMode;
		if (effectiveMode === 'html') {
			const ck = (typeof s.auth.cookieKey === 'string') ? s.auth.cookieKey.trim() : liveConfig.authCookieKey;
			const cn = s.auth.cookieName || liveConfig.authCookieName;
			const cd = Number.isFinite(s.auth.cookieDays) ? s.auth.cookieDays : liveConfig.authCookieDays;
			if (!ck) {
				errors.push('server.auth.cookieKey is required when auth mode is "html"');
			}
			if (!cn) {
				errors.push('server.auth.cookieName is required when auth mode is "html"');
			}
			if (!Number.isFinite(cd) || cd <= 0) {
				errors.push('server.auth.cookieDays must be > 0 when auth mode is "html"');
			}
		}
	}

	// Access control (required — default is empty, startup requires non-empty)
	ensureAllowSubnets(s.allowSubnets, 'server.allowSubnets', errors, { maxItems: 100 });
	if (s.trustProxy !== undefined) ensureBoolean(s.trustProxy, 'server.trustProxy', errors);
	if (Array.isArray(s.denyXFFSubnets)) ensureAllowSubnets(s.denyXFFSubnets, 'server.denyXFFSubnets', errors, { allowEmpty: true, maxItems: 100 });

	// Security headers
	if (isPlainObject(s.securityHeaders)) {
		ensureBoolean(s.securityHeaders.enabled, 'server.securityHeaders.enabled', errors);
		if (isPlainObject(s.securityHeaders.hsts)) {
			ensureBoolean(s.securityHeaders.hsts.enabled, 'server.securityHeaders.hsts.enabled', errors);
			ensureNumber(s.securityHeaders.hsts.maxAge, 'server.securityHeaders.hsts.maxAge', { min: 0 }, errors);
			ensureBoolean(s.securityHeaders.hsts.includeSubDomains, 'server.securityHeaders.hsts.includeSubDomains', errors);
			ensureBoolean(s.securityHeaders.hsts.preload, 'server.securityHeaders.hsts.preload', errors);
		}
		if (isPlainObject(s.securityHeaders.csp)) {
			ensureBoolean(s.securityHeaders.csp.enabled, 'server.securityHeaders.csp.enabled', errors);
			ensureBoolean(s.securityHeaders.csp.reportOnly, 'server.securityHeaders.csp.reportOnly', errors);
			ensureString(s.securityHeaders.csp.policy || '', 'server.securityHeaders.csp.policy', { allowEmpty: true, maxLen: 4096 }, errors);
			if (s.securityHeaders.csp.enabled && !(s.securityHeaders.csp.policy || '').trim()) {
				errors.push('server.securityHeaders.csp.policy must be set when CSP is enabled');
			}
		}
		if (s.securityHeaders.referrerPolicy !== undefined) {
			const ref = typeof s.securityHeaders.referrerPolicy === 'string' ? s.securityHeaders.referrerPolicy.trim() : '';
			if (ref) {
				const allowed = ['no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin',
					'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url'];
				if (!allowed.includes(ref)) {
					errors.push('server.securityHeaders.referrerPolicy must be a supported value');
				}
			}
		}
	}

	// Proxy (required — default is empty, startup requires non-empty)
	if (ensureArray(s.proxyAllowlist, 'server.proxyAllowlist', { allowEmpty: false, maxItems: 100 }, errors)) {
		s.proxyAllowlist.forEach((entry, index) => {
			if (!parseProxyAllowEntry(entry)) {
				errors.push(`server.proxyAllowlist[${index}] is not a valid host or host:port`);
			}
		});
	}
	if (Array.isArray(s.webviewNoProxy)) {
		if (s.webviewNoProxy.length > 100) {
			errors.push(`server.webviewNoProxy must have at most 100 items but has ${s.webviewNoProxy.length}`);
		} else {
			s.webviewNoProxy.forEach((entry, index) => {
				if (!parseProxyAllowEntry(entry)) {
					errors.push(`server.webviewNoProxy[${index}] is not a valid host or host:port`);
				}
			});
		}
	}

	// Assets
	if (isPlainObject(s.assets)) {
		ensureVersion(s.assets.assetVersion, 'server.assets.assetVersion', errors);
		ensureVersion(s.assets.appleTouchIconVersion, 'server.assets.appleTouchIconVersion', errors);
		ensureVersion(s.assets.iconVersion, 'server.assets.iconVersion', errors);
	}

	// Scalar server fields
	if (s.userAgent !== undefined) ensureString(s.userAgent, 'server.userAgent', { allowEmpty: false, maxLen: 256 }, errors);
	if (s.iconSize !== undefined) ensureNumber(s.iconSize, 'server.iconSize', { min: 1 }, errors);
	if (s.iconCacheConcurrency !== undefined) ensureNumber(s.iconCacheConcurrency, 'server.iconCacheConcurrency', { min: 1 }, errors);
	if (s.iconCacheTtlMs !== undefined) ensureNumber(s.iconCacheTtlMs, 'server.iconCacheTtlMs', { min: 0 }, errors);
	if (s.deltaCacheLimit !== undefined) ensureNumber(s.deltaCacheLimit, 'server.deltaCacheLimit', { min: 1 }, errors);
	if (s.logFile !== undefined) ensureLogPath(s.logFile, 'server.logFile', errors);
	if (s.accessLog !== undefined) ensureLogPath(s.accessLog, 'server.accessLog', errors);
	if (s.jsLogFile !== undefined) ensureLogPath(s.jsLogFile, 'server.jsLogFile', errors);
	if (s.jsLogEnabled !== undefined) ensureBoolean(s.jsLogEnabled, 'server.jsLogEnabled', errors);
	if (s.accessLogLevel !== undefined) {
		if (s.accessLogLevel !== 'all' && s.accessLogLevel !== '400+') {
			errors.push('server.accessLogLevel must be "all" or "400+"');
		}
	}
	if (s.proxyMiddlewareLogLevel !== undefined) {
		const valid = ['silent', 'error', 'warn', 'info', 'debug'];
		if (!valid.includes(s.proxyMiddlewareLogLevel)) {
			errors.push('server.proxyMiddlewareLogLevel must be one of: ' + valid.join(', '));
		}
	}
	if (s.slowQueryMs !== undefined) ensureNumber(s.slowQueryMs, 'server.slowQueryMs', { min: 0 }, errors);
	if (s.logRotationEnabled !== undefined) ensureBoolean(s.logRotationEnabled, 'server.logRotationEnabled', errors);
	if (s.sessionMaxAgeDays !== undefined) ensureNumber(s.sessionMaxAgeDays, 'server.sessionMaxAgeDays', { min: 1 }, errors);

	// Background tasks
	if (isPlainObject(s.backgroundTasks)) {
		ensureNumber(s.backgroundTasks.sitemapRefreshMs, 'server.backgroundTasks.sitemapRefreshMs', { min: 1000 }, errors);
		if (s.backgroundTasks.structureMapRefreshMs !== undefined) {
			ensureNumber(s.backgroundTasks.structureMapRefreshMs, 'server.backgroundTasks.structureMapRefreshMs', { min: 0 }, errors);
		}
		if (s.backgroundTasks.npmUpdateCheckMs !== undefined) {
			ensureNumber(s.backgroundTasks.npmUpdateCheckMs, 'server.backgroundTasks.npmUpdateCheckMs', { min: 0 }, errors);
		}
	}

	// WebSocket
	if (isPlainObject(s.websocket)) {
		const validModes = ['polling', 'atmosphere', 'sse'];
		if (!validModes.includes(s.websocket.mode)) {
			errors.push('server.websocket.mode must be one of: ' + validModes.join(', '));
		}
		ensureNumber(s.websocket.pollingIntervalMs, 'server.websocket.pollingIntervalMs', { min: 100 }, errors);
		ensureNumber(s.websocket.pollingIntervalBgMs, 'server.websocket.pollingIntervalBgMs', { min: 100 }, errors);
		ensureNumber(s.websocket.atmosphereNoUpdateWarnMs, 'server.websocket.atmosphereNoUpdateWarnMs', { min: 0 }, errors);
		ensureNumber(s.websocket.backendRecoveryDelayMs, 'server.websocket.backendRecoveryDelayMs', { min: 0 }, errors);
	}

	// Video preview
	if (isPlainObject(s.videoPreview)) {
		ensureNumber(s.videoPreview.intervalMs, 'server.videoPreview.intervalMs', { min: 0 }, errors);
		ensureNumber(s.videoPreview.pruneAfterHours, 'server.videoPreview.pruneAfterHours', { min: 1 }, errors);
	}

	// CMD API
	if (isPlainObject(s.cmdapi)) {
		ensureBoolean(s.cmdapi.enabled, 'server.cmdapi.enabled', errors);
		if (Array.isArray(s.cmdapi.allowedSubnets)) {
			ensureCidrList(s.cmdapi.allowedSubnets, 'server.cmdapi.allowedSubnets', { allowEmpty: true, maxItems: 100 }, errors);
		}
		if (Array.isArray(s.cmdapi.allowedItems)) {
			if (s.cmdapi.allowedItems.length > 100) {
				errors.push(`server.cmdapi.allowedItems must have at most 100 items but has ${s.cmdapi.allowedItems.length}`);
			} else {
				s.cmdapi.allowedItems.forEach((entry, index) => {
					if (typeof entry !== 'string' || (!entry.trim() && entry !== '*')) {
						errors.push(`server.cmdapi.allowedItems[${index}] must be a non-empty string or '*'`);
					}
				});
			}
		}
	}

	// GPS
	if (isPlainObject(s.gps)) {
		if (s.gps.homeLat !== undefined && s.gps.homeLat !== '') {
			const lat = Number(s.gps.homeLat);
			if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
				errors.push('server.gps.homeLat must be a number between -90 and 90');
			}
		}
		if (s.gps.homeLon !== undefined && s.gps.homeLon !== '') {
			const lon = Number(s.gps.homeLon);
			if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
				errors.push('server.gps.homeLon must be a number between -180 and 180');
			}
		}
	}

	// Binaries
	if (isPlainObject(s.binaries)) {
		ensureAbsolutePath(s.binaries.ffmpeg, 'server.binaries.ffmpeg', errors);
		ensureAbsolutePath(s.binaries.convert, 'server.binaries.convert', errors);
		ensureAbsolutePath(s.binaries.shell, 'server.binaries.shell', errors);
	}

	// Features
	if (Array.isArray(s.groupItems)) {
		if (s.groupItems.length > 100) {
			errors.push(`server.groupItems must have at most 100 items but has ${s.groupItems.length}`);
		} else {
			s.groupItems.forEach((entry, index) => {
				if (typeof entry !== 'string') {
					errors.push(`server.groupItems[${index}] must be a string but currently is ${describeValue(entry)}`);
				} else if (entry.length > 256) {
					errors.push(`server.groupItems[${index}] must be at most 256 characters but is ${entry.length}`);
				}
			});
		}
	}

	// External services
	if (isPlainObject(s.apiKeys)) {
		ensureString(s.apiKeys.anthropic || '', 'server.apiKeys.anthropic', { allowEmpty: true, maxLen: 512 }, errors);
	}
	if (isPlainObject(s.weatherbit)) {
		ensureString(s.weatherbit.apiKey || '', 'server.weatherbit.apiKey', { allowEmpty: true, maxLen: 512 }, errors);
		ensureString(s.weatherbit.latitude || '', 'server.weatherbit.latitude', { allowEmpty: true, maxLen: 64 }, errors);
		if (typeof s.weatherbit.latitude === 'string' && s.weatherbit.latitude.trim() !== '') {
			const lat = Number(s.weatherbit.latitude.trim());
			if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
				errors.push('server.weatherbit.latitude must be a number between -90 and 90');
			}
		}
		ensureString(s.weatherbit.longitude || '', 'server.weatherbit.longitude', { allowEmpty: true, maxLen: 64 }, errors);
		if (typeof s.weatherbit.longitude === 'string' && s.weatherbit.longitude.trim() !== '') {
			const lon = Number(s.weatherbit.longitude.trim());
			if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
				errors.push('server.weatherbit.longitude must be a number between -180 and 180');
			}
		}
		if (s.weatherbit.units !== undefined && s.weatherbit.units !== 'metric' && s.weatherbit.units !== 'imperial') {
			errors.push('server.weatherbit.units must be "metric" or "imperial"');
		}
		if (s.weatherbit.refreshIntervalMs !== undefined) {
			ensureNumber(s.weatherbit.refreshIntervalMs, 'server.weatherbit.refreshIntervalMs', { min: 1 }, errors);
		}
	}
	if (isPlainObject(s.voice)) {
		if (s.voice.model !== undefined) {
			const validModels = ['browser', 'vosk'];
			if (!validModels.includes(s.voice.model)) {
				errors.push('server.voice.model must be one of: ' + validModels.join(', '));
			}
		}
		if (s.voice.voskHost !== undefined) {
			ensureString(s.voice.voskHost || '', 'server.voice.voskHost', { allowEmpty: true, maxLen: 256 }, errors);
		}
	}

	// Client config
	if (isPlainObject(c)) {
		if (c.siteName !== undefined) ensureString(c.siteName || '', 'client.siteName', { allowEmpty: true, maxLen: 256 }, errors);
		if (c.statusNotification !== undefined) ensureBoolean(c.statusNotification, 'client.statusNotification', errors);
		if (c.pageFadeOutMs !== undefined) ensureNumber(c.pageFadeOutMs, 'client.pageFadeOutMs', { min: 0 }, errors);
		if (c.pageFadeInMs !== undefined) ensureNumber(c.pageFadeInMs, 'client.pageFadeInMs', { min: 0 }, errors);
		if (c.loadingDelayMs !== undefined) ensureNumber(c.loadingDelayMs, 'client.loadingDelayMs', { min: 0 }, errors);
		if (c.minImageRefreshMs !== undefined) ensureNumber(c.minImageRefreshMs, 'client.minImageRefreshMs', { min: 0 }, errors);
		if (c.imageLoadTimeoutMs !== undefined) ensureNumber(c.imageLoadTimeoutMs, 'client.imageLoadTimeoutMs', { min: 0 }, errors);
		if (c.sliderDebounceMs !== undefined) ensureNumber(c.sliderDebounceMs, 'client.sliderDebounceMs', { min: 0 }, errors);
		if (c.idleAfterMs !== undefined) ensureNumber(c.idleAfterMs, 'client.idleAfterMs', { min: 0 }, errors);
		if (c.activityThrottleMs !== undefined) ensureNumber(c.activityThrottleMs, 'client.activityThrottleMs', { min: 0 }, errors);
		if (c.voiceResponseTimeoutMs !== undefined) ensureNumber(c.voiceResponseTimeoutMs, 'client.voiceResponseTimeoutMs', { min: 0 }, errors);
		if (c.touchReloadMinHiddenMs !== undefined) ensureNumber(c.touchReloadMinHiddenMs, 'client.touchReloadMinHiddenMs', { min: 0 }, errors);
		if (c.defaultTheme !== undefined) {
			const validThemes = ['dark', 'light'];
			if (!validThemes.includes(c.defaultTheme)) {
				errors.push('client.defaultTheme must be one of: ' + validThemes.join(', '));
			}
		}
		if (c.dateFormat !== undefined) ensureString(c.dateFormat, 'client.dateFormat', { allowEmpty: false, maxLen: 64 }, errors);
		if (c.timeFormat !== undefined) ensureString(c.timeFormat, 'client.timeFormat', { allowEmpty: false, maxLen: 64 }, errors);
		if (isPlainObject(c.pollIntervalsMs)) {
			if (c.pollIntervalsMs.default) {
				ensureNumber(c.pollIntervalsMs.default.active, 'client.pollIntervalsMs.default.active', { min: 1 }, errors);
				ensureNumber(c.pollIntervalsMs.default.idle, 'client.pollIntervalsMs.default.idle', { min: 1 }, errors);
			}
			if (c.pollIntervalsMs.slim) {
				ensureNumber(c.pollIntervalsMs.slim.active, 'client.pollIntervalsMs.slim.active', { min: 1 }, errors);
				ensureNumber(c.pollIntervalsMs.slim.idle, 'client.pollIntervalsMs.slim.idle', { min: 1 }, errors);
			}
		}
		if (isPlainObject(c.transport)) {
			if (c.transport.sharedWorkerEnabled !== undefined) {
				ensureBoolean(c.transport.sharedWorkerEnabled, 'client.transport.sharedWorkerEnabled', errors);
			}
			if (c.transport.swHttpEnabled !== undefined) {
				ensureBoolean(c.transport.swHttpEnabled, 'client.transport.swHttpEnabled', errors);
			}
			if (c.transport.workerRpcTimeoutMs !== undefined) {
				ensureNumber(c.transport.workerRpcTimeoutMs, 'client.transport.workerRpcTimeoutMs', { min: 1 }, errors);
			}
		}
		if (isPlainObject(c.searchDebounceMs)) {
			ensureNumber(c.searchDebounceMs.default, 'client.searchDebounceMs.default', { min: 0 }, errors);
			ensureNumber(c.searchDebounceMs.slim, 'client.searchDebounceMs.slim', { min: 0 }, errors);
		}
		if (isPlainObject(c.searchStateMinIntervalMs)) {
			ensureNumber(c.searchStateMinIntervalMs.default, 'client.searchStateMinIntervalMs.default', { min: 0 }, errors);
			ensureNumber(c.searchStateMinIntervalMs.slim, 'client.searchStateMinIntervalMs.slim', { min: 0 }, errors);
		}
		if (isPlainObject(c.searchStateConcurrency)) {
			ensureNumber(c.searchStateConcurrency.default, 'client.searchStateConcurrency.default', { min: 1 }, errors);
			ensureNumber(c.searchStateConcurrency.slim, 'client.searchStateConcurrency.slim', { min: 1 }, errors);
		}
	}

	return errors;
}

function findForbiddenObjectKeyPath(value, path = '') {
	if (!value || typeof value !== 'object') return null;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const nestedPath = findForbiddenObjectKeyPath(value[i], `${path}[${i}]`);
			if (nestedPath) return nestedPath;
		}
		return null;
	}
	for (const key of Object.keys(value)) {
		if (FORBIDDEN_OBJECT_KEYS.has(key)) {
			return path ? `${path}.${key}` : key;
		}
		const nestedPath = findForbiddenObjectKeyPath(value[key], path ? `${path}.${key}` : key);
		if (nestedPath) return nestedPath;
	}
	return null;
}

function isValidUserVoicePreference(value) {
	return value === 'system' || value === 'browser' || value === 'vosk';
}

function isValidUserMapviewRendering(value) {
	return value === 'ohproxy' || value === 'openhab';
}

function validateAdminUserConfig(userConfig) {
	const errors = [];
	if (userConfig === undefined) return errors;
	if (!isPlainObject(userConfig)) {
		errors.push('user must be an object');
		return errors;
	}

	const allowedUserKeys = new Set(['trackGps', 'voiceModel', 'mapviewRendering', 'password', 'confirm']);
	for (const key of Object.keys(userConfig)) {
		if (!allowedUserKeys.has(key)) {
			errors.push(`user.${key} is not supported`);
		}
	}
	if (Object.prototype.hasOwnProperty.call(userConfig, 'trackGps') && typeof userConfig.trackGps !== 'boolean') {
		errors.push('user.trackGps must be true/false');
	}
	if (Object.prototype.hasOwnProperty.call(userConfig, 'voiceModel')) {
		if (userConfig.voiceModel !== 'system' && userConfig.voiceModel !== 'browser' && userConfig.voiceModel !== 'vosk') {
			errors.push('user.voiceModel must be "system", "browser", or "vosk"');
		}
	}
	if (Object.prototype.hasOwnProperty.call(userConfig, 'mapviewRendering')) {
		if (typeof userConfig.mapviewRendering !== 'string') {
			errors.push('user.mapviewRendering must be "ohproxy" or "openhab"');
		} else {
			const mapviewRendering = userConfig.mapviewRendering.trim().toLowerCase();
			if (!isValidUserMapviewRendering(mapviewRendering)) {
				errors.push('user.mapviewRendering must be "ohproxy" or "openhab"');
			}
		}
	}
	if (Object.prototype.hasOwnProperty.call(userConfig, 'password') && typeof userConfig.password !== 'string') {
		errors.push('user.password must be a string');
	}
	if (Object.prototype.hasOwnProperty.call(userConfig, 'confirm') && typeof userConfig.confirm !== 'string') {
		errors.push('user.confirm must be a string');
	}

	const password = typeof userConfig.password === 'string' ? userConfig.password : '';
	const confirm = typeof userConfig.confirm === 'string' ? userConfig.confirm : '';
	const wantsPasswordChange = password.length > 0 || confirm.length > 0;

	if (wantsPasswordChange) {
		if (!password || !confirm) {
			errors.push('user.password and user.confirm are required to change password');
		}
		if (!password || !confirm || hasAnyControlChars(password) || hasAnyControlChars(confirm) || password.length > 200 || confirm.length > 200) {
			errors.push('user.password and user.confirm must match login password format');
		}
		if (password !== confirm) {
			errors.push('user.password and user.confirm must match');
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
	return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
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
	return sessions.getAuthUserMap();
}

function getCookieValue(req, name) {
	return getCookieValueFromHeader(req?.headers?.cookie, name);
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
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('X-XSS-Protection', '1; mode=block');
	if (liveConfig.securityHsts.enabled && isSecureRequest(req)) {
		res.setHeader('Strict-Transport-Security', buildHstsHeader());
	}
	if (liveConfig.securityCsp.enabled) {
		let policy = safeText(liveConfig.securityCsp.policy).replace(/[\r\n]+/g, ' ').trim();
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

function getAuthCookieUser(req, users, key) {
	if (!key) return null;
	const raw = getCookieValue(req, liveConfig.authCookieName);
	if (!raw) return null;
	return parseAuthCookieValue(raw, users, key);
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
		const child = execFile(liveConfig.binShell, ['-c', command], { detached: true, stdio: 'ignore' });
		child.unref();
		logMessage(`Auth failure notify command executed for ${safeIp}`);
	} catch (err) {
		logMessage(`Failed to run auth failure notify command: ${err.message || err}`);
	}
}

function sendAuthRequired(req, res) {
	res.setHeader('X-OhProxy-Authenticated', 'false');
	// Skip WWW-Authenticate for API requests to prevent browser credential dialog spam
	const reqPath = getRequestPath(req);
	if (!reqPath.startsWith('/api/')) {
		res.setHeader('WWW-Authenticate', `Basic realm="${liveConfig.authRealm}"`);
	}
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
	configErrors.forEach((msg) => writeLogLine(LOG_FILE, formatLogLine(`Config error: ${msg}`)));
	process.exit(1);
}

const LOCAL_CONFIG_PATH = path.join(__dirname, 'config.local.js');
const SESSIONS_DB_PATH = path.join(__dirname, 'database.db');
const SENSITIVE_FILE_MODE = 0o600;
let lastConfigMtime = 0;
let configRestartScheduled = false;
let configRestartTriggered = false;

function ensureSensitiveFilePermissions(filePath, label) {
	const target = safeText(filePath).trim();
	if (!target) return;
	try {
		if (!fs.existsSync(target)) return;
		const stat = fs.statSync(target);
		if (!stat.isFile()) return;
		const currentMode = stat.mode & 0o777;
		// Keep stricter perms as-is; only tighten when current mode is broader.
		if ((currentMode & ~SENSITIVE_FILE_MODE) === 0) return;
		fs.chmodSync(target, SENSITIVE_FILE_MODE);
		logMessage(`[Security] Hardened file permissions for ${label || target}: ${formatPermissionMode(currentMode)} -> ${formatPermissionMode(SENSITIVE_FILE_MODE)}`);
	} catch (err) {
		logMessage(`[Security] Failed to harden file permissions for ${label || target}: ${err.message || err}`);
	}
}

function hardenSensitiveFilePermissions() {
	ensureSensitiveFilePermissions(LOCAL_CONFIG_PATH, 'config.local.js');
	ensureSensitiveFilePermissions(SESSIONS_DB_PATH, 'database.db');
	ensureSensitiveFilePermissions(HTTPS_KEY_FILE, 'HTTPS key file');
	ensureSensitiveFilePermissions(HTTPS_CERT_FILE, 'HTTPS certificate file');
}

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
	ohTimeoutMs: OPENHAB_REQUEST_TIMEOUT_MS,
	iconVersion: ICON_VERSION,
	userAgent: USER_AGENT,
	assetVersion: ASSET_VERSION,
	appleTouchVersion: APPLE_TOUCH_VERSION,
	iconSize: ICON_SIZE,
	iconCacheConcurrency: ICON_CACHE_CONCURRENCY,
	iconCacheTtlMs: ICON_CACHE_TTL_MS,
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
	structureMapRefreshMs: STRUCTURE_MAP_REFRESH_MS,
	npmUpdateCheckMs: NPM_UPDATE_CHECK_MS,
	logRotationEnabled: LOG_ROTATION_ENABLED,
	clientConfig: CLIENT_CONFIG,
	wsMode: WS_MODE,
	wsPollingIntervalMs: WS_POLLING_INTERVAL_MS,
	wsPollingIntervalBgMs: WS_POLLING_INTERVAL_BG_MS,
	wsAtmosphereNoUpdateWarnMs: WS_ATMOSPHERE_NO_UPDATE_WARN_MS,
	backendRecoveryDelayMs: BACKEND_RECOVERY_DELAY_MS,
	cmdapiEnabled: CMDAPI_ENABLED,
	cmdapiAllowedSubnets: CMDAPI_ALLOWED_SUBNETS,
	cmdapiAllowedItems: CMDAPI_ALLOWED_ITEMS,
	jsLogEnabled: JS_LOG_ENABLED,
	logFile: LOG_FILE,
	accessLog: ACCESS_LOG,
	accessLogLevel: ACCESS_LOG_LEVEL,
	jsLogFile: JS_LOG_FILE,
	proxyLogLevel: PROXY_LOG_LEVEL,
	binFfmpeg: BIN_FFMPEG,
	binConvert: BIN_CONVERT,
	binShell: BIN_SHELL,
	anthropicApiKey: ANTHROPIC_API_KEY,
	aiModel: AI_MODEL,
	voiceModel: VOICE_MODEL,
	voskHost: VOSK_HOST,
	weatherbitApiKey: WEATHERBIT_API_KEY,
	weatherbitLatitude: WEATHERBIT_LATITUDE,
	weatherbitLongitude: WEATHERBIT_LONGITUDE,
	weatherbitUnits: WEATHERBIT_UNITS,
	weatherbitRefreshMs: WEATHERBIT_REFRESH_MS,
	videoPreviewIntervalMs: VIDEO_PREVIEW_INTERVAL_MS,
	videoPreviewPruneHours: VIDEO_PREVIEW_PRUNE_HOURS,
	gpsHomeLat: Number.isFinite(parseFloat(SERVER_CONFIG.gps?.homeLat)) ? parseFloat(SERVER_CONFIG.gps?.homeLat) : NaN,
	gpsHomeLon: Number.isFinite(parseFloat(SERVER_CONFIG.gps?.homeLon)) ? parseFloat(SERVER_CONFIG.gps?.homeLon) : NaN,
};

logMessage('-----');
logMessage('[Startup] Starting ohProxy instance...');

// Values that require restart if changed
const restartRequiredKeys = [
	'http.enabled', 'http.host', 'http.port',
	'https.enabled', 'https.host', 'https.port', 'https.certFile', 'https.keyFile',
	'mysql.socket', 'mysql.host', 'mysql.port', 'mysql.database', 'mysql.username', 'mysql.password',
];

function getNestedValue(obj, path) {
	return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

function setNestedValue(obj, path, value) {
	const keys = path.split('.');
	let cur = obj;
	for (let i = 0; i < keys.length - 1; i++) {
		if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
		cur = cur[keys[i]];
	}
	cur[keys[keys.length - 1]] = value;
}

const SENSITIVE_CONFIG_KEYS = [
	'server.auth.cookieKey',
	'server.apiKeys.anthropic',
	'server.weatherbit.apiKey',
	'server.openhab.pass',
	'server.openhab.apiToken',
	'server.mysql.password',
];
const SENSITIVE_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

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

	// Validate before applying — reject malformed configs
	const validationErrors = validateAdminConfig(newConfig);
	if (validationErrors.length > 0) {
		logMessage(`[Config] Hot reload rejected — validation failed:\n  ${validationErrors.join('\n  ')}`);
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
	app.set('trust proxy', liveConfig.trustProxy);
	liveConfig.denyXFFSubnets = newServer.denyXFFSubnets;
	liveConfig.proxyAllowlist = normalizeProxyAllowlist(newServer.proxyAllowlist);
	liveConfig.webviewNoProxy = normalizeProxyAllowlist(newServer.webviewNoProxy);
	liveConfig.ohTarget = safeText(newServer.openhab?.target);
	liveConfig.ohUser = safeText(newServer.openhab?.user || '');
	liveConfig.ohPass = safeText(newServer.openhab?.pass || '');
	liveConfig.ohApiToken = safeText(newServer.openhab?.apiToken || '');
	liveConfig.ohTimeoutMs = configNumber(newServer.openhab?.timeoutMs, 15000);
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
	liveConfig.appleTouchVersion = safeText(newAssets.appleTouchIconVersion);
	liveConfig.iconSize = configNumber(newServer.iconSize);
	liveConfig.iconCacheConcurrency = Math.max(1, Math.floor(configNumber(newServer.iconCacheConcurrency, 5)));
	liveConfig.iconCacheTtlMs = Math.max(0, Math.floor(configNumber(newServer.iconCacheTtlMs, 86400000)));
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
	const prevStructureMapRefreshMs = liveConfig.structureMapRefreshMs;
	liveConfig.structureMapRefreshMs = configNumber(newTasks.structureMapRefreshMs);
	const prevNpmUpdateCheckMs = liveConfig.npmUpdateCheckMs;
	liveConfig.npmUpdateCheckMs = configNumber(newTasks.npmUpdateCheckMs);
	const prevLogRotationEnabled = liveConfig.logRotationEnabled;
	liveConfig.logRotationEnabled = newServer.logRotationEnabled === true;
	liveConfig.clientConfig = newConfig.client || {};
	sessions.setDefaultTheme(liveConfig.clientConfig.defaultTheme || 'light');

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

	// CMD API config
	liveConfig.cmdapiEnabled = newServer.cmdapi?.enabled === true;
	liveConfig.cmdapiAllowedSubnets = Array.isArray(newServer.cmdapi?.allowedSubnets)
		? newServer.cmdapi.allowedSubnets
		: [];
	liveConfig.cmdapiAllowedItems = Array.isArray(newServer.cmdapi?.allowedItems)
		? newServer.cmdapi.allowedItems
		: [];

	// Logging config
	liveConfig.jsLogEnabled = newServer.jsLogEnabled === true;
	liveConfig.logFile = safeText(newServer.logFile || '');
	liveConfig.accessLog = safeText(newServer.accessLog || '');
	liveConfig.accessLogLevel = (['all', '400+'].includes(safeText(newServer.accessLogLevel || '').trim().toLowerCase()))
		? safeText(newServer.accessLogLevel || '').trim().toLowerCase() : 'all';
	liveConfig.jsLogFile = safeText(newServer.jsLogFile || '');
	liveConfig.proxyLogLevel = safeText(newServer.proxyMiddlewareLogLevel || 'silent');
	proxyCommon.logLevel = liveConfig.proxyLogLevel;

	// System binaries
	const newBinaries = newServer.binaries || {};
	liveConfig.binFfmpeg = safeText(newBinaries.ffmpeg) || '/usr/bin/ffmpeg';
	liveConfig.binConvert = safeText(newBinaries.convert) || '/usr/bin/convert';
	liveConfig.binShell = safeText(newBinaries.shell) || '/bin/sh';

	// External services
	liveConfig.anthropicApiKey = safeText(newServer.apiKeys?.anthropic) || '';
	const newAiModel = safeText(newServer.apiKeys?.aiModel) || '';
	liveConfig.aiModel = AI_MODEL_IDS.includes(newAiModel) ? newAiModel : 'claude-3-haiku-20240307';
	const newVoice = newServer.voice || {};
	const vm = (safeText(newVoice.model) || 'browser').toLowerCase();
	liveConfig.voiceModel = (vm === 'browser' || vm === 'vosk') ? vm : 'browser';
	liveConfig.voskHost = safeText(newVoice.voskHost) || '';
	const newWeatherbit = newServer.weatherbit || {};
	const prevWeatherbitUnits = liveConfig.weatherbitUnits;
	liveConfig.weatherbitApiKey = safeText(newWeatherbit.apiKey).trim();
	liveConfig.weatherbitLatitude = safeText(newWeatherbit.latitude).trim();
	liveConfig.weatherbitLongitude = safeText(newWeatherbit.longitude).trim();
	liveConfig.weatherbitUnits = safeText(newWeatherbit.units).trim() || 'metric';
	liveConfig.weatherbitRefreshMs = configNumber(newWeatherbit.refreshIntervalMs, 3600000);
	updateBackgroundTaskInterval('weatherbit', isWeatherbitConfigured() ? liveConfig.weatherbitRefreshMs : 0);
	if (liveConfig.weatherbitUnits !== prevWeatherbitUnits && isWeatherbitConfigured()) {
		try { fs.unlinkSync(WEATHERBIT_FORECAST_FILE); } catch {}
		fetchWeatherbitData();
	}

	// Video preview config
	const newVideoPreview = newServer.videoPreview || {};
	liveConfig.videoPreviewIntervalMs = configNumber(newVideoPreview.intervalMs, 900000);
	liveConfig.videoPreviewPruneHours = configNumber(newVideoPreview.pruneAfterHours, 24);
	updateBackgroundTaskInterval('video-preview', liveConfig.videoPreviewIntervalMs);

	// GPS config
	const newGps = newServer.gps || {};
	liveConfig.gpsHomeLat = Number.isFinite(parseFloat(newGps.homeLat)) ? parseFloat(newGps.homeLat) : NaN;
	liveConfig.gpsHomeLon = Number.isFinite(parseFloat(newGps.homeLon)) ? parseFloat(newGps.homeLon) : NaN;

	// Session max age
	const newMaxAge = configNumber(newServer.sessionMaxAgeDays, 14);
	if (newMaxAge >= 1) sessions.setMaxAgeDays(newMaxAge);

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

	if (liveConfig.structureMapRefreshMs !== prevStructureMapRefreshMs) {
		updateBackgroundTaskInterval('structure-map', liveConfig.structureMapRefreshMs);
	}

	if (liveConfig.npmUpdateCheckMs !== prevNpmUpdateCheckMs) {
		updateBackgroundTaskInterval('npm-update-check', liveConfig.npmUpdateCheckMs);
	}

	if (liveConfig.logRotationEnabled !== prevLogRotationEnabled) {
		syncLogRotationSchedule();
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
const LANG_JS_PATH = path.join(PUBLIC_DIR, 'lang.js');
const OH_UTILS_JS_PATH = path.join(PUBLIC_DIR, 'oh-utils.js');
const TRANSPORT_CLIENT_JS_PATH = path.join(PUBLIC_DIR, 'transport-client.js');
const TRANSPORT_SHAREDWORKER_JS_PATH = path.join(PUBLIC_DIR, 'transport.sharedworker.js');
const WIDGET_NORMALIZER_PATH = path.join(__dirname, 'lib', 'widget-normalizer.js');
const MATERIAL_ICONS_DIR = path.join(__dirname, 'node_modules', '@material-design-icons', 'svg');
const MATERIAL_ICONS_FILLED_DIR = path.join(MATERIAL_ICONS_DIR, 'filled');
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
const LOG_ROTATION_MAX_FILES = 9;
let logRotationTimer = null;

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

function msUntilNextLocalMidnight(now = new Date()) {
	const next = new Date(now);
	next.setHours(24, 0, 0, 0);
	return Math.max(0, next.getTime() - now.getTime());
}

function getConfiguredLogFilePaths() {
	const uniquePaths = new Set();
	for (const filePath of [liveConfig.logFile, liveConfig.accessLog, liveConfig.jsLogFile]) {
		const target = safeText(filePath).trim();
		if (target) uniquePaths.add(target);
	}
	return Array.from(uniquePaths);
}

function unlinkIfExists(filePath) {
	try {
		fs.unlinkSync(filePath);
		return true;
	} catch (err) {
		if (err && err.code === 'ENOENT') return false;
		throw err;
	}
}

function renameIfExists(fromPath, toPath) {
	try {
		fs.renameSync(fromPath, toPath);
		return true;
	} catch (err) {
		if (err && err.code === 'ENOENT') return false;
		throw err;
	}
}

function ensureFileExists(filePath) {
	const fd = fs.openSync(filePath, 'a');
	fs.closeSync(fd);
}

function rotateLogFile(filePath) {
	const target = safeText(filePath).trim();
	if (!target) return false;
	unlinkIfExists(`${target}.${LOG_ROTATION_MAX_FILES}`);
	for (let index = LOG_ROTATION_MAX_FILES - 1; index >= 1; index--) {
		renameIfExists(`${target}.${index}`, `${target}.${index + 1}`);
	}
	const rotated = renameIfExists(target, `${target}.1`);
	ensureFileExists(target);
	return rotated;
}

function rotateConfiguredLogFiles() {
	const logFiles = getConfiguredLogFilePaths();
	if (logFiles.length === 0) return;
	let rotatedCount = 0;
	for (const filePath of logFiles) {
		try {
			if (rotateLogFile(filePath)) rotatedCount += 1;
		} catch (err) {
			logMessage(`[LogRotate] Failed to rotate ${filePath}: ${err.message || err}`);
		}
	}
	logMessage(`[LogRotate] Completed rotation for ${logFiles.length} configured log file(s); archived ${rotatedCount} active file(s)`);
}

function scheduleLogRotation() {
	if (logRotationTimer) {
		clearTimeout(logRotationTimer);
		logRotationTimer = null;
	}
	if (!liveConfig.logRotationEnabled) return;
	const delayMs = Math.max(1000, msUntilNextLocalMidnight());
	logRotationTimer = setTimeout(() => {
		logRotationTimer = null;
		rotateConfiguredLogFiles();
		scheduleLogRotation();
	}, delayMs);
	logMessage(`[LogRotate] Next rotation in ${formatInterval(delayMs)}`);
}

function syncLogRotationSchedule() {
	if (!liveConfig.logRotationEnabled) {
		if (logRotationTimer) {
			clearTimeout(logRotationTimer);
			logRotationTimer = null;
			logMessage('[LogRotate] Disabled');
		}
		return;
	}
	scheduleLogRotation();
}

const backgroundState = {
	sitemaps: [],
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
	ws.clientIp = clientIp;  // Track for LAN status detection

	// Determine if client is on LAN (in allowSubnets)
	const isLan = clientIp !== 'unknown' && ipInAnySubnet(clientIp, liveConfig.allowSubnets);

	// Send welcome message and current backend status
	try {
		ws.send(JSON.stringify({ event: 'connected', data: { time: Date.now(), assetVersion: liveConfig.assetVersion } }));
		ws.send(JSON.stringify({
			event: 'backendStatus',
			data: { ok: backendStatus.ok, error: backendStatus.lastError },
		}));
		ws.send(JSON.stringify({ event: 'lanStatus', data: { isLan } }));
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
let backendRecoveryAttemptInOutage = 0;

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
		backendRecoveryAttemptInOutage = 0;
		logMessage(`[Backend] Status: FAILED - ${backendStatus.lastError}`);
		wsBroadcast('backendStatus', {
			ok: backendStatus.ok,
			error: backendStatus.lastError,
		});
		return;
	}

	// Going to OK state - apply fixed recovery policy
	if (backendStatus.ok === true) return; // Already OK
	if (backendRecoveryTimer) return; // Recovery already pending

	const recoveryReason = safeText(backendStatus.lastError).trim() || 'unknown';
	const delayMs = getBackendRecoveryDelayMs(recoveryReason, backendRecoveryAttemptInOutage);
	const recoveryAttempt = backendRecoveryAttemptInOutage + 1;
	backendRecoveryAttemptInOutage = recoveryAttempt;
	if (delayMs > 0) {
		logMessage(`[Backend] Recovery detected (reason: ${recoveryReason}, attempt: ${recoveryAttempt}), waiting ${delayMs}ms before marking OK...`);
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
		// Policy selected immediate recovery
		logMessage(`[Backend] Recovery detected (reason: ${recoveryReason}, attempt: ${recoveryAttempt}), marking OK immediately`);
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
		// Support both OH 1.x 'widget' and OH 3.x+ 'widgets' formats
		const widgetSource = data?.widgets || data?.widget;
		if (!data || !widgetSource) return null;
		const changes = [];
		function extractItems(widget) {
			if (widget.item && widget.item.name && widget.item.state !== undefined) {
				changes.push({ name: widget.item.name, state: widget.item.state });
			}
			// Support both 'widget' (OH 1.x) and 'widgets' (OH 3.x+)
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
const atmospherePages = new Map(); // sitemap|pageId -> { connection, trackingId, reconnectTimer }
let atmosphereConnectInFlight = false;
let atmosphereResubscribeTimer = null;
let atmosphereResubscribeRequested = false;
let atmosphereNeedsSitemapRefresh = false;
let atmosphereNoUpdateTimer = null;
let atmosphereNoUpdateWarned = false;
let atmosphereLastItemUpdateAt = 0;
let atmosphereMonitorStartedAt = 0;

// SSE (Server-Sent Events) state for openHAB 3.x+ real-time updates
let sseConnection = null;
let sseReconnectTimer = null;
const SSE_RECONNECT_MS = 5000;
let sseReconnectAttempt = 0;

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

function atmospherePageKey(sitemapName, pageId) {
	const sitemap = safeText(sitemapName).trim();
	const page = safeText(pageId).trim();
	return `${sitemap}|${page}`;
}

function connectAtmospherePage(sitemapName, pageId) {
	const sitemap = safeText(sitemapName).trim();
	if (!sitemap) return;
	const page = safeText(pageId).trim() || sitemap;
	const key = atmospherePageKey(sitemap, page);
	const existing = atmospherePages.get(key);
	if (existing) {
		if (existing.connection) {
			try { existing.connection.destroy(); } catch {}
		}
		if (existing.reconnectTimer) {
			clearTimeout(existing.reconnectTimer);
		}
	}

	const target = new URL(liveConfig.ohTarget);
	const isHttps = target.protocol === 'https:';
	const client = isHttps ? https : http;
	const basePath = target.pathname && target.pathname !== '/' ? target.pathname.replace(/\/$/, '') : '';
	const reqPath = `${basePath}/rest/sitemaps/${encodeURIComponent(sitemap)}/${encodeURIComponent(page)}?type=json`;

	const pageState = atmospherePages.get(key) || { connection: null, trackingId: null, reconnectTimer: null };

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
		agent: getOhAgent(),
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
					const affectedGroupsSet = new Set();
					for (const c of actualChanges) {
						const groups = memberToGroups.get(c.name);
						if (groups) for (const g of groups) affectedGroupsSet.add(g);
					}
					for (const groupName of affectedGroupsSet) {
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

					const allChanges = [...actualChanges, ...groupChanges];
					if (allChanges.length > 0) {
						noteAtmosphereItemUpdate();
						if (wss.clients.size > 0) {
							wsBroadcast('update', { type: 'items', changes: allChanges });
						}
					}
				}
			} else if (res.statusCode >= 400) {
				setBackendStatus(false, `HTTP ${res.statusCode}`);
			}
			// Reconnect for next update
			if (wss.clients.size > 0) {
				scheduleAtmospherePageReconnect(sitemap, page, 100);
			}
		});
	});

	req.on('error', (err) => {
		pageState.connection = null;
		// socket hang up and ECONNRESET are expected for long-polling, silently reconnect
		const msg = err.message || err;
		const isExpectedClose = msg === 'socket hang up' || err.code === 'ECONNRESET';
		if (!isExpectedClose) {
			logMessage(`[Atmosphere:${sitemap}/${page}] Error: ${msg}`);
			setBackendStatus(false, msg);
		}
		scheduleAtmospherePageReconnect(sitemap, page, ATMOSPHERE_RECONNECT_MS);
	});

	req.on('timeout', () => {
		req.destroy();
		pageState.connection = null;
		scheduleAtmospherePageReconnect(sitemap, page, 0);
	});

	req.end();
	pageState.connection = req;
	atmospherePages.set(key, pageState);
}

function scheduleAtmospherePageReconnect(sitemapName, pageId, delay) {
	const key = atmospherePageKey(sitemapName, pageId);
	const pageState = atmospherePages.get(key);
	if (!pageState) return;
	if (pageState.reconnectTimer) clearTimeout(pageState.reconnectTimer);
	pageState.reconnectTimer = setTimeout(() => {
		pageState.reconnectTimer = null;
		if (wss.clients.size > 0) {
			connectAtmospherePage(sitemapName, pageId);
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
	// Recurse into widgets - support both 'widget' (OH 1.x) and 'widgets' (OH 3.x+)
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

// Extract all video URLs from Video widgets in sitemap data
function extractVideoUrls(data, results = new Map()) {
	if (!data) return results;
	const type = (data.type || '').toLowerCase();
	if (type === 'video') {
		const url = safeText(data.url).trim();
		if (url) {
			const encoding = (data.encoding || '').trim().toLowerCase();
			results.set(url, encoding || null);
		}
	}
	// Recurse into widgets - support both 'widget' (OH 1.x) and 'widgets' (OH 3.x+)
	const widgetSource = data.widgets || data.widget;
	const widgets = Array.isArray(widgetSource) ? widgetSource : (widgetSource ? [widgetSource] : []);
	for (const w of widgets) {
		extractVideoUrls(w, results);
	}
	// Recurse into linkedPage
	if (data.linkedPage) {
		extractVideoUrls(data.linkedPage, results);
	}
	// Recurse into homepage
	if (data.homepage) {
		extractVideoUrls(data.homepage, results);
	}
	return results;
}

// Hash video URL to generate filename
function videoUrlHash(url) {
	return crypto.createHash('md5').update(url).digest('hex').substring(0, 16);
}

// Resolve video encoding from explicit param or auto-detect from URL
const VALID_VIDEO_ENCODINGS = new Set(['rtsp', 'mjpeg', 'hls', 'mp4']);

function resolveVideoEncoding(rawEncoding, target) {
	if (typeof rawEncoding === 'string' && rawEncoding.trim()) {
		const enc = rawEncoding.trim().toLowerCase();
		if (VALID_VIDEO_ENCODINGS.has(enc)) return enc;
	}
	// Auto-detect from URL
	if (target.protocol === 'rtsp:' || target.protocol === 'rtsps:') return 'rtsp';
	const pathname = (target.pathname || '').toLowerCase();
	if (pathname.endsWith('.m3u8')) return 'hls';
	if (pathname.endsWith('.mp4') || pathname.endsWith('.m4v')) return 'mp4';
	if (pathname.endsWith('.mjpg') || pathname.endsWith('.mjpeg') || pathname.includes('mjpeg')) return 'mjpeg';
	return null;
}

// Build ffmpeg input arguments for a given encoding type
function buildFfmpegInputArgs(encoding, url) {
	const common = ['-probesize', '100000', '-analyzeduration', '100000', '-fflags', '+nobuffer+genpts+discardcorrupt', '-flags', 'low_delay'];
	switch (encoding) {
	case 'rtsp':
		return [...common, '-rtsp_transport', 'tcp', '-i', url];
	case 'mjpeg':
		return [...common, '-f', 'mjpeg', '-i', url];
	case 'hls':
		return [...common, '-protocol_whitelist', 'file,http,https,tcp,tls', '-i', url];
	case 'mp4':
		return [...common, '-protocol_whitelist', 'file,http,https,tcp,tls', '-i', url];
	default:
		return [...common, '-i', url];
	}
}

function urlsHaveSameHostPort(left, right) {
	if (!(left instanceof URL) || !(right instanceof URL)) return false;
	const leftHost = safeText(left.hostname).toLowerCase();
	const rightHost = safeText(right.hostname).toLowerCase();
	if (!leftHost || !rightHost || leftHost !== rightHost) return false;
	return targetPortForUrl(left) === targetPortForUrl(right);
}

function openhabProxyPath(baseUrl) {
	try {
		const base = new URL(baseUrl);
		const basePath = base.pathname && base.pathname !== '/' ? base.pathname.replace(/\/$/, '') : '';
		return `${basePath}/proxy`;
	} catch {
		return '/proxy';
	}
}

function isOpenhabWidgetProxyTarget(target, baseUrl) {
	if (!(target instanceof URL)) return false;
	if (target.pathname !== openhabProxyPath(baseUrl)) return false;
	const sitemap = safeText(target.searchParams.get('sitemap')).trim();
	const widgetId = safeText(target.searchParams.get('widgetId')).trim();
	if (!sitemap || !widgetId) return false;
	let openhabTarget;
	try {
		openhabTarget = new URL(baseUrl);
	} catch {
		return false;
	}
	return urlsHaveSameHostPort(target, openhabTarget);
}

function cleanExtractedRtspUrl(candidate) {
	let out = safeText(candidate).trim();
	if (!out) return '';
	out = out.replace(/(?:&(apos|quot|amp|lt|gt|#39);)+$/ig, '');
	out = out.replace(/[\s)>,;'"`]+$/g, '');
	return out;
}

function extractRtspUrlFromBody(body, _contentType) {
	if (!body) return '';
	let text = '';
	try {
		if (Buffer.isBuffer(body)) text = body.subarray(0, 131072).toString('utf8');
		else text = safeText(body).slice(0, 131072);
	} catch {
		return '';
	}
	if (!text) return '';
	const matches = text.match(/rtsps?:\/\/[^\s"'<>]+/ig) || [];
	for (const rawMatch of matches) {
		const cleaned = cleanExtractedRtspUrl(rawMatch);
		if (!cleaned) continue;
		try {
			const parsed = new URL(cleaned);
			if (parsed.protocol === 'rtsp:' || parsed.protocol === 'rtsps:') return parsed.toString();
		} catch {}
	}
	return '';
}

// Chart cache helpers
const CHART_CACHE_MAX_FILES = 2000;
const CHART_CACHE_MAX_BYTES = 256 * 1024 * 1024; // 256MB
const CHART_CACHE_PRUNE_MIN_INTERVAL_MS = 5 * 60 * 1000;
let lastChartCachePruneAt = 0;

function chartCacheKey(item, period, mode, title, legend, yAxisDecimalPattern, interpolation, service, forceAsItem = false, unitSignature = '') {
	const assetVersion = liveConfig.assetVersion || 'v1';
	const dateFmt = liveConfig.clientConfig?.dateFormat || '';
	const timeFmt = liveConfig.clientConfig?.timeFormat || '';
	return crypto.createHash('md5')
		.update(`${item}|${period}|${mode || 'dark'}|${assetVersion}|${title || ''}|${dateFmt}|${timeFmt}|${legend}|${yAxisDecimalPattern || ''}|${interpolation || 'linear'}|${service || ''}|${forceAsItem ? 'forceasitem' : 'groupmode'}|${normalizeChartUnitSymbol(unitSignature)}`)
		.digest('hex')
		.substring(0, 16);
}

function getChartCachePath(item, period, mode, title, legend, yAxisDecimalPattern, interpolation, service, forceAsItem = false, unitSignature = '') {
	const hash = chartCacheKey(item, period, mode, title, legend, yAxisDecimalPattern, interpolation, service, forceAsItem, unitSignature);
	return path.join(CHART_CACHE_DIR, `${hash}.html`);
}

function isChartCacheValid(cachePath, durationSec) {
	if (!fs.existsSync(cachePath)) return false;
	const ttl = chartCacheTtl(durationSec);
	try {
		const stat = fs.statSync(cachePath);
		return (Date.now() - stat.mtimeMs) < ttl;
	} catch {
		return false;
	}
}

function maybePruneChartCache() {
	const now = Date.now();
	if (now - lastChartCachePruneAt < CHART_CACHE_PRUNE_MIN_INTERVAL_MS) return;
	lastChartCachePruneAt = now;
	setTimeout(() => {
		pruneChartCache({ force: true });
	}, 0);
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

// Chart generation

function parsePersistenceStateNumber(value) {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	const text = safeText(value).trim();
	if (!text) return null;
	const upper = text.toUpperCase();
	if (upper === 'ON' || upper === 'OPEN' || upper === 'TRUE') return 1;
	if (upper === 'OFF' || upper === 'CLOSED' || upper === 'FALSE') return 0;
	if (upper === 'NULL' || upper === 'UNDEF' || upper === 'NAN') return null;
	if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(text)) return null;
	const parsed = Number(text);
	return Number.isFinite(parsed) ? parsed : null;
}

function parsePersistenceTimestampSec(value) {
	if (typeof value === 'number' && Number.isFinite(value)) {
		if (value <= 0) return null;
		return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
	}
	const text = safeText(value).trim();
	if (!text) return null;
	if (/^\d+$/.test(text)) {
		const asNumber = Number(text);
		if (!Number.isFinite(asNumber) || asNumber <= 0) return null;
		return asNumber > 1e12 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
	}
	const asDateMs = Date.parse(text);
	if (!Number.isFinite(asDateMs)) return null;
	return Math.floor(asDateMs / 1000);
}

function parsePersistencePoint(entry) {
	if (Array.isArray(entry)) {
		if (entry.length < 2) return null;
		const ts = parsePersistenceTimestampSec(entry[0]);
		const value = parsePersistenceStateNumber(entry[1]);
		return Number.isFinite(ts) && value !== null ? [ts, value] : null;
	}
	if (!entry || typeof entry !== 'object') return null;
	const ts = parsePersistenceTimestampSec(entry.time ?? entry.timestamp ?? entry.t ?? entry.date);
	const value = parsePersistenceStateNumber(entry.state ?? entry.value ?? entry.val);
	return Number.isFinite(ts) && value !== null ? [ts, value] : null;
}

function extractPersistencePoints(payload) {
	const source = Array.isArray(payload?.data)
		? payload.data
		: Array.isArray(payload?.datapoints)
			? payload.datapoints
			: Array.isArray(payload?.values)
				? payload.values
				: Array.isArray(payload)
					? payload
					: [];
	const parsed = [];
	for (const entry of source) {
		const point = parsePersistencePoint(entry);
		if (point) parsed.push(point);
	}
	if (!parsed.length) return [];
	parsed.sort((a, b) => a[0] - b[0]);
	const deduped = [];
	for (const point of parsed) {
		if (deduped.length && deduped[deduped.length - 1][0] === point[0]) {
			deduped[deduped.length - 1] = point;
		} else {
			deduped.push(point);
		}
	}
	return deduped;
}

async function fetchPersistenceSeries(item, periodWindow = 86400, service = '') {
	const window = normalizePeriodWindow(periodWindow) || periodWindowFromPeriodString('D');
	const { start, end } = periodWindowDates(window);
	const params = new URLSearchParams();
	params.set('starttime', start.toISOString());
	params.set('endtime', end.toISOString());
	if (service) params.set('serviceId', service);
	const reqPath = `/rest/persistence/items/${encodeURIComponent(item)}?${params.toString()}`;
	const result = await fetchOpenhab(reqPath);
	if (!result?.ok) {
		const status = Number(result?.status) || 500;
		const detail = safeText(result?.body || '').replace(/\s+/g, ' ').trim().slice(0, 200);
		throw new Error(`Persistence request failed (${status})${detail ? `: ${detail}` : ''}`);
	}
	let payload;
	try {
		payload = JSON.parse(result.body);
	} catch {
		throw new Error('Persistence response was not valid JSON');
	}
	const points = extractPersistencePoints(payload);
	return points.length ? points : null;
}

function isGroupItemType(itemType) {
	const normalized = safeText(itemType).trim().toLowerCase();
	return normalized === 'group' || normalized.startsWith('group:');
}

function normalizeChartSeriesLabel(rawLabel, fallbackName) {
	const fallback = safeText(fallbackName).trim() || 'Series';
	const text = safeText(rawLabel).trim();
	if (!text) return fallback;
	const parts = splitLabelState(text);
	const title = safeText(parts?.title || '').trim();
	return title || text || fallback;
}

async function fetchOpenhabItemDefinition(itemName) {
	const reqPath = `/rest/items/${encodeURIComponent(itemName)}`;
	const result = await fetchOpenhab(reqPath);
	if (!result?.ok) {
		const status = Number(result?.status) || 500;
		const detail = safeText(result?.body || '').replace(/\s+/g, ' ').trim().slice(0, 200);
		throw new Error(`Item metadata request failed (${status})${detail ? `: ${detail}` : ''}`);
	}
	let payload;
	try {
		payload = JSON.parse(result.body);
	} catch {
		throw new Error('Item metadata response was not valid JSON');
	}
	if (!payload || typeof payload !== 'object') {
		throw new Error('Item metadata response was not an object');
	}
	return payload;
}

function extractGroupMemberDefinitions(groupDef, groupItemName) {
	const rawMembers = Array.isArray(groupDef?.members) ? groupDef.members : [];
	const out = [];
	const seen = new Set();
	for (const member of rawMembers) {
		const memberName = safeText(member?.name || '').trim();
		if (!memberName || memberName === groupItemName) continue;
		if (!/^[a-zA-Z0-9_-]{1,50}$/.test(memberName)) continue;
		if (seen.has(memberName)) continue;
		seen.add(memberName);
		out.push({
			name: memberName,
			label: normalizeChartSeriesLabel(member?.label || memberName, memberName),
		});
	}
	return out;
}

function normalizeChartUnitSymbol(rawUnitSymbol) {
	const text = safeText(rawUnitSymbol).replace(/\s+/g, ' ').trim();
	return text || '';
}

function extractUnitFromPattern(pattern) {
	if (!pattern || typeof pattern !== 'string') return '';
	const spaceIdx = pattern.indexOf(' ');
	if (spaceIdx === -1) return '';
	return normalizeChartUnitSymbol(pattern.slice(spaceIdx + 1).replace(/%%/g, '%'));
}

function resolveItemDefinitionUnitSymbol(itemDefinition) {
	const direct = normalizeChartUnitSymbol(itemDefinition?.unitSymbol);
	if (direct) return direct;
	return extractUnitFromPattern(itemDefinition?.stateDescription?.pattern);
}

function deriveChartUnitSignatureFromItemDefinition(itemDefinition, itemName, forceAsItem = false) {
	if (!itemDefinition || typeof itemDefinition !== 'object') return '';
	if (forceAsItem || !isGroupItemType(itemDefinition?.type)) {
		return resolveItemDefinitionUnitSymbol(itemDefinition);
	}
	const normalizedGroupName = safeText(itemName).trim();
	const rawMembers = Array.isArray(itemDefinition?.members) ? itemDefinition.members : [];
	const uniqueUnits = new Set();
	for (const member of rawMembers) {
		const memberName = safeText(member?.name || '').trim();
		if (!memberName || memberName === normalizedGroupName) continue;
		if (!/^[a-zA-Z0-9_-]{1,50}$/.test(memberName)) continue;
		const unitSymbol = resolveItemDefinitionUnitSymbol(member);
		if (!unitSymbol) continue;
		uniqueUnits.add(unitSymbol);
		if (uniqueUnits.size > 1) return '';
	}
	if (uniqueUnits.size === 1) return Array.from(uniqueUnits)[0];
	return resolveItemDefinitionUnitSymbol(itemDefinition);
}

function resolveDisplayedSeriesUnitSymbol(seriesList) {
	const list = Array.isArray(seriesList) ? seriesList : [];
	const uniqueUnits = new Set();
	for (const series of list) {
		const unit = normalizeChartUnitSymbol(series?.unitSymbol);
		if (!unit) continue;
		uniqueUnits.add(unit);
		if (uniqueUnits.size > 1) return '';
	}
	if (uniqueUnits.size === 1) return Array.from(uniqueUnits)[0];
	return '';
}

async function fetchChartSeriesData(item, periodWindow = 86400, service = '', forceAsItem = false, preloadedItemDefinition = null) {
	const fallbackLabel = normalizeChartSeriesLabel(item, item);
	let itemDefinition = (preloadedItemDefinition && typeof preloadedItemDefinition === 'object')
		? preloadedItemDefinition
		: null;
	if (!itemDefinition) {
		try {
			itemDefinition = await fetchOpenhabItemDefinition(item);
		} catch (err) {
			// Metadata lookup failure should not block single-item chart rendering.
			logMessage(`[Chart] Item metadata lookup failed for "${item}": ${err.message || err}`);
		}
	}

	const cacheUnitSignature = deriveChartUnitSignatureFromItemDefinition(itemDefinition, item, forceAsItem);
	const primaryLabel = normalizeChartSeriesLabel(itemDefinition?.label || item, item);
	const isGroupItem = !forceAsItem && isGroupItemType(itemDefinition?.type);
	if (!isGroupItem) {
		const primaryData = await fetchPersistenceSeries(item, periodWindow, service);
		if (!primaryData || !primaryData.length) return { series: [], unitSymbol: '', cacheUnitSignature };
		const unitSymbol = resolveItemDefinitionUnitSymbol(itemDefinition);
		return { series: [{ item, label: primaryLabel || fallbackLabel, data: primaryData }], unitSymbol, cacheUnitSignature };
	}

	const memberDefs = extractGroupMemberDefinitions(itemDefinition, item);
	if (memberDefs.length) {
		const rawMembers = Array.isArray(itemDefinition?.members) ? itemDefinition.members : [];
		const memberUnitByName = new Map();
		for (const member of rawMembers) {
			const memberName = safeText(member?.name || '').trim();
			if (!memberName || memberName === item) continue;
			if (!/^[a-zA-Z0-9_-]{1,50}$/.test(memberName)) continue;
			if (memberUnitByName.has(memberName)) continue;
			memberUnitByName.set(memberName, resolveItemDefinitionUnitSymbol(member));
		}
		const fetchedMembers = await Promise.all(memberDefs.map(async (member, index) => {
			try {
				const points = await fetchPersistenceSeries(member.name, periodWindow, service);
				if (!points || !points.length) return null;
				return {
					item: member.name,
					label: member.label,
					data: points,
					unitSymbol: memberUnitByName.get(member.name) || '',
					order: index,
				};
			} catch (err) {
				logMessage(`[Chart] Group member persistence lookup failed for "${member.name}": ${err.message || err}`);
				return null;
			}
		}));
		const memberSeries = fetchedMembers
			.filter(Boolean)
			.sort((left, right) => left.order - right.order)
			.map(({ order, ...series }) => series);
		if (memberSeries.length) {
			const unitSymbol = resolveDisplayedSeriesUnitSymbol(memberSeries);
			return { series: memberSeries, unitSymbol, cacheUnitSignature };
		}
	}

	// Fallback when no member data is available: render the group item as a single series.
	const primaryData = await fetchPersistenceSeries(item, periodWindow, service);
	if (!primaryData || !primaryData.length) return { series: [], unitSymbol: '', cacheUnitSignature };
	const unitSymbol = resolveItemDefinitionUnitSymbol(itemDefinition);
	return { series: [{ item, label: primaryLabel || fallbackLabel, data: primaryData }], unitSymbol, cacheUnitSignature };
}

function computeChartYBounds(dataMin, dataMax) {
	if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) {
		return { yMin: 0, yMax: 100 };
	}
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

	if (yMin === yMax) {
		yMin -= 1;
		yMax += 1;
	}
	return { yMin, yMax };
}

function processChartData(data, periodWindow, maxPoints = 500) {
	if (!data || data.length === 0) return { data: [], yMin: 0, yMax: 100 };

	const { startSec, endSec, window } = periodWindowBounds(periodWindow);

	// Filter and track min/max (and their indices for extreme-preserving downsample)
	let filtered = [];
	let dataMin = Infinity, dataMax = -Infinity;
	let dataMinIdx = -1, dataMaxIdx = -1;

	for (const [ts, val] of data) {
		if (ts >= startSec && ts <= endSec) {
			if (val < dataMin) { dataMin = val; dataMinIdx = filtered.length; }
			if (val > dataMax) { dataMax = val; dataMaxIdx = filtered.length; }
			filtered.push([ts, val]);
		}
	}

	// Compute average from full dataset before downsampling
	let dataAvg = null;
	if (filtered.length > 0) {
		let sum = 0;
		for (const [, val] of filtered) sum += val;
		dataAvg = sum / filtered.length;
	}

	// Downsample if needed (preserves pre-downsampled dataMin/dataMax/dataAvg)
	if (filtered.length > maxPoints) {
		const step = filtered.length / maxPoints;
		const picked = new Set();
		for (let i = 0; i < maxPoints; i++) {
			picked.add(Math.floor(i * step));
		}
		// Always include last point and extreme points so the chart line hits actual min/max
		picked.add(filtered.length - 1);
		if (dataMinIdx >= 0) picked.add(dataMinIdx);
		if (dataMaxIdx >= 0) picked.add(dataMaxIdx);
		const indices = Array.from(picked).sort((a, b) => a - b);
		filtered = indices.map(i => filtered[i]);
	}

	const { yMin, yMax } = computeChartYBounds(dataMin, dataMax);
	return { data: filtered, yMin, yMax, dataMin, dataMax, dataAvg };
}

function generateXLabels(data) {
	if (!data || data.length === 0) return [];

	const startTs = data[0][0];
	const endTs = data[data.length - 1][0];
	const duration = endTs - startTs;

	const interval = chartXLabelInterval(duration);
	const labels = [];

	for (let ts = startTs; ts <= endTs; ts += interval) {
		const pos = duration > 0 ? ((ts - startTs) / duration) * 100 : 50;
		labels.push({ ts: ts * 1000, pos });
	}

	// Ensure end label
	if (labels.length > 0 && labels[labels.length - 1].pos < 95) {
		labels.push({ ts: endTs * 1000, pos: 100 });
	}

	return labels;
}

function generateXLabelsFromBounds(startSec, endSec) {
	if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return [];
	const duration = endSec - startSec;
	const interval = chartXLabelInterval(duration);
	const labels = [];
	for (let ts = startSec; ts <= endSec; ts += interval) {
		const pos = duration > 0 ? ((ts - startSec) / duration) * 100 : 50;
		labels.push({ ts: ts * 1000, pos });
	}
	if (labels.length === 0 || labels[labels.length - 1].pos < 99.5) {
		labels.push({ ts: endSec * 1000, pos: 100 });
	}
	return labels;
}

function generateChartPoints(data, startSec = null, endSec = null) {
	if (!data || data.length === 0) return [];

	const defaultStartTs = data[0][0];
	const defaultEndTs = data[data.length - 1][0];
	let startTs = Number.isFinite(startSec) ? startSec : defaultStartTs;
	let endTs = Number.isFinite(endSec) ? endSec : defaultEndTs;
	if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) {
		startTs = defaultStartTs;
		endTs = defaultEndTs;
	}
	const duration = endTs - startTs;

	return data.map(([ts, val], i) => ({
		x: Math.round((duration > 0 ? ((ts - startTs) / duration) * 100 : 50) * 100) / 100,
		y: Math.round(val * 1000) / 1000,
		t: ts * 1000,
		index: i
	}));
}

function computeChartDataHash(rawData, periodWindow) {
	if (!rawData || rawData.length === 0) return null;

	// Filter to requested period window (same bounds as processChartData)
	const { startSec, endSec, window } = periodWindowBounds(periodWindow);
	const periodData = rawData.filter(([ts]) => ts >= startSec && ts <= endSec);
	if (periodData.length === 0) return null;

	// Sample rate and rounding based on duration for stable hashing
	const cfg = chartHashConfig(window.totalSec);

	const sampled = periodData.filter((_, i) => i % cfg.sample === 0);
	const dataStr = sampled.map(([ts, val]) => {
		const roundedTs = Math.floor(ts / cfg.tsRound) * cfg.tsRound;
		const roundedVal = Number(val.toFixed(cfg.decimals));
		return `${roundedTs}:${roundedVal}`;
	}).join('|');

	return crypto.createHash('md5').update(dataStr).digest('hex').substring(0, 16);
}

function computeChartSeriesDataHash(rawSeriesList, periodWindow, unitSymbol = '') {
	const list = Array.isArray(rawSeriesList) ? rawSeriesList : [];
	if (list.length === 0) return null;
	let baseHash = null;
	if (list.length === 1) {
		const onlySeries = list[0];
		baseHash = computeChartDataHash(Array.isArray(onlySeries?.data) ? onlySeries.data : [], periodWindow);
		if (!baseHash) return null;
		const unitSig = normalizeChartUnitSymbol(unitSymbol);
		return crypto.createHash('md5').update(`${baseHash}|u:${unitSig}`).digest('hex').substring(0, 16);
	}
	const parts = [];
	for (const series of list) {
		const itemName = safeText(series?.item || '').trim();
		const seriesData = Array.isArray(series?.data) ? series.data : [];
		const hash = computeChartDataHash(seriesData, periodWindow);
		if (!hash) continue;
		parts.push(`${itemName}:${hash}`);
	}
	if (!parts.length) return null;
	parts.sort();
	baseHash = crypto.createHash('md5').update(parts.join('|')).digest('hex').substring(0, 16);
	const unitSig = normalizeChartUnitSymbol(unitSymbol);
	return crypto.createHash('md5').update(`${baseHash}|u:${unitSig}`).digest('hex').substring(0, 16);
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

function prepareChartSeriesRenderData(rawSeriesList, periodWindow) {
	const window = normalizePeriodWindow(periodWindow) || periodWindowFromPeriodString('D');
	const rawList = Array.isArray(rawSeriesList) ? rawSeriesList : [];
	if (!rawList.length) return null;

	let dataMin = Infinity;
	let dataMax = -Infinity;
	const processedSeries = [];
	for (const rawSeries of rawList) {
		const itemName = safeText(rawSeries?.item || '').trim();
		const label = normalizeChartSeriesLabel(rawSeries?.label || itemName, itemName || 'Series');
		const sourceData = Array.isArray(rawSeries?.data) ? rawSeries.data : [];
		const processed = processChartData(sourceData, window, 500);
		if (!processed?.data || !processed.data.length) continue;
		if (Number.isFinite(processed.dataMin)) dataMin = Math.min(dataMin, processed.dataMin);
		if (Number.isFinite(processed.dataMax)) dataMax = Math.max(dataMax, processed.dataMax);
		processedSeries.push({
			item: itemName,
			label,
			data: processed.data,
			dataAvg: processed.dataAvg,
		});
	}
	if (!processedSeries.length) return null;
	const isMultiSeries = processedSeries.length > 1;
	let labelStartSec = null;
	let labelEndSec = null;
	let xLabels = [];
	if (isMultiSeries) {
		const bounds = periodWindowBounds(window);
		labelStartSec = bounds.startSec;
		labelEndSec = bounds.endSec;
		xLabels = generateXLabelsFromBounds(labelStartSec, labelEndSec);
	} else {
		xLabels = generateXLabels(processedSeries[0].data);
	}

	const chartSeries = processedSeries.map((series, index) => ({
		item: series.item,
		label: series.label,
		colorIndex: index % 12,
		points: generateChartPoints(series.data, labelStartSec, labelEndSec),
	}));
	const { yMin, yMax } = computeChartYBounds(dataMin, dataMax);
	const primarySeries = processedSeries[0];
	const primaryPoints = chartSeries[0]?.points || [];
	const dataCur = primaryPoints.length ? primaryPoints[primaryPoints.length - 1].y : null;
	return {
		chartSeries,
		xLabels,
		yMin,
		yMax,
		dataMin,
		dataMax,
		dataAvg: primarySeries?.dataAvg ?? null,
		dataCur,
		isMultiSeries,
		durationSec: window.totalSec,
	};
}

function generateChartHtml(chartSeries, xLabels, yMin, yMax, dataMin, dataMax, title, unit, mode, dataHash, dataAvg, dataCur, period, legend, yAxisDecimalPattern, durationSec, interpolation, isMultiSeries = false) {
	const theme = mode === 'dark' ? 'dark' : 'light';
	const safeTitle = escapeHtml(title);
	const unitDisplay = unit ? escapeHtml(unit) : '';
	const assetVersion = liveConfig.assetVersion || 'v1';
	const dataHashAttr = dataHash ? ` data-hash="${dataHash}"` : '';
	const seriesCount = Array.isArray(chartSeries) ? chartSeries.length : 0;
	const showLegend = !isMultiSeries && shouldShowChartLegend(legend, seriesCount || 1);
	const primaryChartData = (Array.isArray(chartSeries) && chartSeries.length && Array.isArray(chartSeries[0].points))
		? chartSeries[0].points
		: [];

	let legendHtml = '';
	let statsHtml = '';
	if (showLegend) {
		legendHtml = unitDisplay ? `<span class="chart-legend"><span class="legend-line"></span><span>${unitDisplay}</span></span>` : '';
		// Format stats values with unit
		const statUnit = unitDisplay ? ' ' + unitDisplay : '';
		const fmtAvg = typeof dataAvg === 'number' ? formatChartValue(dataAvg) + statUnit : '';
		const fmtMin = typeof dataMin === 'number' ? formatChartValue(dataMin) + statUnit : '';
		const fmtMax = typeof dataMax === 'number' ? formatChartValue(dataMax) + statUnit : '';
		const fmtCur = (chartShowCurStat(durationSec || 3600) && typeof dataCur === 'number') ? formatChartValue(dataCur) + statUnit : '';
		const curHtml = fmtCur ? `<span class="stat-item" id="statCur"><span class="stat-label">Cur</span> <span class="stat-value" data-raw="${dataCur}">${fmtCur}</span></span>` : '';
		statsHtml = fmtAvg ? `${curHtml}<span class="stat-item"><span class="stat-label">Avg</span> <span class="stat-value" data-raw="${dataAvg}">${fmtAvg}</span></span><span class="stat-item" id="statMin"><span class="stat-label">Min</span> <span class="stat-value" data-raw="${dataMin}">${fmtMin}</span></span><span class="stat-item" id="statMax"><span class="stat-label">Max</span> <span class="stat-value" data-raw="${dataMax}">${fmtMax}</span></span>` : '';
	}

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
<div class="chart-header-right" id="chartStats">${statsHtml}${legendHtml}<span class="chart-fs-divider" id="fsDivider"></span><button class="chart-fs-btn" id="chartRotate" type="button"><svg viewBox="0 0 24 24"><path d="M12 5V2L8 6l4 4V7c3.31 0 6 2.69 6 6 0 1.01-.25 1.96-.7 2.8l1.46 1.46A7.944 7.944 0 0 0 20 13c0-4.42-3.58-8-8-8zM6.7 9.2 5.24 7.74A7.944 7.944 0 0 0 4 13c0 4.42 3.58 8 8 8v3l4-4-4-4v3c-3.31 0-6-2.69-6-6 0-1.01.25-1.96.7-2.8z"/></svg></button><button class="chart-fs-btn" id="chartFullscreen" type="button"><svg viewBox="0 0 24 24"><path d="M3 3h6v2H5v4H3V3zm12 0h6v6h-2V5h-4V3zM3 15h2v4h4v2H3v-6zm16 0h2v6h-6v-2h4v-4z"/></svg></button></div>
</div>
<div class="chart-container" id="chartContainer">
<svg class="chart-svg" id="chartSvg"></svg>
<div class="tooltip" id="tooltip"><div class="tooltip-value" id="tooltipValue"></div><div class="tooltip-label" id="tooltipLabel"></div></div>
</div>
</div>
</div>
<script>
window._chartData=${inlineJson(primaryChartData)};
window._chartSeries=${inlineJson(chartSeries)};
window._chartIsMultiSeries=${inlineJson(isMultiSeries)};
window._chartXLabels=${inlineJson(xLabels)};
window._chartYMin=${inlineJson(yMin)};
window._chartYMax=${inlineJson(yMax)};
window._chartDataMin=${inlineJson(dataMin)};
window._chartDataMax=${inlineJson(dataMax)};
window._chartUnit=${inlineJson(unit)};
window._chartPeriod=${inlineJson(period)};
window._chartDateFormat=${inlineJson(liveConfig.clientConfig?.dateFormat || 'MMM Do, YYYY')};
window._chartTimeFormat=${inlineJson(liveConfig.clientConfig?.timeFormat || 'H:mm:ss')};
window._chartYAxisPattern=${inlineJson(yAxisDecimalPattern || null)};
window._chartInterpolation=${inlineJson(interpolation || 'linear')};
</script>
<script src="/oh-utils.${assetVersion}.js"></script>
<script src="/chart.${assetVersion}.js"></script>
</body>
</html>`;
}

function renderChartFromSeries(rawSeriesList, period, mode, title, legend, yAxisDecimalPattern, periodWindow, interpolation, precomputedDataHash = '', unitSymbol = '') {
	const window = normalizePeriodWindow(periodWindow) || periodWindowFromPeriodString(period, 86400);
	const prepared = prepareChartSeriesRenderData(rawSeriesList, window);
	if (!prepared?.chartSeries?.length) return null;

	const unit = normalizeChartUnitSymbol(unitSymbol);

	// Reuse precomputed hash when available (e.g. /api/chart-hash path) to avoid duplicate hashing.
	const dataHash = (typeof precomputedDataHash === 'string' && precomputedDataHash)
		? precomputedDataHash
		: computeChartSeriesDataHash(rawSeriesList, window, unit);
	if (!dataHash) return null;

	// Generate HTML
	const html = generateChartHtml(
		prepared.chartSeries,
		prepared.xLabels,
		prepared.yMin,
		prepared.yMax,
		prepared.dataMin,
		prepared.dataMax,
		title,
		unit,
		mode,
		dataHash,
		prepared.dataAvg,
		prepared.dataCur,
		period,
		legend,
		yAxisDecimalPattern,
		prepared.durationSec,
		interpolation,
		prepared.isMultiSeries
	);
	return {
		html,
		dataHash,
	};
}

async function generateChart(item, period, mode, title, legend, yAxisDecimalPattern, periodWindow, interpolation, service = '', forceAsItem = false, preloadedItemDefinition = null) {
	const window = normalizePeriodWindow(periodWindow) || periodWindowFromPeriodString(period, 86400);
	const { series: rawSeriesList, unitSymbol, cacheUnitSignature } = await fetchChartSeriesData(item, window, service, forceAsItem, preloadedItemDefinition);
	if (!rawSeriesList || !rawSeriesList.length) return null;
	const rendered = renderChartFromSeries(rawSeriesList, period, mode, title, legend, yAxisDecimalPattern, window, interpolation, '', unitSymbol);
	if (!rendered?.html) return null;
	return {
		html: rendered.html,
		cacheUnitSignature,
	};
}

async function fetchAllPagesAcrossSitemaps() {
	let sitemaps = getBackgroundSitemaps();
	let needsSitemapRefresh = false;

	if (!sitemaps.length) {
		await refreshSitemapCache({ skipAtmosphereResubscribe: true });
		sitemaps = getBackgroundSitemaps();
	}

	if (!sitemaps.length) {
		needsSitemapRefresh = true;
		return {
			targets: [],
			needsSitemapRefresh,
		};
	}

	const targets = [];
	for (const entry of sitemaps) {
		const sitemapName = safeText(entry?.name).trim();
		if (!sitemapName) continue;
		try {
			const result = await fetchOpenhab(`/rest/sitemaps/${encodeURIComponent(sitemapName)}?type=json`);
			if (!result.ok) {
				throw new Error(`HTTP ${result.status}`);
			}
			const data = JSON.parse(result.body);
			const pages = Array.from(extractPageIds(data));
			if (!pages.length) {
				needsSitemapRefresh = true;
				targets.push({ sitemapName, pageId: sitemapName });
				continue;
			}
			for (const pageId of pages) {
				const normalizedPageId = safeText(pageId).trim();
				if (!normalizedPageId) continue;
				targets.push({ sitemapName, pageId: normalizedPageId });
			}
		} catch (e) {
			logMessage(`[Atmosphere] Failed to fetch pages for sitemap "${sitemapName}": ${e.message}`);
			needsSitemapRefresh = true;
			targets.push({ sitemapName, pageId: sitemapName });
		}
	}

	return {
		targets,
		needsSitemapRefresh,
	};
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

		// Fetch all pages across all sitemaps and subscribe to each
		const { targets, needsSitemapRefresh } = await fetchAllPagesAcrossSitemaps();

		// If no pages found, OpenHAB may still be starting - retry later
		if (targets.length === 0) {
			logMessage(`[Atmosphere] No sitemap pages found, will retry in ${ATMOSPHERE_RECONNECT_MS}ms`);
			setTimeout(() => connectAtmosphere(), ATMOSPHERE_RECONNECT_MS);
			return;
		}

		atmosphereNeedsSitemapRefresh = needsSitemapRefresh;

		const perSitemapCounts = new Map();
		for (const target of targets) {
			perSitemapCounts.set(
				target.sitemapName,
				(perSitemapCounts.get(target.sitemapName) || 0) + 1
			);
		}
		const summary = Array.from(perSitemapCounts.entries())
			.map(([name, count]) => `${name}:${count}`)
			.join(', ');
		logMessage(`[Atmosphere] Subscribing to ${targets.length} pages across ${perSitemapCounts.size} sitemap(s): ${summary}`);
		for (const target of targets) {
			connectAtmospherePage(target.sitemapName, target.pageId);
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
	stopAtmosphereNoUpdateMonitor();
}

// --- SSE Mode (openHAB 3.x+) ---

function handleSSEEvent(eventData) {
	// Parse OH 3.x+ SSE event format:
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

	logMessage('[SSE] Connecting to openHAB 3.x+ event stream...');

	const req = client.request({
		method: 'GET',
		hostname: target.hostname,
		port: target.port || (isHttps ? 443 : 80),
		path: reqPath,
		headers,
		agent: getOhAgent(),
	}, (res) => {
		if (res.statusCode !== 200) {
			logMessage(`[SSE] Connection failed: HTTP ${res.statusCode}`);
			setBackendStatus(false, `SSE HTTP ${res.statusCode}`);
			scheduleSSEReconnect();
			return;
		}

		logMessage('[SSE] Connected to event stream');
		sseReconnectAttempt = 0;
		setBackendStatus(true);
		groupMemberBackoffLevel = 0;
		groupMemberLastFingerprint = null;
		refreshGroupMemberMap().catch(() => {});

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
							const affectedGroups = memberToGroups.get(change.name);
							if (affectedGroups) {
								for (const groupName of affectedGroups) {
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
								wsBroadcast('update', { type: 'items', changes: allChanges });
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
			sseConnection = null;
			scheduleSSEReconnect();
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
	const delayMs = sseReconnectAttempt === 0 ? 0 : SSE_RECONNECT_MS;
	sseReconnectAttempt++;

	sseReconnectTimer = setTimeout(() => {
		sseReconnectTimer = null;
		if (liveConfig.wsMode === 'sse' && wss.clients.size > 0) {
			connectSSE();
		}
	}, delayMs);
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
	sseReconnectAttempt = 0;
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
		const affectedGroupsSet = new Set();
		for (const c of actualChanges) {
			const groups = memberToGroups.get(c.name);
			if (groups) for (const g of groups) affectedGroupsSet.add(g);
		}
		for (const groupName of affectedGroupsSet) {
			if (actualChanges.some(c => c.name === groupName)) continue;

			const calculatedState = await calculateGroupState(groupName);
			if (calculatedState !== null) {
				const prevCalculated = groupItemCalculatedStates.get(groupName);
				if (prevCalculated !== calculatedState) {
					groupItemCalculatedStates.set(groupName, calculatedState);
					const itemData = items.find(i => i.name === groupName);
					if (itemData) {
						groupChanges.push({ ...itemData, state: calculatedState });
					} else {
						groupChanges.push({ name: groupName, state: calculatedState });
					}
				}
			}
		}

		const allChanges = [...actualChanges, ...groupChanges];
		if (allChanges.length > 0) {
			wsBroadcast('update', { type: 'items', changes: allChanges });
		}
	}

	// Schedule next poll with dynamic interval
	if (pollingActive && wss.clients.size > 0) {
		if (pollingTimer) clearTimeout(pollingTimer);
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

function getInitialPageTitle(context = {}) {
	const clientSiteName = safeText(liveConfig.clientConfig?.siteName || '').trim();
	if (clientSiteName) return clientSiteName;
	const selectedSitemapTitle = safeText(context?.selectedSitemapTitle || '').trim();
	if (selectedSitemapTitle) return selectedSitemapTitle;
	const homepagePageTitle = safeText(context?.homepagePageTitle || '').trim();
	if (homepagePageTitle) return homepagePageTitle;
	const cached = safeText(getPrimaryBackgroundSitemap()?.title);
	return cached || DEFAULT_PAGE_TITLE;
}

function getInitialDocumentTitle(context = {}) {
	const site = getInitialPageTitle(context);
	if (!site || site.toLowerCase() === DEFAULT_PAGE_TITLE.toLowerCase()) {
		return `${DEFAULT_PAGE_TITLE} · Home`;
	}
	return `${DEFAULT_PAGE_TITLE} · ${site} · Home`;
}

function getInitialPageTitleHtml(context = {}) {
	const site = escapeHtml(getInitialPageTitle(context));
	const home = 'Home';
	return `<span class="font-semibold">${site}</span>` +
		`<span class="font-light text-slate-300"> · ${escapeHtml(home)}</span>`;
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
	html = html.replace(/__PAGE_TITLE__/g, getInitialPageTitleHtml(opts));
	html = html.replace(/__DOC_TITLE__/g, escapeHtml(getInitialDocumentTitle(opts)));
	html = html.replace(/__STATUS_TEXT__/g, escapeHtml(opts.statusText || 'Connected'));
	html = html.replace(/__STATUS_CLASS__/g, escapeHtml(opts.statusClass || 'status-pending'));
	html = html.replace(/__AUTH_INFO__/g, inlineJson(opts.authInfo || {}));
	html = html.replace(/__SESSION_SETTINGS__/g, inlineJson(opts.sessionSettings || {}));
	html = html.replace(/__HOMEPAGE_DATA__/g, opts.homepageData ? inlineJson(opts.homepageData) : 'null');
	html = html.replace(/__SITEMAP_CACHE__/g, opts.sitemapCache ? inlineJson(opts.sitemapCache) : 'null');
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

	const days = Array.isArray(forecastData?.data) ? forecastData.data : [];
	if (!days.length) {
		return `<!DOCTYPE html>
<html><head><title>Weather</title><style>@font-face{font-family:'Rubik';src:url('/fonts/rubik-300.woff2') format('woff2');font-weight:300;font-display:swap}body{font-family:'Rubik',system-ui,sans-serif;font-weight:300;padding:2rem;text-align:center}</style></head>
<body>
<h1>Weather data unavailable</h1>
<p>Forecast data is empty or invalid. It will be refreshed automatically.</p>
</body></html>`;
	}
	const cityName = escapeHtml(forecastData?.city_name || '');
	const unitSymbol = liveConfig.weatherbitUnits === 'imperial' ? 'F' : 'C';

	const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

	const forecastCards = days.map((day) => {
		const date = new Date(day.datetime);
		const dayName = dayNames[date.getUTCDay()];
		const dayOfMonth = date.getUTCDate();
		const suffix = (dayOfMonth === 1 || dayOfMonth === 21 || dayOfMonth === 31) ? 'st'
		             : (dayOfMonth === 2 || dayOfMonth === 22) ? 'nd'
		             : (dayOfMonth === 3 || dayOfMonth === 23) ? 'rd' : 'th';
		const dateLabel = monthNames[date.getUTCMonth()] + ' ' + dayOfMonth + suffix;
		const icon = escapeHtml(day.weather?.icon || 'c01d');
		const highTemp = Math.round(day.high_temp || 0);
		const lowTemp = Math.round(day.low_temp || 0);
		const pop = day.pop || 0;
		const rainOpacity = pop > 0 ? '0.9' : '0.3';
		const rainTextColor = pop > 0 ? rainColor : 'inherit';

		return `
			<div class="forecast-day">
				<div class="day-name">${dayName}</div>
				<div class="day-date">${dateLabel}</div>
				<img class="weather-icon" src="/weather/icons/${icon}.png" alt="${escapeHtml(day.weather?.description || '')}">
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
	padding: 12px;
}
.forecast-container {
	display: flex;
	gap: 12px;
	overflow: hidden;
	padding: 5px;
	flex: 1;
}
.forecast-day {
	flex: 1;
	min-width: 70px;
	background: transparent;
	border-radius: 10px;
	padding: 12px;
	display: none;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 12px;
}
.forecast-day.visible { display: flex; }
.day-name {
	font-size: 1.125rem;
	font-weight: 400;
	opacity: 0.7;
}
.day-date {
	font-size: .7rem;
	font-weight: 300;
	opacity: 0.5;
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
	font-size: .7rem;
	margin-top: 8px;
}
.rain-icon {
	width: .625rem;
	height: .625rem;
}
.forecast-dots {
	display: none;
	justify-content: center;
	gap: 4px;
	padding-top: 12px;
}
.forecast-dots.visible { display: flex; }
.forecast-dot {
	border-radius: 50%;
	background: ${textColor};
	opacity: 0.25;
	transition: opacity 0.2s;
	cursor: pointer;
	border: 4px solid transparent;
	box-sizing: content-box;
}
.forecast-dot.active { opacity: 0.8; }
</style>
</head>
<body>
<script>if(window.self===window.top)document.documentElement.style.background='${isDark ? '#0f172a' : '#ffffff'}'</script>
<div class="weather-card">
	<div class="forecast-container">
		${forecastCards}
	</div>
	<div class="forecast-dots"></div>
</div>
<script>
(function() {
  var container = document.querySelector('.forecast-container');
  if (!container) return;
  var cards = container.querySelectorAll('.forecast-day');
  if (!cards.length) return;
  var dotsEl = document.querySelector('.forecast-dots');
  var startIndex = 0;
  var maxFit = 1;

  function fitCards() {
    var contentWidth = container.clientWidth - 10;
    maxFit = Math.max(1, Math.floor((contentWidth + 10) / 80));
    var maxStart = Math.max(0, cards.length - maxFit);
    if (startIndex > maxStart) startIndex = maxStart;
    for (var i = 0; i < cards.length; i++) {
      if (i >= startIndex && i < startIndex + maxFit) cards[i].classList.add('visible');
      else cards[i].classList.remove('visible');
    }
    updateDots();
  }

  function updateDots() {
    if (!dotsEl) return;
    var totalPages = Math.max(1, cards.length - maxFit + 1);
    if (totalPages <= 1) {
      dotsEl.classList.remove('visible');
      return;
    }
    dotsEl.classList.add('visible');
    var html = '';
    for (var i = 0; i < totalPages; i++) {
      html += '<div class="forecast-dot' + (i === startIndex ? ' active' : '') + '"></div>';
    }
    dotsEl.innerHTML = html;
  }

  // Click on dots to navigate
  if (dotsEl) {
    dotsEl.addEventListener('click', function(e) {
      var dot = e.target.closest('.forecast-dot');
      if (!dot) return;
      var dots = dotsEl.querySelectorAll('.forecast-dot');
      for (var i = 0; i < dots.length; i++) {
        if (dots[i] === dot) { startIndex = i; fitCards(); break; }
      }
    });
  }

  // Touch swipe handling
  var startX = 0, startY = 0, swiping = false;
  container.addEventListener('touchstart', function(e) {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    swiping = false;
  }, { passive: true });

  container.addEventListener('touchmove', function(e) {
    if (e.touches.length !== 1) return;
    var dx = Math.abs(e.touches[0].clientX - startX);
    var dy = Math.abs(e.touches[0].clientY - startY);
    if (dx > dy && dx > 10) {
      swiping = true;
      e.preventDefault();
    }
  }, { passive: false });

  container.addEventListener('touchend', function(e) {
    if (!swiping) return;
    var endX = e.changedTouches[0].clientX;
    var delta = endX - startX;
    if (Math.abs(delta) < 50) return;
    var maxStart = Math.max(0, cards.length - maxFit);
    if (delta < 0) startIndex = Math.min(startIndex + 1, maxStart);
    else startIndex = Math.max(startIndex - 1, 0);
    fitCards();
  }, { passive: true });

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(fitCards).observe(container);
  } else {
    fitCards();
    window.addEventListener('resize', fitCards);
  }
})();
</script>
</body>
</html>`;
}

const HOMEPAGE_DATA_TIMEOUT_MS = 500;
const SITEMAP_CACHE_TIMEOUT_MS = 2000;
const HOMEPAGE_INLINE_ICON_LIMIT = 80;

async function getFullSitemapData(sitemapName) {
	if (!sitemapName) return null;

	const rootPath = `/rest/sitemaps/${encodeURIComponent(sitemapName)}/${encodeURIComponent(sitemapName)}?type=json`;
	const queue = [rootPath];
	const seenPages = new Set();
	const pages = {};
	const startTime = Date.now();

	while (queue.length) {
		// Check timeout
		if (Date.now() - startTime > SITEMAP_CACHE_TIMEOUT_MS) {
			break;
		}

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

		// Apply group state overrides
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
				if (w?.widget) findLinks(w.widget);
				if (w?.widgets) findLinks(w.widgets);
			}
		};
		findLinks(page?.widgets || page?.widget);
	}

	if (Object.keys(pages).length === 0) return null;
	return { pages, root: rootPath };
}

function filterSitemapCacheVisibility(cache, userRole) {
	if (!cache || !cache.pages || userRole === 'admin') return cache;
	const visibilityMap = buildVisibilityMap();

	const withWidgetKeyContext = (widget, ctx = {}) => {
		const clone = { ...widget };
		const baseSectionPath = Array.isArray(ctx.sectionPath) ? ctx.sectionPath.slice() : [];
		const label = sectionLabel(clone);
		const isSection = clone?.__section === true || widgetType(clone) === 'Frame';
		const keySectionPath = isSection && label ? baseSectionPath.concat([label]) : baseSectionPath.slice();

		if (ctx.sitemapName) clone.__sitemapName = ctx.sitemapName;
		if (keySectionPath.length) {
			clone.__sectionPath = keySectionPath.slice();
			clone.__frame = keySectionPath[keySectionPath.length - 1];
		}
		return { clone, keySectionPath };
	};

	const shouldHide = (w, ctx = {}) => {
		if (!w) return false;
		const { clone } = withWidgetKeyContext(w, ctx);
		const wKey = widgetKey(clone);
		const vis = visibilityMap.get(wKey) || 'all';
		return !isVisibilityAllowedForRole(vis, userRole);
	};

	// Filter an array of widgets, cloning each kept widget before recursing.
	const filterArray = (arr, ctx = {}) => {
		return arr.filter((w) => !w || !shouldHide(w, ctx)).map((w) => {
			if (!w) return w;
			const { clone, keySectionPath } = withWidgetKeyContext(w, ctx);
			const nextCtx = { sitemapName: ctx.sitemapName, sectionPath: keySectionPath };
			if (clone.widgets) clone.widgets = filterNested(clone.widgets, nextCtx);
			if (clone.widget) clone.widget = filterNested(clone.widget, nextCtx);
			return clone;
		});
	};

	// Normalize any widget structure to filtered output, preserving shape.
	const filterNested = (val, ctx = {}) => {
		if (!val) return val;
		if (Array.isArray(val)) return filterArray(val, ctx);
		// Object with .item array (XML-to-JSON wrapper)
		if (Array.isArray(val.item)) return { ...val, item: filterArray(val.item, ctx) };
		// Object with single .item (XML-to-JSON single child)
		if (val.item) {
			if (shouldHide(val.item, ctx)) return null;
			const filtered = filterArray([val.item], ctx);
			return filtered.length ? { ...val, item: filtered[0] } : null;
		}
		// Single widget object
		if (shouldHide(val, ctx)) return null;
		const { clone, keySectionPath } = withWidgetKeyContext(val, ctx);
		const nextCtx = { sitemapName: ctx.sitemapName, sectionPath: keySectionPath };
		if (clone.widgets) clone.widgets = filterNested(clone.widgets, nextCtx);
		if (clone.widget) clone.widget = filterNested(clone.widget, nextCtx);
		return clone;
	};

	const filtered = { pages: {}, root: cache.root };
	for (const [url, page] of Object.entries(cache.pages)) {
		const copy = { ...page };
		const pageSitemapName = sitemapNameFromRestSitemapPath(url);
		const rootCtx = { sitemapName: pageSitemapName, sectionPath: [] };
		if (copy.widgets) copy.widgets = filterNested(copy.widgets, rootCtx);
		if (copy.widget) copy.widget = filterNested(copy.widget, rootCtx);
		filtered.pages[url] = copy;
	}
	return filtered;
}

async function getHomepageData(req, sitemapName) {
	const sitemap = safeText(sitemapName).trim();
	if (!sitemap) return null;

	try {
		const result = await Promise.race([
			fetchOpenhab(`/rest/sitemaps/${encodeURIComponent(sitemap)}/${encodeURIComponent(sitemap)}?type=json`),
			new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), HOMEPAGE_DATA_TIMEOUT_MS)),
		]);
		if (!result.ok) return null;

		const page = JSON.parse(result.body);
		await applyGroupStateOverrides(page);
		const widgets = normalizeWidgets(page, { sitemapName: sitemap });

		// Apply visibility filtering
		const userRole = getRequestUserRole(req);
		const visibilityMap = buildVisibilityMap();

		const visibleWidgets = widgets.filter((w) => isWidgetVisibleForRole(w, userRole, visibilityMap));
		const inlineIcons = await buildHomepageInlineIcons(visibleWidgets);

		return {
			sitemapName: sitemap,
			pageUrl: `/rest/sitemaps/${encodeURIComponent(sitemap)}/${encodeURIComponent(sitemap)}?type=json`,
			pageTitle: page.title || sitemap,
			widgets: visibleWidgets,
			inlineIcons,
		};
	} catch {
		return null;
	}
}

async function sendIndex(req, res) {
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Content-Type', 'text/html; charset=utf-8');
	const status = getInitialStatusInfo(req);
	status.authInfo = getAuthInfo(req);
	status.sessionSettings = req.ohProxySession?.settings || sessions.getDefaultSettings();

	// Embed homepage and sitemap data for authenticated users
	if (req.ohProxyAuth === 'authenticated') {
		// Ensure sitemap cache is populated (may not be ready on cold start)
		if (!getBackgroundSitemaps().length) {
			await refreshSitemapCache({ skipAtmosphereResubscribe: true });
		}
		const sitemapName = resolveRequestSitemapName(req);
		if (sitemapName) {
			const selectedSitemap = getVisibleBackgroundSitemapsForRequest(req).find((entry) => entry?.name === sitemapName);
			status.selectedSitemapTitle = safeText(selectedSitemap?.title || selectedSitemap?.name || '').trim();
			const [homepageData, sitemapCache] = await Promise.all([
				getHomepageData(req, sitemapName),
				getFullSitemapData(sitemapName),
			]);
			const userRole = getRequestUserRole(req);
			status.homepageData = homepageData;
			status.homepagePageTitle = safeText(homepageData?.pageTitle || '').trim();
			status.sitemapCache = filterSitemapCacheVisibility(sitemapCache, userRole);
		}
	}

	res.send(renderIndexHtml(status));
}

function sendServiceWorker(res) {
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
	res.send(renderServiceWorker());
}

function styledErrorPage(message, req) {
	const rawMode = typeof req.query?.mode === 'string' ? req.query.mode.trim().toLowerCase() : '';
	const dark = rawMode === 'dark';
	const bg = dark ? '#1e1e1e' : '#f5f6fa';
	const fg = dark ? 'rgba(234,235,238,0.98)' : 'rgba(19,21,54,0.98)';
	return '<!DOCTYPE html><html><head><meta charset="utf-8">'
		+ '<meta name="viewport" content="width=device-width,initial-scale=1">'
		+ '<style>@font-face{font-family:Rubik;src:url(/fonts/rubik-300.woff2) format("woff2");font-weight:300;font-display:swap}'
		+ 'html,body{margin:0;height:100%;box-sizing:border-box}'
		+ 'body{font-family:Rubik,system-ui,sans-serif;font-weight:300;font-size:1.125rem;'
		+ 'background:' + bg + ';color:' + fg + ';display:flex;align-items:center;justify-content:center;text-align:center;padding:1rem}'
		+ '</style></head><body>' + (message || '') + '</body></html>';
}

function sendStyledError(res, req, status, message) {
	return res.status(status).type('text/html').send(styledErrorPage(message || '', req));
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

function sendImmutableSvg(res, filePath) {
	if (!filePath || !fs.existsSync(filePath)) {
		res.status(404).send('Not found');
		return;
	}
	res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
	res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
	res.sendFile(filePath);
}

function normalizeWidgets(page, ctx = {}) {
	// Support both OH 1.x 'widget' and OH 3.x+ 'widgets'
	let w = page?.widgets || page?.widget;
	if (!w) return [];
	if (!Array.isArray(w)) {
		if (w && Array.isArray(w.item)) w = w.item;
		else w = [w];
	}

	const out = [];
	const sitemapName = safeText(ctx?.sitemapName || '').trim();
	const basePath = Array.isArray(ctx?.path) ? ctx.path.slice() : null;
	const walk = (list, sectionPath = []) => {
		for (const item of list) {
			if (item?.type === 'Frame') {
				const label = safeText(item?.label || item?.item?.label || item?.item?.name || '');
				const icon = frameSectionIcon(item);
				const nextSectionPath = label ? sectionPath.concat([label]) : sectionPath.slice();
				out.push({
					__section: true,
					label,
					icon,
					staticIcon: !!item?.staticIcon,
					__sectionPath: nextSectionPath.slice(),
					__sitemapName: sitemapName,
				});
				// Support both 'widget' (OH 1.x) and 'widgets' (OH 3.x+)
				let kids = item.widgets || item.widget;
				if (kids) {
					if (!Array.isArray(kids)) {
						if (Array.isArray(kids.item)) kids = kids.item;
						else kids = [kids];
					}
					walk(kids, nextSectionPath);
				}
				continue;
			}
			if (basePath) item.__path = basePath.slice();
			if (sectionPath.length) {
				item.__sectionPath = sectionPath.slice();
				item.__frame = sectionPath[sectionPath.length - 1];
			}
			if (sitemapName) item.__sitemapName = sitemapName;
			out.push(item);
		}
	};

	walk(w, []);
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

function frameSectionIcon(widget) {
	const rawIcon = safeText(widgetIconName(widget)).trim();
	if (!rawIcon) return '';
	// openHAB can expose "frame" as the default category for Frame widgets.
	// Treat that implicit default as "no icon" unless staticIcon is explicitly set.
	if (rawIcon.toLowerCase() === 'frame' && !widget?.staticIcon) return '';
	return rawIcon;
}

function widgetLabel(widget) {
	if (widget?.label) return safeText(widget.label);
	if (widget?.item?.label) return safeText(widget.item.label);
	return safeText(widget?.item?.name || widget?.name || '');
}



function labelPathSegments(label) {
	const parts = splitLabelState(label);
	const segs = [];
	if (parts.title && parts.title !== '-') segs.push(parts.title);
	if (parts.state && parts.state !== '-') segs.push(parts.state);
	return segs;
}

function normalizeSearchWidgets(page, ctx) {
	// Support both OH 1.x 'widget' and OH 3.x+ 'widgets' formats
	let w = page?.widgets || page?.widget;
	if (!w) return [];

	if (!Array.isArray(w)) {
		if (w && Array.isArray(w.item)) w = w.item;
		else w = [w];
	}

	const out = [];
	const path = Array.isArray(ctx?.path) ? ctx.path : null;
	const sitemapName = safeText(ctx?.sitemapName || '').trim();
	const walk = (list, frameLabel, sectionPath = []) => {
		for (const item of list) {
			if (item?.type === 'Frame') {
				const label = sectionLabel(item);
				const icon = frameSectionIcon(item);
				const nextSectionPath = label ? sectionPath.concat([label]) : sectionPath.slice();
				if (label) {
					out.push({
						__section: true,
						label,
						icon,
						staticIcon: !!item?.staticIcon,
						__sectionPath: nextSectionPath.slice(),
						__sitemapName: sitemapName,
					});
				}
				// Support both 'widget' (OH 1.x) and 'widgets' (OH 3.x+)
				let kids = item.widgets || item.widget;
				if (kids) {
					if (!Array.isArray(kids)) {
						if (Array.isArray(kids.item)) kids = kids.item;
						else kids = [kids];
					}
					walk(kids, label || frameLabel, nextSectionPath);
				}
				continue;
			}
			if (path) item.__path = path.slice();
			if (sectionPath.length) item.__sectionPath = sectionPath.slice();
			if (frameLabel) item.__frame = frameLabel;
			if (sitemapName) item.__sitemapName = sitemapName;
			out.push(item);
		}
	};

	walk(w, '', []);
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

function decodeSitemapName(name) {
	const raw = safeText(name).trim();
	if (!raw) return '';
	try {
		return decodeURIComponent(raw).trim();
	} catch {
		return raw;
	}
}

function sitemapNameFromRestSitemapPath(pathname) {
	const raw = safeText(pathname).trim();
	if (!raw) return '';
	const withoutQuery = raw.split('?')[0].replace(/\/+$/, '');
	const parts = withoutQuery.split('/').filter(Boolean);
	const idx = parts.indexOf('sitemaps');
	if (idx === -1 || idx + 1 >= parts.length) return '';
	return decodeSitemapName(parts[idx + 1]);
}

function normalizeSitemapEntry(entry, updatedAt = Date.now()) {
	if (!entry || typeof entry !== 'object') return null;
	let name = safeText(entry?.name || entry?.id).trim();
	if (!name) {
		const homepage = safeText(entry?.homepage?.link || entry?.link || '').trim();
		if (homepage) {
			const withoutQuery = homepage.split('?')[0].replace(/\/+$/, '');
			const parts = withoutQuery.split('/');
			name = decodeSitemapName(parts[parts.length - 1] || '');
		}
	}
	if (!name) return null;
	const title = safeText(entry?.label || entry?.title || name);
	const homepage = safeText(entry?.homepage?.link || entry?.link || '');
	return {
		name,
		title,
		homepage,
		updatedAt,
		ok: true,
	};
}

function sitemapCatalogSignature(sitemaps) {
	if (!Array.isArray(sitemaps) || !sitemaps.length) return '';
	return sitemaps.map((entry) => safeText(entry?.name).trim()).filter(Boolean).join('|');
}

function getBackgroundSitemaps() {
	if (!Array.isArray(backgroundState.sitemaps) || !backgroundState.sitemaps.length) return [];
	return backgroundState.sitemaps.filter((entry) => !!safeText(entry?.name).trim());
}

function getRequestUserRole(req) {
	return safeText(req?.ohProxyUserData?.role || '').trim().toLowerCase();
}

function isVisibilityAllowedForRole(visibility, userRole) {
	const vis = safeText(visibility || '').trim().toLowerCase() || 'all';
	const role = safeText(userRole || '').trim().toLowerCase();
	if (vis === 'all') return true;
	if (vis === 'admin') return role === 'admin';
	if (vis === 'normal') return role === 'normal' || role === 'readonly';
	return true;
}

function buildSitemapVisibilityMap() {
	const rules = sessions.getAllSitemapVisibilityRules();
	return new Map(rules.map((entry) => [safeText(entry?.sitemapName).trim(), entry?.visibility]));
}

function sitemapVisibilityForName(sitemapName, sitemapVisibilityMap = null) {
	const name = safeText(sitemapName).trim();
	if (!name) return 'all';
	const map = sitemapVisibilityMap || buildSitemapVisibilityMap();
	return safeText(map.get(name) || 'all').trim().toLowerCase() || 'all';
}

function isSitemapVisibleForRole(sitemapName, userRole, sitemapVisibilityMap = null) {
	const name = safeText(sitemapName).trim();
	if (!name) return false;
	const visibility = sitemapVisibilityForName(name, sitemapVisibilityMap);
	return isVisibilityAllowedForRole(visibility, userRole);
}

function filterSitemapEntriesForRole(entries, userRole, sitemapVisibilityMap = null) {
	if (!Array.isArray(entries) || !entries.length) return [];
	const map = sitemapVisibilityMap || buildSitemapVisibilityMap();
	return entries.filter((entry) => {
		const name = safeText(entry?.name).trim();
		if (!name) return false;
		return isSitemapVisibleForRole(name, userRole, map);
	});
}

function filterSitemapPayloadForRole(payload, userRole, sitemapVisibilityMap = null) {
	const map = sitemapVisibilityMap || buildSitemapVisibilityMap();
	const canSee = (entry) => {
		const normalized = normalizeSitemapEntry(entry, 0);
		if (!normalized?.name) return false;
		return isSitemapVisibleForRole(normalized.name, userRole, map);
	};
	const filterList = (list) => (Array.isArray(list) ? list.filter(canSee) : []);

	if (Array.isArray(payload)) {
		return filterList(payload);
	}
	if (!payload || typeof payload !== 'object') {
		return { sitemaps: [] };
	}
	if (Array.isArray(payload.sitemaps)) {
		return { ...payload, sitemaps: filterList(payload.sitemaps) };
	}
	if (Array.isArray(payload.sitemaps?.sitemap)) {
		return {
			...payload,
			sitemaps: {
				...payload.sitemaps,
				sitemap: filterList(payload.sitemaps.sitemap),
			},
		};
	}
	if (Array.isArray(payload.sitemap)) {
		return { ...payload, sitemap: filterList(payload.sitemap) };
	}
	if (payload.sitemap && typeof payload.sitemap === 'object') {
		return canSee(payload.sitemap) ? payload : { ...payload, sitemap: null };
	}
	if (payload.sitemaps && typeof payload.sitemaps === 'object') {
		return canSee(payload.sitemaps) ? payload : { ...payload, sitemaps: null };
	}
	return { ...payload, sitemaps: [] };
}

function getVisibleBackgroundSitemapsForRequest(req, sitemapVisibilityMap = null) {
	const userRole = getRequestUserRole(req);
	return filterSitemapEntriesForRole(getBackgroundSitemaps(), userRole, sitemapVisibilityMap);
}

function getPrimaryBackgroundSitemap() {
	const sitemaps = getBackgroundSitemaps();
	return sitemaps[0] || null;
}

function resolveRequestSitemapName(req) {
	const sitemaps = getVisibleBackgroundSitemapsForRequest(req);
	if (!sitemaps.length) return '';

	const selected = safeText(req?.ohProxySession?.settings?.selectedSitemap).trim();
	if (selected) {
		const found = sitemaps.find((entry) => entry?.name === selected);
		if (found) return found.name;
	}
	return safeText(sitemaps[0]?.name).trim();
}

function buildVisibilityMap() {
	const visibilityRules = sessions.getAllVisibilityRules();
	return new Map(visibilityRules.map((entry) => [entry.widgetId, entry.visibility]));
}


function isWidgetVisibleForRole(widget, userRole, visibilityMap) {
	if (widget?.__section) return true;
	const wKey = widgetKey(widget);
	const vis = visibilityMap.get(wKey) || 'all';
	return isVisibilityAllowedForRole(vis, userRole);
}

function mappingsSignatureFromNormalized(normalized) {
	if (!Array.isArray(normalized) || !normalized.length) return '';
	return normalized.map((m) => `${m.command}:${m.releaseCommand || ''}:${m.label}:${m.icon || ''}`).join('|');
}

function mappingsSignature(mapping) {
	return mappingsSignatureFromNormalized(normalizeMapping(mapping));
}

function isButtongridButtonVisible(button) {
	if (button?.visibility === false || button?.visibility === 0) return false;
	const raw = safeText(button?.visibility).trim().toLowerCase();
	if (raw === 'false' || raw === '0') return false;
	return true;
}

function buttonsSignature(buttons) {
	if (!buttons || !buttons.length) return '';
	return buttons.map((b) =>
		`${b.row}:${b.column}:${b.command}:${b.releaseCommand}:${b.label}:${b.icon}:${b.itemName}:${b.state || ''}:${b.stateless}:${safeText(b?.source || '')}:${safeText(b?.labelcolor || '')}:${safeText(b?.iconcolor || '')}:${isButtongridButtonVisible(b) ? '1' : '0'}`
	).join('|');
}

function roundPresenceCoord(value) {
	return Math.round(Number(value) * 10000000) / 10000000;
}

function presenceMarkerTooltip(timestamp) {
	if (!timestamp) return '';
	const d = new Date(timestamp);
	const date = formatDT(d, liveConfig.clientConfig?.dateFormat || 'MMM Do, YYYY');
	const time = formatDT(d, liveConfig.clientConfig?.timeFormat || 'H:mm:ss');
	return '<div class="tt-date">' + date + '</div><div class="tt-time">' + time + '</div>';
}

function buildPresenceMarkersFromRows(rows) {
	const markers = [];
	const seen = new Set();
	let first = true;
	for (const row of rows || []) {
		const lat = roundPresenceCoord(row.lat);
		const lon = roundPresenceCoord(row.lon);
		const key = lat + ',' + lon;
		if (seen.has(key)) continue;
		seen.add(key);
		markers.push([lat, lon, first ? 'red' : 'blue', presenceMarkerTooltip(row.timestamp)]);
		first = false;
	}
	markers.reverse();
	return markers;
}

function widgetSnapshot(widget) {
	// Support both OH 1.x 'mapping' and OH 3.x+ 'mappings'
	const type = safeText(widget?.type || '').toLowerCase();
	const isButtongrid = type === 'buttongrid';
	const widgetMapping = isButtongrid ? null : (widget?.mappings || widget?.mapping);
	const normalizedMapping = isButtongrid ? [] : normalizeMapping(widgetMapping);
	const mappingSig = mappingsSignatureFromNormalized(normalizedMapping);
	const buttons = type === 'buttongrid' ? normalizeButtongridButtons(widget, (name) => name ? itemStates.get(name) : '') : [];
	const btnSig = buttonsSignature(buttons);
	return {
		key: deltaKey(widget),
		id: safeText(widget?.widgetId || widget?.id || ''),
		itemName: safeText(widget?.item?.name || widget?.itemName || ''),
		label: safeText(isButtongrid ? (splitLabelState(widget?.label || '').title === safeText(widget?.item?.name || '') ? '' : (widget?.label || '')) : (widget?.label || widget?.item?.label || widget?.item?.name || '')),
		state: safeText(widget?.item?.state ?? widget?.state ?? ''),
		icon: widgetIconName(widget),
		staticIcon: !!widget?.staticIcon,
		mappings: mappingSig,
		mapping: normalizedMapping,
		buttons: buttons,
		buttonsSig: btnSig,
		labelcolor: safeText(widget?.labelcolor || ''),
		valuecolor: safeText(widget?.valuecolor || ''),
		iconcolor: safeText(widget?.iconcolor || ''),
	};
}

function normalizeIconName(icon) {
	const raw = safeText(icon).replace(/\\/g, '/').trim();
	if (!raw) return '';
	const rel = raw.replace(/^\/+/, '');
	if (!rel) return '';
	const segments = rel.split('/');
	if (segments.some((seg) => seg === '.' || seg === '..' || seg === '')) return '';
	return segments.join('/');
}

async function buildInlineIconDataUri(iconName) {
	const normalized = normalizeIconName(iconName);
	if (!normalized) return '';
	try {
		const buffer = await resolveIcon(normalized, undefined, 'png');
		if (Buffer.isBuffer(buffer) && buffer.length) {
			return `data:image/png;base64,${buffer.toString('base64')}`;
		}
	} catch {}
	return '';
}

async function buildHomepageInlineIcons(widgets) {
	const list = Array.isArray(widgets) ? widgets : [];
	const icons = [];
	const seen = new Set();
	for (const widget of list) {
		if (!widget || widget.__section) continue;
		const iconName = normalizeIconName(widgetIconName(widget));
		if (!iconName || seen.has(iconName)) continue;
		seen.add(iconName);
		icons.push(iconName);
		if (icons.length >= HOMEPAGE_INLINE_ICON_LIMIT) break;
	}
	if (!icons.length) return {};

	const inlineIcons = {};
	for (const iconName of icons) {
		try {
			const dataUri = await buildInlineIconDataUri(iconName);
			if (dataUri) inlineIcons[iconName] = dataUri;
		} catch (err) {
			logMessage(`[Icons] Homepage inline icon failed for ${iconName}: ${err.message || err}`);
		}
	}
	return inlineIcons;
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
			icon: e.icon,
			staticIcon: e.staticIcon,
			mappings: e.mappings,
			buttonsSig: e.buttonsSig,
			labelcolor: e.labelcolor,
			valuecolor: e.valuecolor,
			iconcolor: e.iconcolor,
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

// Reverse lookup: memberName → Set of groupNames this member belongs to
const memberToGroups = new Map();

// Forward lookup: groupName → [{name, label}] array of members
const groupToMembers = new Map();

// Backoff tiers for unchanged group member maps: 1m → 2m → 5m → 10m
const GROUP_MEMBER_BACKOFF_TIERS = [60000, 120000, 300000, 600000];
let groupMemberBackoffLevel = 0;
let groupMemberLastFingerprint = null;

function getGroupMemberFingerprint() {
	const entries = [];
	for (const [k, v] of memberToGroups) {
		entries.push(k + ':' + [...v].sort().join(','));
	}
	entries.sort();
	return entries.join('|');
}

async function refreshGroupMemberMap() {
	if (!liveConfig.groupItems || !liveConfig.groupItems.length) {
		memberToGroups.clear();
		groupToMembers.clear();
		return;
	}
	const newReverseMap = new Map();
	const newForwardMap = new Map();
	for (const groupName of liveConfig.groupItems) {
		try {
			const body = await fetchOpenhab(`/rest/items/${encodeURIComponent(groupName)}`);
			if (!body.ok) continue;
			const data = JSON.parse(body.body);
			if (!data || !Array.isArray(data.members)) continue;
			const members = [];
			for (const m of data.members) {
				if (!m || !m.name) continue;
				if (!newReverseMap.has(m.name)) newReverseMap.set(m.name, new Set());
				newReverseMap.get(m.name).add(groupName);
				members.push({ name: m.name, label: safeText(m.label || m.name) });
			}
			newForwardMap.set(groupName, members);
		} catch {
			// Skip this group on error; map stays partial, no regression
		}
	}
	memberToGroups.clear();
	for (const [k, v] of newReverseMap) memberToGroups.set(k, v);
	groupToMembers.clear();
	for (const [k, v] of newForwardMap) groupToMembers.set(k, v);
	const fingerprint = getGroupMemberFingerprint();
	if (groupMemberLastFingerprint !== null && fingerprint === groupMemberLastFingerprint) {
		groupMemberBackoffLevel = Math.min(groupMemberBackoffLevel + 1, GROUP_MEMBER_BACKOFF_TIERS.length - 1);
	} else {
		groupMemberBackoffLevel = 0;
		groupMemberLastFingerprint = fingerprint;
		groupItemCalculatedStates.clear();
	}
	const nextInterval = GROUP_MEMBER_BACKOFF_TIERS[groupMemberBackoffLevel];
	updateBackgroundTaskInterval('group-member-map', nextInterval);
	logMessage(`[GroupState] Member map refreshed: ${memberToGroups.size} members across ${liveConfig.groupItems.length} groups (next in ${formatInterval(nextInterval)})`);
}

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
				// Use cached value; only fetch if cache is empty (e.g. first render after startup)
				let calculatedState = groupItemCalculatedStates.get(itemName);
				if (calculatedState === undefined) {
					calculatedState = await calculateGroupState(itemName);
					if (calculatedState !== null) {
						groupItemCalculatedStates.set(itemName, calculatedState);
					}
				}
				if (calculatedState !== null && calculatedState !== undefined) {
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

	// Support both OH 1.x 'widget' and OH 3.x+ 'widgets'
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
			prev.icon !== current.icon ||
			prev.staticIcon !== current.staticIcon ||
			prev.mappings !== current.mappings ||
			prev.buttonsSig !== current.buttonsSig ||
			prev.labelcolor !== current.labelcolor ||
			prev.valuecolor !== current.valuecolor ||
			prev.iconcolor !== current.iconcolor
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

function fetchBinaryFromUrl(targetUrl, headers, redirectsLeft = 3, agent, validateRedirect) {
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
		const opts = {
			method: 'GET',
			hostname: url.hostname,
			port: url.port || (isHttps ? 443 : 80),
			path: `${url.pathname}${url.search}`,
			headers: requestHeaders,
		};
		if (agent) opts.agent = agent;
		opts.timeout = 30000;
		const req = client.request(opts, (res) => {
			const status = res.statusCode || 500;
			const location = res.headers.location;
			if (location && redirectsLeft > 0 && REDIRECT_STATUS.has(status)) {
				res.resume();
				const nextUrl = new URL(location, url);
				if (typeof validateRedirect === 'function' && !validateRedirect(nextUrl)) {
					reject(new Error('Redirect target not allowed'));
					return;
				}
				resolve(fetchBinaryFromUrl(nextUrl.toString(), headers, redirectsLeft - 1, agent, validateRedirect));
				return;
			}

			const chunks = [];
			res.on('error', reject);
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

		req.on('timeout', () => {
			req.destroy(new Error('Proxy fetch timed out'));
		});
		req.on('error', reject);
		req.end();
	});
}

function fetchErrorBodyIfHttpError(targetUrl, headers, redirectsLeft = 3, agent, validateRedirect) {
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
		const opts = {
			method: 'GET',
			hostname: url.hostname,
			port: url.port || (isHttps ? 443 : 80),
			path: `${url.pathname}${url.search}`,
			headers: requestHeaders,
		};
		if (agent) opts.agent = agent;
		opts.timeout = 30000;

		const req = client.request(opts, (res) => {
			const status = res.statusCode || 500;
			const location = res.headers.location;
			if (location && redirectsLeft > 0 && REDIRECT_STATUS.has(status)) {
				res.resume();
				const nextUrl = new URL(location, url);
				if (typeof validateRedirect === 'function' && !validateRedirect(nextUrl)) {
					reject(new Error('Redirect target not allowed'));
					return;
				}
				resolve(fetchErrorBodyIfHttpError(nextUrl.toString(), headers, redirectsLeft - 1, agent, validateRedirect));
				return;
			}

			const contentType = safeText(res.headers['content-type']);
			if (status < 400) {
				res.resume();
				resolve({
					status,
					ok: true,
					contentType,
					url: url.toString(),
				});
				return;
			}

			const chunks = [];
			res.on('error', reject);
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
					ok: false,
					body,
					contentType,
					contentEncoding: encoding,
					url: url.toString(),
				});
			});
		});

		req.on('timeout', () => {
			req.destroy(new Error('Proxy fetch timed out'));
		});
		req.on('error', reject);
		req.end();
	});
}

function pipeStreamingProxy(targetUrl, expressRes, headers = {}, agent) {
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

		const opts = {
			method: 'GET',
			hostname: url.hostname,
			port: url.port || (isHttps ? 443 : 80),
			path: `${url.pathname}${url.search}`,
			headers: requestHeaders,
		};
		if (agent) opts.agent = agent;
		const req = client.request(opts, (upstreamRes) => {
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

let cachedOpenhabClient = null;
let cachedOpenhabClientKey = '';

function getOpenhabClient() {
	const clientKey = [
		safeText(liveConfig.ohTarget),
		safeText(liveConfig.ohUser),
		safeText(liveConfig.ohPass),
		safeText(liveConfig.ohApiToken),
		safeText(liveConfig.userAgent),
		String(configNumber(liveConfig.ohTimeoutMs, 0)),
	].join('\n');
	if (!cachedOpenhabClient || cachedOpenhabClientKey !== clientKey) {
		cachedOpenhabClient = buildOpenhabClient({
			target: liveConfig.ohTarget,
			user: liveConfig.ohUser,
			pass: liveConfig.ohPass,
			apiToken: liveConfig.ohApiToken,
			userAgent: liveConfig.userAgent,
			timeoutMs: liveConfig.ohTimeoutMs,
			agent: () => getOhAgent(),
		});
		cachedOpenhabClientKey = clientKey;
	}
	return cachedOpenhabClient;
}

function fetchOpenhab(pathname) {
	const client = getOpenhabClient();
	return client.get(pathname, { timeoutMs: liveConfig.ohTimeoutMs, timeoutLabel: 'openHAB request' });
}

function sendItemCommand(itemName, command, { timeoutMs = 0, timeoutLabel = 'request' } = {}) {
	const client = getOpenhabClient();
	return client.post(`/rest/items/${encodeURIComponent(itemName)}`, String(command), {
		timeoutMs,
		timeoutLabel,
		headers: {
			'Content-Type': 'text/plain',
			'Accept': 'application/json',
		},
	});
}

function sendOpenhabCommand(itemName, command) {
	return sendItemCommand(itemName, command, { timeoutMs: liveConfig.ohTimeoutMs, timeoutLabel: 'openHAB command' });
}

function sendCmdApiCommand(itemName, command) {
	return sendItemCommand(itemName, command, { timeoutMs: CMDAPI_TIMEOUT_MS, timeoutLabel: 'CMD API request' });
}

function callAnthropicApi(requestBody) {
	return new Promise((resolve, reject) => {
		if (!liveConfig.anthropicApiKey) {
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
				'x-api-key': liveConfig.anthropicApiKey,
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
					const err = new Error(`Anthropic API error ${res.statusCode}`);
					err.statusCode = res.statusCode;
					try { err.apiBody = JSON.parse(data); } catch {}
					reject(err);
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

function getVoiceErrorMessage(err) {
	if (!err) return 'Voice command processing failed. Please try again.';
	const msg = err.message || '';
	const code = err.statusCode;
	const bodyMsg = err.apiBody?.error?.message || '';

	// Network failures
	if (['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'].some(c => msg.includes(c))) {
		return 'Unable to reach the AI service. Please check the network connection.';
	}
	// Timeout
	if (msg.includes('timeout') || msg.includes('Timeout')) {
		return 'The AI service took too long to respond. Please try again.';
	}
	// Invalid JSON from Anthropic
	if (msg.includes('Invalid JSON response')) {
		return 'The AI service returned an unreadable response. Please try again.';
	}
	// HTTP status codes
	if (code === 400 && (bodyMsg.toLowerCase().includes('credit balance') || msg.toLowerCase().includes('credit balance'))) {
		return 'The AI service has run out of credits. Please top up the account.';
	}
	if (code === 401) return 'The AI service API key is invalid. Please check the configuration.';
	if (code === 403) return 'The AI service denied access. Please check the API key permissions.';
	if (code === 429) return 'The AI service is busy. Please wait a moment and try again.';
	if (code === 500) return 'The AI service is experiencing an internal error. Please try again later.';
	if (code === 529) return 'The AI service is currently overloaded. Please try again later.';
	if (code && code >= 400) return 'The AI service returned an unexpected error. Please try again.';

	return 'Voice command processing failed. Please try again.';
}

const STRUCTURE_MAP_TYPES = ['all', 'writable', 'readable'];
const aiStructureMapCache = new Map();
const structureMapOnDemandCooldownUntil = new Map();
const structureMapOnDemandInflight = new Map();

function structureMapSitemapToken(sitemapName) {
	const normalized = safeText(sitemapName).trim();
	if (!normalized) return '';
	return encodeURIComponent(normalized);
}

function structureMapPathForSitemap(sitemapName, type = 'writable') {
	const normalizedType = safeText(type).trim().toLowerCase();
	if (!STRUCTURE_MAP_TYPES.includes(normalizedType)) return '';
	const token = structureMapSitemapToken(sitemapName);
	if (!token) return '';
	return path.join(AI_CACHE_DIR, `structuremap-${token}-${normalizedType}.json`);
}

function clearAiStructureMapCache(filePath = '') {
	const normalizedPath = safeText(filePath).trim();
	if (normalizedPath) {
		aiStructureMapCache.delete(normalizedPath);
		return;
	}
	aiStructureMapCache.clear();
}

function readAiStructureMapFile(filePath) {
	const normalizedPath = safeText(filePath).trim();
	if (!normalizedPath) return null;
	try {
		if (!fs.existsSync(normalizedPath)) return null;
		const stat = fs.statSync(normalizedPath);
		const cached = aiStructureMapCache.get(normalizedPath);
		if (cached && cached.mtimeMs === stat.mtimeMs) {
			return cached.data;
		}
		const data = JSON.parse(fs.readFileSync(normalizedPath, 'utf8'));
		aiStructureMapCache.set(normalizedPath, { mtimeMs: stat.mtimeMs, data });
		return data;
	} catch {
		return null;
	}
}

function getAiStructureMap(sitemapName = '') {
	const normalizedName = safeText(sitemapName).trim();
	if (!normalizedName) return null;
	const scopedPath = structureMapPathForSitemap(normalizedName, 'writable');
	return readAiStructureMapFile(scopedPath);
}

function writeStructureMapCacheFile(filePath, type, sitemapName, result, generatedAt) {
	const normalizedType = safeText(type).trim().toLowerCase();
	const payload = result?.[normalizedType];
	if (!payload) {
		throw new Error(`Missing structure map payload for type "${normalizedType}"`);
	}
	fs.writeFileSync(filePath, JSON.stringify({
		generatedAt,
		sitemap: sitemapName,
		type: normalizedType,
		itemCount: payload.itemCount,
		request: payload.request,
	}, null, 2));
	clearAiStructureMapCache(filePath);
}

function writeStructureMapResultFiles(result, generatedAt) {
	const sitemapName = safeText(result?.sitemapName).trim();
	if (!sitemapName) throw new Error('Structure map generation returned an empty sitemap name');
	ensureDir(AI_CACHE_DIR);
	for (const type of STRUCTURE_MAP_TYPES) {
		const scopedPath = structureMapPathForSitemap(sitemapName, type);
		if (!scopedPath) continue;
		writeStructureMapCacheFile(scopedPath, type, sitemapName, result, generatedAt);
	}
}

function getStructureMapOnDemandCooldownMs(sitemapName) {
	const normalizedName = safeText(sitemapName).trim();
	if (!normalizedName) return 0;
	const cooldownUntil = structureMapOnDemandCooldownUntil.get(normalizedName);
	if (!cooldownUntil) return 0;
	const remaining = cooldownUntil - Date.now();
	if (remaining <= 0) {
		structureMapOnDemandCooldownUntil.delete(normalizedName);
		return 0;
	}
	return remaining;
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
	let timer = null;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

async function fetchStructureMapSitemapNames() {
	const res = await fetchOpenhab('/rest/sitemaps?type=json');
	if (!res?.ok) throw new Error('Failed to fetch sitemap list');
	let data;
	try {
		data = JSON.parse(res.body);
	} catch {
		throw new Error('Failed to parse sitemap list response');
	}
	const sitemaps = extractSitemaps(data);
	const now = Date.now();
	const names = [];
	const seen = new Set();
	for (const entry of sitemaps) {
		const normalized = normalizeSitemapEntry(entry, now);
		if (!normalized) continue;
		if (seen.has(normalized.name)) continue;
		seen.add(normalized.name);
		names.push(normalized.name);
	}
	if (!names.length) throw new Error('No sitemaps found');
	return names;
}

async function fetchStructureMapSitemapFull(name) {
	const sitemapName = safeText(name).trim();
	if (!sitemapName) throw new Error('Missing sitemap name');
	const encoded = encodeURIComponent(sitemapName);
	const res = await fetchOpenhab(`/rest/sitemaps/${encoded}?type=json&includeHidden=true`);
	if (!res?.ok) throw new Error(`Failed to fetch sitemap ${sitemapName}`);
	try {
		return JSON.parse(res.body);
	} catch {
		throw new Error(`Failed to parse sitemap ${sitemapName}`);
	}
}

async function generateStructureMapForSitemap(sitemapName, sitemapNames = null) {
	const targetSitemap = safeText(sitemapName).trim();
	if (!targetSitemap) throw new Error('Missing sitemap name');
	const names = Array.isArray(sitemapNames) && sitemapNames.length
		? sitemapNames
		: await fetchStructureMapSitemapNames();
	return generateStructureMap(
		async () => names.map((name) => ({ name })),
		(name) => fetchStructureMapSitemapFull(name),
		{ sitemapName: targetSitemap, model: liveConfig.aiModel }
	);
}

async function getOrGenerateAiStructureMapForSitemap(sitemapName) {
	const targetSitemap = safeText(sitemapName).trim();
	if (!targetSitemap) {
		return { map: null, generated: false, cooldownMs: 0, error: new Error('Sitemap not resolved') };
	}

	const existing = getAiStructureMap(targetSitemap);
	if (existing) return { map: existing, generated: false, cooldownMs: 0 };

	const cooldownMs = getStructureMapOnDemandCooldownMs(targetSitemap);
	if (cooldownMs > 0) {
		return { map: null, generated: false, cooldownMs, error: new Error('Structure map generation cooldown active') };
	}

	let inflight = structureMapOnDemandInflight.get(targetSitemap);
	if (!inflight) {
		inflight = (async () => {
			try {
				const generatedAt = new Date().toISOString();
				const result = await withTimeout(
					(async () => {
						const sitemapNames = await fetchStructureMapSitemapNames();
						return generateStructureMapForSitemap(targetSitemap, sitemapNames);
					})(),
					STRUCTURE_MAP_ON_DEMAND_TIMEOUT_MS,
					`Timed out generating structure map for sitemap "${targetSitemap}"`
				);
				writeStructureMapResultFiles(result, generatedAt);
				structureMapOnDemandCooldownUntil.delete(targetSitemap);
				logMessage(`[StructureMap] On-demand generated sitemap "${targetSitemap}" (${result.stats.total} items)`);
				return { ok: true };
			} catch (err) {
				structureMapOnDemandCooldownUntil.set(
					targetSitemap,
					Date.now() + STRUCTURE_MAP_ON_DEMAND_FAILURE_COOLDOWN_MS
				);
				logMessage(
					`[StructureMap] On-demand generation failed for sitemap "${targetSitemap}": ${err.message || err} ` +
					`(cooldown ${formatInterval(STRUCTURE_MAP_ON_DEMAND_FAILURE_COOLDOWN_MS)})`
				);
				return { ok: false, error: err };
			} finally {
				structureMapOnDemandInflight.delete(targetSitemap);
			}
		})();
		structureMapOnDemandInflight.set(targetSitemap, inflight);
	}

	const generationResult = await inflight;
	const refreshed = getAiStructureMap(targetSitemap);
	if (refreshed) {
		return { map: refreshed, generated: generationResult.ok === true, cooldownMs: 0 };
	}
	return {
		map: null,
		generated: false,
		cooldownMs: getStructureMapOnDemandCooldownMs(targetSitemap),
		error: generationResult.error || new Error('Failed to load generated structure map'),
	};
}

async function refreshStructureMapCache() {
	const sitemapNames = await fetchStructureMapSitemapNames();
	const generatedAt = new Date().toISOString();
	let generatedCount = 0;
	let failedCount = 0;
	let totalItems = 0;
	let totalWritable = 0;
	let totalReadable = 0;

	for (const sitemapName of sitemapNames) {
		try {
			const result = await generateStructureMapForSitemap(sitemapName, sitemapNames);
			writeStructureMapResultFiles(result, generatedAt);
			generatedCount += 1;
			totalItems += result.stats.total;
			totalWritable += result.stats.writable;
			totalReadable += result.stats.readable;
		} catch (err) {
			failedCount += 1;
			logMessage(`[StructureMap] Failed for sitemap "${sitemapName}": ${err.message || err}`);
		}
	}

	clearAiStructureMapCache();

	if (generatedCount === 0) {
		throw new Error('Failed to generate structure maps for all sitemaps');
	}

	logMessage(
		`[StructureMap] Generated ${generatedCount}/${sitemapNames.length} sitemap map(s): ` +
		`${totalItems} items (${totalWritable} writable, ${totalReadable} readable)` +
		(failedCount ? `, ${failedCount} failed` : '')
	);
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
	if (!Array.isArray(sitemaps) || !sitemaps.length) return false;

	const oldSignature = sitemapCatalogSignature(getBackgroundSitemaps());
	const now = Date.now();
	const nextCatalog = [];
	const seenNames = new Set();
	for (const entry of sitemaps) {
		const normalized = normalizeSitemapEntry(entry, now);
		if (!normalized) continue;
		if (seenNames.has(normalized.name)) continue;
		seenNames.add(normalized.name);
		nextCatalog.push(normalized);
	}
	if (!nextCatalog.length) return false;

	backgroundState.sitemaps = nextCatalog;

	if (!options.skipAtmosphereResubscribe) {
		const newSignature = sitemapCatalogSignature(nextCatalog);
		const catalogChanged = !!oldSignature && !!newSignature && oldSignature !== newSignature;
		if (liveConfig.wsMode === 'atmosphere' && wss.clients.size > 0) {
			if (atmosphereNeedsSitemapRefresh || catalogChanged) {
				const reason = catalogChanged ? 'sitemap catalog changed' : 'sitemap cache refreshed';
				atmosphereNeedsSitemapRefresh = false;
				scheduleAtmosphereResubscribe(reason);
			}
		} else {
			atmosphereNeedsSitemapRefresh = false;
		}
	}

	// Trigger initial video preview bootstrap on first successful sitemap pull:
	// generate missing previews immediately (independent of schedule), then let
	// normal task scheduling continue as configured.
	if (!videoPreviewInitialCaptureDone && liveConfig.videoPreviewIntervalMs > 0) {
		videoPreviewInitialCaptureDone = true;
		captureVideoPreviewsTask({ onlyMissing: true, reason: 'startup-bootstrap' }).catch((err) => {
			logMessage(`Initial video preview bootstrap failed: ${err.message || err}`);
		});
	}

	return true;
}

function fetchOpenhabBinary(pathname, options = {}) {
	const baseUrl = options.baseUrl || liveConfig.ohTarget;
	const headers = { Accept: 'image/*,*/*;q=0.8', 'User-Agent': liveConfig.userAgent };
	const ah = authHeader();
	if (ah) headers.Authorization = ah;
	return fetchBinaryFromUrl(buildTargetUrl(baseUrl, pathname), headers, 3, getOhAgent());
}

function iconStateHash(state) {
	return crypto.createHash('sha256').update(state).digest('hex').slice(0, 12);
}

async function resizeToPng(buffer) {
	const iconSize = configNumber(liveConfig.iconSize, ICON_SIZE);
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-icon-'));
	const srcPath = path.join(tmpDir, 'src.img');
	const dstPath = path.join(tmpDir, 'dst.png');
	try {
		fs.writeFileSync(srcPath, buffer);
		await enqueueIconConvert(() => execFileAsync(liveConfig.binConvert, [
			srcPath,
			'-resize', `${iconSize}x${iconSize}`,
			'-background', 'none',
			'-gravity', 'center',
			'-extent', `${iconSize}x${iconSize}`,
			`PNG32:${dstPath}`,
		]));
		return fs.readFileSync(dstPath);
	} finally {
		try {
			if (fs.rmSync) fs.rmSync(tmpDir, { recursive: true, force: true });
			else fs.rmdirSync(tmpDir, { recursive: true });
		} catch {}
	}
}

function getIconCachePath(name, format, state) {
	const cacheDir = getIconCacheDir();
	if (state !== undefined && state !== '') {
		return path.join(cacheDir, 'dyn', `${name}_${iconStateHash(state)}.${format}`);
	}
	return path.join(cacheDir, `${name}.${format}`);
}

async function getOrBuildCachedIcon(cachePath, buildFn) {
	if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath);
	if (iconInflight.has(cachePath)) return iconInflight.get(cachePath);
	const promise = (async () => {
		const buffer = await buildFn();
		ensureDir(path.dirname(cachePath));
		fs.writeFileSync(cachePath, buffer);
		return buffer;
	})();
	iconInflight.set(cachePath, promise);
	try {
		return await promise;
	} finally {
		iconInflight.delete(cachePath);
	}
}

async function resolveIcon(name, state, format) {
	const fmt = (format === 'svg') ? 'svg' : 'png';
	const cachePath = getIconCachePath(name, fmt, state);
	return getOrBuildCachedIcon(cachePath, async () => {
		const hasDynState = state !== undefined && state !== '';
		const fetchPath = hasDynState
			? `/icon/${name}?state=${encodeURIComponent(state)}&format=${fmt}`
			: `/images/${name}.${fmt}`;
		let res = await fetchOpenhabBinary(fetchPath);
		// Static path (/images/) may 404 for icons that only exist at /icon/;
		// fall back to the dynamic endpoint without state.
		if (!hasDynState && (!res.ok || !isImageContentType(res.contentType))) {
			const fallbackPath = `/icon/${name}?format=${fmt}`;
			res = await fetchOpenhabBinary(fallbackPath);
		}
		if (!res.ok || !isImageContentType(res.contentType)) {
			const fullUrl = buildTargetUrl(liveConfig.ohTarget, fetchPath);
			const reason = !res.ok ? `status ${res.status}` : `content-type ${res.contentType || 'unknown'}`;
			logMessage(`[Icon] Not found: ${fullUrl} -> ${reason}`);
			throw new Error(`Icon not found: ${name}`);
		}
		if (fmt === 'png') return resizeToPng(res.body);
		return res.body;
	});
}

const app = express();
app.set('query parser', 'simple');
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', true);
const jsonParserSmall = express.json({ limit: '4kb', strict: true, type: 'application/json' });
const jsonParserMedium = express.json({ limit: '16kb', strict: true, type: 'application/json' });
const jsonParserLarge = express.json({ limit: '64kb', strict: true, type: 'application/json' });
const urlencodedParserSmall = express.urlencoded({ extended: false, limit: '4kb' });

function requireAdmin(req, res, next) {
	if (req.ohProxyUserData?.role !== 'admin') {
		res.status(403).json({ error: 'Admin access required' });
		return;
	}
	next();
}
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
	if (!isPlainObject(req.query)) {
		res.status(400).json({ result: 'failed', error: 'Invalid query format' });
		return;
	}
	const queryKeys = Object.keys(req.query);
	if (queryKeys.length !== 1) {
		res.status(400).json({ result: 'failed', error: 'Invalid query format - expected ?Item=state' });
		return;
	}

	const itemName = queryKeys[0];
	const rawState = req.query[itemName];
	if (typeof rawState !== 'string') {
		res.status(400).json({ result: 'failed', error: 'Invalid state value' });
		return;
	}
	const state = rawState;

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
	if (hasAnyControlChars(state)) {
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
app.post('/api/auth/login', jsonParserSmall, (req, res) => {
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

	if (!isPlainObject(req.body)) {
		res.status(400).json({ error: 'Invalid request body' });
		return;
	}
	const { username, password } = req.body;

	// Validate username format (alphanumeric, underscore, dash, 1-20 chars)
	if (!username || typeof username !== 'string' || hasAnyControlChars(username) || !/^[a-zA-Z0-9_-]{1,20}$/.test(username)) {
		res.status(400).json({ error: 'Invalid username format' });
		return;
	}

	// Validate password is a string with reasonable length
	if (!password || typeof password !== 'string' || hasAnyControlChars(password) || password.length > 200) {
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
	const sessionId = sessions.generateSessionId();
	sessions.createSession(sessionId, username, sessions.getDefaultSettings(), clientIp);
	setAuthCookie(res, username, sessionId, users[username]);
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
				return next();
			}
			// Clear invalid cookie if present
			if (getCookieValue(req, liveConfig.authCookieName)) {
				clearAuthCookie(res);
			}
		}

		// Allow login page assets (versioned) and fonts to load before authentication.
		if (
			/^\/login\.v[\w.-]+\.js$/i.test(req.path)
			|| /^\/oh-utils\.v[\w.-]+\.js$/i.test(req.path)
			|| req.path.startsWith('/fonts/')
		) {
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
				applySecurityHeaders(req, res);
				res.redirect('/');
				return;
			}
			// Set CSRF cookie for login page
			const csrfToken = generateCsrfToken();
			setCsrfCookie(res, csrfToken);
			applySecurityHeaders(req, res);
			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			res.setHeader('Cache-Control', 'no-store');
			res.send(renderLoginHtml());
			return;
		}

		// Static assets and API requests without auth - return 401
		applySecurityHeaders(req, res);
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
			sendAuthRequired(req, res);
			return;
		}
		authenticatedUser = user;
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
		sendAuthRequired(req, res);
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
	let sessionId;
	if (cookieResult && cookieResult.sessionId) {
		// Already has new format cookie with embedded sessionId
		sessionId = cookieResult.sessionId;
	} else {
		// Create new session
		sessionId = sessions.generateSessionId();
		sessions.createSession(sessionId, authenticatedUser, sessions.getDefaultSettings(), clientIp);
	}
	setAuthCookie(res, authenticatedUser, sessionId, users[authenticatedUser]);
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
	req.ohProxyUserData = user;
	next();
});
// Session middleware - runs after auth, assigns/loads session for all authorized users
app.use((req, res, next) => {
	try {
		const clientIp = req.ohProxyClientIp || null;
		const cookieResult = req._cookieResult;
		const sessionId = cookieResult ? cookieResult.sessionId : null;

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

	// Get user role, GPS tracking flag, and user preferences if authenticated
	let userRole = null;
	let trackGps = false;
	let effectiveVoiceModel = liveConfig.voiceModel;
	let mapviewRendering = 'ohproxy';
	if (req.ohProxyUserData) {
		userRole = req.ohProxyUserData.role || null;
		if (req.ohProxyUserData.trackgps) trackGps = true;
		const userVoicePreference = isValidUserVoicePreference(req.ohProxyUserData.voicePreference) ? req.ohProxyUserData.voicePreference : 'system';
		if (userVoicePreference !== 'system') {
			effectiveVoiceModel = userVoicePreference;
		}
		const userMapviewRendering = isValidUserMapviewRendering(req.ohProxyUserData.mapviewRendering)
			? req.ohProxyUserData.mapviewRendering
			: 'ohproxy';
		mapviewRendering = userMapviewRendering;
	}

	res.send(`window.__OH_CONFIG__=${JSON.stringify({
		assetVersion: liveConfig.assetVersion,
		iconVersion: liveConfig.iconVersion,
		jsLogEnabled: liveConfig.jsLogEnabled,
		client: clientConfig,
		webviewNoProxy: liveConfig.webviewNoProxy,
		widgetGlowRules: sessions.getAllGlowRules(),
		widgetVisibilityRules: sessions.getAllVisibilityRules(),
		widgetVideoConfigs: sessions.getAllVideoConfigs(),
		widgetIframeConfigs: sessions.getAllIframeConfigs(),
		widgetProxyCacheConfigs: sessions.getAllProxyCacheConfigs(),
		widgetCardWidths: sessions.getAllCardWidths(),
		userRole: userRole,
		trackGps: trackGps,
		groupItems: liveConfig.groupItems || [],
		voiceModel: effectiveVoiceModel,
		mapviewRendering: mapviewRendering,
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

app.post('/api/settings', jsonParserSmall, (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	const session = req.ohProxySession;
	if (!session) {
		res.status(400).json({ error: 'No session' });
		return;
	}
	const newSettings = req.body;
	if (!isPlainObject(newSettings)) {
		res.status(400).json({ error: 'Invalid settings' });
		return;
	}
	// Whitelist allowed settings keys
	const allowedKeys = ['slimMode', 'theme', 'fontSize', 'compactView', 'showLabels', 'darkMode', 'selectedSitemap'];
	const allowedKeySet = new Set(allowedKeys);
	const incomingKeys = Object.keys(newSettings);
	if (incomingKeys.some((key) => !allowedKeySet.has(key))) {
		res.status(400).json({ error: 'Invalid settings key' });
		return;
	}
	const sanitized = {};
	const boolKeys = new Set(['slimMode', 'compactView', 'showLabels', 'darkMode']);
	for (const key of incomingKeys) {
		const val = newSettings[key];
		if (boolKeys.has(key)) {
			if (typeof val !== 'boolean') {
				res.status(400).json({ error: `Invalid value for ${key}` });
				return;
			}
			sanitized[key] = val;
			continue;
		}
		if (key === 'theme') {
			if (typeof val !== 'string' || hasAnyControlChars(val)) {
				res.status(400).json({ error: 'Invalid theme value' });
				return;
			}
			const theme = val.trim().toLowerCase();
			if (theme !== 'light' && theme !== 'dark') {
				res.status(400).json({ error: 'Invalid theme value' });
				return;
			}
			sanitized[key] = theme;
			continue;
		}
		if (key === 'fontSize') {
			const size = parseOptionalInt(val, { min: 8, max: 32 });
			if (!Number.isFinite(size)) {
				res.status(400).json({ error: 'Invalid fontSize value' });
				return;
			}
			sanitized[key] = size;
			continue;
		}
		if (key === 'selectedSitemap') {
			if (typeof val !== 'string' || hasAnyControlChars(val)) {
				res.status(400).json({ error: 'Invalid selectedSitemap value' });
				return;
			}
			const selected = val.trim();
			if (!selected || selected.length > 120) {
				res.status(400).json({ error: 'Invalid selectedSitemap value' });
				return;
			}
			if (!isSitemapVisibleForRole(selected, getRequestUserRole(req))) {
				res.status(403).json({ error: 'Selected sitemap is not accessible' });
				return;
			}
			sanitized[key] = selected;
			continue;
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
app.post('/api/jslog', jsonParserLarge, (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache, no-store');
	// Require authentication
	const session = req.ohProxySession;
	if (!session) {
		res.status(401).json({ error: 'Unauthorized' });
		return;
	}
	// Check if JS logging is enabled
	if (!liveConfig.jsLogFile) {
		res.json({ ok: true, logged: false });
		return;
	}
	// Sanitize and validate input
	const body = req.body;
	if (!isPlainObject(body)) {
		res.status(400).json({ error: 'Invalid request body' });
		return;
	}
	if ('message' in body && typeof body.message !== 'string') {
		res.status(400).json({ error: 'Invalid message' });
		return;
	}
	if ('url' in body && typeof body.url !== 'string') {
		res.status(400).json({ error: 'Invalid url' });
		return;
	}
	if ('stack' in body && typeof body.stack !== 'string') {
		res.status(400).json({ error: 'Invalid stack' });
		return;
	}
	if ('userAgent' in body && typeof body.userAgent !== 'string') {
		res.status(400).json({ error: 'Invalid userAgent' });
		return;
	}
	if ('line' in body && typeof body.line !== 'number') {
		res.status(400).json({ error: 'Invalid line' });
		return;
	}
	if ('col' in body && typeof body.col !== 'number') {
		res.status(400).json({ error: 'Invalid col' });
		return;
	}
	const message = typeof body.message === 'string' ? stripControlChars(body.message).slice(0, 2000) : '';
	const url = typeof body.url === 'string' ? stripControlChars(body.url).slice(0, 500) : '';
	const line = typeof body.line === 'number' ? Math.floor(body.line) : 0;
	const col = typeof body.col === 'number' ? Math.floor(body.col) : 0;
	const stack = typeof body.stack === 'string' ? stripControlChars(body.stack).slice(0, 5000) : '';
	const userAgent = typeof body.userAgent === 'string' ? stripControlChars(body.userAgent).slice(0, 300) : '';
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

// GPS reporting API
app.post('/api/gps', jsonParserMedium, (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache, no-store');
	const session = req.ohProxySession;
	if (!session) {
		res.status(401).json({ error: 'Unauthorized' });
		return;
	}
	const username = req.ohProxyUser;
	if (!username) {
		res.status(401).json({ error: 'Unauthorized' });
		return;
	}
	// Reject users who don't have GPS tracking enabled
	if (!req.ohProxyUserData?.trackgps) {
		res.status(403).json({ error: 'GPS tracking not enabled' });
		return;
	}
	// Validate body
	const body = req.body;
	if (!isPlainObject(body)) {
		res.status(400).json({ error: 'Invalid request body' });
		return;
	}
	if (typeof body.lat !== 'number' || typeof body.lon !== 'number') {
		res.status(400).json({ error: 'Invalid coordinates' });
		return;
	}
	const rawLat = Number.isFinite(body.lat) ? body.lat : null;
	const rawLon = Number.isFinite(body.lon) ? body.lon : null;
	if (rawLat === null || rawLon === null || rawLat < -90 || rawLat > 90 || rawLon < -180 || rawLon > 180) {
		res.status(400).json({ error: 'Invalid coordinates' });
		return;
	}
	if ('accuracy' in body && typeof body.accuracy !== 'number') {
		res.status(400).json({ error: 'Invalid accuracy' });
		return;
	}
	if ('batt' in body && typeof body.batt !== 'number') {
		res.status(400).json({ error: 'Invalid battery value' });
		return;
	}
	const accuracy = typeof body.accuracy === 'number' && Number.isFinite(body.accuracy) && body.accuracy >= 0 && body.accuracy <= 10000
		? Math.round(body.accuracy)
		: null;
	const batt = typeof body.batt === 'number' && Number.isFinite(body.batt) && body.batt >= 0 && body.batt <= 100
		? Math.round(body.batt)
		: null;
	// Snap to home coordinates if within 150m
	const homeLat = liveConfig.gpsHomeLat;
	const homeLon = liveConfig.gpsHomeLon;
	let lat = rawLat;
	let lon = rawLon;
	let distanceHome = null;
	if (Number.isFinite(homeLat) && Number.isFinite(homeLon)) {
		const toRad = (deg) => deg * Math.PI / 180;
		const R = 6371000;
		const dLat = toRad(rawLat - homeLat);
		const dLon = toRad(rawLon - homeLon);
		const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(homeLat)) * Math.cos(toRad(rawLat)) * Math.sin(dLon / 2) ** 2;
		const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
		if (dist <= 150) {
			lat = homeLat;
			lon = homeLon;
			distanceHome = 0;
		} else {
			distanceHome = Math.round(dist / 10) / 100;
		}
	}
	logMessage(`[GPS] user=${username} lat=${lat.toFixed(7)} lon=${lon.toFixed(7)} accuracy=${accuracy}m ip=${req.ohProxyClientIp}`);
	const conn = getMysqlConnection();
	if (conn) {
		conn.query(
			'INSERT INTO log_gps (username, lat, lon, distancehome, batt) VALUES (?, ?, ?, ?, ?)',
			[username, lat, lon, distanceHome, batt],
			(err) => {
				if (err) logMessage(`[GPS] DB insert failed: ${err.message || err}`);
			}
		);
	}
	res.json({ ok: true, logged: true });
});

// Widget card config API (admin only)
app.get('/api/card-config/:widgetId', requireAdmin, (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	const rawWidgetId = req.params.widgetId;
	if (typeof rawWidgetId !== 'string') {
		res.status(400).json({ error: 'Missing widgetId' });
		return;
	}
	const widgetId = safeText(rawWidgetId);
	if (!widgetId || widgetId.length > 200 || hasAnyControlChars(widgetId)) {
		res.status(400).json({ error: 'Missing widgetId' });
		return;
	}
	const rules = sessions.getGlowRules(widgetId);
	res.json({ widgetId, rules });
});

app.post('/api/card-config', jsonParserLarge, requireAdmin, (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');

	if (!isPlainObject(req.body)) {
		res.status(400).json({ error: 'Invalid request body' });
		return;
	}

	const { widgetId, rules, visibility, defaultMuted, iframeHeight, proxyCacheSeconds, cardWidth } = req.body;
	if (!widgetId || typeof widgetId !== 'string' || widgetId.length > 200 || hasAnyControlChars(widgetId)) {
		res.status(400).json({ error: 'Missing or invalid widgetId' });
		return;
	}

	// Validate rules if provided
	if (rules !== undefined) {
		if (!Array.isArray(rules)) {
			res.status(400).json({ error: 'Rules must be an array' });
			return;
		}
		if (rules.length > 100) {
			res.status(400).json({ error: 'Too many rules' });
			return;
		}

		const validOperators = ['=', '!=', '>', '<', '>=', '<=', 'contains', '!contains', 'startsWith', 'endsWith', '*'];
		const validColors = ['green', 'orange', 'red'];
		const allowedRuleKeys = new Set(['operator', 'color', 'value']);
		for (const rule of rules) {
			if (!isPlainObject(rule)) {
				res.status(400).json({ error: 'Each rule must be an object' });
				return;
			}
			const ruleKeys = Object.keys(rule);
			if (ruleKeys.some((key) => !allowedRuleKeys.has(key))) {
				res.status(400).json({ error: 'Invalid rule key' });
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
			if (rule.value !== undefined && rule.value !== null) {
				const valueType = typeof rule.value;
				if (valueType === 'string') {
					if (rule.value.length > 200 || hasAnyControlChars(rule.value)) {
						res.status(400).json({ error: 'Invalid rule value' });
						return;
					}
				} else if (valueType === 'number') {
					if (!Number.isFinite(rule.value)) {
						res.status(400).json({ error: 'Invalid rule value' });
						return;
					}
				} else if (valueType !== 'boolean') {
					res.status(400).json({ error: 'Invalid rule value' });
					return;
				}
			}
		}
	}

	// Validate visibility if provided
	if (visibility !== undefined) {
		const validVisibilities = ['all', 'normal', 'admin'];
		if (typeof visibility !== 'string' || hasAnyControlChars(visibility) || !validVisibilities.includes(visibility)) {
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
	let heightNum = null;
	if (iframeHeight !== undefined) {
		const parsed = parseOptionalInt(iframeHeight, { min: 0, max: 10000 });
		if (parsed === null) {
			heightNum = 0;
		} else if (!Number.isFinite(parsed)) {
			res.status(400).json({ error: 'iframeHeight must be empty or a positive integer (max 10000)' });
			return;
		} else {
			heightNum = parsed;
		}
	}

	// Validate proxyCacheSeconds if provided (must be null, empty string, or positive integer 0-86400)
	let cacheNum = null;
	if (proxyCacheSeconds !== undefined) {
		const parsed = parseOptionalInt(proxyCacheSeconds, { min: 0, max: 86400 });
		if (parsed === null) {
			cacheNum = 0;
		} else if (!Number.isFinite(parsed)) {
			res.status(400).json({ error: 'proxyCacheSeconds must be empty or an integer 0-86400' });
			return;
		} else {
			cacheNum = parsed;
		}
	}

	// Validate cardWidth if provided
	if (cardWidth !== undefined) {
		const validWidths = ['standard', 'full', 'stretch'];
		if (typeof cardWidth !== 'string' || !validWidths.includes(cardWidth)) {
			res.status(400).json({ error: `Invalid cardWidth: ${cardWidth}` });
			return;
		}
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
			sessions.setIframeConfig(widgetId, heightNum);
		}
		if (proxyCacheSeconds !== undefined) {
			sessions.setProxyCacheConfig(widgetId, cacheNum);
		}
		if (cardWidth !== undefined) {
			sessions.setCardWidth(widgetId, cardWidth);
		}
		res.json({ ok: true, widgetId, rules, visibility, defaultMuted, iframeHeight, proxyCacheSeconds, cardWidth });
	} catch (err) {
		logMessage(`Failed to save card config: ${err.message || err}`, 'error');
		res.status(500).json({ error: 'Failed to save config' });
	}
});

// Sitemap visibility config API (admin only)
app.get('/api/sitemap-config/:sitemapName', requireAdmin, (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	const rawSitemapName = req.params.sitemapName;
	if (typeof rawSitemapName !== 'string') {
		res.status(400).json({ error: 'Missing sitemapName' });
		return;
	}
	const sitemapName = safeText(rawSitemapName).trim();
	if (!isValidSitemapName(sitemapName)) {
		res.status(400).json({ error: 'Invalid sitemapName' });
		return;
	}
	const visibilityMap = new Map(
		sessions.getAllSitemapVisibilityRules().map((entry) => [safeText(entry?.sitemapName).trim(), entry?.visibility])
	);
	const visibility = safeText(visibilityMap.get(sitemapName) || 'all').trim().toLowerCase() || 'all';
	res.json({ sitemapName, visibility });
});

app.post('/api/sitemap-config', jsonParserMedium, requireAdmin, (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	if (!isPlainObject(req.body)) {
		res.status(400).json({ error: 'Invalid request body' });
		return;
	}
	const sitemapName = safeText(req.body.sitemapName).trim();
	const visibility = safeText(req.body.visibility).trim().toLowerCase();
	if (!isValidSitemapName(sitemapName)) {
		res.status(400).json({ error: 'Invalid sitemapName' });
		return;
	}
	if (!['all', 'normal', 'admin'].includes(visibility)) {
		res.status(400).json({ error: `Invalid visibility: ${visibility}` });
		return;
	}
	if (!sessions.setSitemapVisibility(sitemapName, visibility)) {
		res.status(400).json({ error: 'Failed to save sitemap visibility' });
		return;
	}
	res.json({ ok: true, sitemapName, visibility });
});

// System settings endpoints
app.get('/api/admin/config', (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	const user = req.ohProxyUserData;
	if (!user) {
		res.status(401).json({ error: 'Authentication required' });
		return;
	}

	const userConfig = {
		trackGps: user.trackgps === true,
		voiceModel: isValidUserVoicePreference(user.voicePreference) ? user.voicePreference : 'system',
		mapviewRendering: isValidUserMapviewRendering(user.mapviewRendering) ? user.mapviewRendering : 'ohproxy',
		password: '',
		confirm: '',
	};

	if (user.role !== 'admin') {
		res.json({ user: userConfig });
		return;
	}

	let config;
	try {
		delete require.cache[require.resolve('./config.local.js')];
		delete require.cache[require.resolve('./config.js')];
		config = JSON.parse(JSON.stringify(loadUserConfig()));
	} catch (err) {
		logMessage(`Failed to load config for admin: ${err.message || err}`);
		res.status(500).json({ error: 'Failed to load config' });
		return;
	}

	for (const keyPath of SENSITIVE_CONFIG_KEYS) {
		const val = getNestedValue(config, keyPath);
		if (val && typeof val === 'string' && val.trim()) {
			setNestedValue(config, keyPath, SENSITIVE_MASK);
		}
	}

	if (!isPlainObject(config.user)) config.user = {};
	Object.assign(config.user, userConfig);

	res.json(config);
});

app.get('/api/admin/config/secret', requireAdmin, (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store');

	const key = req.query.key;
	if (!key || typeof key !== 'string' || !SENSITIVE_CONFIG_KEYS.includes(key)) {
		res.status(403).json({ error: 'Forbidden' });
		return;
	}

	let config;
	try {
		delete require.cache[require.resolve('./config.local.js')];
		delete require.cache[require.resolve('./config.js')];
		config = loadUserConfig();
	} catch (err) {
		logMessage(`Failed to load config for secret reveal: ${err.message || err}`);
		res.status(500).json({ error: 'Failed to load config' });
		return;
	}

	const val = getNestedValue(config, key);
	res.json({ value: val !== undefined ? String(val) : '' });
});

app.post('/api/admin/config', jsonParserLarge, (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	const user = req.ohProxyUserData;
	if (!user) {
		res.status(401).json({ error: 'Authentication required' });
		return;
	}
	const isAdminUser = user.role === 'admin';

	const incoming = req.body;
	if (!isPlainObject(incoming)) {
		res.status(400).json({ error: 'Invalid config' });
		return;
	}
	const forbiddenKeyPath = findForbiddenObjectKeyPath(incoming);
	if (forbiddenKeyPath) {
		res.status(400).json({ error: `Invalid config key: ${forbiddenKeyPath}` });
		return;
	}
	const userErrors = validateAdminUserConfig(incoming.user);
	if (userErrors.length > 0) {
		res.status(400).json({ errors: userErrors });
		return;
	}

	if (!isAdminUser) {
		const topKeys = Object.keys(incoming);
		const disallowedTopKey = topKeys.find((key) => key !== 'user');
		if (disallowedTopKey) {
			res.status(403).json({ error: 'Admin access required for non-user settings' });
			return;
		}
	}

	let incomingConfig = null;
	let needsRestart = false;
	let needsClientReload = false;
	if (isAdminUser) {
		incomingConfig = JSON.parse(JSON.stringify(incoming));
		delete incomingConfig.user;

		// Restore masked sensitive values from current config
		let currentLocal;
		try {
			delete require.cache[require.resolve('./config.local.js')];
			currentLocal = require('./config.local.js');
		} catch { currentLocal = {}; }

		for (const keyPath of SENSITIVE_CONFIG_KEYS) {
			const val = getNestedValue(incomingConfig, keyPath);
			if (val === SENSITIVE_MASK) {
				const currentVal = getNestedValue(currentLocal, keyPath);
				if (currentVal !== undefined) {
					setNestedValue(incomingConfig, keyPath, currentVal);
				} else {
					setNestedValue(incomingConfig, keyPath, '');
				}
			}
		}

		// Validate
		const errors = validateAdminConfig(incomingConfig);
		if (errors.length > 0) {
			res.status(400).json({ errors });
			return;
		}

		// Check if restart will be required (compare against merged boot config, not raw config.local.js,
		// because config.local.js may omit keys that have default values)
		needsRestart = restartRequiredKeys.some(key => {
			const oldVal = getNestedValue(SERVER_CONFIG, key);
			const newVal = getNestedValue(incomingConfig.server || {}, key);
			return JSON.stringify(oldVal) !== JSON.stringify(newVal);
		});

		// Check if client config changed (requires browser reload)
		needsClientReload = JSON.stringify(CLIENT_CONFIG) !== JSON.stringify(incomingConfig.client || {});
	}

	const previousTrackGps = user.trackgps === true;
	const previousVoicePreference = isValidUserVoicePreference(user.voicePreference) ? user.voicePreference : 'system';
	const previousMapviewRendering = isValidUserMapviewRendering(user.mapviewRendering) ? user.mapviewRendering : 'ohproxy';
	const previousPassword = typeof user.password === 'string' ? user.password : '';
	const nextTrackGps = isPlainObject(incoming.user) && Object.prototype.hasOwnProperty.call(incoming.user, 'trackGps')
		? incoming.user.trackGps
		: previousTrackGps;
	const nextVoicePreference = isPlainObject(incoming.user) && Object.prototype.hasOwnProperty.call(incoming.user, 'voiceModel')
		? incoming.user.voiceModel
		: previousVoicePreference;
	const nextMapviewRendering = isPlainObject(incoming.user) && Object.prototype.hasOwnProperty.call(incoming.user, 'mapviewRendering')
		? safeText(incoming.user.mapviewRendering).trim().toLowerCase()
		: previousMapviewRendering;
	const nextPassword = isPlainObject(incoming.user) && typeof incoming.user.password === 'string'
		? incoming.user.password
		: '';
	const nextConfirm = isPlainObject(incoming.user) && typeof incoming.user.confirm === 'string'
		? incoming.user.confirm
		: '';
	const updateTrackGps = nextTrackGps !== previousTrackGps;
	const updateVoiceModel = nextVoicePreference !== previousVoicePreference;
	const updateMapviewRendering = nextMapviewRendering !== previousMapviewRendering;
	const updatePassword = nextPassword.length > 0 || nextConfirm.length > 0;

	let userTrackUpdated = false;
	let userVoiceUpdated = false;
	let userMapviewRenderingUpdated = false;
	let userPasswordUpdated = false;

	const rollbackUserUpdates = () => {
		if (userTrackUpdated && !sessions.updateUserTrackGps(user.username, previousTrackGps)) {
			logMessage(`[Settings] Failed to roll back user GPS setting for ${user.username || 'unknown'}`, 'error');
		}
		if (userVoiceUpdated && !sessions.updateUserVoicePreference(user.username, previousVoicePreference)) {
			logMessage(`[Settings] Failed to roll back user voice setting for ${user.username || 'unknown'}`, 'error');
		}
		if (userMapviewRenderingUpdated && !sessions.updateUserMapviewRendering(user.username, previousMapviewRendering)) {
			logMessage(`[Settings] Failed to roll back user mapview rendering setting for ${user.username || 'unknown'}`, 'error');
		}
		if (userPasswordUpdated && !sessions.updateUserPassword(user.username, previousPassword)) {
			logMessage(`[Settings] Failed to roll back user password for ${user.username || 'unknown'}`, 'error');
		}
	};

	if (updateTrackGps) {
		if (!sessions.updateUserTrackGps(user.username, nextTrackGps)) {
			res.status(500).json({ error: 'Failed to update user GPS setting' });
			return;
		}
		userTrackUpdated = true;
	}
	if (updateVoiceModel) {
		if (!sessions.updateUserVoicePreference(user.username, nextVoicePreference)) {
			rollbackUserUpdates();
			res.status(500).json({ error: 'Failed to update user voice setting' });
			return;
		}
		userVoiceUpdated = true;
	}
	if (updateMapviewRendering) {
		if (!sessions.updateUserMapviewRendering(user.username, nextMapviewRendering)) {
			rollbackUserUpdates();
			res.status(500).json({ error: 'Failed to update user mapview rendering setting' });
			return;
		}
		userMapviewRenderingUpdated = true;
	}
	if (updatePassword) {
		if (nextPassword !== nextConfirm) {
			rollbackUserUpdates();
			res.status(400).json({ errors: ['user.password and user.confirm must match'] });
			return;
		}
		if (!sessions.updateUserPassword(user.username, nextPassword)) {
			rollbackUserUpdates();
			res.status(500).json({ error: 'Failed to update user password' });
			return;
		}
		userPasswordUpdated = true;
	}

	if (isAdminUser) {
		// Write config.local.js atomically
		const content = '\'use strict\';\n\nmodule.exports = ' + JSON.stringify(incomingConfig, null, '\t') + ';\n';
		const tmpPath = LOCAL_CONFIG_PATH + '.tmp';
		try {
			fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: SENSITIVE_FILE_MODE });
			fs.renameSync(tmpPath, LOCAL_CONFIG_PATH);
			ensureSensitiveFilePermissions(LOCAL_CONFIG_PATH, 'config.local.js');
		} catch (err) {
			rollbackUserUpdates();
			logMessage(`Failed to write admin config: ${err.message || err}`);
			res.status(500).json({ error: 'Failed to write config: ' + err.message });
			return;
		}
	}

	const needsReload = needsClientReload || userTrackUpdated || userVoiceUpdated || userMapviewRenderingUpdated;
	if (userPasswordUpdated) {
		clearAuthCookie(res);
	}

	const actorLabel = isAdminUser ? 'Admin' : 'User';
	logMessage(`[${actorLabel}] Config updated by ${user.username || 'unknown'}`);
	res.json({
		ok: true,
		restartRequired: needsRestart,
		reloadRequired: needsReload,
		passwordChanged: userPasswordUpdated,
		logoutRequired: userPasswordUpdated,
	});
});

app.post('/api/admin/restart', jsonParserSmall, requireAdmin, (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	logMessage(`[Admin] Restart triggered by ${req.ohProxyUserData.username || 'unknown'}`);
	res.json({ ok: true });
	res.once('finish', maybeTriggerRestart);
	res.once('close', maybeTriggerRestart);
});

app.get('/api/card-config/:itemName/history', requireAdmin, async (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');
	const rawItemName = req.params.itemName;
	if (typeof rawItemName !== 'string' || !/^[a-zA-Z0-9_]{1,50}$/.test(rawItemName)) {
		res.status(400).json({ error: 'Invalid item name' });
		return;
	}
	const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
	if (offset > 100000) {
		res.status(400).json({ error: 'Invalid offset' });
		return;
	}
	const rawCommands = typeof req.query.commands === 'string' ? req.query.commands : '';
	const validCommands = rawCommands.length > 0 && rawCommands.length <= 200
		? new Set(rawCommands.split(',').map(c => c.toLowerCase()))
		: null;
	const rawBefore = typeof req.query.before === 'string' ? req.query.before : '';
	const conn = getMysqlConnection();
	if (!conn) {
		return res.status(503).json({ ok: false, error: 'Database unavailable' });
	}
	try {
		// Group items: merged timeline from all members
		if (groupToMembers.has(rawItemName)) {
			const members = groupToMembers.get(rawItemName);
			if (!members || !members.length) {
				return res.json({ ok: true, entries: [], hasNewer: false, hasOlder: false, isGroup: true });
			}
			// Batch-lookup ItemIds for all member names
			const memberNames = members.map(m => m.name);
			const placeholders = memberNames.map(() => '?').join(',');
			const idRows = await queryWithTimeout(conn, 'SELECT ItemName, ItemId FROM items WHERE ItemName IN (' + placeholders + ')', memberNames);
			const memberIdMap = new Map();
			for (const row of idRows) {
				const id = parseInt(row.ItemId, 10);
				if (Number.isFinite(id) && id >= 0) memberIdMap.set(row.ItemName, id);
			}
			const labelMap = new Map();
			for (const m of members) labelMap.set(m.name, m.label);
			let beforeDate = null;
			if (rawBefore) {
				beforeDate = new Date(rawBefore);
				if (isNaN(beforeDate.getTime())) {
					return res.status(400).json({ error: 'Invalid before cursor' });
				}
			}
			// Find transition points per member, then merge
			const allTransitions = [];
			const MEMBER_BATCH = 100;
			const MEMBER_MAX_BATCHES = 10;
			for (const [memberName, itemId] of memberIdMap) {
				const tableId = parseInt(itemId, 10);
				const label = safeText(labelMap.get(memberName) || memberName);
				const transitions = [];
				let pendingValue = null;
				let pendingEntry = null;
				let mCursor = 0;
				for (let batch = 0; batch < MEMBER_MAX_BATCHES && transitions.length < 4; batch++) {
					const sql = beforeDate
						? 'SELECT Time, Value FROM Item' + tableId + ' WHERE Time < ? ORDER BY Time DESC LIMIT ' + MEMBER_BATCH + ' OFFSET ?'
						: 'SELECT Time, Value FROM Item' + tableId + ' ORDER BY Time DESC LIMIT ' + MEMBER_BATCH + ' OFFSET ?';
					const params = beforeDate ? [beforeDate, mCursor] : [mCursor];
					const rows = await queryWithTimeout(conn, sql, params);
					for (let i = 0; i < rows.length; i++) {
						const val = String(rows[i].Value).trim();
						if (!val || val === 'NULL' || val === 'UNDEF') continue;
						const valLower = val.toLowerCase();
						if (valLower !== pendingValue) {
							if (pendingEntry !== null) {
								transitions.push(pendingEntry);
								if (transitions.length >= 4) break;
							}
							pendingValue = valLower;
						}
						pendingEntry = {
							time: rows[i].Time instanceof Date ? rows[i].Time.toISOString() : String(rows[i].Time),
							state: val,
							member: label,
						};
					}
					if (transitions.length >= 4) break;
					mCursor += rows.length;
					if (rows.length < MEMBER_BATCH) break;
				}
				if (pendingEntry !== null && transitions.length < 4) {
					transitions.push(pendingEntry);
				}
				allTransitions.push(...transitions);
			}
			// Sort by time DESC and take top entries
			allTransitions.sort((a, b) => b.time.localeCompare(a.time));
			const entries = allTransitions.slice(0, 3);
			const hasOlder = allTransitions.length > 3;
			const nextCursor = entries.length ? entries[entries.length - 1].time : null;
			return res.json({
				ok: true,
				entries,
				hasNewer: !!rawBefore,
				hasOlder,
				nextCursor,
				isGroup: true,
			});
		}
		// Look up ItemId from the items mapping table
		const itemRows = await queryWithTimeout(conn, 'SELECT ItemId FROM items WHERE ItemName = ? LIMIT 1', [rawItemName]);
		if (!itemRows.length) {
			return res.json({ ok: true, entries: [], hasNewer: false, hasOlder: false });
		}
		const itemId = parseInt(itemRows[0].ItemId, 10);
		if (!Number.isFinite(itemId) || itemId < 0) {
			return res.json({ ok: true, entries: [], hasNewer: false, hasOlder: false });
		}
		// Fetch batches and find transition points (oldest occurrence of each state run)
		const tableName = 'Item' + itemId;
		const BATCH = 500;
		const MAX_BATCHES = 10;
		const deduped = [];
		let pendingValue = null;
		let pendingEntry = null;
		let cursor = offset;
		let exhausted = false;
		for (let batch = 0; batch < MAX_BATCHES && deduped.length < 4; batch++) {
			const rows = await queryWithTimeout(conn, 'SELECT Time, Value FROM `' + tableName + '` ORDER BY Time DESC LIMIT ' + BATCH + ' OFFSET ?', [cursor]);
			for (let i = 0; i < rows.length; i++) {
				const val = String(rows[i].Value).trim();
				if (!val || val === 'NULL' || val === 'UNDEF') continue;
				const valLower = val.toLowerCase();
				if (valLower !== pendingValue) {
					// Value changed — emit the pending entry (oldest row of the previous run)
					if (pendingEntry !== null) {
						if (!validCommands || validCommands.has(pendingEntry.state.toLowerCase())) {
							deduped.push(pendingEntry);
							if (deduped.length >= 4) break;
						}
					}
					pendingValue = valLower;
				}
				// Keep updating pending to the current (older) row
				pendingEntry = {
					time: rows[i].Time instanceof Date ? rows[i].Time.toISOString() : String(rows[i].Time),
					state: val,
					cursorPos: cursor + i,
				};
			}
			if (deduped.length >= 4) break;
			cursor += rows.length;
			if (rows.length < BATCH) { exhausted = true; break; }
		}
		// Emit trailing pending entry (oldest row of the last run)
		if (pendingEntry !== null && deduped.length < 4) {
			if (!validCommands || validCommands.has(pendingEntry.state.toLowerCase())) {
				deduped.push(pendingEntry);
			}
		}
		const entries = deduped.slice(0, 3).map(({ time, state }) => ({ time, state }));
		const nextOffset = deduped.length > 3 ? deduped[3].cursorPos : cursor;
		const hasOlder = deduped.length > 3 || !exhausted;
		res.json({
			ok: true,
			entries,
			hasNewer: offset > 0,
			hasOlder,
			nextOffset,
		});
	} catch (err) {
		logMessage(`[History API] Query failed for ${rawItemName}: ${err.message || err}`);
		res.status(504).json({ ok: false, error: 'Query failed' });
	}
});

app.post('/api/voice/transcribe', express.raw({ type: 'application/octet-stream', limit: '5mb' }), async (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');

	const username = req.ohProxyUserData?.username || 'anonymous';

	if (!liveConfig.voskHost) {
		res.status(503).json({ error: 'Vosk host not configured' });
		return;
	}

	if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
		res.status(400).json({ error: 'Empty or invalid audio data' });
		return;
	}

	const startTime = Date.now();

	try {
		const text = await new Promise((resolve, reject) => {
			const ws = new WebSocket(`ws://${liveConfig.voskHost}`);
			let result = '';
			let lastPartial = '';
			const timeout = setTimeout(() => {
				ws.terminate();
				reject(new Error('Vosk timeout'));
			}, 30000);

			ws.on('open', () => {
				ws.send(JSON.stringify({ config: { sample_rate: 16000 } }));
				ws.send(req.body);
				ws.send(JSON.stringify({ eof: 1 }));
			});

			ws.on('message', (data) => {
				try {
					const msg = JSON.parse(data);
					if (msg.text !== undefined) result = msg.text;
					if (msg.partial !== undefined) lastPartial = msg.partial;
				} catch {}
			});

			ws.on('close', () => {
				clearTimeout(timeout);
				resolve(result || lastPartial);
			});

			ws.on('error', (err) => {
				clearTimeout(timeout);
				reject(err);
			});
		});

		const elapsed = Date.now() - startTime;
		logMessage(`[Voice] [${username}] Vosk transcribed: "${text}" (${elapsed}ms)`);

		res.json({ text: text || '' });
	} catch (err) {
		logMessage(`[Voice] [${username}] Vosk transcription failed: ${err.message || err}`);
		res.status(502).json({ error: 'Vosk transcription failed' });
	}
});

app.post('/api/voice', jsonParserSmall, async (req, res) => {
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache');

	if (!isPlainObject(req.body)) {
		res.status(400).json({ error: 'Invalid request body', voiceError: 'Sorry, something went wrong with the voice request.' });
		return;
	}
	const { command } = req.body;
	if (!command || typeof command !== 'string' || command.length > 500 || hasAnyControlChars(command)) {
		res.status(400).json({ error: 'Missing or invalid command', voiceError: 'Sorry, I could not understand the command.' });
		return;
	}

	const trimmed = command.trim();
	if (!trimmed || trimmed.length > 500) {
		res.status(400).json({ error: 'Empty or too long command', voiceError: 'Sorry, the command was empty or too long.' });
		return;
	}

	const username = req.ohProxyUserData?.username || 'anonymous';

	// Check if AI is configured
	if (!liveConfig.anthropicApiKey) {
		logMessage(`[Voice] [${username}] "${trimmed}" - AI not configured`);
		res.status(503).json({ error: 'Voice AI not configured', voiceError: 'Voice commands are not configured. Please ask an administrator to set up the AI service.' });
		return;
	}

	let requestSitemapName = resolveRequestSitemapName(req);
	if (!requestSitemapName) {
		await refreshSitemapCache({ skipAtmosphereResubscribe: true });
		requestSitemapName = resolveRequestSitemapName(req);
	}
	if (!requestSitemapName) {
		logMessage(`[Voice] [${username}] "${trimmed}" - sitemap not resolved`);
		res.status(503).json({
			error: 'Voice AI sitemap is not resolved yet.',
			voiceError: 'Voice commands are temporarily unavailable while sitemap data loads.',
		});
		return;
	}
	const structureMapResult = await getOrGenerateAiStructureMapForSitemap(requestSitemapName);
	const structureMap = structureMapResult.map;
	if (!structureMap) {
		const cooldownMs = Math.max(0, Number(structureMapResult.cooldownMs) || 0);
		if (cooldownMs > 0) {
			logMessage(
				`[Voice] [${username}] "${trimmed}" - structure map unavailable for sitemap "${requestSitemapName}" ` +
				`(cooldown ${formatInterval(cooldownMs)})`
			);
			res.status(503).json({
				error: 'Voice AI structure map is cooling down after a generation failure.',
				voiceError: 'Voice commands are temporarily unavailable while the system retries structure map generation.',
			});
			return;
		}
		logMessage(
			`[Voice] [${username}] "${trimmed}" - structure map not found for sitemap "${requestSitemapName}": ` +
			`${structureMapResult.error?.message || 'missing structure map'}`
		);
		res.status(503).json({
			error: 'Voice AI structure map not found for the selected sitemap.',
			voiceError: 'Voice commands are not ready for this sitemap. The system structure map needs to be generated.',
		});
		return;
	}

	const itemList = structureMap.request?.messages?.[0]?.content;
	if (!itemList) {
		logMessage(`[Voice] [${username}] "${trimmed}" - invalid structure map`);
		res.status(503).json({ error: 'Invalid structure map format', voiceError: 'Voice commands are not working. The system structure map is invalid.' });
		return;
	}

	try {
		const aiResponse = await callAnthropicApi({
			model: liveConfig.aiModel,
			max_tokens: 4096,
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
			res.status(502).json({ error: 'Empty response from AI', voiceError: 'The AI returned an empty response. Please try again.' });
			return;
		}

		// Parse JSON response - strip markdown fences or surrounding text if present
		let jsonText = textContent.text.trim();
		const fenceMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
		if (fenceMatch) {
			jsonText = fenceMatch[1].trim();
		} else {
			const firstBrace = jsonText.indexOf('{');
			const lastBrace = jsonText.lastIndexOf('}');
			if (firstBrace !== -1 && lastBrace > firstBrace) {
				jsonText = jsonText.slice(firstBrace, lastBrace + 1);
			}
		}

		let parsed;
		try {
			parsed = JSON.parse(jsonText);
		} catch {
			logMessage(`[Voice] [${username}] "${trimmed}" - invalid AI JSON: ${textContent.text}`);
			res.status(502).json({ error: 'Invalid response from AI', voiceError: 'The AI returned a garbled response. Please try again.' });
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
		const pricing = AI_MODEL_PRICING[liveConfig.aiModel] || AI_MODEL_PRICING['claude-3-haiku-20240307'];
		const inputCost = (inputTokens / 1000000) * pricing.input;
		const outputCost = (outputTokens / 1000000) * pricing.output;
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
		res.status(502).json({ error: 'AI processing failed', voiceError: getVoiceErrorMessage(err) });
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
		const rawTheme = req.query?.theme;
		const theme = (typeof rawTheme === 'string' && !hasAnyControlChars(rawTheme))
			? rawTheme.toLowerCase()
			: '';
		if (theme === 'light' || theme === 'dark') {
			const themeColor = theme === 'light' ? '#f5f6fa' : '#131420';
			const bgColor = theme === 'light' ? '#f5f6fa' : '#131420';
			manifest.theme_color = themeColor;
			manifest.background_color = bgColor;
		}
		res.send(JSON.stringify(manifest));
	} catch {
		res.sendFile(manifestPath);
	}
});

app.get('/search-index', async (req, res) => {
	const rawRoot = typeof req.query?.root === 'string' ? req.query.root : '';
	const rawSitemap = typeof req.query?.sitemap === 'string' ? req.query.sitemap : '';
	const rootInput = rawRoot && !hasAnyControlChars(rawRoot) && rawRoot.length <= 512 ? rawRoot : '';
	const sitemapInput = rawSitemap && !hasAnyControlChars(rawSitemap) && rawSitemap.length <= 64 ? rawSitemap : '';
	let rootPath = '';

	if (rootInput && !rootInput.includes('..') && !rootInput.includes('\\')) {
		const normalized = normalizeOpenhabPath(rootInput);
		if (normalized && normalized.includes('/rest/sitemaps/')) {
			rootPath = normalized;
		}
	}

	if (!rootPath && sitemapInput && isValidSitemapName(sitemapInput)) {
		const nameEnc = encodeURIComponent(sitemapInput);
		rootPath = `/rest/sitemaps/${nameEnc}/${nameEnc}`;
	}

	if (!rootPath) return res.status(400).send('Missing sitemap');
	rootPath = ensureJsonParam(rootPath);
	const searchSitemapName = sitemapInput || sitemapNameFromRestSitemapPath(rootPath);
	const userRole = getRequestUserRole(req);
	if (!isSitemapVisibleForRole(searchSitemapName, userRole)) {
		return res.status(403).json({ error: 'Sitemap access denied' });
	}

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

		await applyGroupStateOverrides(page);
		const normalized = normalizeSearchWidgets(page, { path: pagePath, sitemapName: searchSitemapName });
		for (const f of normalized) {
			if (!f || !f.__section) continue;
			const frameLabel = safeText(f.label);
			if (!frameLabel) continue;
			const frameKey = `${pagePath.join('>')}|${frameLabel}`;
			if (seenFrames.has(frameKey)) continue;
			seenFrames.add(frameKey);
			frames.push({
				label: frameLabel,
				path: pagePath.slice(),
				icon: safeText(f.icon || ''),
				staticIcon: !!f.staticIcon,
			});
		}

		for (const w of normalized) {
			if (!w || w.__section) continue;
			const link = widgetPageLink(w);
			if (link) {
				const rel = normalizeOpenhabPath(link);
				if (rel && rel.includes('/rest/sitemaps/')) {
					const label = widgetLabel(w);
					const segs = labelPathSegments(label);
					const nextPath = pagePath.concat(segs.length ? segs : [label]).filter(s => s && s !== '-');
					queue.push({ url: rel, path: nextPath });
				}
			}
			const key = w?.widgetId || `${safeText(w?.item?.name || '')}|${safeText(w?.label || '')}|${safeText(link || '')}`;
			if (seenWidgets.has(key)) continue;
			seenWidgets.add(key);
			widgets.push(w);
		}
	}

	// Filter widgets/frames by visibility for the current role.
	const visibilityMap = buildVisibilityMap();

	const filteredWidgets = widgets.filter(w => isWidgetVisibleForRole(w, userRole, visibilityMap));

	const filteredFrames = frames.filter(f => {
		const label = safeText(f.label);
		const sectionPath = Array.isArray(f.path) ? f.path.concat([label]) : [label];
		const fKey = widgetKey({
			__section: true,
			label,
			__sectionPath: sectionPath,
			__sitemapName: searchSitemapName,
		});
		const vis = visibilityMap.get(fKey) || 'all';
		return isVisibilityAllowedForRole(vis, userRole);
	});

	res.setHeader('Cache-Control', 'no-store');
	return res.json({ widgets: filteredWidgets, frames: filteredFrames });
});

// Return full sitemap structure with all pages indexed by URL
app.get('/sitemap-full', async (req, res) => {
	try {
		const rawRoot = typeof req.query?.root === 'string' ? req.query.root : '';
		const rawSitemap = typeof req.query?.sitemap === 'string' ? req.query.sitemap : '';
		const rootInput = rawRoot && !hasAnyControlChars(rawRoot) && rawRoot.length <= 512 ? rawRoot : '';
		const sitemapInput = rawSitemap && !hasAnyControlChars(rawSitemap) && rawSitemap.length <= 64 ? rawSitemap : '';
		let rootPath = '';

		if (rootInput && !rootInput.includes('..') && !rootInput.includes('\\')) {
			const normalized = normalizeOpenhabPath(rootInput);
			if (normalized && normalized.includes('/rest/sitemaps/')) {
				rootPath = normalized;
			}
		}

		if (!rootPath && sitemapInput && isValidSitemapName(sitemapInput)) {
			const nameEnc = encodeURIComponent(sitemapInput);
			rootPath = `/rest/sitemaps/${nameEnc}/${nameEnc}`;
		}

		if (!rootPath) return res.status(400).send('Missing sitemap');
		rootPath = ensureJsonParam(rootPath);
		const targetSitemapName = sitemapInput || sitemapNameFromRestSitemapPath(rootPath);
		const userRole = getRequestUserRole(req);
		if (!isSitemapVisibleForRole(targetSitemapName, userRole)) {
			return res.status(403).json({ error: 'Sitemap access denied' });
		}

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
					// Recurse into nested widgets (Frames) - support both OH 1.x and 3.x+
					if (w?.widget) findLinks(w.widget);
					if (w?.widgets) findLinks(w.widgets);
				}
			};
			// Support both OH 1.x 'widget' and OH 3.x+ 'widgets'
			findLinks(page?.widgets || page?.widget);
		}

		const filtered = filterSitemapCacheVisibility({ pages, root: rootPath }, userRole);

		res.setHeader('Cache-Control', 'no-store');
		return res.json(filtered);
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

	const rawMode = typeof req.query?.mode === 'string' ? req.query.mode : '';
	const mode = (rawMode && !hasAnyControlChars(rawMode) && rawMode.trim().toLowerCase() === 'dark') ? 'dark' : 'light';

	// Read cached weather data
	let weatherData = null;
	try {
		weatherData = JSON.parse(fs.readFileSync(WEATHERBIT_FORECAST_FILE, 'utf8'));
	} catch {
		sendStyledError(res, req, 503, 'Weather data not available');
		return;
	}

	const forecast = weatherData && typeof weatherData === 'object' && !Array.isArray(weatherData)
		? weatherData.forecast
		: null;
	if (!forecast || typeof forecast !== 'object' || Array.isArray(forecast)) {
		sendStyledError(res, req, 503, 'Weather data not available');
		return;
	}

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
<style>@font-face{font-family:'Rubik';src:url('/fonts/rubik-300.woff2') format('woff2');font-weight:300;font-display:swap}body{font-family:'Rubik',system-ui,sans-serif;font-weight:300;padding:2rem}</style>
</head>
<body>
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
	res.redirect('/');
});

app.post('/logout', urlencodedParserSmall, (req, res) => {
	if (liveConfig.authMode === 'html' && !validateCsrfToken(req)) {
		res.status(403).type('text/plain').send('Invalid CSRF token');
		return;
	}
	clearAuthCookie(res);
	res.redirect('/');
});

app.post('/api/logout', (req, res) => {
	clearAuthCookie(res);
	if (liveConfig.authMode === 'basic') {
		res.json({ ok: true, basicLogout: true });
	} else {
		res.json({ ok: true });
	}
});

app.get('/api/logout', (req, res) => {
	clearAuthCookie(res);
	res.setHeader('WWW-Authenticate', `Basic realm="${liveConfig.authRealm}"`);
	res.status(401).type('text/html').send(
		'<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Logged out</title>' +
		'<style>@font-face{font-family:\'Rubik\';src:url(\'/fonts/rubik-300.woff2\') format(\'woff2\');font-weight:300;font-display:swap}body{font-family:\'Rubik\',system-ui,sans-serif;font-weight:300;text-align:center;padding:3em}</style></head>' +
		'<body><p>You have been logged out.</p><a href="/">Log in</a></body></html>'
	);
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

app.get(/^\/lang\.v[\w.-]+\.js$/i, (req, res) => {
	sendVersionedAsset(res, LANG_JS_PATH, 'application/javascript; charset=utf-8');
});

app.get(/^\/oh-utils\.v[\w.-]+\.js$/i, (req, res) => {
	sendVersionedAsset(res, OH_UTILS_JS_PATH, 'application/javascript; charset=utf-8');
});

app.get(/^\/transport-client\.v[\w.-]+\.js$/i, (req, res) => {
	sendVersionedAsset(res, TRANSPORT_CLIENT_JS_PATH, 'application/javascript; charset=utf-8');
});

app.get(/^\/transport\.sharedworker\.v[\w.-]+\.js$/i, (req, res) => {
	sendVersionedAsset(res, TRANSPORT_SHAREDWORKER_JS_PATH, 'application/javascript; charset=utf-8');
});

app.get(/^\/widget-normalizer\.v[\w.-]+\.js$/i, (req, res) => {
	sendVersionedAsset(res, WIDGET_NORMALIZER_PATH, 'application/javascript; charset=utf-8');
});

// --- Proxy FIRST (so bodies aren't eaten by any parsers) ---
// Delegating agent that forwards all operations to the protocol-appropriate agent,
// so proxy middleware always uses the correct agent even if ohTarget changes at runtime
const ohDynamicAgent = new Proxy({}, {
	get(_target, prop, receiver) {
		return Reflect.get(getOhAgent(), prop, receiver);
	},
});
const proxyCommon = {
	target: OH_TARGET,
	router: () => liveConfig.ohTarget,
	changeOrigin: true,
	ws: false, // Disabled - we handle WebSocket ourselves via wss
	logLevel: liveConfig.proxyLogLevel,
	agent: ohDynamicAgent,
	onProxyReq(proxyReq) {
		proxyReq.setHeader('User-Agent', liveConfig.userAgent);
		const ah = authHeader();
		if (ah) proxyReq.setHeader('Authorization', ah);
	},
};

purgeOldIconCache();
ensureDir(getIconCacheDir());

app.get(/^\/icon\/(v\d+)\/(.+)$/i, async (req, res, next) => {
	const match = req.path.match(/^\/icon\/(v\d+)\/(.+)$/i);
	if (!match) return next();
	const version = match[1];
	if (version !== liveConfig.iconVersion) return next();
	let rawName;
	try { rawName = decodeURIComponent(safeText(match[2])).replace(/\\/g, '/').trim(); } catch { return res.status(400).type('text/plain').send('Invalid icon name'); }
	if (!rawName) return res.status(400).type('text/plain').send('Invalid icon name');
	const segments = rawName.split('/');
	if (segments.some((seg) => seg === '.' || seg === '..' || seg === '')) {
		return res.status(400).type('text/plain').send('Invalid icon name');
	}
	const name = segments.join('/');
	const rawFormat = safeText(req.query?.format || '').trim().toLowerCase();
	const format = rawFormat === 'svg' ? 'svg' : 'png';
	const rawState = req.query?.state;
	let state;
	if (rawState !== undefined && rawState !== '') {
		const stateStr = safeText(rawState);
		if (ANY_CONTROL_CHARS_RE.test(stateStr)) {
			return res.status(400).type('text/plain').send('Invalid state');
		}
		state = stateStr;
	}

	try {
		const buffer = await resolveIcon(name, state, format);
		res.setHeader('Content-Type', format === 'svg' ? 'image/svg+xml' : 'image/png');
		res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
		res.send(buffer);
	} catch (err) {
		logMessage(`[Icon] ${name}: ${err.message || err}`);
		res.status(404).type('text/plain').send('Icon not found');
	}
});

app.use('/rest', async (req, res, next) => {
	if (req.method !== 'GET') return next();
	const userRole = getRequestUserRole(req);
	const sitemapVisibilityMap = buildSitemapVisibilityMap();

	const rawQuerySitemap = typeof req.query?.sitemap === 'string' ? req.query.sitemap : '';
	if (rawQuerySitemap && !hasAnyControlChars(rawQuerySitemap)) {
		const querySitemapName = safeText(rawQuerySitemap).trim();
		if (querySitemapName && !isSitemapVisibleForRole(querySitemapName, userRole, sitemapVisibilityMap)) {
			return res.status(403).type('text/plain').send('Sitemap access denied');
		}
	}
	if (!req.path.startsWith('/sitemaps')) return next();

	// Filter sitemap catalog by role.
	if (req.path === '/sitemaps' || req.path === '/sitemaps/') {
		const rawQuery = req.originalUrl.split('?')[1] || '';
		const params = new URLSearchParams(rawQuery);
		if (!params.has('type')) params.set('type', 'json');
		const upstreamPath = `/rest/sitemaps${params.toString() ? `?${params.toString()}` : ''}`;

		let body;
		try {
			body = await fetchOpenhab(upstreamPath);
		} catch (err) {
			return res.status(502).json({ error: err.message || 'Upstream error' });
		}
		if (!body.ok) {
			return res.status(body.status).send(body.body);
		}
		let payload;
		try {
			payload = JSON.parse(body.body);
		} catch {
			return res.status(502).json({ error: 'Non-JSON response from openHAB' });
		}
		res.setHeader('Cache-Control', 'no-store');
		return res.json(filterSitemapPayloadForRole(payload, userRole, sitemapVisibilityMap));
	}

	// Deny direct page access for blocked sitemaps.
	const sitemapName = sitemapNameFromRestSitemapPath(`/rest${req.path}`);
	if (sitemapName && !isSitemapVisibleForRole(sitemapName, userRole, sitemapVisibilityMap)) {
		return res.status(403).type('text/plain').send('Sitemap access denied');
	}
	return next();
});

app.use('/rest', async (req, res, next) => {
	if (req.method !== 'GET') return next();
	const rawDelta = req.query?.delta;
	if (typeof rawDelta !== 'string') return next();
	const delta = rawDelta.trim();
	if (hasAnyControlChars(delta)) return next();
	if (delta !== '1' && delta !== 'true') return next();
	if (!req.path.startsWith('/sitemaps/')) return next();
	res.setHeader('Cache-Control', 'no-store');

	const rawQuery = req.originalUrl.split('?')[1] || '';
	const params = new URLSearchParams(rawQuery);
	const sinceRaw = params.get('since') || '';
	const since = isValidSha1(sinceRaw) ? sinceRaw : '';
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
			prev.icon !== current.icon ||
			prev.staticIcon !== current.staticIcon ||
			prev.mappings !== current.mappings ||
			prev.buttonsSig !== current.buttonsSig ||
			prev.labelcolor !== current.labelcolor ||
			prev.valuecolor !== current.valuecolor ||
			prev.iconcolor !== current.iconcolor
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

// /chart is handled by dedicated endpoint with caching (see app.get('/chart', ...))

// Serve local images from public/images/ (app icons, etc.)
app.use('/images', (req, res, next) => {
	const imagesDir = path.join(PUBLIC_DIR, 'images');
	const localPath = path.normalize(path.join(imagesDir, req.path));
	if (!localPath.startsWith(imagesDir + path.sep) && localPath !== imagesDir) {
		return next();
	}
	if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
		return res.sendFile(localPath);
	}
	next();
});

// Video preview endpoint
app.get('/video-preview', (req, res) => {
	const rawUrl = req.query?.url;
	if (typeof rawUrl !== 'string') {
		return res.status(400).type('text/plain').send('Missing URL');
	}
	const url = rawUrl.trim();
	if (!url || url.length > 2048 || hasAnyControlChars(url)) {
		return res.status(400).type('text/plain').send('Missing URL');
	}

	// Parse and validate RTSP URL
	let target;
	try {
		target = new URL(url);
	} catch {
		let decoded = url;
		try { decoded = decodeURIComponent(url); } catch {}
		if (!decoded || decoded.length > 2048 || hasAnyControlChars(decoded)) {
			return res.status(400).type('text/plain').send('Invalid URL');
		}
		try {
			target = new URL(decoded);
		} catch {
			return res.status(400).type('text/plain').send('Invalid URL');
		}
	}

	if (!['http:', 'https:', 'rtsp:', 'rtsps:'].includes(target.protocol)) {
		return res.status(400).type('text/plain').send('Invalid video URL');
	}

	// Validate against proxy allowlist
	if (!isProxyTargetAllowed(target, liveConfig.proxyAllowlist)) {
		return res.status(403).type('text/plain').send('Video target not allowed');
	}

	const hash = videoUrlHash(url);
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

// Chart endpoint - generates interactive HTML charts from openHAB persistence data
app.get('/chart', async (req, res) => {
	// Extract and validate parameters
	const rawItem = req.query?.item;
	const rawPeriod = req.query?.period;
	const rawMode = req.query?.mode;
	const rawTitle = req.query?.title;
	const rawLegend = req.query?.legend;
	const rawYAxisDecimalPattern = req.query?.yAxisDecimalPattern;
	const rawInterpolation = req.query?.interpolation;
	const rawService = req.query?.service;
	const rawForceAsItem = req.query?.forceasitem ?? req.query?.forceAsItem;
	if (typeof rawItem !== 'string') {
		return sendStyledError(res, req, 400, 'Invalid item parameter');
	}
	if (rawPeriod !== undefined && typeof rawPeriod !== 'string') {
		return sendStyledError(res, req, 400, 'Invalid period parameter');
	}
	if ((rawMode !== undefined && typeof rawMode !== 'string') || (rawTitle !== undefined && typeof rawTitle !== 'string')) {
		return sendStyledError(res, req, 400, 'Invalid mode parameter');
	}
	if (rawYAxisDecimalPattern !== undefined && typeof rawYAxisDecimalPattern !== 'string') {
		return sendStyledError(res, req, 400, 'Invalid yAxisDecimalPattern parameter');
	}
	if (rawInterpolation !== undefined && typeof rawInterpolation !== 'string') {
		return sendStyledError(res, req, 400, 'Invalid interpolation parameter');
	}
	if (rawLegend !== undefined && typeof rawLegend !== 'string') {
		return sendStyledError(res, req, 400, 'Invalid legend parameter');
	}
	if (rawService !== undefined && typeof rawService !== 'string') {
		return sendStyledError(res, req, 400, 'Invalid service parameter');
	}
	if (rawForceAsItem !== undefined && typeof rawForceAsItem !== 'string') {
		return sendStyledError(res, req, 400, 'Invalid forceasitem parameter');
	}
	const item = rawItem.trim();
	const period = typeof rawPeriod === 'string' ? rawPeriod.trim() : 'h';
	const mode = typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : 'dark';
	const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
	const yAxisDecimalPattern = typeof rawYAxisDecimalPattern === 'string' ? rawYAxisDecimalPattern.trim() : '';
	const interpolation = typeof rawInterpolation === 'string' ? rawInterpolation.trim().toLowerCase() : 'linear';
	const service = typeof rawService === 'string' ? rawService.trim() : '';
	const forceAsItemParsed = parseChartForceAsItem(rawForceAsItem);
	const legend = parseChartLegendMode(rawLegend);
	if (legend === null) {
		return sendStyledError(res, req, 400, 'Invalid legend parameter');
	}
	if (rawForceAsItem !== undefined && forceAsItemParsed === null) {
		return sendStyledError(res, req, 400, 'Invalid forceasitem parameter');
	}
	const forceAsItem = forceAsItemParsed === true;
	if (hasAnyControlChars(item) || hasAnyControlChars(period) || hasAnyControlChars(mode) || (title && hasAnyControlChars(title))) {
		return sendStyledError(res, req, 400, 'Invalid parameters');
	}
	if (yAxisDecimalPattern && (hasAnyControlChars(yAxisDecimalPattern) || yAxisDecimalPattern.length > 50)) {
		return sendStyledError(res, req, 400, 'Invalid yAxisDecimalPattern parameter');
	}
	if (title && title.length > 200) {
		return sendStyledError(res, req, 400, 'Invalid title parameter');
	}
	if (!['linear', 'step'].includes(interpolation)) {
		return sendStyledError(res, req, 400, 'Invalid interpolation parameter');
	}
	if (service && (hasAnyControlChars(service) || !CHART_SERVICE_RE.test(service))) {
		return sendStyledError(res, req, 400, 'Invalid service parameter');
	}

	// Validate item: a-zA-Z0-9_- max 50 chars
	if (!item || !/^[a-zA-Z0-9_-]{1,50}$/.test(item)) {
		return sendStyledError(res, req, 400, 'Invalid item parameter');
	}

		// Validate period: safe chars, bounded length, and must parse to a positive duration
		if (period.length > CHART_PERIOD_MAX_LEN || !/^[0-9A-Za-z-]+$/.test(period)) {
			return sendStyledError(res, req, 400, 'Invalid period parameter');
		}
	const periodWindow = parsePeriodWindow(period);
	if (!periodWindow) {
		return sendStyledError(res, req, 400, 'Invalid period parameter');
	}
	const durationSec = periodWindow.totalSec;

	// Validate mode: light or dark
	if (!['light', 'dark'].includes(mode)) {
		return sendStyledError(res, req, 400, 'Invalid mode parameter');
	}

	const cacheTtlMs = chartCacheTtl(durationSec);
	const resolvedTitle = title || item;
	let preloadedItemDefinition = null;
	try {
		preloadedItemDefinition = await fetchOpenhabItemDefinition(item);
	} catch {
		// Non-fatal; chart generation will retry metadata lookup if needed.
	}
	const cacheUnitSignature = deriveChartUnitSignatureFromItemDefinition(preloadedItemDefinition, item, forceAsItem);
	const cachePath = getChartCachePath(
		item,
		period,
		mode,
		resolvedTitle,
		legend,
		yAxisDecimalPattern,
		interpolation,
		service,
		forceAsItem,
		cacheUnitSignature
	);

	// Check cache
	if (isChartCacheValid(cachePath, durationSec)) {
		try {
			const html = fs.readFileSync(cachePath, 'utf8');
			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			res.setHeader('Cache-Control', `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
			res.setHeader('X-Chart-Cache', 'hit');
			return res.send(html);
		} catch {
			// Fall through to generate
		}
	}

	try {
		const generated = await generateChart(
			item,
			period,
			mode,
			resolvedTitle,
			legend,
			yAxisDecimalPattern,
			periodWindow,
			interpolation,
			service,
			forceAsItem,
			preloadedItemDefinition
		);
		if (!generated?.html) {
			return sendStyledError(res, req, 404, 'Chart data not available');
		}
		const finalCacheUnitSignature = normalizeChartUnitSymbol(generated.cacheUnitSignature || cacheUnitSignature);
		const writeCachePath = getChartCachePath(
			item,
			period,
			mode,
			resolvedTitle,
			legend,
			yAxisDecimalPattern,
			interpolation,
			service,
			forceAsItem,
			finalCacheUnitSignature
		);

			// Cache the generated HTML
			try {
				ensureDir(CHART_CACHE_DIR);
				fs.writeFileSync(writeCachePath, generated.html);
				maybePruneChartCache();
			} catch {}

		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.setHeader('Cache-Control', `private, max-age=${Math.floor(cacheTtlMs / 1000)}`);
		res.setHeader('X-Chart-Cache', 'miss');
		res.send(generated.html);
	} catch (err) {
		logMessage(`Chart generation failed: ${err.message || err}`);
		sendStyledError(res, req, 500, 'Chart generation failed');
	}
});

// Chart hash endpoint - regenerates chart and returns hash for smart iframe refresh
app.get('/api/chart-hash', async (req, res) => {
	const rawItem = req.query?.item;
	const rawPeriod = req.query?.period;
	const rawMode = req.query?.mode;
	const rawTitle = req.query?.title;
	const rawLegend = req.query?.legend;
	const rawYAxisDecimalPattern = req.query?.yAxisDecimalPattern;
	const rawInterpolation = req.query?.interpolation;
	const rawService = req.query?.service;
	const rawForceAsItem = req.query?.forceasitem ?? req.query?.forceAsItem;
	if (typeof rawItem !== 'string') {
		return res.status(400).json({ error: 'Invalid item' });
	}
	if (rawPeriod !== undefined && typeof rawPeriod !== 'string') {
		return res.status(400).json({ error: 'Invalid period' });
	}
	if ((rawMode !== undefined && typeof rawMode !== 'string') || (rawTitle !== undefined && typeof rawTitle !== 'string')) {
		return res.status(400).json({ error: 'Invalid mode' });
	}
	if (rawYAxisDecimalPattern !== undefined && typeof rawYAxisDecimalPattern !== 'string') {
		return res.status(400).json({ error: 'Invalid yAxisDecimalPattern' });
	}
	if (rawInterpolation !== undefined && typeof rawInterpolation !== 'string') {
		return res.status(400).json({ error: 'Invalid interpolation' });
	}
	if (rawLegend !== undefined && typeof rawLegend !== 'string') {
		return res.status(400).json({ error: 'Invalid legend' });
	}
	if (rawService !== undefined && typeof rawService !== 'string') {
		return res.status(400).json({ error: 'Invalid service' });
	}
	if (rawForceAsItem !== undefined && typeof rawForceAsItem !== 'string') {
		return res.status(400).json({ error: 'Invalid forceasitem' });
	}
	const item = rawItem.trim();
	const period = typeof rawPeriod === 'string' ? rawPeriod.trim() : 'h';
	const mode = typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : 'dark';
	const title = (typeof rawTitle === 'string' ? rawTitle.trim() : '') || item;
	const yAxisDecimalPattern = typeof rawYAxisDecimalPattern === 'string' ? rawYAxisDecimalPattern.trim() : '';
	const interpolation = typeof rawInterpolation === 'string' ? rawInterpolation.trim().toLowerCase() : 'linear';
	const service = typeof rawService === 'string' ? rawService.trim() : '';
	const forceAsItemParsed = parseChartForceAsItem(rawForceAsItem);
	const legend = parseChartLegendMode(rawLegend);
	if (legend === null) {
		return res.status(400).json({ error: 'Invalid legend' });
	}
	if (rawForceAsItem !== undefined && forceAsItemParsed === null) {
		return res.status(400).json({ error: 'Invalid forceasitem' });
	}
	const forceAsItem = forceAsItemParsed === true;
	if (hasAnyControlChars(item) || hasAnyControlChars(period) || hasAnyControlChars(mode) || (title && hasAnyControlChars(title))) {
		return res.status(400).json({ error: 'Invalid parameters' });
	}
	if (yAxisDecimalPattern && (hasAnyControlChars(yAxisDecimalPattern) || yAxisDecimalPattern.length > 50)) {
		return res.status(400).json({ error: 'Invalid yAxisDecimalPattern' });
	}
	if (title && title.length > 200) {
		return res.status(400).json({ error: 'Invalid title' });
	}
	if (!['linear', 'step'].includes(interpolation)) {
		return res.status(400).json({ error: 'Invalid interpolation' });
	}
	if (service && (hasAnyControlChars(service) || !CHART_SERVICE_RE.test(service))) {
		return res.status(400).json({ error: 'Invalid service' });
	}

	// Validate parameters
	if (!item || !/^[a-zA-Z0-9_-]{1,50}$/.test(item)) {
		return res.status(400).json({ error: 'Invalid item' });
	}
		if (period.length > CHART_PERIOD_MAX_LEN || !/^[0-9A-Za-z-]+$/.test(period)) {
			return res.status(400).json({ error: 'Invalid period' });
		}
	const periodWindow = parsePeriodWindow(period);
	if (!periodWindow) {
		return res.status(400).json({ error: 'Invalid period' });
	}
	if (!['light', 'dark'].includes(mode)) {
		return res.status(400).json({ error: 'Invalid mode' });
	}

	try {
		const { series: rawSeriesList, unitSymbol, cacheUnitSignature } = await fetchChartSeriesData(item, periodWindow, service, forceAsItem);
		if (!rawSeriesList || rawSeriesList.length === 0) {
			res.setHeader('Cache-Control', 'no-cache');
			return res.json({ hash: null, error: 'No data' });
		}

		const cachePath = getChartCachePath(
			item,
			period,
			mode,
			title,
			legend,
			yAxisDecimalPattern,
			interpolation,
			service,
			forceAsItem,
			cacheUnitSignature
		);
		const dataHash = computeChartSeriesDataHash(rawSeriesList, periodWindow, unitSymbol);
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

		const rendered = renderChartFromSeries(rawSeriesList, period, mode, title, legend, yAxisDecimalPattern, periodWindow, interpolation, dataHash, unitSymbol);
		if (!rendered?.html) {
			res.setHeader('Cache-Control', 'no-cache');
			return res.json({ hash: null, error: 'Generation failed' });
		}

			// Write to cache
			ensureDir(CHART_CACHE_DIR);
			fs.writeFileSync(cachePath, rendered.html);
			maybePruneChartCache();

		res.setHeader('Cache-Control', 'no-cache');
		res.json({ hash: dataHash });
	} catch (err) {
		logMessage(`Chart hash generation failed: ${err.message || err}`);
		res.setHeader('Cache-Control', 'no-cache');
		res.json({ hash: null, error: 'Generation failed' });
	}
});

app.get('/api/presence', async (req, res) => {
	const username = req.ohProxyUser;
	if (!username) {
		return res.status(401).json({ ok: false, error: 'Unauthorized' });
	}
	if (!req.ohProxyUserData?.trackgps) {
		return res.status(403).json({ ok: false, error: 'GPS tracking not enabled' });
	}

	const conn = getMysqlConnection();
	if (!conn) {
		return res.status(503).json({ ok: false, error: 'Database unavailable' });
	}

	const month = parseInt(req.query.month, 10);
	const day = parseInt(req.query.day, 10);
	const year = parseInt(req.query.year, 10);

	if (isNaN(month) || isNaN(day) || isNaN(year) || month < 0 || month > 11 || day < 1 || day > 31 || year < 2000 || year > 2050) {
		return res.status(400).json({ ok: false, error: 'Invalid date parameters' });
	}

	const dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');

	let rows;
	try {
		rows = await queryWithTimeout(conn, 'SELECT * FROM log_gps WHERE username = ? AND DATE(timestamp) = ? ORDER BY id DESC', [username, dateStr]);
	} catch (err) {
		logMessage(`[Presence API] Query failed: ${err.message || err}`);
		return res.status(504).json({ ok: false, error: 'Query failed' });
	}

	const markers = buildPresenceMarkersFromRows(rows);
	res.json({ ok: true, markers: markers });
});

app.get('/api/presence/nearby-days', async (req, res) => {
	const username = req.ohProxyUser;
	if (!username) {
		return res.status(401).json({ ok: false, error: 'Unauthorized' });
	}
	if (!req.ohProxyUserData?.trackgps) {
		return res.status(403).json({ ok: false, error: 'GPS tracking not enabled' });
	}

	const conn = getMysqlConnection();
	if (!conn) {
		return res.status(503).json({ ok: false, error: 'Database unavailable' });
	}

	const lat = parseFloat(req.query.lat);
	const lon = parseFloat(req.query.lon);
	const rawOffset = req.query.offset;
	const rawRadius = req.query.radius;
	const offset = rawOffset !== undefined ? parseInt(rawOffset, 10) : 0;
	const radius = rawRadius !== undefined ? parseInt(rawRadius, 10) : 100;

	if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
		return res.status(400).json({ ok: false, error: 'Invalid coordinates' });
	}
	if (!Number.isFinite(offset) || offset < 0 || offset > 10000) {
		return res.status(400).json({ ok: false, error: 'Invalid offset' });
	}
	if (!Number.isFinite(radius) || radius < 1 || radius > 50000) {
		return res.status(400).json({ ok: false, error: 'Invalid radius' });
	}

	const latDelta = radius / 111111;
	const cosLat = Math.cos(lat * Math.PI / 180);
	const lonDelta = cosLat > 1e-6 ? latDelta / cosLat : 360;
	const latMin = lat - latDelta;
	const latMax = lat + latDelta;
	const lonMin = lon - lonDelta;
	const lonMax = lon + lonDelta;

	let rows;
	try {
		rows = await queryWithTimeout(conn, 'SELECT lat, lon, timestamp, DATE(timestamp) AS day_date FROM log_gps WHERE username = ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? ORDER BY timestamp DESC LIMIT 5000', [username, latMin, latMax, lonMin, lonMax]);
	} catch (err) {
		logMessage(`[Nearby Days API] Query failed: ${err.message || err}`);
		return res.status(504).json({ ok: false, error: 'Query failed' });
	}

	const toRad = (deg) => deg * Math.PI / 180;
	const R = 6371000;
	const dayData = {};
	for (const row of rows) {
		const dLat = toRad(row.lat - lat);
		const dLon = toRad(row.lon - lon);
		const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(row.lat)) * Math.sin(dLon / 2) ** 2;
		const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
		if (dist <= radius) {
			const key = row.day_date instanceof Date ? row.day_date.getFullYear() + '-' + String(row.day_date.getMonth() + 1).padStart(2, '0') + '-' + String(row.day_date.getDate()).padStart(2, '0') : String(row.day_date);
			if (!dayData[key]) {
				dayData[key] = { count: 0, lat: row.lat, lon: row.lon, timestamp: row.timestamp };
			}
			dayData[key].count++;
		}
	}

	const sorted = Object.entries(dayData).sort((a, b) => b[0].localeCompare(a[0]));
	const page = sorted.slice(offset, offset + 5);
	const dateFormat = liveConfig.clientConfig?.dateFormat || 'MMM Do, YYYY';
	const timeFormat = liveConfig.clientConfig?.timeFormat || 'H:mm:ss';
	const days = page.map(([dateStr, data]) => {
		const parts = dateStr.split('-');
		const d = data.timestamp instanceof Date ? data.timestamp : new Date(data.timestamp);
		const formattedDate = formatDT(d, dateFormat);
		const formattedTime = formatDT(d, timeFormat);
		return { year: parseInt(parts[0], 10), month: parseInt(parts[1], 10) - 1, day: parseInt(parts[2], 10), label: dateStr, count: data.count, lat: data.lat, lon: data.lon, tooltip: '<div class="tt-date">' + formattedDate + '</div><div class="tt-time">' + formattedTime + '</div>' };
	});

	res.json({ ok: true, days, hasMore: sorted.length > offset + 5 });
});

app.get('/presence', async (req, res) => {
	const username = req.ohProxyUser;
	if (!username) {
		return sendStyledError(res, req, 401);
	}
	if (!req.ohProxyUserData) {
		return sendStyledError(res, req, 403);
	}
	const user = req.ohProxyUserData;

	const rawLat = req.query?.lat;
	const rawLon = req.query?.lon;
	const hasLat = rawLat !== undefined;
	const hasLon = rawLon !== undefined;
	if (hasLat !== hasLon) {
		return sendStyledError(res, req, 400, 'Both lat and lon are required');
	}

	let singlePointMode = false;
	let singlePointLat = null;
	let singlePointLon = null;
	if (hasLat && hasLon) {
		if (typeof rawLat !== 'string' || typeof rawLon !== 'string') {
			return sendStyledError(res, req, 400, 'Invalid lat/lon');
		}
		const parsedLat = Number(rawLat.trim());
		const parsedLon = Number(rawLon.trim());
		if (
			!Number.isFinite(parsedLat)
			|| parsedLat < -90
			|| parsedLat > 90
			|| !Number.isFinite(parsedLon)
			|| parsedLon < -180
			|| parsedLon > 180
		) {
			return sendStyledError(res, req, 400, 'Invalid lat/lon');
		}
		singlePointMode = true;
		singlePointLat = parsedLat;
		singlePointLon = parsedLon;
	}

	// History mode requires GPS tracking; single-point viewer mode does not.
	if (!singlePointMode && !user.trackgps) {
		return sendStyledError(res, req, 403);
	}

	let conn = null;
	if (!singlePointMode) {
		conn = getMysqlConnection();
		if (!conn) {
			return sendStyledError(res, req, 503);
		}
	}

	let rows = [];
	let displayDate = new Date();
	if (!singlePointMode) {
		try {
			// Try today first
			rows = await queryWithTimeout(conn, 'SELECT * FROM log_gps WHERE username = ? AND DATE(timestamp) = CURDATE() ORDER BY id DESC', [username]);

			// If no results for today, fall back to the most recent date with data
			if (!rows.length) {
				const fallbackRows = await queryWithTimeout(conn, 'SELECT * FROM log_gps WHERE username = ? ORDER BY timestamp DESC LIMIT 1', [username]);
				if (fallbackRows.length && fallbackRows[0].timestamp) {
					displayDate = new Date(fallbackRows[0].timestamp);
					const dateStr = displayDate.toISOString().slice(0, 10);
					rows = await queryWithTimeout(conn, 'SELECT * FROM log_gps WHERE username = ? AND DATE(timestamp) = ? ORDER BY id DESC', [username, dateStr]);
				}
			}
		} catch (err) {
			logMessage(`[Presence] Query failed: ${err.message || err}`);
			return sendStyledError(res, req, 504);
		}
	}

	const markers = [];
	if (singlePointMode) {
		const lat = roundPresenceCoord(singlePointLat);
		const lon = roundPresenceCoord(singlePointLon);
		markers.push([lat, lon, 'red', '']);
	} else {
		markers.push(...buildPresenceMarkersFromRows(rows));
	}

	const markersJson = JSON.stringify(markers).replace(/</g, '\\u003c');

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
.olControlZoom{display:none!important}
	#map-controls{position:fixed;top:16px;left:16px;z-index:150;background:rgb(245,246,250);border:1px solid rgba(150,150,150,0.3);border-radius:18px;box-shadow:0 12px 20px rgba(0,0,0,0.1),3px 3px 0.5px -3.5px rgba(255,255,255,0.15) inset,-2px -2px 0.5px -2px rgba(255,255,255,0.1) inset,0 0 8px 1px rgba(255,255,255,0.06) inset,0 0 2px 0 rgba(0,0,0,0.18);padding:6px;display:flex;flex-direction:column;gap:4px}
	@media(pointer:coarse){#map-controls{background:none;border:none;box-shadow:none;padding:0;gap:6px}}
	@media(pointer:coarse){#presence-root.presence-fs-search-visible #map-controls{background:rgb(245,246,250);border:1px solid rgba(150,150,150,0.3);box-shadow:0 12px 20px rgba(0,0,0,0.1),3px 3px 0.5px -3.5px rgba(255,255,255,0.15) inset,-2px -2px 0.5px -2px rgba(255,255,255,0.1) inset,0 0 8px 1px rgba(255,255,255,0.06) inset,0 0 2px 0 rgba(0,0,0,0.18);padding:6px;gap:4px}}
.map-ctrl-btn{width:36px;height:36px;border-radius:10px;border:1px solid rgba(19,21,54,0.2);background:rgba(19,21,54,0.12);color:#0f172a;font-size:18px;font-weight:300;font-family:'Rubik',sans-serif;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;outline:none;transition:background-color .4s ease,border-color .4s ease,box-shadow .4s ease}
	@media(hover:hover){.map-ctrl-btn:hover{background:rgba(78,183,128,0.12);border-color:rgba(78,183,128,0.45);box-shadow:0 0 10px rgba(78,183,128,0.35)}}
	@media(pointer:coarse){.map-ctrl-btn:hover{background:rgba(19,21,54,0.12);border-color:rgba(19,21,54,0.2);box-shadow:none}}
	.map-ctrl-btn svg{width:16px;height:16px;fill:currentColor}
	#presence-root{position:fixed;top:0;left:0;width:100vw;height:100vh;overflow:hidden;transform-origin:center center}
	#presence-root.presence-rotated{top:50%;left:50%;width:100vh;height:100vw;transform:translate(-50%,-50%) rotate(90deg)}
	#map{position:absolute;top:0;left:0;right:0;bottom:0;z-index:0}
	body{margin:0;padding:0;overflow:hidden}
	html,body{width:100%;height:100%;overscroll-behavior:none}
	html,body,#presence-root,#map{overscroll-behavior:none}
	.tooltip{position:absolute;background:#f1f2f9;border:1px solid #ccccd1;border-radius:10px;padding:0.5rem 0.75rem;font-size:.7rem;line-height:1.5;font-family:'Rubik',sans-serif;color:#0f172a;pointer-events:none;user-select:none;z-index:100;white-space:nowrap;box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.08),0 4px 6px -4px rgb(0 0 0 / 0.05)}
.tooltip .tt-date{font-weight:500}
.tooltip .tt-time{font-weight:300;margin-top:0.125rem}
#hover-tooltip{display:none}
#preview-tooltip{display:none}
.ctx-drag-handle{cursor:move;user-select:none}
	@media(max-width:767px){#search-modal{display:none!important}}
	@media(max-width:767px){#presence-root.presence-fs-search-visible #search-modal{display:block!important}}
#search-modal{position:fixed;top:16px;right:16px;z-index:150;background:rgb(245,246,250);border:1px solid rgba(150,150,150,0.3);border-radius:18px;box-shadow:0 12px 20px rgba(0,0,0,0.1),3px 3px 0.5px -3.5px rgba(255,255,255,0.15) inset,-2px -2px 0.5px -2px rgba(255,255,255,0.1) inset,0 0 8px 1px rgba(255,255,255,0.06) inset,0 0 2px 0 rgba(0,0,0,0.18);padding:12px;font-family:'Rubik',sans-serif}
.search-header{display:flex;justify-content:space-between;align-items:center;font-size:0.625rem;font-weight:500;letter-spacing:0.08em;color:rgba(19,21,54,0.5);margin-bottom:8px}
.search-today{cursor:pointer}
.search-controls{display:flex;gap:6px;align-items:center}
.search-controls button,.search-controls input{box-sizing:border-box;height:36px;padding:0 12px;font-size:.75rem;font-weight:300;font-family:'Rubik',sans-serif;color:#0f172a;background:rgba(19,21,54,0.08);border:1px solid rgba(19,21,54,0.2);border-radius:10px;cursor:pointer;transition:background-color .4s ease,border-color .4s ease,box-shadow .4s ease;outline:none}
	@media(hover:hover){.search-controls button:hover,.search-controls input:hover{background:rgba(78,183,128,0.12);border-color:rgba(78,183,128,0.45);box-shadow:0 0 10px rgba(78,183,128,0.35)}}
.search-controls input{background:rgba(255,255,255,0.7);box-shadow:inset 0 1px 3px rgba(0,0,0,0.08);cursor:text}
	@media(pointer:coarse){.search-controls button:hover{background:rgba(19,21,54,0.08);border-color:rgba(19,21,54,0.2);box-shadow:none}}
	@media(pointer:coarse){.search-controls input:hover{background:rgba(255,255,255,0.7);border-color:rgba(19,21,54,0.2);box-shadow:inset 0 1px 3px rgba(0,0,0,0.08)}}
.search-controls input:focus{border-color:rgba(78,183,128,0.45);box-shadow:0 0 10px rgba(78,183,128,0.35),inset 0 1px 3px rgba(0,0,0,0.08)}
.search-controls input.search-dd{width:48px;text-align:center}
.search-controls input.search-yyyy{width:64px;text-align:center}
.month-select{position:relative}
.month-select-btn{min-width:60px;text-align:center;white-space:nowrap}
.month-select-btn.active{background:rgba(78,183,128,0.12);border-color:rgba(78,183,128,0.45);box-shadow:0 0 8px rgba(78,183,128,0.35)}
.month-select-menu{position:fixed;z-index:200;background:rgb(245,246,250);border:1px solid rgba(150,150,150,0.3);border-radius:10px;box-shadow:0 8px 16px rgba(0,0,0,0.12);padding:0;overflow:hidden;opacity:0;visibility:hidden;pointer-events:none;transition:opacity 0.4s ease,visibility 0.4s ease}
.month-select-menu.open{opacity:1;visibility:visible;pointer-events:auto}
.month-select-menu div{padding:6px 16px;font-size:.75rem;font-weight:300;font-family:'Rubik',sans-serif;color:#0f172a;cursor:pointer;white-space:nowrap;text-align:center}
.month-select-menu div:first-child{padding-top:8px}
.month-select-menu div:last-child{padding-bottom:8px}
.month-select-menu div:hover{background:rgba(78,183,128,0.12)}
.month-select-menu div.selected{background:rgba(78,183,128,0.12);font-weight:500}
.search-go{}
.search-empty{display:none;font-size:0.625rem;font-weight:300;letter-spacing:0.08em;color:rgba(19,21,54,0.5);padding:0 0 8px;font-family:'Rubik',sans-serif}
@media(max-width:767px){#ctx-menu{display:none!important}}
#ctx-menu{display:none;position:absolute;z-index:200;background:rgb(245,246,250);border:1px solid rgba(150,150,150,0.3);border-radius:18px;box-shadow:0 12px 20px rgba(0,0,0,0.1),3px 3px 0.5px -3.5px rgba(255,255,255,0.15) inset,-2px -2px 0.5px -2px rgba(255,255,255,0.1) inset,0 0 8px 1px rgba(255,255,255,0.06) inset,0 0 2px 0 rgba(0,0,0,0.18);padding:12px;font-family:'Rubik',sans-serif;min-width:160px}
.ctx-header{display:flex;align-items:center;justify-content:space-between;font-size:0.625rem;font-weight:500;letter-spacing:0.08em;color:rgba(19,21,54,0.5);margin-bottom:8px}
.ctx-actions{display:flex;align-items:center}
.ctx-radius-wrap{display:flex;align-items:center}
.ctx-radius{box-sizing:content-box;padding:1px 1px 1px 0;margin-right:2px;font-size:0.625rem;font-weight:500;letter-spacing:0;color:rgba(19,21,54,0.5);font-family:'Rubik',sans-serif;background:none;border:none;border-bottom:1px solid rgba(19,21,54,0.2);outline:none;text-align:right;transition:border-color .4s ease}
.ctx-radius:focus{border-bottom-color:rgba(78,183,128,0.45)}
.ctx-close{margin-left:8px;padding:0;border:none;background:none;font-size:0.625rem;font-weight:500;letter-spacing:0.08em;line-height:1;color:rgba(19,21,54,0.5);font-family:'Rubik',sans-serif;cursor:pointer;transition:color .4s ease}
.ctx-close:hover{color:rgba(19,21,54,0.8)}
.ctx-day{display:flex;align-items:center;justify-content:space-between;padding:6px 0;cursor:pointer;font-size:.75rem;font-weight:300;font-family:'Rubik',sans-serif;color:#0f172a}
.ctx-count{font-size:0.625rem;color:rgba(19,21,54,0.4);margin-left:12px;white-space:nowrap}
.ctx-older,.ctx-newer{box-sizing:border-box;display:block;width:100%;height:36px;padding:0 12px;margin-top:8px;font-size:.75rem;font-weight:300;font-family:'Rubik',sans-serif;color:#0f172a;background:rgba(19,21,54,0.08);border:1px solid rgba(19,21,54,0.2);border-radius:10px;cursor:pointer;transition:background-color .4s ease,border-color .4s ease,box-shadow .4s ease;outline:none}
.ctx-older:hover,.ctx-newer:hover{background:rgba(78,183,128,0.12);border-color:rgba(78,183,128,0.45);box-shadow:0 0 10px rgba(78,183,128,0.35)}
.ctx-nav{display:flex;gap:6px;margin-top:8px}
.ctx-nav .ctx-older,.ctx-nav .ctx-newer{margin-top:0}
.ctx-empty,.ctx-loading{font-size:0.625rem;font-weight:300;letter-spacing:0.08em;color:rgba(19,21,54,0.5);font-family:'Rubik',sans-serif}
#map-fullscreen{display:none}
#map-rotate{display:none}
@keyframes shake{0%,100%{transform:translateX(0)}10%,30%,50%,70%,90%{transform:translateX(-5px)}20%,40%,60%,80%{transform:translateX(5px)}}
.shake{animation:shake 0.5s ease-in-out}
</style>
	<script src="/vendor/OpenLayers.js"></script>
	</head>
	<body>
	<div id="presence-root">
	<div id="map"></div>
	${singlePointMode ? '' : `<div id="red-tooltip" class="tooltip"></div>
	<div id="hover-tooltip" class="tooltip"></div>
	<div id="preview-tooltip" class="tooltip"></div>
	<div id="ctx-menu"></div>`}
	<div id="map-controls">
	<button class="map-ctrl-btn" id="zoom-in" type="button">+</button>
	<button class="map-ctrl-btn" id="zoom-home" type="button"><svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"/></svg></button>
	<button class="map-ctrl-btn" id="map-fullscreen" type="button"><svg viewBox="0 0 24 24"><path d="M3 3h6v2H5v4H3V3zm12 0h6v6h-2V5h-4V3zM3 15h2v4h4v2H3v-6zm16 0h2v6h-6v-2h4v-4z"/></svg></button>
	<button class="map-ctrl-btn" id="map-rotate" type="button"><svg viewBox="0 0 24 24"><path d="M12 5V2L8 6l4 4V7c3.31 0 6 2.69 6 6 0 1.01-.25 1.96-.7 2.8l1.46 1.46A7.944 7.944 0 0 0 20 13c0-4.42-3.58-8-8-8zM6.7 9.2 5.24 7.74A7.944 7.944 0 0 0 4 13c0 4.42 3.58 8 8 8v3l4-4-4-4v3c-3.31 0-6-2.69-6-6 0-1.01.25-1.96.7-2.8z"/></svg></button>
	<button class="map-ctrl-btn" id="zoom-out" type="button">&minus;</button>
	</div>
	${singlePointMode ? '' : `<div id="search-modal">
	<div class="search-header"><span>SEARCH HISTORY</span><span class="search-today">TODAY</span></div>
	<div class="search-empty">No results found</div>
	<div class="search-controls">
	<div class="month-select"><button class="month-select-btn" type="button">Month</button><div class="month-select-menu" id="month-menu"></div></div>
	<input type="text" class="search-dd" placeholder="DD" maxlength="2">
	<input type="text" class="search-yyyy" placeholder="YYYY" maxlength="4">
	<button class="search-go" type="button">Search</button>
	</div>
	</div>`}
	</div>
	<script>
	(function(){
	var markers=${markersJson};
	var singlePointMode=${singlePointMode ? 'true' : 'false'};

	var map=new OpenLayers.Map("map",{theme:null});
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

	var previewLayer=null;
	if(!singlePointMode){
	previewLayer=new OpenLayers.Layer.Vector("Preview",{
	styleMap:new OpenLayers.StyleMap({
	"default":new OpenLayers.Style({
	externalGraphic:'/images/marker-blue.png',
	graphicHeight:41,
	graphicWidth:25,
	graphicXOffset:-12,
	graphicYOffset:-41,
	graphicOpacity:0.5,
	cursor:'pointer'
	})
	})
	});
	map.addLayer(previewLayer);
	}

	var previewTooltip=singlePointMode?null:document.getElementById('preview-tooltip');
	var hoverTooltip=singlePointMode?null:document.getElementById('hover-tooltip');
	var red=markers.length?markers[markers.length-1]:null;
	var redTooltip=singlePointMode?null:document.getElementById('red-tooltip');
	var mapEl=document.getElementById('map');
	var isTouchDevice=('ontouchstart' in window)||navigator.maxTouchPoints>0;
	var presenceFullscreenActive=false;
	var presenceRotated=false;
	var rotatedPanTracking=false;
	var rotatedPanMoved=false;
	var rotatedPanLastX=0;
	var rotatedPanLastY=0;
	var updateFullscreenSearchVisibility=function(){};
	function isRotatedTouchPanMode(){
	return isTouchDevice&&presenceFullscreenActive&&presenceRotated;
	}
	function isRotatedViewportMode(){
	return presenceFullscreenActive&&presenceRotated;
	}
	function clientToMapPixel(clientX,clientY){
	var rect=mapEl.getBoundingClientRect();
	var rectW=rect.width||1;
	var rectH=rect.height||1;
	var localW=mapEl.clientWidth||rectW;
	var localH=mapEl.clientHeight||rectH;
	var relX=Math.max(0,Math.min(rectW,clientX-rect.left));
	var relY=Math.max(0,Math.min(rectH,clientY-rect.top));
	var x=(relX/rectW)*localW;
	var y=(relY/rectH)*localH;
	if(isRotatedViewportMode()){
	// Inverse of CSS rotate(90deg): screen x follows local y, screen y follows inverted local x.
	var mappedX=(relY/rectH)*localW;
	var mappedY=((rectW-relX)/rectW)*localH;
	x=mappedX;
	y=mappedY;
	}
	return new OpenLayers.Pixel(x,y);
	}
	var originalGetMousePosition=map.events.getMousePosition;
	map.events.getMousePosition=function(evt){
	if(isRotatedViewportMode()&&evt&&typeof evt.clientX==='number'&&typeof evt.clientY==='number'){
	return clientToMapPixel(evt.clientX,evt.clientY);
	}
	return originalGetMousePosition.call(this,evt);
	};
	mapEl.addEventListener('wheel',function(e){e.preventDefault()},{passive:false});
	mapEl.addEventListener('mousewheel',function(e){e.preventDefault()},{passive:false});
	mapEl.addEventListener('touchstart',function(e){
	if(!isRotatedTouchPanMode()||!e.touches||e.touches.length!==1){
	rotatedPanTracking=false;
	rotatedPanMoved=false;
	return;
	}
	rotatedPanTracking=true;
	rotatedPanMoved=false;
	rotatedPanLastX=e.touches[0].clientX;
	rotatedPanLastY=e.touches[0].clientY;
	},{passive:true,capture:true});
	mapEl.addEventListener('touchmove',function(e){
	if(!rotatedPanTracking||!isRotatedTouchPanMode()||!e.touches||e.touches.length!==1)return;
	var x=e.touches[0].clientX;
	var y=e.touches[0].clientY;
	var dx=x-rotatedPanLastX;
	var dy=y-rotatedPanLastY;
	rotatedPanLastX=x;
	rotatedPanLastY=y;
	if(!dx&&!dy)return;
	rotatedPanMoved=true;
	// Remap touch movement to match rotated (90deg) viewport direction.
	map.pan(-dy,dx,{animate:false});
	e.preventDefault();
	e.stopPropagation();
	},{passive:false,capture:true});
	mapEl.addEventListener('touchend',function(e){
	if(!rotatedPanTracking)return;
	var moved=rotatedPanMoved;
	rotatedPanTracking=false;
	rotatedPanMoved=false;
	if(moved){
	e.preventDefault();
	e.stopPropagation();
	}
	},{passive:false,capture:true});
	mapEl.addEventListener('touchcancel',function(e){
	if(!rotatedPanTracking)return;
	rotatedPanTracking=false;
	rotatedPanMoved=false;
	e.preventDefault();
	e.stopPropagation();
	},{passive:false,capture:true});
	var tooltipOffsets={redAnchor:{x:15,y:-60},blueAnchor:{x:15,y:-55},pointer:{x:15,y:15}};
	var lastClickFeature=null;
	var lastClickTime=0;
	var suppressFeatureClickUntil=0;
	var blueTooltipFeature=null;
	var blueTooltipPinned=false;
	if(!singlePointMode&&red&&redTooltip)setTooltipHtml(redTooltip,red[3]);

	function setTooltipHtml(el,html){
	if(!el)return;
	el.innerHTML=html||'';
	}

	function showTooltip(el){
	if(!el)return;
	el.style.display='block';
	}

	function hideTooltip(el){
	if(!el)return;
	el.style.display='none';
	}

	function isTooltipVisible(el){
	return !!(el&&el.style.display==='block');
	}

	function positionTooltip(el,px,offset){
	if(!el||!px||!offset)return;
	el.style.left=(px.x+offset.x)+'px';
	el.style.top=(px.y+offset.y)+'px';
	}

	function getFeaturePixel(f){
	if(!f||!f.geometry)return null;
	return map.getPixelFromLonLat(new OpenLayers.LonLat(f.geometry.x,f.geometry.y));
	}

	function positionTooltipForFeature(el,f,offset){
	positionTooltip(el,getFeaturePixel(f),offset);
	}

	function updateRedTooltip(){
	if(singlePointMode||!red||!redTooltip)return;
	var lonlat=new OpenLayers.LonLat(red[1],red[0]).transform(wgs84,proj);
	positionTooltip(redTooltip,map.getPixelFromLonLat(lonlat),tooltipOffsets.redAnchor);
	}

	function updateBluePinnedTooltip(){
	if(!blueTooltipPinned||!blueTooltipFeature||!isTooltipVisible(hoverTooltip))return;
	positionTooltipForFeature(hoverTooltip,blueTooltipFeature,tooltipOffsets.blueAnchor);
	}

	function updateAnchoredTooltips(){
	updateRedTooltip();
	updateBluePinnedTooltip();
	}

	function resetBlueTooltip(){
	hideTooltip(hoverTooltip);
	blueTooltipPinned=false;
	blueTooltipFeature=null;
	}

	function showBlueTooltip(f,px,pinToFeature){
	if(singlePointMode||!hoverTooltip||!f||f.layer!==vector||f.attributes.color!=='blue'||!f.attributes.timestamp)return false;
	setTooltipHtml(hoverTooltip,f.attributes.timestamp);
	var shouldAnchor=!!pinToFeature||blueTooltipPinned;
	var offset=shouldAnchor||!px?tooltipOffsets.blueAnchor:tooltipOffsets.pointer;
	positionTooltip(hoverTooltip,px||getFeaturePixel(f),offset);
	showTooltip(hoverTooltip);
	if(pinToFeature){
	blueTooltipPinned=true;
	blueTooltipFeature=f;
	}else if(!blueTooltipPinned){
	blueTooltipFeature=null;
	}
	return true;
	}

	function showPreviewTooltip(f){
	if(singlePointMode||!previewTooltip||!f||f.layer!==previewLayer||!f.attributes.tooltip)return;
	setTooltipHtml(previewTooltip,f.attributes.tooltip);
	showTooltip(previewTooltip);
	}

	function hidePreviewTooltip(){
	hideTooltip(previewTooltip);
	}

	function positionPointerTooltips(px){
	if(isTooltipVisible(previewTooltip))positionTooltip(previewTooltip,px,tooltipOffsets.pointer);
	if(isTooltipVisible(hoverTooltip)&&!blueTooltipPinned)positionTooltip(hoverTooltip,px,tooltipOffsets.pointer);
	}

	function eventToPixel(e){
	return clientToMapPixel(e.clientX,e.clientY);
	}

	function findBlueFeatureNearPixel(px,maxDistance){
	if(!px)return null;
	var maxSq=maxDistance*maxDistance;
	var nearest=null;
	for(var i=0;i<vector.features.length;i++){
	var f=vector.features[i];
	if(!f||!f.attributes||f.attributes.color!=='blue')continue;
	var fp=getFeaturePixel(f);
	if(!fp)continue;
	var dx=fp.x-px.x;
	var dy=fp.y-px.y;
	var distSq=dx*dx+dy*dy;
	if(distSq<=maxSq){
	maxSq=distSq;
	nearest=f;
	}
	}
	return nearest;
	}

	function clearBlueTooltipSelectionState(){
	resetBlueTooltip();
	lastClickFeature=null;lastClickTime=0;
	mapEl.style.cursor='';
	}

	function showBlueAndHandleClick(f,px,pinToFeature){
	if(!showBlueTooltip(f,px,pinToFeature))return;
	var now=Date.now();
	if(lastClickFeature===f&&now-lastClickTime<400){
	var center=new OpenLayers.LonLat(f.geometry.x,f.geometry.y);
	var zoom=Math.min(map.getNumZoomLevels()-1,map.getZoom()+3);
	map.setCenter(center,zoom);
	lastClickFeature=null;lastClickTime=0;
	}else{
	lastClickFeature=f;lastClickTime=now;
	}
	}

	if(!singlePointMode){
	var hoverControl=new OpenLayers.Control.SelectFeature([previewLayer,vector],{
	hover:true,
	highlightOnly:true,
	overFeature:function(f){
	if(f.layer===previewLayer&&f.attributes.tooltip){
showPreviewTooltip(f);
mapEl.style.cursor='pointer';
}else if(f.layer===vector&&f.attributes.color==='blue'){
mapEl.style.cursor='pointer';
}
},
outFeature:function(f){
if(f.layer===previewLayer){
hidePreviewTooltip();
mapEl.style.cursor='';
}else if(f.layer===vector&&f.attributes.color==='blue'){
mapEl.style.cursor='';
}
},
clickFeature:function(f){
if(Date.now()<suppressFeatureClickUntil)return;
if(f.layer===previewLayer){
loadDayFromCtx(f.attributes.month,f.attributes.day,f.attributes.year);
}else if(f.layer===vector&&f.attributes.color==='blue'){
showBlueAndHandleClick(f,null,true);
}
}
	});
	map.addControl(hoverControl);
	hoverControl.activate();
	}

	if(!singlePointMode){
	map.events.register('mousemove',map,function(e){
	positionPointerTooltips(e.xy);
	});
	}

	if(!singlePointMode&&isTouchDevice){
	var touchStartPx=null;
	var touchMoved=false;
	mapEl.addEventListener('touchstart',function(e){
	if(e.touches.length!==1)return;
	touchStartPx=clientToMapPixel(e.touches[0].clientX,e.touches[0].clientY);
	touchMoved=false;
	},{passive:true});
	mapEl.addEventListener('touchmove',function(e){
	if(!touchStartPx||e.touches.length!==1)return;
	var movePx=clientToMapPixel(e.touches[0].clientX,e.touches[0].clientY);
	var dx=movePx.x-touchStartPx.x;
	var dy=movePx.y-touchStartPx.y;
	if(dx*dx+dy*dy>100)touchMoved=true;
	},{passive:true});
	mapEl.addEventListener('touchend',function(e){
	if(!touchStartPx)return;
	var startPx=touchStartPx;
	touchStartPx=null;
	if(touchMoved||!e.changedTouches||!e.changedTouches.length)return;
	var endPx=clientToMapPixel(e.changedTouches[0].clientX,e.changedTouches[0].clientY);
	var dx=endPx.x-startPx.x;
	var dy=endPx.y-startPx.y;
	if(dx*dx+dy*dy>100)return;
	var f=findBlueFeatureNearPixel(endPx,36);
	if(f){
	suppressFeatureClickUntil=Date.now()+450;
	showBlueAndHandleClick(f,endPx,true);
	}else{
	clearBlueTooltipSelectionState();
	}
	},{passive:true});
	mapEl.addEventListener('touchcancel',function(){
	touchStartPx=null;
	touchMoved=false;
	},{passive:true});
	}

	if(!singlePointMode){
	map.events.register('move',map,updateAnchoredTooltips);
	map.events.register('moveend',map,updateAnchoredTooltips);
	map.events.register('zoomend',map,updateAnchoredTooltips);
	}

function zoomToMarkers(){
var extent=vector.getDataExtent();
if(!extent)return;
if(markers.length===1){map.setCenter(new OpenLayers.LonLat(red[1],red[0]).transform(wgs84,proj),15);return}
var res=map.getResolutionForZoom(map.getZoomForExtent(extent));
extent.left-=30*res;extent.right+=30*res;
extent.top+=50*res;extent.bottom-=15*res;
map.zoomToExtent(extent);
}

	if(markers.length){
	zoomToMarkers();
	if(!singlePointMode)setTimeout(updateAnchoredTooltips,100);
	}

document.getElementById('zoom-in').addEventListener('click',function(){map.zoomIn()});
document.getElementById('zoom-out').addEventListener('click',function(){map.zoomOut()});
	document.getElementById('zoom-home').addEventListener('click',function(){
	if(red){
	map.setCenter(new OpenLayers.LonLat(red[1],red[0]).transform(wgs84,proj));
	}
	});

	(function(){
	if(window===window.top)return;
	var fsBtn=document.getElementById('map-fullscreen');
	var rotateBtn=document.getElementById('map-rotate');
	var presenceRoot=document.getElementById('presence-root');
	fsBtn.style.display='flex';
	var fsActive=false;
	var isRotated=false;
	var expandSvg='<svg viewBox="0 0 24 24"><path d="M3 3h6v2H5v4H3V3zm12 0h6v6h-2V5h-4V3zM3 15h2v4h4v2H3v-6zm16 0h2v6h-6v-2h4v-4z"/></svg>';
	var minimizeSvg='<svg viewBox="0 0 24 24"><path d="M9 3v6H3V7h4V3h2zm6 0h2v4h4v2h-6V3zM3 15h6v6H7v-4H3v-2zm12 0h6v2h-4v4h-2v-6z"/></svg>';
		function scheduleMapReflow(){
		setTimeout(function(){
		map.updateSize();
		if(!singlePointMode)updateAnchoredTooltips();
		updateFullscreenSearchVisibility();
		},60);
		}
	function applyRotation(){
	if(isRotated){
	presenceRoot.classList.add('presence-rotated');
	presenceRotated=true;
	}else{
	presenceRoot.classList.remove('presence-rotated');
	presenceRotated=false;
	}
	scheduleMapReflow();
	}
	function syncRotateButton(){
	rotateBtn.style.display=(isTouchDevice&&fsActive)?'flex':'none';
	}
	rotateBtn.addEventListener('click',function(){
	if(!isTouchDevice||!fsActive)return;
	isRotated=!isRotated;
	applyRotation();
	});
	fsBtn.addEventListener('click',function(){
	if(!fsActive){
	window.parent.postMessage({type:'ohproxy-fullscreen-request'},'*');
	}else{
	window.parent.postMessage({type:'ohproxy-fullscreen-exit'},'*');
	}
	});
		window.addEventListener('message',function(e){
		if(!e.data||e.data.type!=='ohproxy-fullscreen-state')return;
		fsActive=!!e.data.active;
		presenceFullscreenActive=fsActive;
		fsBtn.innerHTML=fsActive?minimizeSvg:expandSvg;
	if(!fsActive){
	isRotated=false;
	applyRotation();
	}else{
	scheduleMapReflow();
		}
		syncRotateButton();
		updateFullscreenSearchVisibility();
		});
		syncRotateButton();
		})();

		if(!singlePointMode){
		var presenceRoot=document.getElementById('presence-root');
		var searchModal=document.getElementById('search-modal');
		var mapControls=document.getElementById('map-controls');
		var searchVisibilityClass='presence-fs-search-visible';
		var searchVisibilityGap=8;
		var searchVisibilityRaf=0;
		var searchVisibilityResizeBound=false;

		function isSpaceConstrainedViewport(){
		return window.matchMedia('(max-width:767px)').matches;
		}

		function computeSearchModalFullscreenFit(){
		if(!presenceRoot||!searchModal||!mapControls)return false;
		var rootRect=presenceRoot.getBoundingClientRect();
		if(!rootRect.width||!rootRect.height)return false;
		var hadClass=presenceRoot.classList.contains(searchVisibilityClass);
		var prevVisibility=searchModal.style.visibility;
		var prevPointerEvents=searchModal.style.pointerEvents;
		searchModal.style.visibility='hidden';
		searchModal.style.pointerEvents='none';
		if(!hadClass)presenceRoot.classList.add(searchVisibilityClass);
		var modalRect=searchModal.getBoundingClientRect();
		var controlsRect=mapControls.getBoundingClientRect();
		searchModal.style.visibility=prevVisibility;
		searchModal.style.pointerEvents=prevPointerEvents;
		if(!hadClass)presenceRoot.classList.remove(searchVisibilityClass);
		if(!modalRect.width||!modalRect.height)return false;
		var fitsRootBounds=modalRect.left>=rootRect.left+8&&modalRect.right<=rootRect.right-8&&modalRect.top>=rootRect.top+8&&modalRect.bottom<=rootRect.bottom-8;
		var clearOfControls=
		controlsRect.right+searchVisibilityGap<=modalRect.left||
		modalRect.right+searchVisibilityGap<=controlsRect.left||
		controlsRect.bottom+searchVisibilityGap<=modalRect.top||
		modalRect.bottom+searchVisibilityGap<=controlsRect.top;
		return fitsRootBounds&&clearOfControls;
		}

		function updateSearchModalFullscreenVisibility(){
		var shouldShow=presenceFullscreenActive&&isSpaceConstrainedViewport()&&computeSearchModalFullscreenFit();
		presenceRoot.classList.toggle(searchVisibilityClass,shouldShow);
		}

		function queueSearchModalFullscreenVisibilityUpdate(){
		if(searchVisibilityRaf)cancelAnimationFrame(searchVisibilityRaf);
		searchVisibilityRaf=requestAnimationFrame(function(){
		searchVisibilityRaf=0;
		updateSearchModalFullscreenVisibility();
		});
		}

		updateFullscreenSearchVisibility=queueSearchModalFullscreenVisibilityUpdate;
		if(!searchVisibilityResizeBound){
		searchVisibilityResizeBound=true;
		window.addEventListener('resize',queueSearchModalFullscreenVisibilityUpdate);
		window.addEventListener('orientationchange',queueSearchModalFullscreenVisibilityUpdate);
		}
		queueSearchModalFullscreenVisibilityUpdate();
		searchModal.addEventListener('keydown',function(e){e.stopPropagation()});

var months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var displayMonth=${displayDate.getMonth()};
var displayDay=${displayDate.getDate()};
var displayYear=${displayDate.getFullYear()};
var monthBtn=document.querySelector('.month-select-btn');
var monthMenu=document.getElementById('month-menu');
var ddInput=document.querySelector('.search-dd');
var yyyyInput=document.querySelector('.search-yyyy');

monthBtn.textContent=months[displayMonth];
ddInput.value=String(displayDay);
yyyyInput.value=String(displayYear);

months.forEach(function(m,i){
var d=document.createElement('div');
d.textContent=m;
if(i===displayMonth)d.classList.add('selected');
d.addEventListener('click',function(){
monthBtn.textContent=m;
monthMenu.classList.remove('open');
monthBtn.classList.remove('active');
monthMenu.querySelectorAll('div').forEach(function(el){el.classList.remove('selected')});
d.classList.add('selected');
});
monthMenu.appendChild(d);
});
monthBtn.addEventListener('click',function(e){
e.stopPropagation();
var open=monthMenu.classList.contains('open');
if(open){monthMenu.classList.remove('open');monthBtn.classList.remove('active');return}
var r=monthBtn.getBoundingClientRect();
monthMenu.style.top=(r.bottom+4)+'px';
monthMenu.style.left=r.left+'px';
monthMenu.style.width=r.width+'px';
monthMenu.classList.add('open');
monthBtn.classList.add('active');
});
function closeMonthMenu(){monthMenu.classList.remove('open');monthBtn.classList.remove('active')}
document.addEventListener('click',closeMonthMenu);
monthMenu.addEventListener('click',function(e){e.stopPropagation()});

function setupInput(inp,validate){
var lastGood=inp.value;
inp.addEventListener('input',function(){
var v=inp.value;
if(!/^\\d*$/.test(v)){inp.value=lastGood;return}
if(v.length>1&&v[0]==='0')v=String(parseInt(v,10));
if(v!==''&&!validate(v)){inp.value=lastGood;return}
inp.value=v;
lastGood=v;
});
}
setupInput(ddInput,function(v){var n=parseInt(v,10);return n>=1&&n<=31});
	setupInput(yyyyInput,function(v){
	var n=parseInt(v,10);
	if(v.length===1)return n===2;
	if(v.length===2)return v==='20';
	if(v.length===3)return n>=200&&n<=205;
	return n>=2000&&n<=2050;
	});

	function isSearchDateInput(el){return el===ddInput||el===yyyyInput}
	var viewportHeightBaseline=(window.visualViewport&&window.visualViewport.height)||window.innerHeight;
	var keyboardWasOpen=false;
	var keyboardOpenThreshold=80;
	var keyboardCloseThreshold=24;
	function updateViewportHeightBaseline(currentHeight){if(currentHeight>viewportHeightBaseline)viewportHeightBaseline=currentHeight}
	function handleDateInputFocus(){
	var currentHeight=(window.visualViewport&&window.visualViewport.height)||window.innerHeight;
	updateViewportHeightBaseline(currentHeight);
	keyboardWasOpen=false;
	}
	function handleDateInputViewportResize(){
	var currentHeight=(window.visualViewport&&window.visualViewport.height)||window.innerHeight;
	var active=document.activeElement;
	if(!isSearchDateInput(active)){
	updateViewportHeightBaseline(currentHeight);
	keyboardWasOpen=false;
	return;
	}
	if(currentHeight<viewportHeightBaseline-keyboardOpenThreshold){
	keyboardWasOpen=true;
	return;
	}
	if(keyboardWasOpen&&currentHeight>=viewportHeightBaseline-keyboardCloseThreshold){
	active.blur();
	keyboardWasOpen=false;
	updateViewportHeightBaseline(currentHeight);
	}
	}
	ddInput.addEventListener('focus',handleDateInputFocus);
	yyyyInput.addEventListener('focus',handleDateInputFocus);
	if(window.visualViewport)window.visualViewport.addEventListener('resize',handleDateInputViewportResize);
	window.addEventListener('resize',handleDateInputViewportResize);
	function blurSearchDateInputsFromMapTouch(){
	if(!isTouchDevice)return;
	var active=document.activeElement;
	if(isSearchDateInput(active))active.blur();
	closeMonthMenu();
	}
	mapEl.addEventListener('touchstart',blurSearchDateInputsFromMapTouch,{passive:true,capture:true});

	ddInput.addEventListener('keydown',function(e){if(e.key==='Enter'&&ddInput.value)yyyyInput.focus()});
	yyyyInput.addEventListener('keydown',function(e){if(e.key==='Enter'&&yyyyInput.value.length===4)document.querySelector('.search-go').click()});

var searchEmpty=document.querySelector('.search-empty');
var searchModal=document.getElementById('search-modal');
function shakeSearch(){
searchModal.classList.remove('shake');
void searchModal.offsetWidth;
searchModal.classList.add('shake');
searchModal.addEventListener('animationend',function onEnd(){
searchModal.removeEventListener('animationend',onEnd);
searchModal.classList.remove('shake');
});
}
function loadDay(month,day,year){
fetch('/api/presence?month='+month+'&day='+day+'&year='+year).then(function(r){return r.json()}).then(function(data){
if(!data.ok){searchEmpty.textContent=data.error||'Request failed';searchEmpty.style.display='block';shakeSearch();return}
if(!data.markers.length){searchEmpty.textContent='No results found';searchEmpty.style.display='block';shakeSearch();return}
searchEmpty.style.display='none';
clearBlueTooltipSelectionState();
vector.removeAllFeatures();
previewLayer.removeAllFeatures();
markers=data.markers;
markers.forEach(function(m,i){
var feature=new OpenLayers.Feature.Vector(
new OpenLayers.Geometry.Point(m[1],m[0]).transform(wgs84,proj),
{timestamp:m[3],index:i,color:m[2]},{externalGraphic:'/images/marker-'+m[2]+'.png',graphicHeight:41,graphicWidth:25,graphicXOffset:-12,graphicYOffset:-41}
);
vector.addFeatures(feature);
});
red=markers[markers.length-1];
setTooltipHtml(redTooltip,red[3]);
zoomToMarkers();
setTimeout(updateAnchoredTooltips,100);
}).catch(function(){searchEmpty.textContent='Request failed';searchEmpty.style.display='block';shakeSearch()});
}

document.querySelector('.search-go').addEventListener('click',function(){
var selItem=monthMenu.querySelector('.selected');
if(!selItem)return;
var month=Array.prototype.indexOf.call(monthMenu.children,selItem);
var day=parseInt(ddInput.value,10);
var year=parseInt(yyyyInput.value,10);
if(isNaN(month)||isNaN(day)||isNaN(year)||!ddInput.value||!yyyyInput.value)return;
var maxDay=new Date(year,month+1,0).getDate();
if(day<1||day>maxDay)return;
var tomorrow=new Date();tomorrow.setDate(tomorrow.getDate()+1);tomorrow.setHours(0,0,0,0);
if(new Date(year,month,day)>=tomorrow){searchEmpty.textContent='No results found';searchEmpty.style.display='block';shakeSearch();return}
loadDay(month,day,year);
});

document.querySelector('.search-today').addEventListener('click',function(){
closeCtxMenu();
var now=new Date();var m=now.getMonth(),d=now.getDate(),y=now.getFullYear();
monthBtn.textContent=months[m];
monthMenu.querySelectorAll('div').forEach(function(el,i){if(i===m)el.classList.add('selected');else el.classList.remove('selected')});
ddInput.value=String(d);yyyyInput.value=String(y);
loadDay(m,d,y);
});

var ctxMenu=document.getElementById('ctx-menu');
var ctxLat=0,ctxLon=0,ctxOffset=0,ctxRadius=100;

function closeCtxMenu(){ctxMenu.style.display='none';previewLayer.removeAllFeatures();hidePreviewTooltip();document.getElementById('map').style.cursor=''}

var radiusCtx=document.createElement('canvas').getContext('2d');
function sizeRadius(inp){
radiusCtx.font=getComputedStyle(inp).font;
inp.style.width=Math.ceil(radiusCtx.measureText(inp.value||'0').width)+'px';
}

function bindRadiusInput(){
var inp=ctxMenu.querySelector('.ctx-radius');
if(!inp)return;
sizeRadius(inp);
inp.addEventListener('keydown',function(e){
if(e.key==='Enter'){
var v=parseInt(inp.value,10);
if(v>=1&&v<=50000){ctxRadius=v;ctxOffset=0;loadNearbyDays()}
}
e.stopPropagation();
});
inp.addEventListener('input',function(){
var v=inp.value.replace(/[^0-9]/g,'').replace(/^0+/,'');
if(v!==inp.value)inp.value=v;
sizeRadius(inp);
});
inp.addEventListener('click',function(e){e.stopPropagation()});
}

function bindCtxClose(){
var btn=ctxMenu.querySelector('.ctx-close');
if(!btn)return;
btn.addEventListener('click',function(e){
e.preventDefault();
e.stopPropagation();
closeCtxMenu();
});
}

function bindCtxHeaderControls(){
bindRadiusInput();
bindCtxDrag();
bindCtxClose();
}

function renderCtxMenuBody(bodyHtml){
ctxMenu.innerHTML=ctxHeader()+bodyHtml;
bindCtxHeaderControls();
}

function ctxHeader(){return '<div class="ctx-header"><span class="ctx-drag-handle">NEARBY DAYS</span><span class="ctx-actions"><span class="ctx-radius-wrap"><input class="ctx-radius" type="text" value="'+ctxRadius+'" maxlength="5">m</span><button class="ctx-close" type="button" aria-label="Close nearby days">X</button></span></div>'}

var ctxDragActive=false,ctxDragStartX=0,ctxDragStartY=0,ctxMenuStartX=0,ctxMenuStartY=0;
function bindCtxDrag(){
var handle=ctxMenu.querySelector('.ctx-drag-handle');
if(!handle)return;
handle.addEventListener('mousedown',function(e){
if(e.button!==0)return;
e.preventDefault();
e.stopPropagation();
ctxDragActive=true;
ctxDragStartX=e.clientX;
ctxDragStartY=e.clientY;
ctxMenuStartX=parseInt(ctxMenu.style.left)||0;
ctxMenuStartY=parseInt(ctxMenu.style.top)||0;
});
}
document.addEventListener('mousemove',function(e){
if(!ctxDragActive)return;
e.preventDefault();
e.stopPropagation();
var dx=e.clientX-ctxDragStartX;
var dy=e.clientY-ctxDragStartY;
var newX=ctxMenuStartX+dx;
var newY=ctxMenuStartY+dy;
var mapRect=document.getElementById('map').getBoundingClientRect();
var menuRect=ctxMenu.getBoundingClientRect();
var minX=8;
var minY=8;
var maxX=mapRect.width-menuRect.width-8;
var maxY=mapRect.height-menuRect.height-8;
ctxMenu.style.left=Math.max(minX,Math.min(maxX,newX))+'px';
ctxMenu.style.top=Math.max(minY,Math.min(maxY,newY))+'px';
},true);
document.addEventListener('mouseup',function(){ctxDragActive=false},true)

function loadNearbyDays(){
if(!ctxDragging){
renderCtxMenuBody('<div class="ctx-loading">Loading\\u2026</div>');
}
ctxMenu.style.display='block';
fetch('/api/presence/nearby-days?lat='+ctxLat+'&lon='+ctxLon+'&offset='+ctxOffset+'&radius='+ctxRadius).then(function(r){return r.json()}).then(function(data){
if(!data.ok){renderCtxMenuBody('<div class="ctx-empty">'+(data.error||'Request failed')+'</div>');previewLayer.removeAllFeatures();return}
var html='';
if(!data.days.length){renderCtxMenuBody('<div class="ctx-empty">No entries nearby</div>');previewLayer.removeAllFeatures();return}
data.days.forEach(function(d){
html+='<div class="ctx-day" data-month="'+d.month+'" data-day="'+d.day+'" data-year="'+d.year+'"><span>'+d.label+'</span><span class="ctx-count">'+d.count+'</span></div>';
});
var hasNewer=ctxOffset>0;
if(hasNewer||data.hasMore){
if(hasNewer&&data.hasMore)html+='<div class="ctx-nav">';
if(hasNewer)html+='<button class="ctx-newer" type="button">Newer \\u25B4</button>';
if(data.hasMore)html+='<button class="ctx-older" type="button">Older \\u25BE</button>';
if(hasNewer&&data.hasMore)html+='</div>';
}
renderCtxMenuBody(html);
previewLayer.removeAllFeatures();
data.days.forEach(function(d){
if(d.lat!==undefined&&d.lon!==undefined){
var feature=new OpenLayers.Feature.Vector(
new OpenLayers.Geometry.Point(d.lon,d.lat).transform(wgs84,proj),
{month:d.month,day:d.day,year:d.year,tooltip:d.tooltip}
);
previewLayer.addFeatures(feature);
}
});
ctxMenu.querySelectorAll('.ctx-day').forEach(function(el){
el.addEventListener('click',function(e){
e.stopPropagation();
loadDayFromCtx(parseInt(el.dataset.month,10),parseInt(el.dataset.day,10),parseInt(el.dataset.year,10));
});
});
var newerBtn=ctxMenu.querySelector('.ctx-newer');
if(newerBtn)newerBtn.addEventListener('click',function(e){e.stopPropagation();ctxOffset=Math.max(0,ctxOffset-5);loadNearbyDays()});
var olderBtn=ctxMenu.querySelector('.ctx-older');
if(olderBtn)olderBtn.addEventListener('click',function(e){e.stopPropagation();ctxOffset+=5;loadNearbyDays()});
clampCtxMenu();
}).catch(function(){renderCtxMenuBody('<div class="ctx-empty">Request failed</div>');previewLayer.removeAllFeatures()});
}

function loadDayFromCtx(month,day,year){
closeCtxMenu();
monthBtn.textContent=months[month];
monthMenu.querySelectorAll('div').forEach(function(el,i){if(i===month)el.classList.add('selected');else el.classList.remove('selected')});
ddInput.value=String(day);
yyyyInput.value=String(year);
loadDay(month,day,year);
}

var ctxDragging=false;
function clampCtxMenu(){var r=ctxMenu.getBoundingClientRect();var mapR=mapEl.getBoundingClientRect();if(r.left<mapR.left)ctxMenu.style.left='8px';if(r.top<mapR.top)ctxMenu.style.top='8px';if(r.right>mapR.right)ctxMenu.style.left=Math.max(0,parseInt(ctxMenu.style.left)-r.right+mapR.right-8)+'px';if(r.bottom>mapR.bottom)ctxMenu.style.top=Math.max(0,parseInt(ctxMenu.style.top)-r.bottom+mapR.bottom-8)+'px'}

function ctxUpdatePos(e){
var rect=mapEl.getBoundingClientRect();
var px=clientToMapPixel(e.clientX,e.clientY);
var lonlat=map.getLonLatFromPixel(px);
if(!lonlat)return false;
lonlat=lonlat.transform(proj,wgs84);
ctxLat=lonlat.lat;ctxLon=lonlat.lon;
ctxMenu.style.left=(e.clientX-rect.left)+'px';
ctxMenu.style.top=(e.clientY-rect.top)+'px';
if(ctxMenu.style.display==='block')clampCtxMenu();
return true;
}

mapEl.addEventListener('mousedown',function(e){
if(e.button!==2)return;
if(!ctxUpdatePos(e))return;
ctxOffset=0;
ctxDragging=true;
renderCtxMenuBody('<div class="ctx-loading">Release to search</div>');
ctxMenu.style.display='block';
ctxMenu.style.pointerEvents='none';
},true);

var ctxThrottle=0;
document.addEventListener('mousemove',function(e){
if(!ctxDragging)return;
ctxUpdatePos(e);
var now=Date.now();
if(now-ctxThrottle>300){ctxThrottle=now;ctxOffset=0;loadNearbyDays()}
},true);

var ctxDragEnded=false;
function endCtxDrag(e){
if(!ctxDragging)return;
ctxDragging=false;
ctxDragEnded=true;
ctxMenu.style.pointerEvents='';
if(ctxUpdatePos(e)){loadNearbyDays()}else{closeCtxMenu()}
}
document.addEventListener('mouseup',function(e){
if(e.button===2)endCtxDrag(e);
},true);
document.addEventListener('contextmenu',function(e){
if(ctxDragging){e.preventDefault();endCtxDrag(e)}
else if(ctxDragEnded){e.preventDefault();ctxDragEnded=false}
},true);

	mapEl.addEventListener('click',function(e){
	closeCtxMenu();
	var px=eventToPixel(e);
	if(findBlueFeatureNearPixel(px,36))return;
	clearBlueTooltipSelectionState();
	});
	ctxMenu.addEventListener('click',function(e){e.stopPropagation()});
	ctxMenu.addEventListener('contextmenu',function(e){e.stopPropagation();e.preventDefault()});
	ctxMenu.addEventListener('mousedown',function(e){e.stopPropagation()});
	}
	})();
	</script>
</body>
</html>`;

	res.setHeader('Content-Type', 'text/html; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store');
	res.send(html);
});

function sendBinaryProxyResponse(res, result) {
	res.status(result.status || 502);
	if (result.contentType) res.setHeader('Content-Type', result.contentType);
	res.setHeader('Cache-Control', 'no-store');
	res.send(result.body || '');
}

function startVideoProxyStream(req, res, target, rawEncoding) {
	if (rawEncoding !== undefined && typeof rawEncoding !== 'string') {
		sendStyledError(res, req, 400, 'Invalid encoding parameter');
		return true;
	}

	const encoding = resolveVideoEncoding(rawEncoding, target);
	if (!encoding) return false;

	const streamUrl = target.toString();
	const streamUrlLog = redactUrlCredentials(streamUrl);
	const clientIp = getRemoteIp(req) || 'unknown';
	const username = req.ohProxyUser || 'anonymous';
	const streamId = ++videoStreamIdCounter;

	// Get viewport width for scaling time overlay (0-10000, invalid = 0)
	if (req.query?.w !== undefined && typeof req.query.w !== 'string') {
		sendStyledError(res, req, 400, 'Invalid viewport width');
		return true;
	}
	const rawWidth = parseOptionalInt(req.query?.w, { min: 0, max: 10000 });
	if (req.query?.w !== undefined && !Number.isFinite(rawWidth)) {
		sendStyledError(res, req, 400, 'Invalid viewport width');
		return true;
	}
	const viewportWidth = Number.isFinite(rawWidth) ? rawWidth : 0;
	// Font size scales with viewport: ~2.5% of width, min 16px, max 48px
	const fontSize = viewportWidth > 0 ? Math.max(16, Math.min(48, Math.round(viewportWidth / 40))) : 24;

	// Track and log stream start
	activeVideoStreams.set(streamId, { url: streamUrlLog, user: username, ip: clientIp, startTime: Date.now(), encoding });
	logMessage(`[Video] Starting ${encoding} stream ${streamUrlLog} to ${username}@${clientIp} (w=${viewportWidth})`);

	// Time overlay filter: top-right, using configured timeFormat (strftime expansion)
	const timeOverlay = (liveConfig.clientConfig?.timeFormat || 'H:mm:ss')
		.replace('HH', '%H').replace(/(?<![Dh%])H(?!H)/, '%-H')
		.replace('hh', '%I').replace(/(?<![Hd%])h(?!h)/, '%-I')
		.replace('mm', '%M').replace('ss', '%S').replace('A', '%p')
		.replace(/:/g, '\\:');
	const drawtext = `drawtext=text='${timeOverlay}':expansion=strftime:x=w-tw-15:y=15:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=4`;
	// Scale to viewport width if provided - ensure even dimensions for x264
	const scaleWidth = viewportWidth > 0 ? (viewportWidth % 2 === 0 ? viewportWidth : viewportWidth + 1) : 0;
	const videoFilter = scaleWidth > 0
		? `scale=${scaleWidth}:-2,${drawtext}`
		: drawtext;

	const inputArgs = buildFfmpegInputArgs(encoding, streamUrl);
	const ffmpegArgs = [
		...inputArgs,
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
	const ffmpeg = spawn(liveConfig.binFfmpeg, ffmpegArgs, {
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
					logMessage(`[Video] Stream info for ${username}@${clientIp}: in:[${inputStreams.join(', ')}] out:[${outputStreams.join(', ')}]`);
				}
			} catch {}
		}
	});

	const endStream = () => {
		if (activeVideoStreams.has(streamId)) {
			activeVideoStreams.delete(streamId);
			logMessage(`[Video] Ending ${encoding} stream ${streamUrlLog} to ${username}@${clientIp}`);
		}
	};

	ffmpeg.on('error', () => {
		endStream();
		if (!res.headersSent) {
			sendStyledError(res, req, 502, 'Video proxy error');
		}
	});
	ffmpeg.on('close', () => {
		endStream();
		if (!res.writableEnded) res.end();
	});
	req.on('close', () => {
		ffmpeg.kill('SIGKILL');
	});
	return true;
}

app.get('/proxy', async (req, res, next) => {
	const raw = req.query?.url;

	// External URL proxy (url= parameter) - supports regular images and MJPEG streams
	if (raw !== undefined) {
		if (typeof raw !== 'string') {
			return sendStyledError(res, req, 400, 'Invalid proxy target');
		}
		const text = raw.trim();
		if (!text || text.length > 2048 || hasAnyControlChars(text)) {
			return sendStyledError(res, req, 400, 'Invalid proxy target');
		}

		let target;
		try {
			target = new URL(text);
		} catch {
			let decoded = text;
			try { decoded = decodeURIComponent(text); } catch {}
			if (!decoded || decoded.length > 2048 || hasAnyControlChars(decoded)) {
				return sendStyledError(res, req, 400, 'Invalid proxy target');
			}
			try {
				target = new URL(decoded);
			} catch {
				return sendStyledError(res, req, 400, 'Invalid proxy target');
			}
		}

		if (!['http:', 'https:', 'rtsp:', 'rtsps:'].includes(target.protocol)) {
			return sendStyledError(res, req, 400, 'Invalid proxy target');
		}
		if (target.port && (!/^\d+$/.test(target.port) || Number(target.port) < 1 || Number(target.port) > 65535)) {
			return sendStyledError(res, req, 400, 'Invalid proxy target');
		}
		if (!isProxyTargetAllowed(target, liveConfig.proxyAllowlist)) {
			return sendStyledError(res, req, 403, 'Proxy target not allowed');
		}

		if (startVideoProxyStream(req, res, target, req.query?.encoding)) return;

		const headers = {};
		const accept = normalizeHeaderValue(req.headers.accept);
		if (accept) headers.Accept = accept;

		// Check for cache parameter (seconds)
		if (req.query?.cache !== undefined && typeof req.query.cache !== 'string') {
			return sendStyledError(res, req, 400, 'Invalid cache parameter');
		}
		const cacheSeconds = parseOptionalInt(req.query?.cache, { min: 0, max: 86400 });
		if (req.query?.cache !== undefined && !Number.isFinite(cacheSeconds)) {
			return sendStyledError(res, req, 400, 'Invalid cache parameter');
		}
		const shouldCache = Number.isFinite(cacheSeconds) && cacheSeconds > 0;

		if (shouldCache) {
			// Caching mode - use buffered fetch
			const targetUrl = target.toString();
			const targetUrlLog = redactUrlCredentials(targetUrl);
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
				const allowlist = liveConfig.proxyAllowlist;
				const result = await fetchBinaryFromUrl(targetUrl, headers, 3, undefined,
					(redirectUrl) => isProxyTargetAllowed(redirectUrl, allowlist));
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
				logMessage(`Cached proxy fetch failed for ${targetUrlLog}: ${err.message || err}`);
				if (!res.headersSent) {
					sendStyledError(res, req, 502, 'Proxy error');
				}
			}
			return;
		}

		const shouldTryRtspFallback = isOpenhabWidgetProxyTarget(target, liveConfig.ohTarget);
		if (shouldTryRtspFallback) {
			const targetUrl = target.toString();
			const targetUrlLog = redactUrlCredentials(targetUrl);
			try {
				const allowlist = liveConfig.proxyAllowlist;
				const probe = await fetchErrorBodyIfHttpError(targetUrl, headers, 3, undefined,
					(redirectUrl) => isProxyTargetAllowed(redirectUrl, allowlist));
				if (probe.ok) {
					await pipeStreamingProxy(targetUrl, res, headers);
					return;
				}

				const fallbackUrl = extractRtspUrlFromBody(probe.body, probe.contentType);
				if (!fallbackUrl) {
					sendBinaryProxyResponse(res, probe);
					return;
				}

				let fallbackTarget;
				try {
					fallbackTarget = new URL(fallbackUrl);
				} catch {
					sendBinaryProxyResponse(res, probe);
					return;
				}
				if (!isProxyTargetAllowed(fallbackTarget, liveConfig.proxyAllowlist)) {
					logMessage(`[Video] Ignoring disallowed RTSP fallback from ${targetUrlLog}: ${redactUrlCredentials(fallbackUrl)}`);
					sendBinaryProxyResponse(res, probe);
					return;
				}

				logMessage(`[Video] Retrying openHAB proxy error via RTSP fallback: ${targetUrlLog} -> ${redactUrlCredentials(fallbackUrl)}`);
				if (startVideoProxyStream(req, res, fallbackTarget, 'rtsp')) return;
				sendBinaryProxyResponse(res, probe);
			} catch (err) {
				logMessage(`Direct proxy failed for ${targetUrlLog}: ${err.message || err}`);
				if (!res.headersSent) {
					sendStyledError(res, req, 502, 'Proxy error');
				}
			}
			return;
		}

		try {
			// Use streaming proxy - works for both regular images and MJPEG streams
			await pipeStreamingProxy(target.toString(), res, headers);
		} catch (err) {
			logMessage(`Direct proxy failed for ${redactUrlCredentials(target.toString())}: ${err.message || err}`);
			if (!res.headersSent) {
				sendStyledError(res, req, 502, 'Proxy error');
			}
		}
		return;
	}

	// openHAB internal proxy (sitemap/widgetId images, etc.)
	const rawSitemapQuery = typeof req.query?.sitemap === 'string' ? req.query.sitemap : '';
	const proxySitemapName = (rawSitemapQuery && !hasAnyControlChars(rawSitemapQuery))
		? safeText(rawSitemapQuery).trim()
		: '';
	if (proxySitemapName && !isSitemapVisibleForRole(proxySitemapName, getRequestUserRole(req))) {
		return sendStyledError(res, req, 403, 'Sitemap access denied');
	}
	const proxyPath = `/proxy${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;
	try {
		const result = await fetchOpenhabBinary(proxyPath);
		res.status(result.status || 502);
		if (result.contentType) res.setHeader('Content-Type', result.contentType);
		res.setHeader('Cache-Control', 'no-store');
		res.send(result.body);
	} catch (err) {
		logMessage(`openHAB proxy failed for ${proxyPath}: ${err.message || err}`);
		sendStyledError(res, req, 502, 'Proxy error');
	}
});

// --- Gated vendor assets ---
app.get('/vendor/OpenLayers.js', (req, res) => {
	if (!req.ohProxyUser) {
		return res.status(401).send('Unauthorized');
	}
	if (!req.ohProxyUserData?.trackgps) {
		return res.status(403).send('GPS tracking not enabled');
	}
	res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
	res.sendFile(path.join(PUBLIC_DIR, 'vendor', 'OpenLayers.js'));
});

// Material icons (locally hosted from npm package)
// Default style: filled (e.g. /icons/material/mic_off.svg)
app.get(/^\/icons\/material\/([a-z0-9][a-z0-9_-]{0,127})\.svg$/i, (req, res) => {
	const match = req.path.match(/^\/icons\/material\/([a-z0-9][a-z0-9_-]{0,127})\.svg$/i);
	const iconName = match && match[1] ? match[1].toLowerCase() : '';
	if (!iconName) {
		res.status(404).send('Not found');
		return;
	}
	const filePath = path.join(MATERIAL_ICONS_FILLED_DIR, `${iconName}.svg`);
	sendImmutableSvg(res, filePath);
});

// Style-specific material icon path (e.g. /icons/material/outlined/mic_off.svg)
app.get(/^\/icons\/material\/(filled|outlined|round|sharp|two-tone)\/([a-z0-9][a-z0-9_-]{0,127})\.svg$/i, (req, res) => {
	const match = req.path.match(/^\/icons\/material\/(filled|outlined|round|sharp|two-tone)\/([a-z0-9][a-z0-9_-]{0,127})\.svg$/i);
	const style = match && match[1] ? match[1].toLowerCase() : '';
	const iconName = match && match[2] ? match[2].toLowerCase() : '';
	if (!style || !iconName) {
		res.status(404).send('Not found');
		return;
	}
	const filePath = path.join(MATERIAL_ICONS_DIR, style, `${iconName}.svg`);
	sendImmutableSvg(res, filePath);
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

// Redirect unknown routes to homepage
app.use((req, res) => {
	res.redirect('/');
});

registerBackgroundTask('sitemap-cache', SITEMAP_REFRESH_MS, refreshSitemapCache);
registerBackgroundTask('group-member-map', 60000, refreshGroupMemberMap);
registerBackgroundTask('structure-map', STRUCTURE_MAP_REFRESH_MS, refreshStructureMapCache);
registerBackgroundTask('icon-cache-cleanup', 3600000, () => {
	const ttl = liveConfig.iconCacheTtlMs;
	if (ttl <= 0) return;
	purgeOldIconCache();
	const dynDir = path.join(getIconCacheDir(), 'dyn');
	if (!fs.existsSync(dynDir)) return;
	const now = Date.now();
	let pruned = 0;
	try {
		const entries = fs.readdirSync(dynDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const filePath = path.join(dynDir, entry.name);
			try {
				const stat = fs.statSync(filePath);
				if (now - stat.mtimeMs > ttl) {
					fs.unlinkSync(filePath);
					pruned += 1;
				}
			} catch {}
		}
	} catch (err) {
		logMessage(`[Icon] Cache cleanup failed: ${err.message || err}`);
	}
	if (pruned > 0) logMessage(`[Icon] Pruned ${pruned} stale dynamic icon(s)`);
});

async function resolveVideoPreviewSource(videoUrl, rawEncoding) {
	const safeVideoUrl = redactUrlCredentials(videoUrl);
	let target;
	try {
		target = new URL(videoUrl);
	} catch {
		return { ok: false, reason: 'invalid-url', safeVideoUrl };
	}

	const directEncoding = resolveVideoEncoding(rawEncoding, target);
	if (directEncoding) {
		return {
			ok: true,
			source: 'direct',
			url: target.toString(),
			safeUrl: safeVideoUrl,
			encoding: directEncoding,
		};
	}

	if (!isOpenhabWidgetProxyTarget(target, liveConfig.ohTarget)) {
		return { ok: false, reason: 'unresolved-encoding', safeVideoUrl };
	}

	const headers = { Accept: '*/*' };
	const ah = authHeader();
	if (ah) headers.Authorization = ah;
	const allowlist = liveConfig.proxyAllowlist;
	try {
		const probe = await fetchErrorBodyIfHttpError(target.toString(), headers, 3, getOhAgent(),
			(redirectUrl) => isProxyTargetAllowed(redirectUrl, allowlist));
		if (probe.ok) {
			return { ok: false, reason: 'proxy-ok-no-rtsp', safeVideoUrl, status: probe.status || 200 };
		}

		const fallbackUrl = extractRtspUrlFromBody(probe.body, probe.contentType);
		if (!fallbackUrl) {
			return { ok: false, reason: 'proxy-error-no-rtsp', safeVideoUrl, status: probe.status || 0 };
		}

		let fallbackTarget;
		try {
			fallbackTarget = new URL(fallbackUrl);
		} catch {
			return { ok: false, reason: 'fallback-invalid-url', safeVideoUrl, status: probe.status || 0 };
		}
		if (!isProxyTargetAllowed(fallbackTarget, allowlist)) {
			return {
				ok: false,
				reason: 'fallback-not-allowlisted',
				safeVideoUrl,
				status: probe.status || 0,
				fallbackUrl: redactUrlCredentials(fallbackUrl),
			};
		}

		const resolvedUrl = fallbackTarget.toString();
		return {
			ok: true,
			source: 'fallback',
			url: resolvedUrl,
			safeUrl: redactUrlCredentials(resolvedUrl),
			encoding: 'rtsp',
			fromUrl: safeVideoUrl,
			status: probe.status || 0,
		};
	} catch (err) {
		return {
			ok: false,
			reason: 'fallback-probe-error',
			safeVideoUrl,
			error: err.message || String(err),
		};
	}
}

// Video preview capture function
// cacheKeyUrl determines preview filename; sourceUrl is the actual ffmpeg input.
async function captureVideoPreview(cacheKeyUrl, sourceUrl, encoding) {
	ensureDir(VIDEO_PREVIEW_DIR);
	const hash = videoUrlHash(cacheKeyUrl);
	const outputPath = path.join(VIDEO_PREVIEW_DIR, `${hash}.jpg`);

	const inputArgs = buildFfmpegInputArgs(encoding, sourceUrl);

	return new Promise((resolve) => {
		const ffmpeg = spawn(liveConfig.binFfmpeg, [
			'-y',
			...inputArgs,
			'-vframes', '1',
			'-q:v', '2',
			outputPath,
		], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stderrData = '';
		ffmpeg.stderr.on('data', (chunk) => {
			if (stderrData.length < 4096) stderrData += chunk.toString();
		});

		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			ffmpeg.kill('SIGKILL');
		}, 10000);

		ffmpeg.on('close', (code, signal) => {
			clearTimeout(timer);
			resolve({
				ok: !killed && code === 0,
				exitCode: Number.isInteger(code) ? code : null,
				signal: safeText(signal),
				timedOut: killed,
				stderr: stderrData.trim().slice(0, 400),
			});
		});

		ffmpeg.on('error', (err) => {
			clearTimeout(timer);
			resolve({
				ok: false,
				exitCode: null,
				signal: '',
				timedOut: false,
				error: err.message || String(err),
				stderr: stderrData.trim().slice(0, 400),
			});
		});
	});
}

// Prune chart cache entries by age and hard caps.
function pruneChartCache(options = {}) {
	if (!fs.existsSync(CHART_CACHE_DIR)) return;
	const force = options && options.force === true;

	const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // 1 week
	const now = Date.now();
	if (!force && now - lastChartCachePruneAt < CHART_CACHE_PRUNE_MIN_INTERVAL_MS) return;
	lastChartCachePruneAt = now;
	let prunedByAge = 0;
	let prunedByCap = 0;
	let totalBytes = 0;
	const entries = [];

	try {
		const files = fs.readdirSync(CHART_CACHE_DIR);
		for (const file of files) {
			if (!file.endsWith('.html') && !file.endsWith('.png')) continue;
			const filePath = path.join(CHART_CACHE_DIR, file);
			try {
				const stat = fs.statSync(filePath);
				if (now - stat.mtimeMs > maxAgeMs) {
					fs.unlinkSync(filePath);
					prunedByAge++;
					continue;
				}
				entries.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size || 0 });
				totalBytes += stat.size || 0;
			} catch (err) {
				// Ignore individual file errors
			}
		}

		entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
		while ((entries.length > CHART_CACHE_MAX_FILES || totalBytes > CHART_CACHE_MAX_BYTES) && entries.length > 0) {
			const oldest = entries.shift();
			try {
				fs.unlinkSync(oldest.filePath);
				totalBytes = Math.max(0, totalBytes - (oldest.size || 0));
				prunedByCap++;
			} catch {
				// Ignore individual file errors
			}
		}

		const totalPruned = prunedByAge + prunedByCap;
		if (totalPruned > 0) {
			logMessage(`Chart cache pruned ${totalPruned} entries (${prunedByAge} by age, ${prunedByCap} by cap)`);
		}
	} catch (err) {
		logMessage(`Chart cache prune failed: ${err.message || err}`);
	}
}

// Prune old video preview images
function pruneVideoPreviews() {
	if (!fs.existsSync(VIDEO_PREVIEW_DIR)) return 0;

	const maxAgeMs = liveConfig.videoPreviewPruneHours * 60 * 60 * 1000;
	const now = Date.now();
	let pruned = 0;

	try {
		const files = fs.readdirSync(VIDEO_PREVIEW_DIR);
		for (const file of files) {
			if (!file.endsWith('.jpg')) continue;
			const filePath = path.join(VIDEO_PREVIEW_DIR, file);
			try {
				const stat = fs.statSync(filePath);
				if (now - stat.mtimeMs > maxAgeMs) {
					fs.unlinkSync(filePath);
					pruned += 1;
				}
			} catch (err) {
				// Ignore individual file errors
			}
		}
		if (pruned > 0) {
			logMessage(`[Video] Preview pruned ${pruned} stale image(s)`);
		}
		return pruned;
	} catch (err) {
		logMessage(`[Video] Preview prune failed: ${err.message || err}`);
		return 0;
	}
}

// Video preview capture background task
async function captureVideoPreviewsTask(options = {}) {
	const onlyMissing = options && options.onlyMissing === true;
	const reason = safeText(options && options.reason).trim();
	const sitemaps = getBackgroundSitemaps();
	if (!sitemaps.length) return;
	const modeText = onlyMissing ? 'missing-only' : 'full';
	const reasonText = reason ? `, reason=${reason}` : '';
	logMessage(
		`[Video] Preview task start (${sitemaps.length} sitemap${sitemaps.length === 1 ? '' : 's'}, ` +
		`mode=${modeText}${reasonText})`
	);

	const videoUrls = new Map();
	for (const entry of sitemaps) {
		const sitemapName = safeText(entry?.name).trim();
		if (!sitemapName) continue;
		try {
			const response = await fetchOpenhab(`/rest/sitemaps/${encodeURIComponent(sitemapName)}?type=json`);
			if (!response || !response.ok) {
				logMessage(
					`[Video] Preview sitemap fetch failed for "${sitemapName}" ` +
					`(HTTP ${response?.status || 'unknown'})`
				);
				continue;
			}
			const sitemapData = JSON.parse(response.body);
			const sitemapVideoUrls = extractVideoUrls(sitemapData);
			logMessage(`[Video] Preview sitemap "${sitemapName}" has ${sitemapVideoUrls.size} video URL(s)`);
			for (const [url, rawEnc] of sitemapVideoUrls) {
				if (videoUrls.has(url)) continue;
				videoUrls.set(url, rawEnc);
			}
		} catch (err) {
			logMessage(`[Video] Preview failed to fetch/parse sitemap "${sitemapName}": ${err.message || err}`);
		}
	}
	if (videoUrls.size === 0) {
		logMessage('[Video] Preview task finished (no video URLs discovered)');
		return;
	}

	const stats = {
		discovered: videoUrls.size,
		attempted: 0,
		captured: 0,
		failed: 0,
		skipped: 0,
		skippedExisting: 0,
		fallbackUsed: 0,
	};

	// Capture screenshots sequentially
	for (const [url, rawEnc] of videoUrls) {
		const safeUrl = redactUrlCredentials(url);
		if (onlyMissing) {
			const hash = videoUrlHash(url);
			const filePath = path.join(VIDEO_PREVIEW_DIR, `${hash}.jpg`);
			if (fs.existsSync(filePath)) {
				stats.skippedExisting += 1;
				continue;
			}
		}
		const resolvedSource = await resolveVideoPreviewSource(url, rawEnc);
		if (!resolvedSource.ok) {
			stats.skipped += 1;
			const statusInfo = resolvedSource.status ? `, status=${resolvedSource.status}` : '';
			const fallbackInfo = resolvedSource.fallbackUrl ? `, fallback=${resolvedSource.fallbackUrl}` : '';
			const errorInfo = resolvedSource.error ? `, error=${resolvedSource.error}` : '';
			logMessage(
				`[Video] Preview skipping ${resolvedSource.safeVideoUrl || safeUrl} ` +
				`(${resolvedSource.reason}${statusInfo}${fallbackInfo}${errorInfo})`
			);
			continue;
		}
		if (resolvedSource.source === 'fallback') {
			stats.fallbackUsed += 1;
			logMessage(
				`[Video] Preview fallback resolved ${resolvedSource.fromUrl || safeUrl} -> ` +
				`${resolvedSource.safeUrl}`
			);
		}

		stats.attempted += 1;
		try {
			const result = await captureVideoPreview(url, resolvedSource.url, resolvedSource.encoding);
			if (result.ok) {
				stats.captured += 1;
				logMessage(
					`[Video] Preview captured screenshot for key=${safeUrl} ` +
					`(sourceUrl=${resolvedSource.safeUrl}, source=${resolvedSource.source}, encoding=${resolvedSource.encoding})`
				);
			} else {
				stats.failed += 1;
				const codeInfo = result.exitCode !== null ? `, code=${result.exitCode}` : '';
				const signalInfo = result.signal ? `, signal=${result.signal}` : '';
				const timeoutInfo = result.timedOut ? ', timeout=true' : '';
				const errorInfo = result.error ? `, error=${result.error}` : '';
				const stderrInfo = result.stderr ? `, stderr=${JSON.stringify(result.stderr)}` : '';
				logMessage(
					`[Video] Preview failed to capture key=${safeUrl} ` +
					`(sourceUrl=${resolvedSource.safeUrl}, source=${resolvedSource.source}, encoding=${resolvedSource.encoding}${codeInfo}${signalInfo}${timeoutInfo}${errorInfo}${stderrInfo})`
				);
			}
		} catch (err) {
			stats.failed += 1;
			logMessage(`[Video] Preview error capturing key=${safeUrl} (sourceUrl=${resolvedSource.safeUrl}): ${err.message || err}`);
		}
	}

	// Prune old previews
	const pruned = pruneVideoPreviews();
	logMessage(
		`[Video] Preview task finished ` +
		`(discovered=${stats.discovered}, attempted=${stats.attempted}, captured=${stats.captured}, ` +
		`failed=${stats.failed}, skipped=${stats.skipped}, skippedExisting=${stats.skippedExisting}, ` +
		`fallback=${stats.fallbackUsed}, pruned=${pruned}, mode=${modeText}${reasonText})`
	);
}

// Register video preview task (interval 0 = disabled, can be hot-enabled via config reload)
registerBackgroundTask('video-preview', liveConfig.videoPreviewIntervalMs, captureVideoPreviewsTask);

// Register chart cache prune task (every 24 hours)
registerBackgroundTask('chart-cache-prune', 24 * 60 * 60 * 1000, pruneChartCache);

// Periodic video stream status logging (every 10 seconds, only if streams active)
setInterval(() => {
	const count = activeVideoStreams.size;
	if (count > 0) {
		logMessage(`[Video] ${count} stream${count === 1 ? '' : 's'} active`);
	}
}, 10000);

// Periodic auth lockout pruning to prevent unbounded growth
setInterval(pruneAuthLockouts, AUTH_LOCKOUT_PRUNE_MS);

// Initialize sessions database
try {
	sessions.setMaxAgeDays(SESSION_MAX_AGE_DAYS);
	sessions.setDefaultTheme(CLIENT_CONFIG.defaultTheme || 'light');
	sessions.initDb();
	logMessage(`[Sessions] Database initialized (max age: ${SESSION_MAX_AGE_DAYS} days)`);
	hardenSensitiveFilePermissions();
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

// NPM module update checker
function fetchNpmVersions(pkgName) {
	return new Promise((resolve, reject) => {
		const parseVersions = (data) => Object.keys(JSON.parse(data).versions || {});
		const req = https.get(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}`, {
			headers: { Accept: 'application/vnd.npm.install-v1+json' },
			timeout: 10000,
		}, (res) => {
			if (res.statusCode === 301 || res.statusCode === 302) {
				const location = res.headers.location;
				res.resume();
				if (!location) { reject(new Error(`redirect with no location`)); return; }
				https.get(location, { headers: { Accept: 'application/vnd.npm.install-v1+json' }, timeout: 10000 }, (res2) => {
					let data = '';
					res2.on('data', chunk => data += chunk);
					res2.on('end', () => {
						if (res2.statusCode !== 200) { reject(new Error(`HTTP ${res2.statusCode}`)); return; }
						try { resolve(parseVersions(data)); } catch { reject(new Error('invalid JSON')); }
					});
				}).on('error', reject);
				return;
			}
			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', () => {
				if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
				try { resolve(parseVersions(data)); } catch { reject(new Error('invalid JSON')); }
			});
		});
		req.on('error', reject);
		req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
	});
}

function highestMinorPatch(installed, versions) {
	const parts = installed.split('.');
	if (parts.length < 3) return null;
	const major = parseInt(parts[0], 10);
	const iMinor = parseInt(parts[1], 10);
	const iPatch = parseInt(parts[2], 10);
	let best = null;
	let bestMinor = iMinor;
	let bestPatch = iPatch;
	for (const v of versions) {
		if (v.includes('-')) continue;
		const p = v.split('.');
		if (p.length < 3) continue;
		const vMajor = parseInt(p[0], 10);
		const vMinor = parseInt(p[1], 10);
		const vPatch = parseInt(p[2], 10);
		if (vMajor !== major) continue;
		if (vMinor > bestMinor || (vMinor === bestMinor && vPatch > bestPatch)) {
			best = v;
			bestMinor = vMinor;
			bestPatch = vPatch;
		}
	}
	return best;
}

async function checkNpmUpdates() {
	let pkg;
	try {
		pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
	} catch (err) {
		logMessage(`[NPM] Failed to read package.json: ${err.message || err}`);
		return;
	}

	const deps = Object.keys(pkg.dependencies || {});
	if (!deps.length) { logMessage('[NPM] No dependencies found in package.json'); return; }
	logMessage(`[NPM] Checking ${deps.length} module(s) for updates...`);

	const upgrades = [];
	const errors = [];
	const concurrency = 4;

	for (let i = 0; i < deps.length; i += concurrency) {
		const batch = deps.slice(i, i + concurrency);
		const results = await Promise.allSettled(batch.map(async (name) => {
			let installed;
			try {
				const modPkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'node_modules', name, 'package.json'), 'utf8'));
				installed = modPkg.version;
			} catch {
				errors.push(`${name}: unable to read installed version`);
				return;
			}
			try {
				const versions = await fetchNpmVersions(name);
				const best = highestMinorPatch(installed, versions);
				if (best && best !== installed) {
					upgrades.push({ name, installed, latest: best });
				}
			} catch (err) {
				errors.push(`${name}: ${err.message || err}`);
			}
		}));
		// allSettled never rejects, results are consumed above
	}

	if (upgrades.length) {
		logMessage(`[NPM] ${upgrades.length} update(s) available:`);
		for (const u of upgrades) {
			logMessage(`[NPM]   ${u.name}: ${u.installed} -> ${u.latest}`);
		}
		if (upgrades.length < deps.length) {
			logMessage('[NPM] All other modules are up to date');
		}
	} else {
		logMessage('[NPM] All modules are up to date');
	}
	if (errors.length) {
		logMessage(`[NPM] ${errors.length} error(s) during check:`);
		for (const e of errors) { logMessage(`[NPM]   ${e}`); }
	}
}

registerBackgroundTask('npm-update-check', liveConfig.npmUpdateCheckMs, checkNpmUpdates);

// Weatherbit weather data fetch
function isWeatherbitConfigured() {
	return !!(liveConfig.weatherbitApiKey && liveConfig.weatherbitLatitude && liveConfig.weatherbitLongitude);
}

function mapWeatherbitUnits(units) {
	return units === 'imperial' ? 'I' : 'M';
}

function getWeatherbitCacheAgeMs() {
	try {
		const stats = fs.statSync(WEATHERBIT_FORECAST_FILE);
		return Date.now() - stats.mtimeMs;
	} catch {
		return Infinity;
	}
}

async function fetchWeatherbitData() {
	if (!isWeatherbitConfigured()) return;

	// Check cache freshness - skip if younger than configured refresh interval
	const cacheAgeMs = getWeatherbitCacheAgeMs();
	if (cacheAgeMs < liveConfig.weatherbitRefreshMs) {
		logMessage(`[Weather] Using cached data (${Math.floor(cacheAgeMs / 60000)} minutes old)`);
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
		const weatherbitApiUnits = mapWeatherbitUnits(liveConfig.weatherbitUnits);
		// Fetch forecast
		const forecastUrl = `https://api.weatherbit.io/v2.0/forecast/daily?lat=${encodeURIComponent(liveConfig.weatherbitLatitude)}&lon=${encodeURIComponent(liveConfig.weatherbitLongitude)}&key=${encodeURIComponent(liveConfig.weatherbitApiKey)}&units=${encodeURIComponent(weatherbitApiUnits)}&days=16`;
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
			const currentUrl = `https://api.weatherbit.io/v2.0/current?lat=${encodeURIComponent(liveConfig.weatherbitLatitude)}&lon=${encodeURIComponent(liveConfig.weatherbitLongitude)}&key=${encodeURIComponent(liveConfig.weatherbitApiKey)}&units=${encodeURIComponent(weatherbitApiUnits)}`;
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

		// Save combined data (atomic write via temp + rename to avoid read races)
		const combined = { forecast, current, currentDescription };
		const tmpFile = WEATHERBIT_FORECAST_FILE + '.tmp';
		fs.writeFileSync(tmpFile, JSON.stringify(combined, null, 2));
		fs.renameSync(tmpFile, WEATHERBIT_FORECAST_FILE);
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

// Schedule weatherbit refresh (uses configured interval, 0 if not configured)
registerBackgroundTask('weatherbit', isWeatherbitConfigured() ? liveConfig.weatherbitRefreshMs : 0, fetchWeatherbitData);

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

function queryWithTimeout(conn, sql, params, timeoutMs = 10000) {
	return new Promise((resolve, reject) => {
		conn.query({ sql, timeout: timeoutMs }, params, (err, results) => {
			if (err) reject(err);
			else resolve(results);
		});
	});
}

// Initialize MySQL connection if configured
if (isMysqlConfigured()) {
	connectMysql();
}

startBackgroundTasks();
syncLogRotationSchedule();

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

let httpsServer = null;

function startHttpsServer() {
	let tlsOptions;
	try {
		tlsOptions = {
			key: fs.readFileSync(HTTPS_KEY_FILE),
			cert: fs.readFileSync(HTTPS_CERT_FILE),
			minVersion: 'TLSv1.2',
			honorCipherOrder: true,
		};
	} catch (err) {
		logMessage(`Failed to read HTTPS credentials: ${err.message || err}`);
		process.exit(1);
	}
	httpsServer = https.createServer(tlsOptions, app);
	const server = httpsServer;
	server.on('error', (err) => {
		logMessage(`HTTPS server error: ${err.message || err}`);
		process.exit(1);
	});
	server.on('upgrade', handleWsUpgrade);
	server.listen(HTTPS_PORT, HTTPS_HOST || undefined, () => {
		const host = HTTPS_HOST || '0.0.0.0';
		logMessage(`[Startup] Listening (HTTPS): https://${host}:${HTTPS_PORT}`);
	});
}

function watchCertificates() {
	if (!HTTPS_ENABLED || !HTTPS_CERT_FILE || !HTTPS_KEY_FILE) return;

	const certDir = path.dirname(HTTPS_CERT_FILE);
	const keyDir = path.dirname(HTTPS_KEY_FILE);
	const certBase = path.basename(HTTPS_CERT_FILE);
	const keyBase = path.basename(HTTPS_KEY_FILE);
	const RELOAD_DELAY_MS = 500;
	let reloadTimer = null;

	const scheduleReload = (trigger) => {
		if (reloadTimer) clearTimeout(reloadTimer);
		reloadTimer = setTimeout(() => {
			reloadTimer = null;
			reloadCertificates(trigger);
		}, RELOAD_DELAY_MS);
	};

	const reloadCertificates = (trigger) => {
		if (!httpsServer) return;
		let key, cert;
		try {
			key = fs.readFileSync(HTTPS_KEY_FILE);
			cert = fs.readFileSync(HTTPS_CERT_FILE);
		} catch (err) {
			logMessage(`[SSL] Failed to read certificates: ${err.message}`);
			return;
		}
		try {
			httpsServer.setSecureContext({ key, cert });
			logMessage(`[SSL] Certificates reloaded successfully (triggered by ${trigger})`);
		} catch (err) {
			logMessage(`[SSL] Failed to apply new certificates: ${err.message}`);
		}
	};

	const watchedDirs = new Set([certDir, keyDir]);
	for (const dir of watchedDirs) {
		try {
			fs.watch(dir, (eventType, filename) => {
				if (filename === certBase || filename === keyBase) {
					scheduleReload(filename);
				}
			});
			logMessage(`[SSL] Watching ${dir} for certificate changes`);
		} catch (err) {
			logMessage(`[SSL] Failed to watch ${dir}: ${err.message}`);
		}
	}
}

if (HTTP_ENABLED) startHttpServer();
if (HTTPS_ENABLED) startHttpsServer();
watchCertificates();

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
