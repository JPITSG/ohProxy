'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TRANSPORT_CLIENT_FILE = path.join(PROJECT_ROOT, 'public', 'transport-client.js');
const TRANSPORT_CLIENT_SOURCE = fs.readFileSync(TRANSPORT_CLIENT_FILE, 'utf8');

class FakeEventTarget {
	constructor() {
		this.listeners = new Map();
	}

	addEventListener(type, listener) {
		if (!type || typeof listener !== 'function') return;
		const key = String(type);
		if (!this.listeners.has(key)) this.listeners.set(key, new Set());
		this.listeners.get(key).add(listener);
	}

	removeEventListener(type, listener) {
		const key = String(type || '');
		const bucket = this.listeners.get(key);
		if (!bucket) return;
		bucket.delete(listener);
		if (bucket.size === 0) this.listeners.delete(key);
	}

	dispatchEvent(event) {
		const evt = event && typeof event === 'object'
			? event
			: { type: String(event || '') };
		const bucket = this.listeners.get(String(evt.type || ''));
		if (!bucket) return true;
		for (const listener of Array.from(bucket)) {
			listener.call(this, evt);
		}
		return true;
	}
}

class BrowserEventTarget extends FakeEventTarget {}

class SimpleEvent {
	constructor(type) {
		this.type = String(type || '');
	}
}

class SimpleMessageEvent extends SimpleEvent {
	constructor(type, init = {}) {
		super(type);
		this.data = init.data;
	}
}

class SimpleCloseEvent extends SimpleEvent {
	constructor(type, init = {}) {
		super(type);
		this.code = Number(init.code) || 1000;
		this.reason = String(init.reason || '');
		this.wasClean = init.wasClean === true;
	}
}

function toBase64(text) {
	return Buffer.from(String(text || ''), 'utf8').toString('base64');
}

function fromBase64(text) {
	return Buffer.from(String(text || ''), 'base64').toString('utf8');
}

function timeoutReject(ms, message) {
	return new Promise((_, reject) => {
		setTimeout(() => reject(new Error(message)), ms);
	});
}

