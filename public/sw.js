'use strict';

const CACHE_NAME = 'ohproxy-shell-__JS_VERSION__-__CSS_VERSION__';
const ICON_CACHE_NAME = 'ohproxy-icons-v1';
const PRECACHE_URLS = [
	'./',
	'./index.html',
	// Note: config.js excluded - contains user-specific data, must not be cached
	'./lang.__JS_VERSION__.js',
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
	if (path === '/sitemap-full' || path === '/video-preview') return false;
	if (path.endsWith('/config.js')) return false; // User-specific, never cache
	return true;
}

function isIconRequest(url) {
	const path = url.pathname;
	return (path.startsWith('/images/') || path.startsWith('/openhab.app/images/')) &&
		(path.endsWith('.png') || path.endsWith('.svg'));
}

self.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);

	if (request.mode === 'navigate') {
		event.respondWith(
			fetch(request)
				.then((response) => {
					const copy = response.clone();
					caches.open(CACHE_NAME).then((cache) => {
						cache.put('./index.html', copy);
					});
					return response;
				})
				.catch(() => caches.match('./index.html')
					.then(cached => cached || new Response('Offline', {
						status: 503, statusText: 'Service Unavailable',
						headers: { 'Content-Type': 'text/plain' },
					})))
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
let heartbeatTimeout = null;
const HEARTBEAT_TIMEOUT_MS = 5000;

function clearStatusNotification() {
	self.registration.getNotifications({ tag: STATUS_NOTIFICATION_TAG })
		.then((notifications) => notifications.forEach((n) => n.close()))
		.catch(() => {});
}

self.addEventListener('message', (event) => {
	if (event.data && event.data.type === 'notification-heartbeat') {
		if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
		heartbeatTimeout = setTimeout(() => clearStatusNotification(), HEARTBEAT_TIMEOUT_MS);
	}
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
