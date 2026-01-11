'use strict';

const CACHE_NAME = 'ohproxy-shell-__JS_VERSION__-__CSS_VERSION__';
const PRECACHE_URLS = [
	'./',
	'./index.html',
	// Note: config.js excluded - contains user-specific data, must not be cached
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
				.filter((key) => key !== CACHE_NAME)
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
	if (path.endsWith('/config.js')) return false; // User-specific, never cache
	return true;
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
				.catch(() => caches.match('./index.html'))
		);
		return;
	}

	if (!shouldHandleRequest(request, url)) return;

	event.respondWith(
		caches.match(request).then((cached) => {
			if (cached) return cached;
			return fetch(request)
				.then((response) => {
					if (response && response.ok) {
						const copy = response.clone();
						caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
					}
					return response;
				})
				.catch(() => cached);
		})
	);
});
