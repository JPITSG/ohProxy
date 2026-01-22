'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

// Create test app with CMD API endpoint
function createCmdApiTestApp(config = {}) {
	const app = express();

	// Config with defaults
	const cmdapiConfig = {
		enabled: config.enabled !== false,
		allowedSubnets: config.allowedSubnets || ['192.168.1.0/24'],
		allowedItems: config.allowedItems || ['*'],
	};

	// OpenHAB mock server config
	const ohMock = config.ohMock || { statusCode: 200 };

	function safeText(value) {
		return value === null || value === undefined ? '' : String(value);
	}

	function getRemoteIp(req) {
		const xff = safeText(req.headers['x-forwarded-for']).split(',')[0].trim();
		if (xff) return xff;
		return safeText(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
	}

	function ipInSubnet(ip, cidr) {
		if (!ip || !cidr) return false;
		const [subnet, bits] = cidr.split('/');
		const mask = bits !== undefined ? parseInt(bits, 10) : 32;
		if (mask < 0 || mask > 32) return false;

		const ipParts = ip.split('.').map(Number);
		const subnetParts = subnet.split('.').map(Number);
		if (ipParts.length !== 4 || subnetParts.length !== 4) return false;

		const ipNum = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
		const subnetNum = (subnetParts[0] << 24) | (subnetParts[1] << 16) | (subnetParts[2] << 8) | subnetParts[3];
		const maskNum = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;

		return (ipNum >>> 0 & maskNum) === (subnetNum >>> 0 & maskNum);
	}

	function ipInAnySubnet(ip, subnets) {
		if (!Array.isArray(subnets) || !subnets.length) return false;
		for (const cidr of subnets) {
			if (cidr === '0.0.0.0/0') return true;
			if (ipInSubnet(ip, cidr)) return true;
		}
		return false;
	}

	// CMD API endpoint
	app.get('/CMD', async (req, res) => {
		// Check if cmdapi is enabled
		if (!cmdapiConfig.enabled) {
			res.status(404).json({ result: 'failed', error: 'CMD API not enabled' });
			return;
		}

		// Check IP allowlist
		const clientIp = getRemoteIp(req);
		if (!clientIp || !ipInAnySubnet(clientIp, cmdapiConfig.allowedSubnets)) {
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
		const allowedItems = cmdapiConfig.allowedItems;
		const itemAllowed = Array.isArray(allowedItems) && allowedItems.length > 0 &&
			(allowedItems.includes('*') || allowedItems.includes(itemName));
		if (!itemAllowed) {
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

		// Simulate OpenHAB response
		if (ohMock.statusCode >= 200 && ohMock.statusCode < 300) {
			res.json({ result: 'success' });
		} else {
			res.json({ result: 'failed', error: `OpenHAB returned ${ohMock.statusCode}` });
		}
	});

	return app;
}

// Helper to make HTTP requests
function httpRequest(options) {
	return new Promise((resolve, reject) => {
		const req = http.request(options, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { body += chunk; });
			res.on('end', () => {
				let parsed = body;
				try {
					parsed = JSON.parse(body);
				} catch {
					// Keep as string
				}
				resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: body });
			});
		});
		req.on('error', reject);
		req.end();
	});
}

