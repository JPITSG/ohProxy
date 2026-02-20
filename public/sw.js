'use strict';

const CACHE_NAME = 'ohproxy-shell-__JS_VERSION__-__CSS_VERSION__';
const ICON_CACHE_NAME = 'ohproxy-icons-v1';
const PRECACHE_URLS = [
	'./',
	'./index.html',
	// Note: config.js excluded - contains user-specific data, must not be cached
	'./lang.__JS_VERSION__.js',
	'./transport-client.__JS_VERSION__.js',
	'./transport.sharedworker.__JS_VERSION__.js',
	'./widget-normalizer.__JS_VERSION__.js',
	'./app.__JS_VERSION__.js',
	'./tailwind.__CSS_VERSION__.css',
	'./styles.__CSS_VERSION__.css',
	'./manifest.webmanifest',
	'./icons/icon-192.png',
	'./icons/icon-512.png',
	'./icons/apple-touch-icon.__APPLE_TOUCH_VERSION__.png',
	'./icons/icon.svg',
	'./icons/image-viewer-close.svg',
];

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME)
			.then((cache) => cache.addAll(PRECACHE_URLS))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys()
			.then((keys) => Promise.all(keys
				.filter((key) => key !== CACHE_NAME && key !== ICON_CACHE_NAME)
				.map((key) => caches.delete(key))))
			.then(() => self.clients.claim())
			.then(() => handleStatusWake('activate'))
	);
});

function shouldHandleRequest(request, url) {
	if (request.method !== 'GET') return false;
	if (url.origin !== self.location.origin) return false;
	const path = url.pathname;
	if (path.includes('/rest/')) return false;
	if (path.includes('/proxy')) return false;
	if (path.includes('/search-index')) return false;
	if (path.startsWith('/api/')) return false;
	if (path === '/sitemap-full' || path === '/video-preview' || path === '/weather') return false;
	if (path.endsWith('/config.js')) return false; // User-specific, never cache
	return true;
}

function isIconRequest(url) {
	return url.pathname.startsWith('/icon/v');
}

const STATUS_FETCH_WAKE_MIN_INTERVAL_MS = 1000;
let lastStatusFetchWakeAt = 0;

self.addEventListener('fetch', (event) => {
	const now = Date.now();
	if ((now - lastStatusFetchWakeAt) >= STATUS_FETCH_WAKE_MIN_INTERVAL_MS) {
		lastStatusFetchWakeAt = now;
		void handleStatusWake('fetch');
	}
	const { request } = event;
	const url = new URL(request.url);

	if (request.mode === 'navigate') {
		// Only cache navigations to the app shell itself, not iframe navigations
		// (charts, webviews, weather, etc.) which would overwrite the cached index
		const navPath = url.pathname;
		const isAppShell = navPath === '/' || navPath.endsWith('/index.html') ||
			navPath === self.registration.scope.replace(url.origin, '');
		event.respondWith(
			fetch(request)
				.then((response) => {
					if (isAppShell) {
						const copy = response.clone();
						caches.open(CACHE_NAME).then((cache) => {
							cache.put('./index.html', copy);
						});
					}
					return response;
				})
				.catch(() => {
					if (isAppShell) {
						return caches.match('./index.html')
							.then(cached => cached || new Response('Offline', {
								status: 503, statusText: 'Service Unavailable',
								headers: { 'Content-Type': 'text/plain' },
							}));
					}
					return new Response('Offline', {
						status: 503, statusText: 'Service Unavailable',
						headers: { 'Content-Type': 'text/plain' },
					});
				})
		);
		return;
	}

	if (!shouldHandleRequest(request, url)) return;

	const cacheName = isIconRequest(url) ? ICON_CACHE_NAME : CACHE_NAME;

	event.respondWith(
		caches.match(request).then((cached) => {
			if (cached) return cached;
			return fetch(request)
				.then((response) => {
					if (response && response.ok) {
						const copy = response.clone();
						caches.open(cacheName).then((cache) => cache.put(request, copy));
					}
					return response;
				})
				.catch(() => cached || new Response('Offline', {
					status: 503, statusText: 'Service Unavailable',
					headers: { 'Content-Type': 'text/plain' },
				}));
		})
	);
});

const STATUS_NOTIFICATION_TAG = 'ohproxy-status';
const STATUS_HEARTBEAT_TIMEOUT_MS = 2000;
let statusHeartbeatAt = 0;
let statusTimeoutTimer = null;
let statusSweepTimer = null;
let statusDesired = { enabled: false, title: '', body: '' };
let statusRenderedFingerprint = '';
const transportHttpInflight = new Map(); // requestId -> { controller, clientId }
const transportPausedClients = new Set();
const TRANSPORT_CLIENT_PRUNE_MIN_INTERVAL_MS = 10000;
let lastTransportClientPruneAt = 0;
let transportClientPruneInFlight = null;

