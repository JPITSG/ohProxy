'use strict';

const crypto = require('crypto');

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
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

function getCookieValueFromHeader(cookieHeader, name) {
	const header = safeText(cookieHeader).trim();
	const cookieName = safeText(name).trim();
	if (!header || !cookieName) return '';
	for (const part of header.split(';')) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		if (key !== cookieName) continue;
		return trimmed.slice(eq + 1).trim();
	}
	return '';
}

function buildAuthCookieValue(user, sessionId, pass, key, expiry) {
	const userEncoded = base64UrlEncode(user);
	const normalizedSessionId = safeText(sessionId);
	const payload = `${userEncoded}|${normalizedSessionId}|${expiry}`;
	const sig = crypto.createHmac('sha256', key).update(`${payload}|${pass}`).digest('hex');
	return base64UrlEncode(`${payload}|${sig}`);
}

function parseAuthCookieValue(cookieValue, users, key) {
	if (!key) return null;
	const decoded = base64UrlDecode(cookieValue);
	if (!decoded) return null;
	const parts = decoded.split('|');
	if (parts.length !== 4) return null;

	const [userEncoded, sessionId, expiryRaw, sig] = parts;
	if (!/^\d+$/.test(expiryRaw)) return null;
	const expiry = Number(expiryRaw);
	if (!Number.isFinite(expiry) || expiry <= Math.floor(Date.now() / 1000)) return null;
	const user = base64UrlDecode(userEncoded);
	if (!user || !Object.prototype.hasOwnProperty.call(users || {}, user)) return null;

	const expected = crypto
		.createHmac('sha256', key)
		.update(`${userEncoded}|${sessionId}|${expiryRaw}|${users[user]}`)
		.digest('hex');
	try {
		const sigBuf = Buffer.from(sig, 'hex');
		const expectedBuf = Buffer.from(expected, 'hex');
		if (sigBuf.length !== expectedBuf.length) return null;
		if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
	} catch {
		return null;
	}
	return { user, sessionId };
}

module.exports = {
	base64UrlEncode,
	base64UrlDecode,
	getCookieValueFromHeader,
	buildAuthCookieValue,
	parseAuthCookieValue,
};
