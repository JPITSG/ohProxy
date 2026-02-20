'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { buildOpenhabAuthHeader, buildOpenhabClient } = require('../../lib/openhab-client');

describe('openhab-client', () => {
	let server;
	let baseUrl;

	before(async () => {
		server = http.createServer((req, res) => {
			const chunks = [];
			req.on('data', (chunk) => chunks.push(chunk));
			req.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf8');
				if (req.url === '/base/rest/json') {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: true, method: req.method }));
					return;
				}
				if (req.url === '/base/rest/not-json') {
					res.writeHead(200, { 'Content-Type': 'text/plain' });
					res.end('not-json');
					return;
				}
				if (req.url === '/base/rest/status500') {
					res.writeHead(500, { 'Content-Type': 'text/plain' });
					res.end('broken');
					return;
				}
				if (req.url === '/base/rest/slow') {
					setTimeout(() => {
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ ok: true }));
					}, 120);
					return;
				}
				if (req.url === '/base/rest/echo') {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({
						method: req.method,
						auth: req.headers.authorization || '',
						body,
					}));
					return;
				}
				res.writeHead(404, { 'Content-Type': 'text/plain' });
				res.end('not found');
			});
		});
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		const addr = server.address();
		baseUrl = `http://127.0.0.1:${addr.port}`;
	});

	after(async () => {
		if (!server) return;
		await new Promise((resolve) => server.close(resolve));
	});

	it('buildOpenhabAuthHeader prefers bearer token over basic', () => {
		const auth = buildOpenhabAuthHeader({
			apiToken: 'token123',
			user: 'demo',
			pass: 'secret',
		});
		assert.strictEqual(auth, 'Bearer token123');
	});

	it('buildOpenhabAuthHeader uses basic auth when token is absent', () => {
		const auth = buildOpenhabAuthHeader({
			user: 'demo',
			pass: 'secret',
		});
		assert.ok(auth.startsWith('Basic '));
	});

	it('buildOpenhabAuthHeader returns null when no credentials are configured', () => {
		const auth = buildOpenhabAuthHeader({});
		assert.strictEqual(auth, null);
	});

	it('builds request paths from target base path and supports JSON parsing', async () => {
		const client = buildOpenhabClient({
			target: `${baseUrl}/base`,
			userAgent: 'test-agent',
		});
		const res = await client.get('/rest/json', { parseJson: true });
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.ok, true);
		assert.deepStrictEqual(res.json, { ok: true, method: 'GET' });
	});

	it('throws on HTTP errors when throwOnHttpError is enabled', async () => {
		const client = buildOpenhabClient({ target: `${baseUrl}/base` });
		await assert.rejects(
			() => client.get('/rest/status500', { throwOnHttpError: true }),
			/HTTP 500: broken/
		);
	});

	it('throws a non-json error when parseJson is enabled and payload is invalid', async () => {
		const client = buildOpenhabClient({ target: `${baseUrl}/base` });
		await assert.rejects(
			() => client.get('/rest/not-json', { parseJson: true }),
			/Non-JSON response from openHAB/
		);
	});

	it('applies timeout label in timeout errors', async () => {
		const client = buildOpenhabClient({
			target: `${baseUrl}/base`,
			timeoutMs: 10,
		});
		await assert.rejects(
			() => client.get('/rest/slow', { timeoutLabel: 'openHAB request' }),
			/openHAB request timed out/
		);
	});

	it('sends bearer auth and supports POST bodies', async () => {
		const client = buildOpenhabClient({
			target: `${baseUrl}/base`,
			apiToken: 'abc123',
		});
		const res = await client.post('/rest/echo', 'ON', { parseJson: true });
		assert.strictEqual(res.json.method, 'POST');
		assert.strictEqual(res.json.auth, 'Bearer abc123');
		assert.strictEqual(res.json.body, 'ON');
	});

	it('wires ai-cli and glowrules-cli to shared openhab client', () => {
		const projectRoot = path.join(__dirname, '..', '..');
		const aiSource = fs.readFileSync(path.join(projectRoot, 'ai-cli.js'), 'utf8');
		const glowSource = fs.readFileSync(path.join(projectRoot, 'glowrules-cli.js'), 'utf8');

		assert.match(aiSource, /require\('\.\/lib\/openhab-client'\)/);
		assert.match(glowSource, /require\('\.\/lib\/openhab-client'\)/);
		assert.doesNotMatch(aiSource, /const http = require\('http'\);/);
		assert.doesNotMatch(aiSource, /const https = require\('https'\);/);
		assert.doesNotMatch(glowSource, /const http = require\('http'\);/);
		assert.doesNotMatch(glowSource, /const https = require\('https'\);/);
	});
});