function statusFingerprint(payload) {
	if (!payload || payload.enabled !== true) return '';
	return `${payload.title || ''}\n${payload.body || ''}`;
}

async function clearStatusNotification() {
	try {
		const notifications = await self.registration.getNotifications({ tag: STATUS_NOTIFICATION_TAG });
		notifications.forEach((n) => n.close());
	} catch (_) {}
	statusRenderedFingerprint = '';
}

function clearStatusTimers() {
	if (statusTimeoutTimer) {
		clearTimeout(statusTimeoutTimer);
		statusTimeoutTimer = null;
	}
	if (statusSweepTimer) {
		clearInterval(statusSweepTimer);
		statusSweepTimer = null;
	}
}

function armStatusTimers() {
	clearStatusTimers();
	statusTimeoutTimer = setTimeout(() => {
		void closeStatusForStaleHeartbeat('timeout');
	}, STATUS_HEARTBEAT_TIMEOUT_MS);
	statusSweepTimer = setInterval(() => {
		void closeStatusForStaleHeartbeat('interval');
	}, STATUS_HEARTBEAT_TIMEOUT_MS);
}

async function renderStatusNotification() {
	if (statusDesired.enabled !== true) {
		await clearStatusNotification();
		return;
	}
	const fingerprint = statusFingerprint(statusDesired);
	if (fingerprint === statusRenderedFingerprint) return;
	try {
		await self.registration.showNotification(statusDesired.title, {
			tag: STATUS_NOTIFICATION_TAG,
			body: statusDesired.body,
			icon: './icons/transparent-192.png',
			silent: true,
			renotify: false,
		});
		statusRenderedFingerprint = fingerprint;
	} catch (_) {}
}

async function closeStatusIfNoVisibleClients() {
	try {
		const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
		const hasVisibleClient = clients.some((client) => client.visibilityState === 'visible' || client.focused === true);
		if (hasVisibleClient) return;
		statusHeartbeatAt = 0;
		statusDesired = { enabled: false, title: '', body: '' };
		clearStatusTimers();
		await clearStatusNotification();
	} catch (_) {}
}

async function closeStatusForStaleHeartbeat(_source) {
	if (!statusHeartbeatAt) {
		await closeStatusIfNoVisibleClients();
		return;
	}
	if ((Date.now() - statusHeartbeatAt) < STATUS_HEARTBEAT_TIMEOUT_MS) return;
	statusHeartbeatAt = 0;
	statusDesired = { enabled: false, title: '', body: '' };
	clearStatusTimers();
	await clearStatusNotification();
}

async function handleStatusWake(source) {
	await closeStatusForStaleHeartbeat(source);
}

function transportClientIdFromEvent(event) {
	const source = event?.source;
	const id = source && typeof source.id === 'string' ? source.id : '';
	return id;
}

function shouldPruneTransportClients(now) {
	return (now - lastTransportClientPruneAt) >= TRANSPORT_CLIENT_PRUNE_MIN_INTERVAL_MS;
}

async function pruneStaleTransportClients(options) {
	if (transportPausedClients.size === 0) return;
	const force = options?.force === true;
	const now = Date.now();
	if (!force && !shouldPruneTransportClients(now)) return;
	if (transportClientPruneInFlight) return transportClientPruneInFlight;
	lastTransportClientPruneAt = now;
	transportClientPruneInFlight = (async () => {
		try {
			const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const activeClientIds = new Set(clients.map((client) => String(client?.id || '')));
			for (const clientId of transportPausedClients) {
				if (!activeClientIds.has(clientId)) {
					transportPausedClients.delete(clientId);
				}
			}
		} catch (_) {
			// Non-fatal: transport pause tracking is best-effort.
		} finally {
			transportClientPruneInFlight = null;
		}
	})();
	return transportClientPruneInFlight;
}

function transportArrayBufferToBase64(buffer) {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode.apply(null, chunk);
	}
	return btoa(binary);
}

function transportBase64ToArrayBuffer(base64) {
	if (!base64) return new ArrayBuffer(0);
	const binary = atob(base64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.charCodeAt(i);
	}
	return out.buffer;
}

function transportHeadersToObject(headers) {
	const out = {};
	if (!headers || typeof headers.entries !== 'function') return out;
	for (const [key, value] of headers.entries()) {
		out[key] = value;
	}
	return out;
}

