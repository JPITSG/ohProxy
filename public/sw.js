'use strict';

const CACHE_NAME = 'ohproxy-shell-__JS_VERSION__-__CSS_VERSION__';
const ICON_CACHE_NAME = 'ohproxy-icons-v1';
const PRECACHE_URLS = [
	'./',
	'./index.html',
	// Note: config.js excluded - contains user-specific data, must not be cached
	'./lang.__JS_VERSION__.js',
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

self.addEventListener('message', (event) => {
	event.waitUntil((async () => {
		await handleStatusWake('message');
		const data = event?.data || {};
		// Backward compatibility for older page scripts still sending heartbeat.
		if (data.type === 'notification-heartbeat') {
			statusHeartbeatAt = Date.now();
			if (statusDesired.enabled === true) armStatusTimers();
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
