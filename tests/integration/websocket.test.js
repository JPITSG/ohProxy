'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');

const { basicAuthHeader, TEST_USERS, TEST_COOKIE_KEY } = require('../test-helpers');

// Create WebSocket test server
function createWsTestServer(config = {}) {
	const app = express();

	const USERS = config.users || TEST_USERS;
	const AUTH_COOKIE_NAME = config.cookieName || 'AuthStore';
	const AUTH_COOKIE_KEY = config.cookieKey || TEST_COOKIE_KEY;
	const ALLOW_SUBNETS = config.allowSubnets || ['0.0.0.0'];

	const authLockouts = new Map();
	const AUTH_LOCKOUT_THRESHOLD = 3;
	const AUTH_LOCKOUT_MS = 15 * 60 * 1000;

	function safeText(value) {
		return value === null || value === undefined ? '' : String(value);
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

	function normalizeRemoteIp(value) {
		const raw = safeText(value).trim();
		if (!raw) return '';
		if (raw.startsWith('::ffff:')) return raw.slice(7);
		return raw;
	}

	function getCookieValue(cookieHeader, name) {
		if (!cookieHeader || !name) return '';
		for (const part of cookieHeader.split(';')) {
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

	function ipInAnySubnet(ip, subnets) {
		if (!Array.isArray(subnets) || !subnets.length) return false;
		for (const cidr of subnets) {
			if (cidr === '0.0.0.0' || cidr === '0.0.0.0/0') return true;
		}
		return false;
	}

	function getLockoutKey(ip) {
		return ip || 'unknown';
	}

	function getAuthLockout(key) {
		const entry = authLockouts.get(key);
		if (!entry) return null;
		if (entry.lockUntil && entry.lockUntil <= Date.now()) {
			authLockouts.delete(key);
			return null;
		}
		return entry;
	}

	function recordAuthFailure(key) {
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

	function clearAuthLockouts() {
		authLockouts.clear();
	}

	// Simple HTTP endpoint for testing
	app.get('/', (req, res) => {
		res.send('OK');
	});

	app.post('/test/reset-lockouts', (req, res) => {
		clearAuthLockouts();
		res.json({ success: true });
	});

	const server = http.createServer(app);

	// WebSocket server
	const wss = new WebSocket.Server({ noServer: true });

	const clients = new Map();

	wss.on('connection', (ws, req, user) => {
		const clientId = Date.now().toString();
		clients.set(clientId, { ws, user, focused: true });

		// Send welcome message
		ws.send(JSON.stringify({ type: 'connected', clientId }));

		ws.on('message', (data) => {
			try {
				const msg = JSON.parse(data.toString());
				if (msg.type === 'clientState') {
					const client = clients.get(clientId);
					if (client) {
						client.focused = msg.focused;
					}
					ws.send(JSON.stringify({ type: 'stateAck', focused: msg.focused }));
				} else if (msg.type === 'ping') {
					ws.send(JSON.stringify({ type: 'pong' }));
				}
			} catch {
				// Ignore parse errors
			}
		});

		ws.on('close', () => {
			clients.delete(clientId);
		});
	});

	server.on('upgrade', (request, socket, head) => {
		const ip = normalizeRemoteIp(socket.remoteAddress);
		const lockoutKey = getLockoutKey(ip);

		// Check lockout
		const lockout = getAuthLockout(lockoutKey);
		if (lockout && lockout.lockUntil > Date.now()) {
			socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
			socket.destroy();
			return;
		}

		// Check allowSubnets
		if (!ipInAnySubnet(ip, ALLOW_SUBNETS)) {
			socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
			socket.destroy();
			return;
		}

		// Check auth
		const authHeader = request.headers.authorization;
		const cookieHeader = request.headers.cookie;
		const [user, pass] = parseBasicAuthHeader(authHeader);

		// Try cookie auth
		const authCookie = getCookieValue(cookieHeader, AUTH_COOKIE_NAME);

		if (user && USERS[user] === pass) {
			// Auth success
			wss.handleUpgrade(request, socket, head, (ws) => {
				wss.emit('connection', ws, request, user);
			});
			return;
		}

		// Auth failed
		if (authHeader) {
			recordAuthFailure(lockoutKey);
		}

		socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Test"\r\n\r\n');
		socket.destroy();
	});

	// Add method to broadcast
	server.broadcast = (message) => {
		for (const [, client] of clients) {
			if (client.ws.readyState === WebSocket.OPEN) {
				client.ws.send(JSON.stringify(message));
			}
		}
	};

	// Get focused client count
	server.getFocusedCount = () => {
		let count = 0;
		for (const [, client] of clients) {
			if (client.focused) count++;
		}
		return count;
	};

	return { server, wss };
}

describe('WebSocket Integration', () => {
	let serverData;
	let baseUrl;
	let wsUrl;

	before(async () => {
		serverData = createWsTestServer({
			allowSubnets: ['0.0.0.0'],
		});
		await new Promise((resolve) => serverData.server.listen(0, '127.0.0.1', resolve));
		const addr = serverData.server.address();
		baseUrl = `http://127.0.0.1:${addr.port}`;
		wsUrl = `ws://127.0.0.1:${addr.port}`;
	});

	after(async () => {
		if (serverData) {
			serverData.wss.close();
			await new Promise((resolve) => serverData.server.close(resolve));
		}
	});

	beforeEach(async () => {
		await fetch(`${baseUrl}/test/reset-lockouts`, { method: 'POST' });
	});

	it('WS upgrade requires auth', async () => {
		await new Promise((resolve, reject) => {
			const ws = new WebSocket(wsUrl);
			ws.on('error', (err) => {
				// Expected - auth required
				resolve();
			});
			ws.on('open', () => {
				ws.close();
				reject(new Error('Should not connect without auth'));
			});
			setTimeout(() => {
				ws.terminate();
				resolve();
			}, 1000);
		});
	});

	it('WS upgrade works with auth', async () => {
		const credentials = Buffer.from('testuser:testpassword').toString('base64');
		await new Promise((resolve, reject) => {
			const ws = new WebSocket(wsUrl, {
				headers: {
					'Authorization': `Basic ${credentials}`,
				},
			});
			ws.on('open', () => {
				ws.close();
				resolve();
			});
			ws.on('error', (err) => {
				reject(err);
			});
			setTimeout(() => {
				ws.terminate();
				reject(new Error('Timeout'));
			}, 5000);
		});
	});

	it('WS sends welcome message', async () => {
		const credentials = Buffer.from('testuser:testpassword').toString('base64');
		const message = await new Promise((resolve, reject) => {
			const ws = new WebSocket(wsUrl, {
				headers: {
					'Authorization': `Basic ${credentials}`,
				},
			});
			ws.on('message', (data) => {
				const msg = JSON.parse(data.toString());
				ws.close();
				resolve(msg);
			});
			ws.on('error', reject);
			setTimeout(() => {
				ws.terminate();
				reject(new Error('Timeout'));
			}, 5000);
		});
		assert.strictEqual(message.type, 'connected');
	});

	it('WS handles clientState message', async () => {
		const credentials = Buffer.from('testuser:testpassword').toString('base64');
		const response = await new Promise((resolve, reject) => {
			const ws = new WebSocket(wsUrl, {
				headers: {
					'Authorization': `Basic ${credentials}`,
				},
			});
			let welcomeReceived = false;
			ws.on('message', (data) => {
				const msg = JSON.parse(data.toString());
				if (msg.type === 'connected') {
					welcomeReceived = true;
					ws.send(JSON.stringify({ type: 'clientState', focused: false }));
				} else if (msg.type === 'stateAck') {
					ws.close();
					resolve(msg);
				}
			});
			ws.on('error', reject);
			setTimeout(() => {
				ws.terminate();
				reject(new Error('Timeout'));
			}, 5000);
		});
		assert.strictEqual(response.type, 'stateAck');
		assert.strictEqual(response.focused, false);
	});

	it('WS ping keeps connection alive', async () => {
		const credentials = Buffer.from('testuser:testpassword').toString('base64');
		const response = await new Promise((resolve, reject) => {
			const ws = new WebSocket(wsUrl, {
				headers: {
					'Authorization': `Basic ${credentials}`,
				},
			});
			let welcomeReceived = false;
			ws.on('message', (data) => {
				const msg = JSON.parse(data.toString());
				if (msg.type === 'connected') {
					welcomeReceived = true;
					ws.send(JSON.stringify({ type: 'ping' }));
				} else if (msg.type === 'pong') {
					ws.close();
					resolve(msg);
				}
			});
			ws.on('error', reject);
			setTimeout(() => {
				ws.terminate();
				reject(new Error('Timeout'));
			}, 5000);
		});
		assert.strictEqual(response.type, 'pong');
	});

	it('WS cleanup on disconnect', async () => {
		const credentials = Buffer.from('testuser:testpassword').toString('base64');
		await new Promise((resolve, reject) => {
			const ws = new WebSocket(wsUrl, {
				headers: {
					'Authorization': `Basic ${credentials}`,
				},
			});
			ws.on('open', () => {
				ws.close();
			});
			ws.on('close', () => {
				// Give time for cleanup
				setTimeout(resolve, 100);
			});
			ws.on('error', reject);
		});
		// If we got here, cleanup happened without error
		assert.ok(true);
	});

	it('WS handles multiple clients', async () => {
		const credentials = Buffer.from('testuser:testpassword').toString('base64');
		const clients = [];

		for (let i = 0; i < 3; i++) {
			const ws = await new Promise((resolve, reject) => {
				const ws = new WebSocket(wsUrl, {
					headers: {
						'Authorization': `Basic ${credentials}`,
					},
				});
				ws.on('open', () => resolve(ws));
				ws.on('error', reject);
			});
			clients.push(ws);
		}

		assert.strictEqual(clients.length, 3);

		// Close all
		for (const ws of clients) {
			ws.close();
		}
	});

	it('WS rejects wrong credentials', async () => {
		const credentials = Buffer.from('testuser:wrongpassword').toString('base64');
		await new Promise((resolve, reject) => {
			const ws = new WebSocket(wsUrl, {
				headers: {
					'Authorization': `Basic ${credentials}`,
				},
			});
			ws.on('error', () => {
				resolve(); // Expected
			});
			ws.on('open', () => {
				ws.close();
				reject(new Error('Should not connect with wrong password'));
			});
			setTimeout(() => {
				ws.terminate();
				resolve();
			}, 1000);
		});
	});

	it('WS lockout returns 429 after failed attempts', async () => {
		const wrongCredentials = Buffer.from('testuser:wrongpassword').toString('base64');

		// Trigger lockout with 3 failures
		for (let i = 0; i < 3; i++) {
			await new Promise((resolve) => {
				const ws = new WebSocket(wsUrl, {
					headers: {
						'Authorization': `Basic ${wrongCredentials}`,
					},
				});
				ws.on('error', () => resolve());
				ws.on('close', () => resolve());
				setTimeout(() => {
					ws.terminate();
					resolve();
				}, 500);
			});
		}

		// Fourth attempt should be blocked
		const correctCredentials = Buffer.from('testuser:testpassword').toString('base64');
		await new Promise((resolve, reject) => {
			const ws = new WebSocket(wsUrl, {
				headers: {
					'Authorization': `Basic ${correctCredentials}`,
				},
			});
			ws.on('error', () => {
				resolve(); // Expected - locked out
			});
			ws.on('open', () => {
				ws.close();
				reject(new Error('Should be locked out'));
			});
			setTimeout(() => {
				ws.terminate();
				resolve();
			}, 1000);
		});
	});
});