async function handleTransportHttpRequest(event, data) {
	const source = event?.source;
	const requestId = String(data?.requestId || '').trim();
	const clientId = transportClientIdFromEvent(event);
	if (!source || !requestId) return;
	if (clientId && transportPausedClients.has(clientId)) {
		source.postMessage({
			type: 'transport-http-error',
			requestId,
			name: 'AbortError',
			error: 'Transport paused',
		});
		return;
	}

	const method = String(data?.method || 'GET').toUpperCase();
	const url = String(data?.url || '').trim();
	const headers = (data?.headers && typeof data.headers === 'object') ? data.headers : {};

	if (!url) {
		source.postMessage({
			type: 'transport-http-error',
			requestId,
			name: 'TypeError',
			error: 'Missing URL',
		});
		return;
	}

	let requestUrl = '';
	try {
		// Defense-in-depth: enforce same-origin at the SW boundary.
		const parsedUrl = new URL(url, self.location.origin);
		if (parsedUrl.origin !== self.location.origin) {
			source.postMessage({
				type: 'transport-http-error',
				requestId,
				name: 'SecurityError',
				error: 'Cross-origin transport requests are not allowed',
			});
			return;
		}
		requestUrl = parsedUrl.toString();
	} catch {
		source.postMessage({
			type: 'transport-http-error',
			requestId,
			name: 'TypeError',
			error: 'Invalid URL',
		});
		return;
	}

	const init = {
		method,
		headers,
		cache: data?.cache || 'default',
		credentials: data?.credentials || 'same-origin',
		mode: data?.mode || 'same-origin',
		redirect: data?.redirect || 'follow',
		keepalive: data?.keepalive === true,
	};
	const controller = new AbortController();
	init.signal = controller.signal;
	const referrer = String(data?.referrer || '').trim();
	if (referrer && referrer !== 'about:client') {
		init.referrer = referrer;
	}
	const referrerPolicy = String(data?.referrerPolicy || '').trim();
	if (referrerPolicy) {
		init.referrerPolicy = referrerPolicy;
	}
	const integrity = String(data?.integrity || '').trim();
	if (integrity) {
		init.integrity = integrity;
	}

	if (method !== 'GET' && method !== 'HEAD' && typeof data?.bodyBase64 === 'string' && data.bodyBase64) {
		init.body = transportBase64ToArrayBuffer(data.bodyBase64);
	}
	transportHttpInflight.set(requestId, { controller, clientId });

	try {
		const response = await fetch(requestUrl, init);
		const responseClone = response.clone();
		// Transport HTTP RPC currently ships responses as a single message payload.
		// This buffers the full body; streaming responses are not yet supported here.
		const bodyBuffer = await responseClone.arrayBuffer();
		source.postMessage({
			type: 'transport-http-response',
			requestId,
			status: response.status,
			statusText: response.statusText || '',
			headers: transportHeadersToObject(response.headers),
			bodyBase64: transportArrayBufferToBase64(bodyBuffer),
		});
	} catch (err) {
		source.postMessage({
			type: 'transport-http-error',
			requestId,
			name: String(err?.name || 'Error'),
			error: String(err?.message || 'Transport HTTP request failed'),
		});
	} finally {
		transportHttpInflight.delete(requestId);
	}
}

function abortTransportRequest(requestId) {
	const pending = transportHttpInflight.get(requestId);
	if (!pending) return;
	transportHttpInflight.delete(requestId);
	try {
		pending.controller.abort();
	} catch {}
}

function abortTransportRequestsForClient(clientId) {
	if (!clientId) return;
	for (const [requestId, pending] of transportHttpInflight.entries()) {
		if (pending.clientId !== clientId) continue;
		transportHttpInflight.delete(requestId);
		try {
			pending.controller.abort();
		} catch {}
	}
}

self.addEventListener('message', (event) => {
	event.waitUntil((async () => {
		await handleStatusWake('message');
		const data = event?.data || {};
		if (data.type === 'transport-http-cancel') {
			abortTransportRequest(String(data.requestId || '').trim());
			return;
		}
		if (data.type === 'transport-http-pause') {
			await pruneStaleTransportClients();
			const clientId = transportClientIdFromEvent(event);
			if (clientId) {
				transportPausedClients.add(clientId);
				abortTransportRequestsForClient(clientId);
			}
			return;
		}
		if (data.type === 'transport-http-resume') {
			await pruneStaleTransportClients();
			const clientId = transportClientIdFromEvent(event);
			if (clientId) transportPausedClients.delete(clientId);
			return;
		}
		if (data.type === 'transport-http-request') {
			void pruneStaleTransportClients();
			await handleTransportHttpRequest(event, data);
			return;
		}
		if (data.type !== 'statusUpdate') return;
		if (data.enabled !== true) {
			statusHeartbeatAt = 0;
			statusDesired = { enabled: false, title: '', body: '' };
			clearStatusTimers();
			await clearStatusNotification();
			return;
		}
		const title = String(data.title || '').trim() || 'openHAB';
		const body = String(data.body || '').trim();
		statusDesired = { enabled: true, title, body };
		statusHeartbeatAt = Date.now();
		armStatusTimers();
		await renderStatusNotification();
	})());
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	event.waitUntil(
		self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
			if (clients.length > 0) {
				return clients[0].focus();
			}
			return self.clients.openWindow('./');
		})
	);
});