function createTransportHarness(options = {}) {
	const origin = String(options.origin || 'https://app.test');
	const windowEvents = new FakeEventTarget();
	const documentEvents = new FakeEventTarget();
	const swEvents = new FakeEventTarget();

	const controllerMessages = [];
	const nativeFetchCalls = [];
	const nativeFetchImpl = typeof options.nativeFetchImpl === 'function'
		? options.nativeFetchImpl
		: async () => new Response('native-ok', { status: 200 });

	const serviceWorkerController = {
		postMessage(message) {
			controllerMessages.push(message);
			if (typeof options.onControllerPostMessage === 'function') {
				options.onControllerPostMessage(message);
			}
		},
	};

	const serviceWorker = {
		controller: serviceWorkerController,
		addEventListener: swEvents.addEventListener.bind(swEvents),
		removeEventListener: swEvents.removeEventListener.bind(swEvents),
		dispatchEvent: swEvents.dispatchEvent.bind(swEvents),
	};

	const document = {
		visibilityState: options.visibilityState || 'visible',
		addEventListener: documentEvents.addEventListener.bind(documentEvents),
		removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
		dispatchEvent: documentEvents.dispatchEvent.bind(documentEvents),
	};

	const navigator = { serviceWorker };

	const nativeFetch = async (request) => {
		nativeFetchCalls.push(request);
		return nativeFetchImpl(request);
	};

	const window = {
		addEventListener: windowEvents.addEventListener.bind(windowEvents),
		removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
		dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
		location: {
			href: `${origin}/`,
			origin,
			protocol: 'https:',
			host: origin.replace(/^https?:\/\//i, ''),
		},
		navigator,
		document,
		fetch: nativeFetch,
		isSecureContext: true,
		__OH_CONFIG__: {
			assetVersion: 'v1000',
			client: {
				transport: {
					sharedWorkerEnabled: false,
					swHttpEnabled: options.swHttpEnabled !== false,
					workerRpcTimeoutMs: options.workerRpcTimeoutMs || 1000,
				},
			},
		},
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		URL,
		Request,
		Response,
		Headers,
		AbortController,
		EventTarget: BrowserEventTarget,
		Event: SimpleEvent,
		MessageEvent: SimpleMessageEvent,
		CloseEvent: SimpleCloseEvent,
		SharedWorker: undefined,
		WebSocket: undefined,
		btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
		atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
	};
	window.window = window;

	const context = {
		console,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		URL,
		Request,
		Response,
		Headers,
		AbortController,
		DOMException: typeof DOMException === 'function' ? DOMException : class extends Error {
			constructor(message, name) {
				super(message);
				this.name = String(name || 'Error');
			}
		},
		EventTarget: BrowserEventTarget,
		Event: SimpleEvent,
		MessageEvent: SimpleMessageEvent,
		CloseEvent: SimpleCloseEvent,
		window,
		document,
		navigator,
		btoa: window.btoa,
		atob: window.atob,
	};

	vm.createContext(context);
	vm.runInContext(TRANSPORT_CLIENT_SOURCE, context, { filename: 'public/transport-client.js' });

	return {
		window: context.window,
		document,
		navigator,
		controllerMessages,
		nativeFetchCalls,
		dispatchVisibility(state) {
			document.visibilityState = state;
			document.dispatchEvent({ type: 'visibilitychange' });
		},
		dispatchControllerChange() {
			serviceWorker.dispatchEvent({ type: 'controllerchange' });
		},
		dispatchServiceWorkerMessage(data) {
			serviceWorker.dispatchEvent({ type: 'message', data });
		},
	};
}

describe('Worker transport behavior', () => {
	it('round-trips request/response bodies through SW RPC for same-origin fetches', async () => {
		let harness;
		let requestBody = '';
		harness = createTransportHarness({
			onControllerPostMessage(message) {
				if (message.type !== 'transport-http-request') return;
				requestBody = fromBase64(message.bodyBase64);
				harness.dispatchServiceWorkerMessage({
					type: 'transport-http-response',
					requestId: message.requestId,
					status: 200,
					statusText: 'OK',
					headers: { 'content-type': 'application/json' },
					bodyBase64: toBase64('{"ok":true}'),
				});
			},
		});

		const response = await harness.window.fetch('https://app.test/rest/items', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{"state":"ON"}',
		});

		assert.equal(requestBody, '{"state":"ON"}');
		assert.equal(await response.text(), '{"ok":true}');
		assert.equal(harness.nativeFetchCalls.length, 0);
		assert.equal(
			harness.controllerMessages.filter((m) => m.type === 'transport-http-request').length,
			1,
		);
	});

	it('falls back to native fetch for non-candidate requests', async () => {
		const harness = createTransportHarness({
			nativeFetchImpl: async (request) => new Response(`native:${request.url}`, { status: 200 }),
		});
		const response = await harness.window.fetch('https://other.test/rest/items');

		assert.equal(await response.text(), 'native:https://other.test/rest/items');
		assert.equal(
			harness.controllerMessages.filter((m) => m.type === 'transport-http-request').length,
			0,
		);
		assert.equal(harness.nativeFetchCalls.length, 1);
	});

	it('pauses and resumes same-origin SW transport on visibility changes', async () => {
		let harness;
		harness = createTransportHarness({
			onControllerPostMessage(message) {
				if (message.type !== 'transport-http-request') return;
				harness.dispatchServiceWorkerMessage({
					type: 'transport-http-response',
					requestId: message.requestId,
					status: 200,
					statusText: 'OK',
					headers: { 'content-type': 'text/plain' },
					bodyBase64: toBase64('resumed-ok'),
				});
			},
		});

		harness.dispatchVisibility('hidden');
		assert.ok(harness.controllerMessages.some((m) => m.type === 'transport-http-pause'));

		await assert.rejects(
			() => harness.window.fetch('https://app.test/rest/items?hidden=1'),
			(err) => err?.name === 'AbortError',
		);

		// Non-candidate requests still use native fetch while hidden.
		const offOrigin = await harness.window.fetch('https://other.test/rest/items?hidden=1');
		assert.equal(await offOrigin.text(), 'native-ok');

		harness.dispatchVisibility('visible');
		assert.ok(harness.controllerMessages.some((m) => m.type === 'transport-http-resume'));

		const resumed = await harness.window.fetch('https://app.test/rest/items?visible=1');
		assert.equal(await resumed.text(), 'resumed-ok');
	});

	it('flushes pending SW RPC calls on controllerchange and falls back quickly', async () => {
		const harness = createTransportHarness({
			nativeFetchImpl: async () => new Response('native-fallback', { status: 200 }),
		});

		const fetchTextPromise = harness.window
			.fetch('https://app.test/rest/items?controllerchange=1')
			.then((response) => response.text());

		// Ensure request is in-flight, then simulate SW controller replacement.
		await Promise.resolve();
		harness.dispatchControllerChange();

		const text = await Promise.race([
			fetchTextPromise,
			timeoutReject(300, 'fetch did not settle quickly after controllerchange'),
		]);

		assert.equal(text, 'native-fallback');
		assert.equal(harness.nativeFetchCalls.length, 1);
		assert.ok(harness.controllerMessages.some((m) => m.type === 'transport-http-request'));
		assert.ok(harness.controllerMessages.some((m) => m.type === 'transport-http-resume'));
	});
});
