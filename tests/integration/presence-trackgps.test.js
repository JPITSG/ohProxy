'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const { basicAuthHeader } = require('../test-helpers');

function createPresenceTestApp(config = {}) {
	const app = express();
	const USERS = config.users || {};

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

	function sendStyledError(res, req, status, message) {
		const payload = message ? { error: message } : {};
		return res.status(status).json(payload);
	}

	app.use((req, res, next) => {
		const [username, password] = parseBasicAuthHeader(req.headers.authorization);
		const account = username ? USERS[username] : null;
		if (!account || account.password !== password) {
			res.setHeader('WWW-Authenticate', 'Basic realm="Presence Test"');
			res.status(401).send('Unauthorized');
			return;
		}

		req.ohProxyAuth = 'authenticated';
		req.ohProxyUser = username;
		req.ohProxyUserData = {
			username,
			trackgps: account.trackgps === true,
		};
		next();
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
		}

		// History mode requires GPS tracking; single-point mode does not.
		if (!singlePointMode && !user.trackgps) {
			return sendStyledError(res, req, 403);
		}

		return res.status(200).type('text/html').send('<!DOCTYPE html><html><body>Presence</body></html>');
	});

	return app;
}

describe('Presence TrackGPS Integration', () => {
	let server;
	let baseUrl;

	before(async () => {
		const app = createPresenceTestApp({
			users: {
				withgps: { password: 'gps-pass', trackgps: true },
				nogps: { password: 'nogps-pass', trackgps: false },
			},
		});
		server = http.createServer(app);
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		const addr = server.address();
		baseUrl = `http://127.0.0.1:${addr.port}`;
	});

	after(async () => {
		if (server) {
			await new Promise((resolve) => server.close(resolve));
		}
	});

	it('returns 403 for /presence history mode when trackgps is disabled', async () => {
		const res = await fetch(`${baseUrl}/presence`, {
			headers: {
				'Authorization': basicAuthHeader('nogps', 'nogps-pass'),
			},
		});
		assert.strictEqual(res.status, 403);
	});

	it('returns 200 for /presence history mode when trackgps is enabled', async () => {
		const res = await fetch(`${baseUrl}/presence`, {
			headers: {
				'Authorization': basicAuthHeader('withgps', 'gps-pass'),
			},
		});
		assert.strictEqual(res.status, 200);
		assert.match(res.headers.get('content-type') || '', /text\/html/i);
	});
});
