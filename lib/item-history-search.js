'use strict';

const path = require('path');

const HISTORY_SEARCH_CURSOR_VERSION = 1;
const HISTORY_SEARCH_CURSOR_MAX_LENGTH = 512;
const ITEM_NAME_RE = /^[a-zA-Z0-9_]{1,50}$/;
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/;

function cleanConfigValue(value) {
	return value === null || value === undefined ? '' : String(value).trim();
}

function isSaneMysqlHistoryConfig(config) {
	if (!config || typeof config !== 'object') return false;
	const database = cleanConfigValue(config.database);
	const username = cleanConfigValue(config.username);
	const socket = cleanConfigValue(config.socket);
	const host = cleanConfigValue(config.host);
	const port = cleanConfigValue(config.port);

	if (!database || database.length > 128 || CONTROL_CHARS_RE.test(database)) return false;
	if (!username || username.length > 128 || CONTROL_CHARS_RE.test(username)) return false;
	if (port && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return false;

	if (socket) {
		return socket.length <= 4096 && !CONTROL_CHARS_RE.test(socket) && path.isAbsolute(socket);
	}
	return !!host && host.length <= 255 && !/[\s\x00-\x1F\x7F]/.test(host);
}

function encodeHistorySearchCursor(time, member = '') {
	const date = time instanceof Date ? time : new Date(time);
	const memberName = cleanConfigValue(member);
	if (!Number.isFinite(date.getTime()) || (memberName && !ITEM_NAME_RE.test(memberName))) return null;
	const json = JSON.stringify([HISTORY_SEARCH_CURSOR_VERSION, date.toISOString(), memberName]);
	return Buffer.from(json, 'utf8').toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
}

function decodeHistorySearchCursor(rawCursor) {
	if (typeof rawCursor !== 'string' || !rawCursor || rawCursor.length > HISTORY_SEARCH_CURSOR_MAX_LENGTH) return null;
	if (!/^[a-zA-Z0-9_-]+$/.test(rawCursor)) return null;
	try {
		const padding = '='.repeat((4 - (rawCursor.length % 4)) % 4);
		const json = Buffer.from(rawCursor.replace(/-/g, '+').replace(/_/g, '/') + padding, 'base64').toString('utf8');
		const parsed = JSON.parse(json);
		if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== HISTORY_SEARCH_CURSOR_VERSION) return null;
		const time = cleanConfigValue(parsed[1]);
		const member = cleanConfigValue(parsed[2]);
		const date = new Date(time);
		if (!time || !Number.isFinite(date.getTime())) return null;
		if (member && !ITEM_NAME_RE.test(member)) return null;
		return { time: date.toISOString(), member };
	} catch {
		return null;
	}
}

module.exports = {
	HISTORY_SEARCH_CURSOR_MAX_LENGTH,
	HISTORY_SEARCH_CURSOR_VERSION,
	decodeHistorySearchCursor,
	encodeHistorySearchCursor,
	isSaneMysqlHistoryConfig,
};