describe('CMD API', () => {
	describe('Disabled state', () => {
		let server;
		let port;

		before(async () => {
			const app = createCmdApiTestApp({ enabled: false });
			server = http.createServer(app);
			await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
			port = server.address().port;
		});

		after(async () => {
			await new Promise(resolve => server.close(resolve));
		});

		it('returns 404 when CMD API is disabled', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Test_Item=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 404);
			assert.strictEqual(res.body.result, 'failed');
			assert.strictEqual(res.body.error, 'CMD API not enabled');
		});
	});

	describe('IP access control', () => {
		let server;
		let port;

		before(async () => {
			const app = createCmdApiTestApp({
				enabled: true,
				allowedSubnets: ['192.168.1.0/24'],
				allowedItems: ['*'],
			});
			server = http.createServer(app);
			await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
			port = server.address().port;
		});

		after(async () => {
			await new Promise(resolve => server.close(resolve));
		});

		it('allows requests from allowed subnet', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Test_Item=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 200);
			assert.strictEqual(res.body.result, 'success');
		});

		it('blocks requests from non-allowed subnet', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Test_Item=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '10.0.0.100' },
			});
			assert.strictEqual(res.status, 403);
			assert.strictEqual(res.body.result, 'failed');
			assert.strictEqual(res.body.error, 'IP not allowed');
		});
	});

	describe('Empty subnets', () => {
		let server;
		let port;

		before(async () => {
			const app = createCmdApiTestApp({
				enabled: true,
				allowedSubnets: [],
				allowedItems: ['*'],
			});
			server = http.createServer(app);
			await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
			port = server.address().port;
		});

		after(async () => {
			await new Promise(resolve => server.close(resolve));
		});

		it('blocks all IPs when allowedSubnets is empty', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Test_Item=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 403);
			assert.strictEqual(res.body.error, 'IP not allowed');
		});
	});

	describe('Item allowlist', () => {
		let server;
		let port;

		before(async () => {
			const app = createCmdApiTestApp({
				enabled: true,
				allowedSubnets: ['192.168.1.0/24'],
				allowedItems: ['Light_Kitchen', 'Dimmer_Living'],
			});
			server = http.createServer(app);
			await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
			port = server.address().port;
		});

		after(async () => {
			await new Promise(resolve => server.close(resolve));
		});

		it('allows requests for allowed items', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Light_Kitchen=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 200);
			assert.strictEqual(res.body.result, 'success');
		});

		it('blocks requests for non-allowed items', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Not_Allowed_Item=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 403);
			assert.strictEqual(res.body.result, 'failed');
			assert.strictEqual(res.body.error, 'Item not allowed');
		});
	});

	describe('Empty allowedItems', () => {
		let server;
		let port;

		before(async () => {
			const app = createCmdApiTestApp({
				enabled: true,
				allowedSubnets: ['192.168.1.0/24'],
				allowedItems: [],
			});
			server = http.createServer(app);
			await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
			port = server.address().port;
		});

		after(async () => {
			await new Promise(resolve => server.close(resolve));
		});

		it('blocks all items when allowedItems is empty', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Test_Item=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 403);
			assert.strictEqual(res.body.error, 'Item not allowed');
		});
	});

	describe('Wildcard allowedItems', () => {
		let server;
		let port;

		before(async () => {
			const app = createCmdApiTestApp({
				enabled: true,
				allowedSubnets: ['192.168.1.0/24'],
				allowedItems: ['*'],
			});
			server = http.createServer(app);
			await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
			port = server.address().port;
		});

		after(async () => {
			await new Promise(resolve => server.close(resolve));
		});

		it('allows all items when allowedItems contains *', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Any_Item_Name=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 200);
			assert.strictEqual(res.body.result, 'success');
		});
	});

	describe('Input validation - item name', () => {
		let server;
		let port;

		before(async () => {
			const app = createCmdApiTestApp({
				enabled: true,
				allowedSubnets: ['192.168.1.0/24'],
				allowedItems: ['*'],
			});
			server = http.createServer(app);
			await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
			port = server.address().port;
		});

		after(async () => {
			await new Promise(resolve => server.close(resolve));
		});

		it('accepts valid item names with alphanumeric chars', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Light_Kitchen123=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 200);
		});

		it('accepts item names with underscores and hyphens', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Light-Kitchen_Room=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 200);
		});

		it('rejects item names with special characters', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Light%24Kitchen=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.body.error, 'Invalid item name');
		});

		it('rejects item names with spaces', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Light%20Kitchen=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.body.error, 'Invalid item name');
		});

		it('rejects item names longer than 100 chars', async () => {
			const longName = 'A'.repeat(101);
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: `/CMD?${longName}=ON`,
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.body.error, 'Invalid item name');
		});

		it('accepts item names at exactly 100 chars', async () => {
			const name100 = 'A'.repeat(100);
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: `/CMD?${name100}=ON`,
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 200);
		});
	});

	describe('Input validation - state', () => {
		let server;
		let port;

		before(async () => {
			const app = createCmdApiTestApp({
				enabled: true,
				allowedSubnets: ['192.168.1.0/24'],
				allowedItems: ['*'],
			});
			server = http.createServer(app);
			await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
			port = server.address().port;
		});

		after(async () => {
			await new Promise(resolve => server.close(resolve));
		});

		it('accepts valid state values', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Test_Item=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 200);
		});

		it('accepts numeric state values', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Dimmer=50',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 200);
		});

		it('rejects empty state values', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Test_Item=',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.body.error, 'Invalid state value');
		});

		it('rejects state values over 500 chars', async () => {
			const longState = 'A'.repeat(501);
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: `/CMD?Test_Item=${longState}`,
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.body.error, 'Invalid state value');
		});

		it('accepts state values at exactly 500 chars', async () => {
			const state500 = 'A'.repeat(500);
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: `/CMD?Test_Item=${state500}`,
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 200);
		});

		it('rejects state with control characters', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Test_Item=ON%00OFF',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.body.error, 'Invalid characters in state');
		});

		it('allows newlines and tabs in state', async () => {
			// Newlines (\n = 0x0A) and tabs (\t = 0x09) are not in the blocked range
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Test_Item=line1%0Aline2',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 200);
		});
	});

	describe('Query format validation', () => {
		let server;
		let port;

		before(async () => {
			const app = createCmdApiTestApp({
				enabled: true,
				allowedSubnets: ['192.168.1.0/24'],
				allowedItems: ['*'],
			});
			server = http.createServer(app);
			await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
			port = server.address().port;
		});

		after(async () => {
			await new Promise(resolve => server.close(resolve));
		});

		it('rejects requests with no query parameters', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.body.error, 'Invalid query format - expected ?Item=state');
		});

		it('rejects requests with multiple query parameters', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Item1=ON&Item2=OFF',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 400);
			assert.strictEqual(res.body.error, 'Invalid query format - expected ?Item=state');
		});

		it('accepts single query parameter', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Test_Item=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 200);
		});
	});

	describe('Response format', () => {
		let server;
		let port;

		before(async () => {
			const app = createCmdApiTestApp({
				enabled: true,
				allowedSubnets: ['192.168.1.0/24'],
				allowedItems: ['*'],
			});
			server = http.createServer(app);
			await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
			port = server.address().port;
		});

		after(async () => {
			await new Promise(resolve => server.close(resolve));
		});

		it('returns JSON response with result field', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Test_Item=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.headers['content-type'], 'application/json; charset=utf-8');
			assert.ok(res.body.result, 'Response should have result field');
		});

		it('returns success result on valid request', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Test_Item=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.body.result, 'success');
		});

		it('returns failed result with error on validation failure', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Test_Item=',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.body.result, 'failed');
			assert.ok(res.body.error, 'Failed response should have error field');
		});
	});

	describe('OpenHAB error responses', () => {
		let server;
		let port;

		before(async () => {
			const app = createCmdApiTestApp({
				enabled: true,
				allowedSubnets: ['192.168.1.0/24'],
				allowedItems: ['*'],
				ohMock: { statusCode: 404 },
			});
			server = http.createServer(app);
			await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
			port = server.address().port;
		});

		after(async () => {
			await new Promise(resolve => server.close(resolve));
		});

		it('returns failed result when OpenHAB returns error', async () => {
			const res = await httpRequest({
				hostname: '127.0.0.1',
				port,
				path: '/CMD?Test_Item=ON',
				method: 'GET',
				headers: { 'X-Forwarded-For': '192.168.1.100' },
			});
			assert.strictEqual(res.status, 200); // Endpoint returns 200, but result is failed
			assert.strictEqual(res.body.result, 'failed');
			assert.strictEqual(res.body.error, 'OpenHAB returned 404');
		});
	});
});
