'use strict';

(function initWorkerTransport() {
	if (typeof window === 'undefined') return;
	const existing = window.__OH_TRANSPORT__;
	if (existing && existing.initialized === true) return;

	const OH_CONFIG = (window.__OH_CONFIG__ && typeof window.__OH_CONFIG__ === 'object')
		? window.__OH_CONFIG__
		: {};
	const CLIENT_CONFIG = (OH_CONFIG.client && typeof OH_CONFIG.client === 'object')
		? OH_CONFIG.client
		: {};
	const TRANSPORT_CONFIG = (CLIENT_CONFIG.transport && typeof CLIENT_CONFIG.transport === 'object')
		? CLIENT_CONFIG.transport
		: {};

	const nativeFetch = typeof window.fetch === 'function'
		? window.fetch.bind(window)
		: null;
	const NativeWebSocket = typeof window.WebSocket === 'function'
		? window.WebSocket
		: null;

	const toNumber = (value, fallback) => {
		const num = Number(value);
		return Number.isFinite(num) && num > 0 ? Math.round(num) : fallback;
	};

	const state = {
		initialized: true,
		nativeFetch,
		NativeWebSocket,
		workerRpcTimeoutMs: toNumber(TRANSPORT_CONFIG.workerRpcTimeoutMs, 15000),
		swHttpEnabled: TRANSPORT_CONFIG.swHttpEnabled !== false,
		sharedWorkerEnabled: TRANSPORT_CONFIG.sharedWorkerEnabled !== false,
		transportPaused: false,
	};
	window.__OH_TRANSPORT__ = state;

	function createAbortError() {
		try {
			return new DOMException('The operation was aborted.', 'AbortError');
		} catch {
			const err = new Error('The operation was aborted.');
			err.name = 'AbortError';
			return err;
		}
	}

	function createControllerChangeError() {
		const err = new Error('Service worker controller changed');
		err.name = 'ServiceWorkerControllerChangeError';
		err._ohReason = 'controllerchange';
		return err;
	}

	function toBase64(buffer) {
		const bytes = new Uint8Array(buffer);
		let binary = '';
		const chunkSize = 0x8000;
		for (let i = 0; i < bytes.length; i += chunkSize) {
			const chunk = bytes.subarray(i, i + chunkSize);
			binary += String.fromCharCode.apply(null, chunk);
		}
		return btoa(binary);
	}

	function fromBase64(base64) {
		const binary = atob(base64);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			out[i] = binary.charCodeAt(i);
		}
		return out.buffer;
	}

	function normalizeProtocols(protocols) {
		if (protocols === undefined || protocols === null) return [];
		if (Array.isArray(protocols)) {
			return protocols
				.map((entry) => String(entry).trim())
				.filter((entry) => entry !== '');
		}
		const single = String(protocols).trim();
		return single ? [single] : [];
	}

	function createEvent(type, extra) {
		let event;
		try {
			if (type === 'message' && typeof MessageEvent === 'function') {
				event = new MessageEvent('message', { data: extra?.data });
			} else if (type === 'close' && typeof CloseEvent === 'function') {
				event = new CloseEvent('close', {
					code: extra?.code || 1000,
					reason: extra?.reason || '',
					wasClean: extra?.wasClean === true,
				});
			} else {
				event = new Event(type);
			}
		} catch {
			event = { type };
		}
		if (extra && typeof extra === 'object') {
			for (const [key, value] of Object.entries(extra)) {
				try {
					if (!(key in event)) event[key] = value;
				} catch {}
			}
		}
		return event;
	}

	function emitEvent(target, type, extra) {
		const event = createEvent(type, extra);
		try {
			target.dispatchEvent(event);
		} catch {}
		const handler = target[`on${type}`];
		if (typeof handler === 'function') {
			try {
				handler.call(target, event);
			} catch {}
		}
	}

	// ---------- Service Worker fetch transport ----------
	const swRpc = {
		pending: new Map(),
		listenerReady: false,
		reqSeq: 0,
		reqPrefix: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
	};

	function swController() {
		return navigator.serviceWorker && navigator.serviceWorker.controller
			? navigator.serviceWorker.controller
			: null;
	}

	function postToServiceWorker(message) {
		const controller = swController();
		if (!controller) return false;
		try {
			controller.postMessage(message);
			return true;
		} catch {
			return false;
		}
	}

	function cancelSwRequest(requestId) {
		if (!requestId) return;
		postToServiceWorker({
			type: 'transport-http-cancel',
			requestId,
		});
	}

	function rejectAllPendingSwRequests(createError, options) {
		const shouldCancel = options?.sendCancel === true;
		const pending = Array.from(swRpc.pending.entries());
		for (const [requestId, entry] of pending) {
			swRpc.pending.delete(requestId);
			clearTimeout(entry.timeoutId);
			if (entry.abortSignal && entry.abortHandler) {
				entry.abortSignal.removeEventListener('abort', entry.abortHandler);
			}
			if (shouldCancel) cancelSwRequest(requestId);
			let err = null;
			try {
				err = typeof createError === 'function' ? createError(requestId) : null;
			} catch {}
			if (!err || typeof err !== 'object') {
				err = new Error('Service worker fetch transport failed');
			}
			entry.reject(err);
		}
	}

	function abortAllPendingSwRequests(reason) {
		rejectAllPendingSwRequests(() => {
			const err = createAbortError();
			if (reason) err._ohReason = String(reason);
			return err;
		}, { sendCancel: true });
	}

	function failAllPendingSwRequestsForControllerChange() {
		rejectAllPendingSwRequests(() => createControllerChangeError(), { sendCancel: false });
	}

	function isCandidateForSwFetch(request) {
		if (!state.swHttpEnabled || !state.nativeFetch) return false;
		if (!('serviceWorker' in navigator)) return false;
		if (!window.isSecureContext) return false;
		if (!navigator.serviceWorker.controller) return false;
		const url = new URL(request.url, window.location.href);
		if (url.origin !== window.location.origin) return false;
		if (request.mode === 'navigate') return false;
		return true;
	}

	function ensureSwMessageListener() {
		if (swRpc.listenerReady || !('serviceWorker' in navigator)) return;
		navigator.serviceWorker.addEventListener('message', (event) => {
			const data = event?.data || {};
			if (data.type !== 'transport-http-response' && data.type !== 'transport-http-error') return;
			const requestId = String(data.requestId || '');
			if (!requestId) return;
			const pending = swRpc.pending.get(requestId);
			if (!pending) return;
			swRpc.pending.delete(requestId);
			clearTimeout(pending.timeoutId);
			if (pending.abortSignal && pending.abortHandler) {
				pending.abortSignal.removeEventListener('abort', pending.abortHandler);
			}
			if (data.type === 'transport-http-error') {
				const err = new Error(String(data.error || 'Service worker fetch transport failed'));
				err.name = data.name || 'Error';
				pending.reject(err);
				return;
			}
			try {
				const headers = new Headers(data.headers || {});
				const bodyBuffer = typeof data.bodyBase64 === 'string' && data.bodyBase64
					? fromBase64(data.bodyBase64)
					: new ArrayBuffer(0);
				const response = new Response(bodyBuffer, {
					status: Number(data.status) || 200,
					statusText: String(data.statusText || ''),
					headers,
				});
				pending.resolve(response);
			} catch (err) {
				pending.reject(err);
			}
		});
		swRpc.listenerReady = true;
	}

	async function fetchViaServiceWorker(request) {
		if (state.transportPaused) {
			throw createAbortError();
		}
		const controller = swController();
		if (!controller) {
			throw new Error('No active service worker controller');
		}
		ensureSwMessageListener();
		const requestId = `${swRpc.reqPrefix}-${++swRpc.reqSeq}`;
		const method = String(request.method || 'GET').toUpperCase();
		const headers = {};
		request.headers.forEach((value, key) => {
			headers[key] = value;
		});
		let bodyBase64 = '';
		if (method !== 'GET' && method !== 'HEAD') {
			const bodyBuffer = await request.arrayBuffer();
			if (bodyBuffer.byteLength > 0) {
				bodyBase64 = toBase64(bodyBuffer);
			}
		}

		return await new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				swRpc.pending.delete(requestId);
				cancelSwRequest(requestId);
				reject(new Error('Service worker fetch transport timeout'));
			}, state.workerRpcTimeoutMs);

			const pendingEntry = {
				resolve,
				reject,
				timeoutId,
				abortSignal: request.signal,
				abortHandler: null,
			};
			swRpc.pending.set(requestId, pendingEntry);

			if (request.signal) {
				const abortHandler = () => {
					clearTimeout(timeoutId);
					swRpc.pending.delete(requestId);
					cancelSwRequest(requestId);
					reject(createAbortError());
				};
				pendingEntry.abortHandler = abortHandler;
				if (request.signal.aborted) {
					abortHandler();
					return;
				}
				request.signal.addEventListener('abort', abortHandler, { once: true });
			}

			try {
				controller.postMessage({
					type: 'transport-http-request',
					requestId,
					url: request.url,
					method,
					headers,
					bodyBase64,
					cache: request.cache || 'default',
					credentials: request.credentials || 'same-origin',
					mode: request.mode || 'same-origin',
					redirect: request.redirect || 'follow',
					referrer: request.referrer || '',
					referrerPolicy: request.referrerPolicy || '',
					integrity: request.integrity || '',
					keepalive: request.keepalive === true,
				});
			} catch (err) {
				clearTimeout(timeoutId);
				swRpc.pending.delete(requestId);
				if (request.signal && pendingEntry.abortHandler) {
					request.signal.removeEventListener('abort', pendingEntry.abortHandler);
				}
				reject(err);
			}
		});
	}

	if (state.nativeFetch) {
		window.fetch = async function patchedFetch(input, init) {
			const request = new Request(input, init);
			if (!isCandidateForSwFetch(request)) {
				return state.nativeFetch(request);
			}
			if (state.transportPaused) {
				// Intentional: while hidden/paused, block same-origin SW-candidate fetches.
				// This pre-empts soft-restart work instead of allowing background churn.
				throw createAbortError();
			}
			const fallbackRequest = request.clone();
			try {
				return await fetchViaServiceWorker(request);
			} catch (err) {
				if (state.transportPaused) throw createAbortError();
				if (err && err.name === 'AbortError') throw err;
				return state.nativeFetch(fallbackRequest);
			}
		};
	}

	// ---------- SharedWorker WebSocket transport ----------
	const wsManager = {
		clientId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		nextSocketId: 1,
		worker: null,
		port: null,
		disabled: false,
		sockets: new Map(),

		workerUrl() {
			const assetVersion = String(OH_CONFIG.assetVersion || 'v1').trim() || 'v1';
			return new URL(`transport.sharedworker.${assetVersion}.js`, window.location.href).toString();
		},

		ensurePort() {
			if (!state.sharedWorkerEnabled) return false;
			if (this.disabled) return false;
			if (this.port) return true;
			if (typeof SharedWorker !== 'function' || !state.NativeWebSocket) return false;
			try {
				this.worker = new SharedWorker(this.workerUrl(), { name: 'ohproxy-transport' });
				this.port = this.worker.port;
				this.port.onmessage = (event) => {
					const data = event?.data || {};
					if (data.type !== 'transport-ws-event') return;
					const socket = this.sockets.get(String(data.id || ''));
					if (!socket) return;
					socket._handleWorkerEvent(data);
				};
				this.port.onmessageerror = () => {};
				this.port.start();
				this.port.postMessage({ type: 'transport-worker-init', clientId: this.clientId });
				return true;
			} catch {
				this.disabled = true;
				this.worker = null;
				this.port = null;
				return false;
			}
		},

		post(message) {
			if (!this.ensurePort()) return false;
			try {
				this.port.postMessage(message);
				return true;
			} catch {
				return false;
			}
		},

		register(socket, url, protocols) {
			if (!this.ensurePort()) return '';
			const id = `${this.clientId}:${this.nextSocketId++}`;
			this.sockets.set(id, socket);
			if (!this.post({
				type: 'transport-ws-open',
				id,
				url: String(url),
				protocols: normalizeProtocols(protocols),
			})) {
				this.sockets.delete(id);
				return '';
			}
			return id;
		},

		unregister(id) {
			if (!id) return;
			this.sockets.delete(id);
		},

		pause(reason) {
			this.post({
				type: 'transport-ws-pause',
				reason: String(reason || 'Transport paused'),
			});
		},

		resume() {
			this.post({
				type: 'transport-ws-resume',
			});
		},
	};

	class WorkerBackedWebSocket extends EventTarget {
		constructor(url, protocols) {
			super();
			this.url = String(url);
			this._protocol = '';
			this._extensions = '';
			this._readyState = WorkerBackedWebSocket.CONNECTING;
			this._binaryType = 'blob';
			this._socketId = '';
			this._native = null;
			this.onopen = null;
			this.onmessage = null;
			this.onerror = null;
			this.onclose = null;

			if (!state.sharedWorkerEnabled || !state.NativeWebSocket) {
				this._attachNative(url, protocols);
				return;
			}

			const socketId = wsManager.register(this, url, protocols);
			if (!socketId) {
				this._attachNative(url, protocols);
				return;
			}
			this._socketId = socketId;
		}

		get readyState() {
			return this._native ? this._native.readyState : this._readyState;
		}

		get bufferedAmount() {
			// SharedWorker-backed sockets do not expose queued-byte stats.
			// Keep behavior predictable until explicit backpressure reporting is added.
			return this._native ? this._native.bufferedAmount : 0;
		}

		get protocol() {
			return this._native ? this._native.protocol : this._protocol;
		}

		get extensions() {
			return this._native ? this._native.extensions : this._extensions;
		}

		get binaryType() {
			return this._native ? this._native.binaryType : this._binaryType;
		}

		set binaryType(value) {
			this._binaryType = value;
			if (this._native) this._native.binaryType = value;
		}

		send(data) {
			if (this._native) {
				this._native.send(data);
				return;
			}
			if (this._readyState !== WorkerBackedWebSocket.OPEN) {
				throw new Error('WebSocket is not open');
			}
			if (!wsManager.post({ type: 'transport-ws-send', id: this._socketId, data })) {
				throw new Error('WebSocket transport unavailable');
			}
		}

		close(code, reason) {
			if (this._native) {
				this._native.close(code, reason);
				return;
			}
			if (this._readyState === WorkerBackedWebSocket.CLOSING || this._readyState === WorkerBackedWebSocket.CLOSED) return;
			this._readyState = WorkerBackedWebSocket.CLOSING;
			wsManager.post({
				type: 'transport-ws-close',
				id: this._socketId,
				code,
				reason,
			});
		}

		_attachNative(url, protocols) {
			const ws = protocols === undefined
				? new state.NativeWebSocket(url)
				: new state.NativeWebSocket(url, protocols);
			this._native = ws;
			ws.binaryType = this._binaryType;
			ws.onopen = () => {
				emitEvent(this, 'open');
			};
			ws.onmessage = (event) => {
				emitEvent(this, 'message', { data: event?.data });
			};
			ws.onerror = () => {
				emitEvent(this, 'error');
			};
			ws.onclose = (event) => {
				emitEvent(this, 'close', {
					code: event?.code || 1000,
					reason: event?.reason || '',
					wasClean: event?.wasClean === true,
				});
			};
		}

		_handleWorkerEvent(data) {
			const eventName = String(data.event || '');
			if (eventName === 'open') {
				this._readyState = WorkerBackedWebSocket.OPEN;
				this._protocol = String(data.protocol || '');
				this._extensions = String(data.extensions || '');
				emitEvent(this, 'open');
				return;
			}
			if (eventName === 'message') {
				if (this._readyState === WorkerBackedWebSocket.CONNECTING) {
					this._readyState = WorkerBackedWebSocket.OPEN;
				}
				emitEvent(this, 'message', { data: data.data });
				return;
			}
			if (eventName === 'error') {
				emitEvent(this, 'error', { message: String(data.message || '') });
				return;
			}
			if (eventName === 'close') {
				this._readyState = WorkerBackedWebSocket.CLOSED;
				wsManager.unregister(this._socketId);
				emitEvent(this, 'close', {
					code: Number(data.code) || 1000,
					reason: String(data.reason || ''),
					wasClean: data.wasClean === true,
				});
			}
		}
	}

	WorkerBackedWebSocket.CONNECTING = state.NativeWebSocket ? state.NativeWebSocket.CONNECTING : 0;
	WorkerBackedWebSocket.OPEN = state.NativeWebSocket ? state.NativeWebSocket.OPEN : 1;
	WorkerBackedWebSocket.CLOSING = state.NativeWebSocket ? state.NativeWebSocket.CLOSING : 2;
	WorkerBackedWebSocket.CLOSED = state.NativeWebSocket ? state.NativeWebSocket.CLOSED : 3;

	if (state.NativeWebSocket && state.sharedWorkerEnabled) {
		window.WebSocket = WorkerBackedWebSocket;
	}

	function setTransportPaused(paused, reason) {
		const next = paused === true;
		if (state.transportPaused === next) return;
		state.transportPaused = next;
		if (next) {
			abortAllPendingSwRequests('Transport paused');
			postToServiceWorker({ type: 'transport-http-pause' });
			wsManager.pause(reason || 'Page hidden');
		} else {
			postToServiceWorker({ type: 'transport-http-resume' });
			wsManager.resume();
		}
	}

	function syncPauseStateFromVisibility() {
		setTransportPaused(document.visibilityState !== 'visible', 'Visibility changed');
	}

	if ('serviceWorker' in navigator) {
		navigator.serviceWorker.addEventListener('controllerchange', () => {
			failAllPendingSwRequestsForControllerChange();
			if (state.transportPaused) {
				postToServiceWorker({ type: 'transport-http-pause' });
			} else {
				postToServiceWorker({ type: 'transport-http-resume' });
			}
		});
	}

	document.addEventListener('visibilitychange', syncPauseStateFromVisibility);
	window.addEventListener('pagehide', () => setTransportPaused(true, 'Page hidden'));
	window.addEventListener('pageshow', syncPauseStateFromVisibility);
	syncPauseStateFromVisibility();

	window.addEventListener('beforeunload', () => {
		setTransportPaused(true, 'Page unload');
	}, { capture: true });
})();
