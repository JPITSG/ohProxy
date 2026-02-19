'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function read(relPath) {
	return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

describe('Worker transport wiring', () => {
	it('loads transport client before app bundle in index template', () => {
		const html = read('public/index.html');
		const transportIdx = html.indexOf('transport-client.__JS_VERSION__.js');
		const appIdx = html.indexOf('app.__JS_VERSION__.js');
		assert.ok(transportIdx !== -1, 'transport-client script is missing from public/index.html');
		assert.ok(appIdx !== -1, 'app script is missing from public/index.html');
		assert.ok(transportIdx < appIdx, 'transport-client script must load before app script');
	});

	it('exposes versioned server routes for transport client and shared worker assets', () => {
		const server = read('server.js');
		assert.match(server, /app\.get\(\s*\/\^\\\/transport-client\\\.v\[\\w\.\-\]\+\\\.js\$\//, 'missing transport-client versioned route');
		assert.match(server, /app\.get\(\s*\/\^\\\/transport\\\.sharedworker\\\.v\[\\w\.\-\]\+\\\.js\$\//, 'missing transport.sharedworker versioned route');
	});

	it('service worker handles transport HTTP RPC request/response message types', () => {
		const sw = read('public/sw.js');
		assert.match(sw, /transport-http-request/, 'missing transport-http-request message type');
		assert.match(sw, /transport-http-response/, 'missing transport-http-response message type');
		assert.match(sw, /transport-http-error/, 'missing transport-http-error message type');
		assert.match(sw, /transport-http-cancel/, 'missing transport-http-cancel message type');
		assert.match(sw, /transport-http-pause/, 'missing transport-http-pause message type');
		assert.match(sw, /transport-http-resume/, 'missing transport-http-resume message type');
		assert.match(sw, /handleTransportHttpRequest/, 'missing service worker transport request handler');
	});

	it('transport client flushes pending SW RPC requests on controller replacement', () => {
		const transportClient = read('public/transport-client.js');
		assert.match(transportClient, /function createControllerChangeError\(\)/, 'missing controller-change error helper');
		assert.match(transportClient, /function failAllPendingSwRequestsForControllerChange\(\)/, 'missing controller-change pending flush helper');
		assert.match(transportClient, /navigator\.serviceWorker\.addEventListener\('controllerchange', \(\) => \{\s*failAllPendingSwRequestsForControllerChange\(\);/, 'controllerchange should flush pending SW RPC entries immediately');
	});

	it('shared worker handles pause/resume for websocket transport', () => {
		const worker = read('public/transport.sharedworker.js');
		assert.match(worker, /transport-ws-pause/, 'missing transport-ws-pause message handling');
		assert.match(worker, /transport-ws-resume/, 'missing transport-ws-resume message handling');
		assert.match(worker, /pausedPorts/, 'missing pausedPorts tracking');
	});

	it('default config defines worker transport settings', () => {
		const defaults = read('config.defaults.js');
		assert.match(defaults, /transport:\s*\{/, 'missing client.transport section');
		assert.match(defaults, /sharedWorkerEnabled:\s*true/, 'missing client.transport.sharedWorkerEnabled default');
		assert.match(defaults, /swHttpEnabled:\s*true/, 'missing client.transport.swHttpEnabled default');
		assert.match(defaults, /workerRpcTimeoutMs:\s*15000/, 'missing client.transport.workerRpcTimeoutMs default');
	});

	it('admin config schema includes client transport fields', () => {
		const app = read('public/app.js');
		assert.match(app, /id:\s*'client-transport'/, 'missing client-transport admin section');
		assert.match(app, /client\.transport\.sharedWorkerEnabled/, 'missing sharedWorkerEnabled admin field');
		assert.match(app, /client\.transport\.swHttpEnabled/, 'missing swHttpEnabled admin field');
		assert.match(app, /client\.transport\.workerRpcTimeoutMs/, 'missing workerRpcTimeoutMs admin field');
	});
});
