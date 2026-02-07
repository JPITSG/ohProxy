'use strict';

// Global error handler - report JS errors to server
(function() {
	const jsLogEnabled = window.__OH_CONFIG__?.jsLogEnabled === true;
	let lastErrorTime = 0;
	const errorThrottleMs = 5000;

	function reportError(message, url, line, col, error) {
		if (!jsLogEnabled) return;
		const now = Date.now();
		if (now - lastErrorTime < errorThrottleMs) return;
		lastErrorTime = now;

		const payload = {
			message: String(message || '').slice(0, 2000),
			url: String(url || '').slice(0, 500),
			line: typeof line === 'number' ? line : 0,
			col: typeof col === 'number' ? col : 0,
			stack: error && error.stack ? String(error.stack).slice(0, 5000) : '',
			userAgent: navigator.userAgent || '',
		};

		fetch('/api/jslog', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		}).catch(function() {});
	}

	window.onerror = function(message, url, line, col, error) {
		reportError(message, url, line, col, error);
	};

	window.addEventListener('unhandledrejection', function(event) {
		const reason = event.reason;
		const message = reason instanceof Error ? reason.message : String(reason);
		const stack = reason instanceof Error ? reason.stack : '';
		reportError('Unhandled Promise rejection: ' + message, '', 0, 0, { stack: stack });
	});

	window.__logJsError = reportError;
})();

function logJsError(message, error) {
	if (typeof window.__logJsError !== 'function') return;
	window.__logJsError(message, '', 0, 0, error || {});
}

// Feature detection for CSS aspect-ratio (Chrome 88+, Safari 15+, Firefox 89+)
const supportsAspectRatio = (function() {
	const el = document.createElement('div');
	el.style.aspectRatio = '1 / 1';
	return el.style.aspectRatio === '1 / 1';
})();

function triggerReload() {
	showResumeSpinner(true);
	window.location.reload();
}

const SOFT_RESET_TIMEOUT_MS = 1000; // Short timeout per attempt
let _spinnerLock = false;

let _softResetRunning = false;
async function softReset() {
	if (_softResetRunning) return;
	_softResetRunning = true;
	closeImageViewer();
	exitVideoFullscreen();
	closeCardConfigModal();
	closeAdminConfigModal();
	_spinnerLock = true;
	showResumeSpinner(true);
	reportGps();

	// Show cached home snapshot behind the blur (if available)
	const snapshot = loadHomeSnapshot();
	const snapshotApplied = snapshot && applyHomeSnapshot(snapshot);
	if (snapshotApplied) {
		render();
		window.scrollTo(0, 0);
	}

	// Clear transient state for fresh start
	state.filter = '';
	if (els.search) els.search.value = '';
	state.searchWidgets = null;
	state.searchIndexReady = false;
	state.searchFrames = [];
	state.sitemapCache.clear();
	state.sitemapCacheReady = false;

	// Stop existing connections/timers
	stopPolling();
	stopPing();
	closeWs();
	setConnectionStatus(false);

	// Fast path: if snapshot provided valid rootPageUrl, skip sitemap fetch
	if (snapshotApplied && state.rootPageUrl) {
		state.pageUrl = state.rootPageUrl;
		try {
			setConnectionStatus(true);
			await refresh(true);
			_spinnerLock = false;
			showResumeSpinner(false);

			// Restart background services
			startPolling();
			resumePingPending = true;
			connectWs();
			fetchFullSitemap().catch(() => {});
			_softResetRunning = false;
			return; // Done!
		} catch (e) {
			// Fast path failed, fall through to sitemap fetch
		}
	}

	// Fallback: fetch sitemap with aggressive retry loop (backoff after 60s)
	const softResetStart = Date.now();
	while (true) {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), SOFT_RESET_TIMEOUT_MS);

		try {
			// Fetch sitemap list
			const res = await fetch('rest/sitemaps?type=json', {
				signal: controller.signal,
				headers: { 'Accept': 'application/json' },
			});

			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();

			// Parse sitemap (same logic as loadDefaultSitemap)
			let sitemaps = [];
			if (Array.isArray(data)) sitemaps = data;
			else if (Array.isArray(data?.sitemaps)) sitemaps = data.sitemaps;
			else if (Array.isArray(data?.sitemaps?.sitemap)) sitemaps = data.sitemaps.sitemap;
			else if (Array.isArray(data?.sitemap)) sitemaps = data.sitemap;
			else if (data?.sitemap && typeof data.sitemap === 'object') sitemaps = [data.sitemap];
			else if (data?.sitemaps && typeof data.sitemaps === 'object') sitemaps = [data.sitemaps];

			const first = Array.isArray(sitemaps) ? sitemaps[0] : null;
			const name = first?.name || first?.id || first?.homepage?.link?.split('/').pop();
			if (!name) throw new Error('No sitemap name');

			state.sitemapName = name;
			const nameEnc = encodeURIComponent(name);
			let pageLink = first?.homepage?.link;
			if (!pageLink && typeof first?.link === 'string') {
				const rel = toRelativeRestLink(first.link);
				if (rel.includes('/rest/sitemaps/')) {
					pageLink = rel.endsWith(`/${nameEnc}`) ? rel : `${rel.replace(/\/$/, '')}/${nameEnc}`;
				} else {
					pageLink = rel;
				}
			}
			if (!pageLink) pageLink = `rest/sitemaps/${nameEnc}/${nameEnc}`;

			state.pageUrl = ensureJsonParam(toRelativeRestLink(pageLink));
			state.pageTitle = first?.label || first?.title || name;
			state.rootPageUrl = state.pageUrl;
			state.rootPageTitle = state.pageTitle;

			// Success - now refresh to get widgets
			setConnectionStatus(true);
			await refresh(true);
			_spinnerLock = false;
			showResumeSpinner(false);

			// Restart background services
			startPolling();
			resumePingPending = true;
			connectWs();
			fetchFullSitemap().catch(() => {});
			_softResetRunning = false;
			return; // Done!

		} catch (e) {
			const elapsed = Date.now() - softResetStart;
			if (elapsed > 60000) {
				const jitter = Math.random() * 2000;
				await new Promise(r => setTimeout(r, 5000 + jitter));
			}
		} finally {
			clearTimeout(timeoutId);
		}
	}
}

const els = {
	title: document.getElementById('pageTitle'),
	grid: document.getElementById('grid'),
	status: document.getElementById('status'),
	statusBar: document.getElementById('statusBar'),
	statusDotWrap: document.getElementById('statusDotWrap'),
	statusDot: document.getElementById('statusDot'),
	statusTooltip: document.getElementById('statusTooltip'),
	statusText: document.getElementById('statusText'),
	search: document.getElementById('search'),
	back: document.getElementById('backBtn'),
	voice: document.getElementById('voiceBtn'),
	home: document.getElementById('homeBtn'),
	logout: document.getElementById('logoutBtn'),
	themeToggle: document.getElementById('themeToggleBtn'),
	lightMode: document.getElementById('lightModeBtn'),
	darkMode: document.getElementById('darkModeBtn'),
	resumeSpinner: document.getElementById('resumeSpinner'),
};

const state = {
	sitemapName: null,
	pageUrl: null,		// full REST link to current page (relative)
	pageTitle: 'openHAB',
	stack: [],			// navigation stack of {pageUrl, pageTitle}
	rootPageUrl: null,
	rootPageTitle: null,
	ohOrigin: null,
	rawWidgets: [],
	searchWidgets: null,
	searchIndexReady: false,
	searchIndexBuilding: false,
	searchStateToken: 0,
	deltaTokens: new Map(),
	searchFrames: [],
	searchStateInFlight: false,
	lastSearchStateSync: 0,
	suppressRefreshCount: 0,
	pendingRefresh: false,
	lastPageUrl: null,
	filter: '',
	pollTimer: null,
	idleTimer: null,
	isIdle: false,
	lastActivity: 0,
	pollInterval: 0,
	isSlim: false,
	headerMode: 'full',
	forcedMode: null,
	connectionOk: true,
	connectionReady: false,
	connectionPending: false,
	lastError: '',
	proxyAuth: '',
	proxyUser: '',
	isRefreshing: false,
	pendingScrollTop: false,
	initialStatusText: '',
	sitemapCache: new Map(),		// Full sitemap cache: pageUrl -> page data
	sitemapCacheReady: false,		// Whether the full sitemap has been loaded
};

let searchPlaceholderFull = '';
let searchPlaceholderCompact = '';
let searchPlaceholderRaf = 0;
const searchPlaceholderMeasureCanvas = document.createElement('canvas');
const searchPlaceholderMeasureCtx = searchPlaceholderMeasureCanvas.getContext('2d');

const OH_CONFIG = (window.__OH_CONFIG__ && typeof window.__OH_CONFIG__ === 'object')
	? window.__OH_CONFIG__
	: {};
const CLIENT_CONFIG = (OH_CONFIG.client && typeof OH_CONFIG.client === 'object')
	? OH_CONFIG.client
	: {};
const AUTH_INFO = (window.__OH_AUTH__ && typeof window.__OH_AUTH__ === 'object')
	? window.__OH_AUTH__
	: {};

state.proxyAuth = typeof AUTH_INFO.auth === 'string' ? AUTH_INFO.auth.toLowerCase() : '';
state.proxyUser = typeof AUTH_INFO.user === 'string' ? AUTH_INFO.user : '';

function reportGps() {
	try {
		if (!OH_CONFIG.trackGps) return;
		if (!isTouchDevice()) return;
		if (state.proxyAuth !== 'authenticated') return;
		if (!navigator.geolocation) return;
		navigator.geolocation.getCurrentPosition(
			async (pos) => {
				try {
					const payload = {
						lat: pos.coords.latitude,
						lon: pos.coords.longitude,
						accuracy: pos.coords.accuracy,
					};
					try {
						if (navigator.getBattery) {
							const battery = await navigator.getBattery();
							payload.batt = Math.round(battery.level * 100);
						}
					} catch (_) {}
					fetch('/api/gps', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(payload),
					}).catch(() => {});
				} catch (_) {}
			},
			() => {},
			{ enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
		);
	} catch (_) {}
}

function configNumber(value, fallback) {
	const num = Number(value);
	return Number.isFinite(num) ? num : fallback;
}

const ICON_VERSION = OH_CONFIG.iconVersion || 'v1';
const WEBVIEW_NO_PROXY = Array.isArray(OH_CONFIG.webviewNoProxy) ? OH_CONFIG.webviewNoProxy : [];
const GROUP_ITEMS_SET = new Set(Array.isArray(OH_CONFIG.groupItems) ? OH_CONFIG.groupItems : []);
const DATE_FORMAT = typeof CLIENT_CONFIG.dateFormat === 'string' ? CLIENT_CONFIG.dateFormat : 'MMM Do, YYYY';
const TIME_FORMAT = typeof CLIENT_CONFIG.timeFormat === 'string' ? CLIENT_CONFIG.timeFormat : 'H:mm:ss';

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function ordinalSuffix(n) {
	if (n >= 11 && n <= 13) return n + 'th';
	switch (n % 10) {
		case 1: return n + 'st';
		case 2: return n + 'nd';
		case 3: return n + 'rd';
		default: return n + 'th';
	}
}
function formatDT(date, fmt) {
	const pad = (n) => String(n).padStart(2, '0');
	const h24 = date.getHours();
	const h12 = h24 % 12 || 12;
	const tokens = { YYYY: date.getFullYear(), MMM: MONTHS_SHORT[date.getMonth()], Do: ordinalSuffix(date.getDate()), DD: pad(date.getDate()), HH: pad(h24), H: h24, hh: pad(h12), h: h12, mm: pad(date.getMinutes()), ss: pad(date.getSeconds()), A: h24 < 12 ? 'AM' : 'PM' };
	return fmt.replace(/YYYY|MMM|Do|DD|HH|H|hh|h|mm|ss|A/g, (m) => tokens[m]);
}

const PAGE_FADE_OUT_MS = configNumber(CLIENT_CONFIG.pageFadeOutMs, 250);
const PAGE_FADE_IN_MS = configNumber(CLIENT_CONFIG.pageFadeInMs, 250);
const LOADING_DELAY_MS = configNumber(CLIENT_CONFIG.loadingDelayMs, 1000);
const MIN_IMAGE_REFRESH_MS = configNumber(CLIENT_CONFIG.minImageRefreshMs, 5000);
const IMAGE_LOAD_TIMEOUT_MS = configNumber(CLIENT_CONFIG.imageLoadTimeoutMs, 15000);
const CONNECTION_PENDING_DELAY_MS = 500;
const IMAGE_VIEWER_MAX_VIEWPORT = 0.9;
const VIDEO_ZOOM_MAX_SCALE = 4;
const VIDEO_ZOOM_DESKTOP_SCALE = 2;
const VIDEO_ZOOM_PAN_SPEED = 1.5;
const VIDEO_ZOOM_RESET_THRESHOLD = 1.05;
const SITEMAP_CACHE_RETRY_BASE_MS = 2000;
const SITEMAP_CACHE_RETRY_MAX_MS = 60000;
const CHART_IFRAME_SWAP_TIMEOUT_MS = 15000;
const CHART_IFRAME_CROSSFADE_MS = 400;
let sitemapCacheInFlight = false;
let sitemapCacheRetryTimer = null;
let sitemapCacheRetryMs = SITEMAP_CACHE_RETRY_BASE_MS;

// Widget glow rules: Map from widgetId to rules array
const widgetGlowRulesMap = new Map();
(function initWidgetGlowRules() {
	const rules = Array.isArray(OH_CONFIG.widgetGlowRules) ? OH_CONFIG.widgetGlowRules : [];
	for (const entry of rules) {
		if (entry.widgetId && Array.isArray(entry.rules)) {
			widgetGlowRulesMap.set(entry.widgetId, entry.rules);
		}
	}
})();

// Widget visibility rules: Map from widgetId to visibility ('all', 'normal', 'admin')
const widgetVisibilityMap = new Map();
(function initWidgetVisibility() {
	const rules = Array.isArray(OH_CONFIG.widgetVisibilityRules) ? OH_CONFIG.widgetVisibilityRules : [];
	for (const entry of rules) {
		if (entry.widgetId && entry.visibility) {
			widgetVisibilityMap.set(entry.widgetId, entry.visibility);
		}
	}
})();

// Widget video configs: Map from widgetId to {defaultMuted: boolean}
const widgetVideoConfigMap = new Map();
(function initWidgetVideoConfigs() {
	const configs = Array.isArray(OH_CONFIG.widgetVideoConfigs) ? OH_CONFIG.widgetVideoConfigs : [];
	for (const entry of configs) {
		if (entry.widgetId) {
			widgetVideoConfigMap.set(entry.widgetId, entry);
		}
	}
})();

// Video fullscreen state
let videoFullscreenActive = false;
let videoFullscreenVideoEl = null;
let videoFullscreenContainer = null;
let videoFullscreenFake = false;
let videoFsEscHandler = null;
let videoFsPlaceholder = null;
let videosPausedForVisibility = false;
const videoZoomStateMap = new WeakMap();

// Widget iframe configs: Map from widgetId to {height: number}
const widgetIframeConfigMap = new Map();
(function initWidgetIframeConfigs() {
	const configs = Array.isArray(OH_CONFIG.widgetIframeConfigs) ? OH_CONFIG.widgetIframeConfigs : [];
	for (const entry of configs) {
		if (entry.widgetId) {
			widgetIframeConfigMap.set(entry.widgetId, entry);
		}
	}
})();

/// Widget proxy cache configs: Map from widgetId to {cacheSeconds: number}
const widgetProxyCacheConfigMap = new Map();
(function initWidgetProxyCacheConfigs() {
	const configs = Array.isArray(OH_CONFIG.widgetProxyCacheConfigs) ? OH_CONFIG.widgetProxyCacheConfigs : [];
	for (const entry of configs) {
		if (entry.widgetId) {
			widgetProxyCacheConfigMap.set(entry.widgetId, entry);
		}
	}
})();

// Widget card width configs: Map from widgetId to width ('standard' or 'full')
const widgetCardWidthMap = new Map();
(function initWidgetCardWidths() {
	if (Array.isArray(OH_CONFIG.widgetCardWidths)) {
		for (const entry of OH_CONFIG.widgetCardWidths) {
			if (entry?.widgetId && entry?.width) {
				widgetCardWidthMap.set(entry.widgetId, entry.width);
			}
		}
	}
})();

// Get current user role from config
function getUserRole() {
	return OH_CONFIG.userRole || null;
}

// Check if widget should be visible to current user
function isWidgetVisible(widget) {
	const userRole = getUserRole();
	// Admins see everything
	if (userRole === 'admin') return true;

	const wKey = widgetKey(widget);
	const vis = widgetVisibilityMap.get(wKey) || 'all';

	if (vis === 'all') return true;
	if (vis === 'admin') return false;
	if (vis === 'normal') return userRole === 'normal' || userRole === 'readonly';
	return true;
}

let connectionPendingTimer = null;

function scheduleConnectionPending() {
	if (connectionPendingTimer) clearTimeout(connectionPendingTimer);
	connectionPendingTimer = setTimeout(() => {
		if (state.connectionReady) return;
		state.connectionPending = true;
		updateStatusBar();
	}, CONNECTION_PENDING_DELAY_MS);
}

function clearConnectionPending() {
	if (connectionPendingTimer) clearTimeout(connectionPendingTimer);
	connectionPendingTimer = null;
	state.connectionPending = false;
}

const pollIntervals = CLIENT_CONFIG.pollIntervalsMs || {};
const pollDefault = pollIntervals.default || {};
const pollSlim = pollIntervals.slim || {};
const POLL_ACTIVE_MS = configNumber(pollDefault.active, 2000);
const POLL_IDLE_MS = configNumber(pollDefault.idle, 10000);
const POLL_SLIM_ACTIVE_MS = configNumber(pollSlim.active, 10000);
const POLL_SLIM_IDLE_MS = configNumber(pollSlim.idle, 20000);

const searchDebounce = CLIENT_CONFIG.searchDebounceMs || {};
const SEARCH_DEBOUNCE_DEFAULT_MS = configNumber(searchDebounce.default, 250);
const SEARCH_DEBOUNCE_SLIM_MS = configNumber(searchDebounce.slim, 500);

const searchStateMin = CLIENT_CONFIG.searchStateMinIntervalMs || {};
const SEARCH_STATE_MIN_DEFAULT_MS = configNumber(searchStateMin.default, 10000);
const SEARCH_STATE_MIN_SLIM_MS = configNumber(searchStateMin.slim, 20000);

const searchStateConcurrency = CLIENT_CONFIG.searchStateConcurrency || {};
const SEARCH_STATE_CONCURRENCY_DEFAULT = Math.max(
	1,
	Math.round(configNumber(searchStateConcurrency.default, 4))
);
const SEARCH_STATE_CONCURRENCY_SLIM = Math.max(
	1,
	Math.round(configNumber(searchStateConcurrency.slim, 2))
);

const SLIDER_DEBOUNCE_MS = configNumber(CLIENT_CONFIG.sliderDebounceMs, 250);
const IDLE_AFTER_MS = configNumber(CLIENT_CONFIG.idleAfterMs, 60000);
const ACTIVITY_THROTTLE_MS = configNumber(CLIENT_CONFIG.activityThrottleMs, 250);
const CHART_HASH_CHECK_MS = 30000; // Check chart hashes every 30 seconds
const HOME_CACHE_KEY = 'ohProxyHomeSnapshot';
const MAX_ICON_CACHE = Math.max(0, Math.round(configNumber(CLIENT_CONFIG.maxIconCache, 500)));
const MAX_CHART_HASHES = Math.max(0, Math.round(configNumber(CLIENT_CONFIG.maxChartHashes, 500)));

const iconCache = new Map();
let imageTimers = [];
let imageLoadQueue = [];
let imageLoadProcessing = false;
let searchDebounceTimer = null;
let chartHashTimer = null;
const chartHashes = new Map(); // item|period|mode -> hash
let searchStateAbort = null;
let searchStateActiveToken = 0;
let resumeReloadArmed = false;
let resumePingPending = false;
let lastHiddenTime = 0;
let pageFadeToken = 0;
let loadingTimer = null;
let loadingToken = 0;

// --- Helpers ---
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function setBoundedCache(cache, key, value, maxSize) {
	if (!key || maxSize <= 0) return;
	if (cache.has(key)) cache.delete(key);
	cache.set(key, value);
	if (cache.size > maxSize) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
}

function registerCardCleanup(card, cleanup) {
	if (!card || typeof cleanup !== 'function') return;
	if (!card._ohCleanups) card._ohCleanups = [];
	card._ohCleanups.push(cleanup);
}

function runCardCleanups(card) {
	const cleanups = card && card._ohCleanups;
	if (!Array.isArray(cleanups) || cleanups.length === 0) return;
	for (const cleanup of cleanups.splice(0)) {
		try { cleanup(); } catch (err) { logJsError('runCardCleanups failed', err); }
	}
}

function clearLoadingStatusTimer() {
	if (loadingTimer) {
		clearTimeout(loadingTimer);
		loadingTimer = null;
	}
	loadingToken += 1;
}

function scheduleLoadingStatus() {
	clearLoadingStatusTimer();
	const token = loadingToken;
	loadingTimer = setTimeout(() => {
		if (token !== loadingToken) return;
		setStatus('Loading…');
		loadingTimer = null;
	}, LOADING_DELAY_MS);
}

function cancelSearchStateRequests() {
	if (searchStateAbort) {
		searchStateAbort.abort();
		searchStateAbort = null;
	}
	searchStateActiveToken = 0;
	state.searchStateInFlight = false;
}

function isTouchDevice() {
	return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

function haptic(ms = 30) {
	if (navigator.vibrate) navigator.vibrate(ms);
}

function isIOSSafari() {
	const ua = navigator.userAgent;
	if (/iPad|iPhone|iPod/.test(ua)) return true;
	// iPad on iOS 13+ reports as Macintosh
	if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
	return false;
}

function isVideoLandscape(videoEl) {
	return new Promise((resolve) => {
		if (videoEl.videoWidth && videoEl.videoHeight) {
			resolve(videoEl.videoWidth > videoEl.videoHeight);
			return;
		}
		const timeout = setTimeout(() => resolve(true), 3000);
		videoEl.addEventListener('loadedmetadata', () => {
			clearTimeout(timeout);
			resolve(videoEl.videoWidth > videoEl.videoHeight);
		}, { once: true });
	});
}

async function enterVideoFullscreen(videoEl, videoContainer) {
	if (videoFullscreenActive) return;
	resetVideoZoom(videoEl);

	// iOS: use native video fullscreen player
	if (isIOSSafari()) {
		try { videoEl.webkitEnterFullscreen(); } catch (_) {}
		return;
	}

	// Try native fullscreen first, fall back to fake (CSS) fullscreen
	let fake = false;
	const requestFs = videoContainer.requestFullscreen
		|| videoContainer.webkitRequestFullscreen;
	try {
		if (requestFs) await requestFs.call(videoContainer);
		else throw new Error('no API');
	} catch (_) {
		// Native fullscreen blocked (e.g. iframe without allow="fullscreen")
		// Use fake fullscreen: move container to body and cover viewport with CSS
		fake = true;

		// Insert placeholder so we can restore the container later
		videoFsPlaceholder = document.createElement('div');
		videoFsPlaceholder.style.display = 'none';
		videoContainer.parentNode.insertBefore(videoFsPlaceholder, videoContainer);
		document.body.appendChild(videoContainer);

		videoContainer.classList.add('fs-active');
		document.documentElement.classList.add('fs-no-scroll');

		// Listen for Escape key to exit fake fullscreen
		videoFsEscHandler = (e) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				cleanupVideoFullscreen();
			}
		};
		document.addEventListener('keydown', videoFsEscHandler, true);
	}

	videoFullscreenActive = true;
	videoFullscreenFake = fake;
	videoFullscreenVideoEl = videoEl;
	videoFullscreenContainer = videoContainer;

	// Update button icon to exit
	const fsBtn = videoContainer.querySelector('.video-fullscreen-btn');
	if (fsBtn) {
		fsBtn.innerHTML = '<img src="icons/video-fullscreen-exit.svg" alt="Exit Fullscreen" style="width:100%;height:100%;display:block;" />';
		fsBtn.title = 'Exit Fullscreen';
	}

	// On mobile with landscape video, rotate to landscape orientation
	const landscape = await isVideoLandscape(videoEl);
	if (landscape && isTouchDevice() && videoFullscreenActive) {
		if (!fake) {
			try {
				await screen.orientation.lock('landscape');
			} catch (_) {
				videoEl.classList.add('fs-rotated');
			}
		} else {
			videoEl.classList.add('fs-rotated');
		}
	}

}

function exitVideoFullscreen() {
	if (!videoFullscreenActive) return;
	resetVideoZoom(videoFullscreenVideoEl);
	if (videoFullscreenFake) {
		cleanupVideoFullscreen();
		return;
	}
	const exitFs = document.exitFullscreen || document.webkitExitFullscreen;
	if (exitFs) {
		try { exitFs.call(document); } catch (_) {}
	}
}

function cleanupVideoFullscreen() {
	if (!videoFullscreenVideoEl) return;
	const videoEl = videoFullscreenVideoEl;
	const videoContainer = videoFullscreenContainer;
	resetVideoZoom(videoEl);

	videoEl.classList.remove('fs-rotated');
	try { screen.orientation.unlock(); } catch (_) {}

	// Clean up fake fullscreen state
	if (videoFullscreenFake) {
		videoContainer.classList.remove('fs-active');
		document.documentElement.classList.remove('fs-no-scroll');
		// Move container back to its original position
		if (videoFsPlaceholder && videoFsPlaceholder.parentNode) {
			videoFsPlaceholder.parentNode.insertBefore(videoContainer, videoFsPlaceholder);
			videoFsPlaceholder.remove();
		}
		videoFsPlaceholder = null;
	}
	if (videoFsEscHandler) {
		document.removeEventListener('keydown', videoFsEscHandler, true);
		videoFsEscHandler = null;
	}

	// Restore button icon to enter
	const fsBtn = videoContainer?.querySelector('.video-fullscreen-btn');
	if (fsBtn) {
		fsBtn.innerHTML = '<img src="icons/video-fullscreen.svg" alt="Fullscreen" style="width:100%;height:100%;display:block;" />';
		fsBtn.title = 'Fullscreen';
	}

	videoFullscreenActive = false;
	videoFullscreenFake = false;
	videoFullscreenVideoEl = null;
	videoFullscreenContainer = null;
}

function getVideoZoomState(videoEl) {
	if (!videoEl) return null;
	let zoomState = videoZoomStateMap.get(videoEl);
	if (!zoomState) {
		zoomState = {
			scale: 1,
			translateX: 0,
			translateY: 0,
			pinchStartDist: 0,
			pinchStartScale: 1,
			panStartX: 0,
			panStartY: 0,
			panStartTranslateX: 0,
			panStartTranslateY: 0,
			isPanning: false,
		};
		videoZoomStateMap.set(videoEl, zoomState);
	}
	return zoomState;
}

function clampVideoZoomTranslate(zoomState, zoomStage) {
	if (!zoomState || !zoomStage) return;
	if (zoomState.scale <= 1) {
		zoomState.translateX = 0;
		zoomState.translateY = 0;
		return;
	}
	const rect = zoomStage.getBoundingClientRect();
	if (!rect.width || !rect.height) {
		zoomState.translateX = 0;
		zoomState.translateY = 0;
		return;
	}
	const baseWidth = rect.width / zoomState.scale;
	const baseHeight = rect.height / zoomState.scale;
	const maxX = (baseWidth * (zoomState.scale - 1)) / 2;
	const maxY = (baseHeight * (zoomState.scale - 1)) / 2;
	zoomState.translateX = Math.min(maxX, Math.max(-maxX, zoomState.translateX));
	zoomState.translateY = Math.min(maxY, Math.max(-maxY, zoomState.translateY));
}

function applyVideoZoom(videoEl) {
	if (!videoEl) return;
	const zoomState = getVideoZoomState(videoEl);
	const zoomStage = videoEl.closest('.video-zoom-stage');
	if (!zoomState || !zoomStage) return;
	const zoomed = zoomState.scale > 1;
	zoomStage.classList.toggle('zoomed', zoomed);
	if (!zoomed) {
		zoomState.scale = 1;
		zoomState.translateX = 0;
		zoomState.translateY = 0;
		zoomStage.style.transform = '';
		zoomStage.style.transformOrigin = '50% 50%';
		return;
	}
	clampVideoZoomTranslate(zoomState, zoomStage);
	zoomStage.style.transform = `translate(${zoomState.translateX}px, ${zoomState.translateY}px) scale(${zoomState.scale})`;
}

function setVideoZoomOriginFromPoint(videoEl, clientX, clientY) {
	if (!videoEl) return;
	const zoomStage = videoEl.closest('.video-zoom-stage');
	if (!zoomStage) return;
	const rect = zoomStage.getBoundingClientRect();
	if (!rect.width || !rect.height) return;
	const x = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
	const y = Math.min(100, Math.max(0, ((clientY - rect.top) / rect.height) * 100));
	zoomStage.style.transformOrigin = `${x}% ${y}%`;
}

function isVideoZoomReady(videoEl) {
	if (!videoEl) return false;
	const zoomStage = videoEl.closest('.video-zoom-stage');
	return !!zoomStage && zoomStage.classList.contains('zoom-ready');
}

function setVideoZoomReady(videoEl, ready) {
	if (!videoEl) return;
	const zoomStage = videoEl.closest('.video-zoom-stage');
	if (!zoomStage) return;
	const zoomReady = !!ready;
	zoomStage.classList.toggle('zoom-ready', zoomReady);
	if (!zoomReady) {
		resetVideoZoom(videoEl);
	}
}

function resetVideoZoom(videoEl) {
	if (!videoEl) return;
	const zoomState = getVideoZoomState(videoEl);
	if (!zoomState) return;
	zoomState.scale = 1;
	zoomState.translateX = 0;
	zoomState.translateY = 0;
	zoomState.pinchStartDist = 0;
	zoomState.pinchStartScale = 1;
	zoomState.panStartX = 0;
	zoomState.panStartY = 0;
	zoomState.panStartTranslateX = 0;
	zoomState.panStartTranslateY = 0;
	zoomState.isPanning = false;
	const zoomStage = videoEl.closest('.video-zoom-stage');
	if (zoomStage) {
		zoomStage.classList.remove('zoomed');
		zoomStage.style.transform = '';
		zoomStage.style.transformOrigin = '50% 50%';
	}
}

function initVideoZoom(videoEl, zoomStage) {
	if (!videoEl || !zoomStage) return;
	if (videoEl.dataset.zoomInit === '1') return;
	videoEl.dataset.zoomInit = '1';
	const zoomState = getVideoZoomState(videoEl);
	if (!zoomState) return;

	if (!isTouchDevice()) {
		zoomStage.addEventListener('click', (e) => {
			if (!isVideoZoomReady(videoEl)) return;
			e.preventDefault();
			e.stopPropagation();
			if (zoomState.scale > 1) {
				resetVideoZoom(videoEl);
				return;
			}
			zoomState.scale = VIDEO_ZOOM_DESKTOP_SCALE;
			zoomState.translateX = 0;
			zoomState.translateY = 0;
			setVideoZoomOriginFromPoint(videoEl, e.clientX, e.clientY);
			applyVideoZoom(videoEl);
		});
		zoomStage.addEventListener('pointermove', (e) => {
			if (!isVideoZoomReady(videoEl)) return;
			if (zoomState.scale <= 1) return;
			setVideoZoomOriginFromPoint(videoEl, e.clientX, e.clientY);
		});
		return;
	}

	zoomStage.addEventListener('touchstart', (e) => {
		if (!isVideoZoomReady(videoEl)) return;
		if (e.touches.length === 2) {
			e.preventDefault();
			zoomState.isPanning = false;
			const dx = e.touches[0].clientX - e.touches[1].clientX;
			const dy = e.touches[0].clientY - e.touches[1].clientY;
			zoomState.pinchStartDist = Math.hypot(dx, dy);
			zoomState.pinchStartScale = zoomState.scale;
		} else if (e.touches.length === 1 && zoomState.scale > 1) {
			zoomState.isPanning = true;
			zoomState.panStartX = e.touches[0].clientX;
			zoomState.panStartY = e.touches[0].clientY;
			zoomState.panStartTranslateX = zoomState.translateX;
			zoomState.panStartTranslateY = zoomState.translateY;
		}
	}, { passive: false });

	zoomStage.addEventListener('touchmove', (e) => {
		if (!isVideoZoomReady(videoEl)) return;
		if (e.touches.length === 2 && zoomState.pinchStartDist > 0) {
			e.preventDefault();
			const dx = e.touches[0].clientX - e.touches[1].clientX;
			const dy = e.touches[0].clientY - e.touches[1].clientY;
			const dist = Math.hypot(dx, dy);
			zoomState.scale = Math.min(VIDEO_ZOOM_MAX_SCALE, Math.max(1, zoomState.pinchStartScale * (dist / zoomState.pinchStartDist)));
			applyVideoZoom(videoEl);
		} else if (e.touches.length === 1 && zoomState.isPanning && zoomState.scale > 1) {
			e.preventDefault();
			const dx = (e.touches[0].clientX - zoomState.panStartX) * VIDEO_ZOOM_PAN_SPEED;
			const dy = (e.touches[0].clientY - zoomState.panStartY) * VIDEO_ZOOM_PAN_SPEED;
			zoomState.translateX = zoomState.panStartTranslateX + dx;
			zoomState.translateY = zoomState.panStartTranslateY + dy;
			applyVideoZoom(videoEl);
		}
	}, { passive: false });

	zoomStage.addEventListener('touchend', (e) => {
		if (e.touches.length < 2) {
			zoomState.pinchStartDist = 0;
		}
		if (e.touches.length === 0) {
			zoomState.isPanning = false;
			if (zoomState.scale < VIDEO_ZOOM_RESET_THRESHOLD) {
				resetVideoZoom(videoEl);
			}
		}
	});

	zoomStage.addEventListener('touchcancel', () => {
		resetVideoZoom(videoEl);
	});
}

function showResumeSpinner(show) {
	if (!els.resumeSpinner) return;
	els.resumeSpinner.classList.toggle('active', show);
	document.body.classList.toggle('resume-spinner-active', show);
}


function isHomePage() {
	return state.rootPageUrl && state.pageUrl && state.rootPageUrl === state.pageUrl;
}

function canRestoreHomeSnapshot() {
	if (!state.pageUrl) return true;
	return state.rootPageUrl && state.pageUrl === state.rootPageUrl;
}

function saveHomeSnapshot() {
	if (!isHomePage()) return;
	if (!Array.isArray(state.rawWidgets) || !state.rawWidgets.length) return;
	const snapshot = {
		pageUrl: state.pageUrl,
		pageTitle: state.pageTitle,
		rootPageUrl: state.rootPageUrl,
		rootPageTitle: state.rootPageTitle,
		ohOrigin: state.ohOrigin,
		rawWidgets: state.rawWidgets,
		iconCache: Object.fromEntries(iconCache),
		savedAt: Date.now(),
	};
	try {
		localStorage.setItem(HOME_CACHE_KEY, JSON.stringify(snapshot));
	} catch (err) {
		logJsError('saveHomeSnapshot failed', err);
	}
}

function loadHomeSnapshot() {
	try {
		const raw = localStorage.getItem(HOME_CACHE_KEY);
		if (!raw) return null;
		const snapshot = JSON.parse(raw);
		if (!snapshot || !Array.isArray(snapshot.rawWidgets) || !snapshot.rawWidgets.length) {
			return null;
		}
		return snapshot;
	} catch (err) {
		logJsError('loadHomeSnapshot failed', err);
		return null;
	}
}

function applyHomeSnapshot(snapshot) {
	if (!snapshot || !Array.isArray(snapshot.rawWidgets) || !snapshot.rawWidgets.length) return false;
	state.rawWidgets = snapshot.rawWidgets;
	state.pageUrl = snapshot.pageUrl || state.pageUrl || null;
	state.pageTitle = snapshot.pageTitle || state.pageTitle;
	state.rootPageUrl = snapshot.rootPageUrl || snapshot.pageUrl || state.rootPageUrl;
	state.rootPageTitle = snapshot.rootPageTitle || snapshot.pageTitle || state.rootPageTitle;
	if (snapshot.ohOrigin) state.ohOrigin = snapshot.ohOrigin;
	state.lastPageUrl = state.pageUrl || state.lastPageUrl;
	state.stack = [];
	state.filter = '';
	if (els.search) els.search.value = '';
	// Restore icon cache from snapshot
	if (snapshot.iconCache && typeof snapshot.iconCache === 'object') {
		for (const [key, url] of Object.entries(snapshot.iconCache)) {
			if (key && url && !iconCache.has(key)) {
				iconCache.set(key, url);
			}
		}
	}
	updateNavButtons();
	syncHistory(true);
	return true;
}

function stopAllVideoStreams() {
	const videos = document.querySelectorAll('video.video-stream');
	for (const video of videos) {
		setVideoZoomReady(video, false);
		resetVideoZoom(video);
		if (video.src) {
			video.src = '';
			video.load();
		}
	}
}

function pauseVideoStreamsForVisibility() {
	const videos = document.querySelectorAll('video.video-stream');
	for (const video of videos) {
		setVideoZoomReady(video, false);
		resetVideoZoom(video);
		if (video.src) {
			video.dataset.savedSrc = video.src;
			// Save preview image URL for use as poster during resume
			const container = video.closest('.video-container');
			const preview = container?.querySelector('.video-preview');
			if (preview) {
				const bg = preview.style.backgroundImage;
				const match = bg && bg.match(/url\(['"]?(.+?)['"]?\)/);
				if (match) video.dataset.savedPoster = match[1];
			}
			video.src = '';
			video.load();
		}
	}
	videosPausedForVisibility = true;
}

function resumeVideoStreamsFromVisibility() {
	videosPausedForVisibility = false;
	const videos = document.querySelectorAll('video.video-stream');
	for (const video of videos) {
		setVideoZoomReady(video, false);
		resetVideoZoom(video);
		if (video.dataset.savedSrc) {
			const container = video.closest('.video-container');
			const spinner = container?.querySelector('.video-spinner');
			if (video.dataset.savedPoster) {
				video.poster = video.dataset.savedPoster;
				delete video.dataset.savedPoster;
			}
			if (spinner) {
				spinner.style.display = 'flex';
				spinner.style.zIndex = '20';
			}
			video.addEventListener('playing', function onResumePlaying() {
				video.removeEventListener('playing', onResumePlaying);
				video.removeAttribute('poster');
				if (spinner) {
					spinner.style.display = '';
					spinner.style.zIndex = '';
				}
			});
			video.src = video.dataset.savedSrc;
			video.play().catch(() => {});
			delete video.dataset.savedSrc;
		}
	}
}

function beginPageFadeOut() {
	if (!els.grid || state.isSlim) return null;
	pageFadeToken += 1;
	const token = pageFadeToken;
	els.grid.classList.remove('page-fade-in');
	els.grid.classList.add('page-fade-out');
	return { token, promise: delay(PAGE_FADE_OUT_MS) };
}

function runPageFadeIn(token) {
	if (!els.grid || state.isSlim) return;
	if (token !== pageFadeToken) return;
	els.grid.classList.remove('page-fade-out');
	// Double rAF ensures browser has painted before starting fade-in
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			if (token !== pageFadeToken) return;
			els.grid.classList.add('page-fade-in');
			setTimeout(() => {
				if (token === pageFadeToken) els.grid.classList.remove('page-fade-in');
			}, PAGE_FADE_IN_MS);
		});
	});
}

function setStatus(msg) {
	const text = msg || '';
	els.status.textContent = text;
	els.status.classList.toggle('hidden', !text);
	els.status.classList.toggle('mb-4', !!text);
}

function scrollToTop() {
	const behavior = 'auto';
	try {
		window.scrollTo({ top: 0, behavior });
	} catch {
		window.scrollTo(0, 0);
	}
}

const BOUNCE_MAX_PX = 52;
const BOUNCE_SCALE = 0.4;
const BOUNCE_RETURN_MS = 180;
const BOUNCE_HOLD_MS = 40;
const BOUNCE_REFRESH_THRESHOLD = 1.8;
let bounceResetTimer = null;
let bounceClearTimer = null;
const bounceTouch = {
	active: false,
	hitMaxAtTop: false,
	startY: 0,
	lastY: 0,
};

function getScrollState() {
	const scroller = document.scrollingElement || document.documentElement;
	if (!scroller) return { top: 0, max: 0, atTop: true, atBottom: true };
	const top = scroller.scrollTop || 0;
	const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
	return {
		top,
		max,
		atTop: top <= 0,
		atBottom: top >= max - 1,
	};
}

function shouldHandleBounce(target) {
	if (!target || typeof target.closest !== 'function') return false;
	if (imageViewer && !imageViewer.classList.contains('hidden')) return false;
	if (adminConfigModal && !adminConfigModal.classList.contains('hidden')) return false;
	if (document.body.classList.contains('card-config-open')) return false;
	if (target.closest('input, textarea, select, button, a')) return false;
	if (target.closest('.inline-slider, .oh-select, .fake-select')) return false;
	return true;
}

function applyBounceOffset(offset, { instant = false } = {}) {
	if (!els.grid) return;
	const clamped = Math.max(-BOUNCE_MAX_PX, Math.min(BOUNCE_MAX_PX, offset));
	if (instant) {
		els.grid.style.transition = 'none';
	} else {
		els.grid.style.transition = `transform ${BOUNCE_RETURN_MS}ms ease-out`;
	}
	els.grid.style.transform = clamped ? `translateY(${clamped}px)` : '';
	if (bounceClearTimer) clearTimeout(bounceClearTimer);
	if (!instant && clamped === 0) {
		bounceClearTimer = setTimeout(() => {
			if (!els.grid) return;
			els.grid.style.transition = '';
		}, BOUNCE_RETURN_MS);
	}
}

function releaseBounce() {
	if (bounceResetTimer) clearTimeout(bounceResetTimer);
	bounceResetTimer = setTimeout(() => {
		applyBounceOffset(0);
	}, BOUNCE_HOLD_MS);
}

function handleBounceTouchStart(e) {
	if (state.isSlim) return;
	if (!shouldHandleBounce(e.target)) return;
	const touch = e.touches && e.touches[0];
	if (!touch) return;
	bounceTouch.active = true;
	bounceTouch.hitMaxAtTop = false;
	bounceTouch.startY = touch.clientY;
	bounceTouch.lastY = touch.clientY;
}

function handleBounceTouchMove(e) {
	if (state.isSlim) return;
	if (!bounceTouch.active) return;
	const touch = e.touches && e.touches[0];
	if (!touch) return;
	bounceTouch.lastY = touch.clientY;
	const delta = bounceTouch.lastY - bounceTouch.startY;
	const { atTop, atBottom } = getScrollState();
	if (delta > 0 && atTop) {
		e.preventDefault();
		const offset = delta * BOUNCE_SCALE;
		applyBounceOffset(offset, { instant: true });
		// Track if user pulled past threshold at top (pull-to-refresh)
		if (offset >= BOUNCE_MAX_PX * BOUNCE_REFRESH_THRESHOLD) {
			bounceTouch.hitMaxAtTop = true;
		}
		return;
	}
	if (delta < 0 && atBottom) {
		e.preventDefault();
		applyBounceOffset(delta * BOUNCE_SCALE, { instant: true });
		return;
	}
}

async function handleBounceTouchEnd() {
	if (state.isSlim) return;
	if (!bounceTouch.active) return;
	const shouldRefresh = bounceTouch.hitMaxAtTop;
	bounceTouch.active = false;
	bounceTouch.hitMaxAtTop = false;
	bounceTouch.startY = 0;
	bounceTouch.lastY = 0;
	releaseBounce();

	// Pull-to-refresh: show spinner, force full refresh, hide after 1s
	if (shouldRefresh) {
		_spinnerLock = true;
		showResumeSpinner(true);
		refresh(true);
		await new Promise(r => setTimeout(r, 1000));
		_spinnerLock = false;
		showResumeSpinner(false);
		updateErrorUiState();
	}
}

function queueScrollTop() {
	if (state.isSlim) {
		scrollToTop();
		return;
	}
	state.pendingScrollTop = true;
}

function updateStatusBar() {
	if (!els.statusBar || !els.statusText) return;
	if (!state.connectionReady) {
		const label = state.initialStatusText || connectionStatusInfo().label || 'Connected';
		els.statusText.textContent = label;
		if (state.connectionPending) {
			els.statusBar.classList.add('status-pending');
			els.statusBar.classList.remove('status-ok', 'status-error', 'status-fast');
		} else {
			els.statusBar.classList.add('status-ok');
			els.statusBar.classList.remove('status-error', 'status-pending', 'status-fast');
		}
		updateErrorUiState();
		closeStatusNotification();
		return;
	}
	if (state.connectionOk) {
		const info = connectionStatusInfo();
		els.statusText.textContent = info.label;
		const fast = isFastConnection();
		if (info.isError) {
			els.statusBar.classList.add('status-error');
			els.statusBar.classList.remove('status-ok', 'status-pending', 'status-fast');
		} else if (fast) {
			els.statusBar.classList.add('status-ok', 'status-fast');
			els.statusBar.classList.remove('status-error', 'status-pending');
		} else {
			els.statusBar.classList.add('status-ok');
			els.statusBar.classList.remove('status-error', 'status-pending', 'status-fast');
		}
	} else {
		els.statusText.textContent = 'Disconnected';
		els.statusBar.classList.add('status-error');
		els.statusBar.classList.remove('status-ok', 'status-pending', 'status-fast');
	}
	updateErrorUiState();
	if (state.connectionOk) {
		showStatusNotification();
	} else {
		closeStatusNotification();
	}
}

function positionStatusTooltip(e) {
	if (!els.statusTooltip) return;
	const tw = els.statusTooltip.offsetWidth;
	const th = els.statusTooltip.offsetHeight;
	const x = Math.max(4, Math.min(e.clientX - tw - 16, window.innerWidth - tw - 4));
	const y = Math.max(4, Math.min(e.clientY - th / 2 + 8, window.innerHeight - th - 4));
	els.statusTooltip.style.left = x + 'px';
	els.statusTooltip.style.top = y + 'px';
}

function showStatusTooltip(e) {
	if (!els.statusTooltip) return;
	const valueEl = els.statusTooltip.querySelector('.status-tooltip-value');
	if (valueEl) {
		if (isLanClient === true) {
			valueEl.textContent = 'LAN';
			valueEl.classList.remove('loading');
		} else {
			const latency = getDisplayLatency();
			if (latency !== null) {
				valueEl.textContent = latency + 'ms';
				valueEl.classList.remove('loading');
			} else {
				valueEl.textContent = '';
				valueEl.classList.add('loading');
			}
		}
	}
	if (e && e.clientX !== undefined) {
		positionStatusTooltip(e);
	}
	els.statusTooltip.classList.add('visible');
}

function hideStatusTooltip() {
	if (!els.statusTooltip) return;
	els.statusTooltip.classList.remove('visible');
}

function getStatusNotificationBody() {
	if (!state.connectionReady || state.connectionPending) {
		return state.initialStatusText || 'Connected';
	}
	if (state.connectionOk) {
		const info = connectionStatusInfo();
		if (isLanClient === true) {
			return info.label + ' · LAN';
		}
		const latency = getDisplayLatency();
		if (latency !== null) {
			return info.label + ' · ' + Math.round(latency) + 'ms';
		}
		return info.label;
	}
	return 'Disconnected';
}

async function showStatusNotification() {
	if (CLIENT_CONFIG.statusNotification === false) return;
	if (notificationPermission !== 'granted' || !isTouchDevice()) return;
	if (document.visibilityState === 'hidden') return;
	try {
		const reg = await navigator.serviceWorker.ready;
		if (document.visibilityState === 'hidden') return;
		const siteName = CLIENT_CONFIG.siteName || state.rootPageTitle || state.pageTitle || 'openHAB';
		await reg.showNotification(siteName, {
			tag: STATUS_NOTIFICATION_TAG,
			body: getStatusNotificationBody(),
			icon: './icons/transparent-192.png',
			silent: true,
			renotify: false,
			requireInteraction: true,
		});
		startNotificationHeartbeat();
	} catch (_) { /* ignore */ }
}

async function closeStatusNotification() {
	stopNotificationHeartbeat();
	try {
		const reg = await navigator.serviceWorker.ready;
		const notifications = await reg.getNotifications({ tag: STATUS_NOTIFICATION_TAG });
		notifications.forEach(n => n.close());
	} catch (_) { /* ignore */ }
}

let notificationHeartbeatTimer = null;
function startNotificationHeartbeat() {
	stopNotificationHeartbeat();
	notificationHeartbeatTimer = setInterval(() => {
		if (navigator.serviceWorker && navigator.serviceWorker.controller) {
			navigator.serviceWorker.controller.postMessage({ type: 'notification-heartbeat' });
		}
	}, 1000);
}
function stopNotificationHeartbeat() {
	if (notificationHeartbeatTimer) { clearInterval(notificationHeartbeatTimer); notificationHeartbeatTimer = null; }
}

function updateErrorUiState() {
	const isError = !state.connectionOk;
	document.documentElement.classList.toggle('error-state', isError);
	if (els.search) els.search.disabled = isError;
	updateNavButtons();
	if (!_spinnerLock) {
		showResumeSpinner(isError);
	}
}

function setConnectionStatus(ok, message) {
	const prevOk = state.connectionOk;
	state.connectionOk = ok;
	state.connectionReady = true;
	clearConnectionPending();
	if (ok) {
		state.lastError = '';
		// Reset WS fail count and try reconnecting if not connected
		if (wsFailCount > 0) {
			wsFailCount = 0;
			if (!wsConnection && !wsConnected) {
				connectWs();
			}
		}
	} else {
		state.lastError = message || 'Connection issue';
		invalidatePing();
	}
	if (ok && !prevOk && !state.sitemapCacheReady) {
		resetSitemapCacheRetry();
		fetchFullSitemap();
	}
	updateStatusBar();
}

function parseCssColor(value) {
	const raw = safeText(value).trim().toLowerCase();
	const match = raw.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)$/);
	if (!match) return null;
	const r = Number(match[1]);
	const g = Number(match[2]);
	const b = Number(match[3]);
	const a = match[4] === undefined ? 1 : Number(match[4]);
	if (![r, g, b, a].every((n) => Number.isFinite(n))) return null;
	return {
		r: Math.min(255, Math.max(0, r)),
		g: Math.min(255, Math.max(0, g)),
		b: Math.min(255, Math.max(0, b)),
		a: Math.min(1, Math.max(0, a)),
	};
}

function blendColors(fg, bg) {
	const a = fg.a;
	const inv = 1 - a;
	return {
		r: Math.round(fg.r * a + bg.r * inv),
		g: Math.round(fg.g * a + bg.g * inv),
		b: Math.round(fg.b * a + bg.b * inv),
		a: 1,
	};
}

function colorToHex(color) {
	if (!color) return '';
	const toHex = (n) => n.toString(16).padStart(2, '0');
	return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function updateThemeMeta() {
	const metaTheme = document.querySelector('meta[name="theme-color"]');
	const metaApple = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
	const manifest = document.querySelector('link[rel="manifest"]');
	if (!metaTheme && !metaApple && !manifest) return;
	let resolved = null;
	const header = document.querySelector('header');
	if (header && header.offsetParent !== null) {
		const headerColor = parseCssColor(getComputedStyle(header).backgroundColor);
		if (headerColor) {
			if (headerColor.a < 1) {
				const bodyColor = parseCssColor(getComputedStyle(document.body).backgroundColor) || {
					r: 0, g: 0, b: 0, a: 1,
				};
				resolved = blendColors(headerColor, bodyColor);
			} else {
				resolved = headerColor;
			}
		}
	}
	if (!resolved) {
		const bodyColor = parseCssColor(getComputedStyle(document.body).backgroundColor);
		if (bodyColor) resolved = bodyColor;
	}
	const hex = colorToHex(resolved);
	if (metaTheme && hex) metaTheme.setAttribute('content', hex);
	if (metaApple) {
		metaApple.setAttribute('content', document.body.classList.contains('theme-dark') ? 'black' : 'default');
	}
	if (manifest) {
		const mode = document.body.classList.contains('theme-dark') ? 'dark' : 'light';
		const href = `manifest.webmanifest?theme=${mode}`;
		if (manifest.getAttribute('href') !== href) manifest.setAttribute('href', href);
	}
}

let serverSettingsLoaded = false;

function setTheme(mode, syncToServer = true) {
	const isLight = mode === 'light';
	document.body.classList.toggle('theme-light', isLight);
	document.body.classList.toggle('theme-dark', !isLight);
	if (els.lightMode) els.lightMode.classList.toggle('active', isLight);
	if (els.darkMode) els.darkMode.classList.toggle('active', !isLight);
	if (typeof requestAnimationFrame === 'function') {
		requestAnimationFrame(updateThemeMeta);
	} else {
		updateThemeMeta();
	}
	try { localStorage.setItem('ohTheme', isLight ? 'light' : 'dark'); }
	catch (err) { logJsError('setTheme localStorage failed', err); }
	// Sync to server if settings have been loaded and this isn't the initial load
	if (syncToServer && serverSettingsLoaded) {
		saveSettingsToServer({ darkMode: !isLight });
	}
	// Reload visible chart and webview iframes with new theme mode
	reloadChartIframes(mode);
	reloadWebviewIframes(mode);
}

function reloadChartIframes(mode) {
	const iframes = document.querySelectorAll('iframe.chart-frame');
	iframes.forEach(iframe => {
		// Get actual current URL from contentWindow (src attribute doesn't update with location.replace)
		let currentUrl;
		try {
			currentUrl = iframe.contentWindow.location.href;
		} catch {
			currentUrl = iframe.src || iframe.dataset.chartUrl || '';
		}
		if (!currentUrl || currentUrl === 'about:blank') {
			currentUrl = iframe.src || iframe.dataset.chartUrl || '';
		}
		if (!currentUrl) return;
		// Replace mode param and strip hash (hash is content-based including colors, so invalid across modes)
		const newUrl = currentUrl
			.replace(/([?&])mode=(light|dark)/, `$1mode=${mode}`)
			.replace(/&_t=[^&]*/, '');
		if (newUrl !== currentUrl) {
			// Use location.replace() to avoid adding browser history entry (same-origin iframes)
			setChartIframeAnimState(iframe, newUrl);
			iframe.dataset.chartUrl = newUrl;
			try {
				iframe.contentWindow.location.replace(newUrl);
			} catch {
				// Fallback if contentWindow access fails
				iframe.src = newUrl;
			}
		}
	});
}

function reloadWebviewIframes(mode) {
	const iframes = document.querySelectorAll('iframe.webview-frame');
	iframes.forEach(iframe => {
		// Get actual current URL from contentWindow (src attribute doesn't update with location.replace)
		let currentUrl;
		try {
			currentUrl = iframe.contentWindow.location.href;
		} catch {
			currentUrl = iframe.src || '';
		}
		if (!currentUrl || currentUrl === 'about:blank') {
			currentUrl = iframe.src || '';
		}
		if (!currentUrl) return;
		// Replace mode param in URL
		const newUrl = currentUrl.replace(/([?&])mode=(light|dark)/, `$1mode=${mode}`);
		if (newUrl !== currentUrl) {
			// Use location.replace() to avoid adding browser history entry (same-origin iframes via proxy)
			try {
				iframe.contentWindow.location.replace(newUrl);
			} catch {
				// Fallback if contentWindow access fails (cross-origin)
				iframe.src = newUrl;
			}
		}
	});
}

function toggleTheme() {
	const isLight = document.body.classList.contains('theme-light');
	setTheme(isLight ? 'dark' : 'light');
}

function initTheme(forcedMode) {
	// Priority: forcedMode (URL param) > injected session > localStorage
	let mode = 'dark'; // default
	try {
		if (forcedMode === 'dark' || forcedMode === 'light') {
			mode = forcedMode;
		} else if (window.__OH_SESSION__ && typeof window.__OH_SESSION__.darkMode === 'boolean') {
			mode = window.__OH_SESSION__.darkMode ? 'dark' : 'light';
		} else {
			const saved = localStorage.getItem('ohTheme');
			if (saved === 'dark' || saved === 'light') mode = saved;
		}
	} catch (err) {
		logJsError('initTheme failed', err);
	}
	setTheme(mode, false); // Don't sync to server on init
	serverSettingsLoaded = true; // Settings already loaded from server via injection
}

async function saveSettingsToServer(settings) {
	try {
		await fetch('/api/settings', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(settings),
		});
	} catch (err) {
		logJsError('saveSettingsToServer failed', err);
	}
}

function applyHeaderSmallLayout() {
	const headerTop = document.getElementById('headerTop');
	const headerBottom = document.getElementById('headerBottom');
	const searchWrap = document.getElementById('searchWrap');
	const navWrap = document.getElementById('navWrap');
	const auxWrap = document.getElementById('auxWrap');
	if (auxWrap) auxWrap.classList.add('hidden');
	if (headerBottom) headerBottom.classList.add('hidden');
	if (headerTop && searchWrap && searchWrap.parentElement !== headerTop) headerTop.appendChild(searchWrap);
	if (headerTop && navWrap && navWrap.parentElement !== headerTop) headerTop.appendChild(navWrap);
	syncSearchFocusedLayout();
	scheduleSearchPlaceholderUpdate();
}

function safeText(v) {
	return (v === null || v === undefined) ? '' : String(v);
}

function buildCompactSearchPlaceholder(fullPlaceholder) {
	const full = safeText(fullPlaceholder).trim();
	if (!full) return '...';
	const cleaned = full
		.replace(/\u2026/g, '...')
		.replace(/\s*\.\.\.\s*$/, '')
		.trim();
	if (!cleaned) return '...';
	const firstWord = cleaned.split(/\s+/).find(Boolean) || '';
	return firstWord ? `${firstWord}...` : '...';
}

function measureInputTextWidth(inputEl, text) {
	if (!inputEl || !searchPlaceholderMeasureCtx) return 0;
	const style = window.getComputedStyle(inputEl);
	const font = style.font
		|| `${style.fontStyle} ${style.fontVariant} ${style.fontWeight} ${style.fontSize} / ${style.lineHeight} ${style.fontFamily}`;
	searchPlaceholderMeasureCtx.font = font;
	return searchPlaceholderMeasureCtx.measureText(text).width;
}

function updateSearchPlaceholder() {
	if (!els.search) return;
	if (!searchPlaceholderFull) {
		searchPlaceholderFull = safeText(els.search.getAttribute('placeholder') || els.search.placeholder).trim() || 'Search...';
		searchPlaceholderCompact = buildCompactSearchPlaceholder(searchPlaceholderFull);
	}
	const style = window.getComputedStyle(els.search);
	const paddingLeft = parseFloat(style.paddingLeft) || 0;
	const paddingRight = parseFloat(style.paddingRight) || 0;
	const availableWidth = Math.max(0, els.search.clientWidth - paddingLeft - paddingRight);
	const fullWidth = measureInputTextWidth(els.search, searchPlaceholderFull);
	let nextPlaceholder = searchPlaceholderFull;
	if (fullWidth > availableWidth) {
		const compactWidth = measureInputTextWidth(els.search, searchPlaceholderCompact);
		nextPlaceholder = compactWidth <= availableWidth ? searchPlaceholderCompact : '...';
	}
	if (els.search.placeholder !== nextPlaceholder) {
		els.search.placeholder = nextPlaceholder;
	}
}

function scheduleSearchPlaceholderUpdate() {
	if (searchPlaceholderRaf) return;
	searchPlaceholderRaf = window.requestAnimationFrame(() => {
		searchPlaceholderRaf = 0;
		updateSearchPlaceholder();
	});
}

function isSmallSearchViewport() {
	return window.matchMedia('(max-width: 639px)').matches;
}

function shouldExpandSearchOnFocus() {
	if (!els.search) return false;
	if (state.headerMode === 'none') return false;
	if (!isSmallSearchViewport()) return false;
	return document.activeElement === els.search;
}

function setSearchFocusedLayout(enabled) {
	const root = document.documentElement;
	const className = 'search-focus-expanded';
	if (root.classList.contains(className) === enabled) return;
	root.classList.toggle(className, enabled);
	scheduleSearchPlaceholderUpdate();
}

function syncSearchFocusedLayout() {
	setSearchFocusedLayout(shouldExpandSearchOnFocus());
}

function escapeHtml(v) {
	return safeText(v)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function connectionStatusInfo() {
	const headerAuth = safeText(state.proxyAuth).trim().toLowerCase();
	const headerUser = safeText(state.proxyUser).trim();
	if (headerAuth === 'authenticated' && headerUser) {
		return { label: `Connected · ${headerUser}`, isError: false };
	}
	return { label: 'Connected', isError: false };
}

function stripLeadingSlash(path) {
	if (!path) return path;
	return path[0] === '/' ? path.slice(1) : path;
}

const colorResolveCache = new Map();
let colorResolveEl = null;

function hexToRgb(hex) {
	const raw = hex.replace('#', '').trim();
	if (![3, 6, 8].includes(raw.length)) return null;
	const clean = raw.length === 3
		? raw.split('').map((c) => c + c).join('')
		: raw.slice(0, 6);
	const num = parseInt(clean, 16);
	if (Number.isNaN(num)) return null;
	return {
		r: (num >> 16) & 255,
		g: (num >> 8) & 255,
		b: num & 255,
	};
}

function parseRgbString(value) {
	const match = safeText(value).match(/rgba?\s*\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s]+([\d.]+))?/i);
	if (!match) return null;
	const r = Number(match[1]);
	const g = Number(match[2]);
	const b = Number(match[3]);
	const a = match[4] === undefined ? null : Number(match[4]);
	if (![r, g, b].every((n) => Number.isFinite(n))) return null;
	if (a !== null && (!Number.isFinite(a) || a <= 0)) return null;
	return { r, g, b };
}

function resolveNamedColor(color) {
	if (!document || !document.body) return null;
	if (!colorResolveEl) {
		colorResolveEl = document.createElement('span');
		colorResolveEl.style.display = 'none';
		document.body.appendChild(colorResolveEl);
	}
	colorResolveEl.style.color = '';
	colorResolveEl.style.color = color;
	const computed = getComputedStyle(colorResolveEl).color;
	return parseRgbString(computed);
}

function resolveColorToRgb(color) {
	const c = safeText(color).trim();
	if (!c) return null;
	const key = c.toLowerCase();
	if (colorResolveCache.has(key)) return colorResolveCache.get(key);
	let rgb = null;
	if (c.startsWith('#')) {
		rgb = hexToRgb(c);
	} else if (c.startsWith('rgb')) {
		rgb = parseRgbString(c);
	} else {
		rgb = resolveNamedColor(c);
	}
	colorResolveCache.set(key, rgb);
	return rgb;
}

function isGreenishRgb(rgb) {
	return !!rgb && rgb.g >= rgb.r && rgb.g >= rgb.b;
}

function colorToRgba(color, alpha) {
	const c = safeText(color).trim();
	if (!c) return '';
	let rgb = resolveColorToRgb(c);
	if (!rgb) return c;
	// Use specific glow colors (matching status indicator)
	if (isGreenishRgb(rgb)) {
		rgb = { r: 118, g: 214, b: 152 }; // matches --color-status-ok
	} else if (rgb.r > 150 && rgb.g > 100 && rgb.g < 200 && rgb.b < 100) {
		// Orange/yellow
		rgb = { r: 255, g: 130, b: 42 }; // #ff822a
	} else if (rgb.r > rgb.g && rgb.r > rgb.b) {
		// Red
		rgb = { r: 234, g: 0, b: 52 }; // #ea0034
	}
	return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function applyGlowStyle(card, color) {
	const solid = colorToRgba(color, 1) || color;
	const glow = colorToRgba(color, 0.6) || color;
	if (!solid || !glow) return;
	card.classList.add('glow-card');
	// Add or update glow dot next to meta text
	let dot = card.querySelector('.glow-dot');
	if (!dot) {
		dot = document.createElement('span');
		dot.className = 'glow-dot';
		const meta = card.querySelector('.meta');
		if (meta && meta.parentNode) {
			meta.parentNode.insertBefore(dot, meta);
		} else {
			card.appendChild(dot);
		}
	}
	dot.style.setProperty('--glow-solid', solid);
	dot.style.setProperty('--glow-color', glow);
}

// Per-widget glow rule matching
function extractNumericValue(val) {
	const str = String(val).trim();
	// Handle "Rained X days ago" pattern
	const rainedMatch = str.match(/^rained\s+(\d+)\s+days?\s+ago$/i);
	if (rainedMatch) return parseInt(rainedMatch[1], 10);
	// Extract leading number from strings like "15.5 l/min", "23.4 °C", "100 W"
	const match = str.match(/^-?\d+\.?\d*/);
	if (match) return parseFloat(match[0]);
	return parseFloat(str);
}

function matchesGlowRule(rule, stateValue) {
	const op = rule.operator;
	const ruleVal = rule.value;

	// Normalize values for comparison
	const stateStr = String(stateValue).toLowerCase();
	const ruleStr = String(ruleVal).toLowerCase();

	// Try numeric comparison - extract numbers from values with units (e.g. "15.5 l/min")
	const stateNum = extractNumericValue(stateValue);
	const ruleNum = extractNumericValue(ruleVal);
	const bothNumeric = !isNaN(stateNum) && !isNaN(ruleNum);

	switch (op) {
		case '*': return true; // catch-all
		case '=':
			return stateStr === ruleStr;
		case '!=':
			return stateStr !== ruleStr;
		case '>':  return bothNumeric && stateNum > ruleNum;
		case '<':  return bothNumeric && stateNum < ruleNum;
		case '>=': return bothNumeric && stateNum >= ruleNum;
		case '<=': return bothNumeric && stateNum <= ruleNum;
		case 'contains':   return stateStr.includes(ruleStr);
		case '!contains':  return !stateStr.includes(ruleStr);
		case 'startsWith': return stateStr.startsWith(ruleStr);
		case 'endsWith':   return stateStr.endsWith(ruleStr);
		default: return false;
	}
}

function getWidgetGlowOverride(wKey, stateValue) {
	const rules = widgetGlowRulesMap.get(wKey);
	if (!rules || !rules.length) return null;
	for (const rule of rules) {
		if (matchesGlowRule(rule, stateValue)) {
			return rule.color;
		}
	}
	return null;
}

function ensureJsonParam(url) {
	if (!url) return url;
	if (url.includes('type=json')) return url;
	return url + (url.includes('?') ? '&' : '?') + 'type=json';
}

function toRelativeRestLink(link) {
	if (!link) return link;
	try {
		const u = new URL(link, window.location.origin);
		return stripLeadingSlash(u.pathname + u.search + u.hash);
	} catch (err) {
		logJsError(`toRelativeRestLink failed for ${link}`, err);
		return stripLeadingSlash(link);
	}
}

function widgetPageLink(widget) {
	const link = widget?.linkedPage?.link || widget?.link;
	if (typeof link !== 'string') return null;
	if (!link.includes('/rest/sitemaps/')) return null;
	return link;
}

function toRelativeUrl(link) {
	if (!link) return link;
	try {
		const u = new URL(link, window.location.origin);
		return stripLeadingSlash(u.pathname + u.search + u.hash);
	} catch (err) {
		logJsError(`toRelativeUrl failed for ${link}`, err);
		return stripLeadingSlash(link);
	}
}

function normalizeMediaUrl(url) {
	if (!url) return url;
	try {
		const u = new URL(url, window.location.origin);
		const path = u.pathname + u.search + u.hash;
		if (
			path.startsWith('/proxy') ||
			path.startsWith('/openhab.app') ||
			path.startsWith('/images') ||
			path.startsWith('/icon') ||
			path.startsWith('/chart')
		) {
			return stripLeadingSlash(path);
		}
		if (state.ohOrigin && u.origin === state.ohOrigin) {
			return stripLeadingSlash(path);
		}
	} catch (err) {
		logJsError(`normalizeMediaUrl failed for ${url}`, err);
	}
	return stripLeadingSlash(url);
}

function shouldBypassProxy(url) {
	if (!url || !WEBVIEW_NO_PROXY.length) return false;
	try {
		const u = new URL(url);
		const host = u.hostname.toLowerCase();
		const port = u.port || (u.protocol === 'https:' ? '443' : '80');
		return WEBVIEW_NO_PROXY.some((entry) => {
			if (!entry) return false;
			let entryHost, entryPort;
			if (typeof entry === 'string') {
				const parts = entry.trim().toLowerCase().split(':');
				entryHost = parts[0];
				entryPort = parts[1] || '';
			} else if (typeof entry === 'object') {
				entryHost = (entry.host || '').toLowerCase();
				entryPort = String(entry.port || '');
			} else {
				return false;
			}
			return host === entryHost && (!entryPort || port === entryPort);
		});
	} catch (err) {
		logJsError(`shouldBypassProxy failed for ${url}`, err);
		return false;
	}
}

function imageWidgetUrl(widget) {
	// All image items use /proxy?url=LABEL - width added by resolveImageUrl
	const label = safeText(widget?.label || '').trim();
	if (!label) return '';
	return `proxy?url=${encodeURIComponent(label)}`;
}

function getThemeMode() {
	return document.body.classList.contains('theme-light') ? 'light' : 'dark';
}

function appendModeParam(url, mode) {
	if (!url) return url;
	// Split at fragment first so we only check/modify the query string portion
	const hashIdx = url.indexOf('#');
	const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
	const frag = hashIdx >= 0 ? url.slice(hashIdx) : '';
	// Don't add if mode param already present in query string
	if (/[?&]mode=/.test(base)) return url;
	return base + (base.includes('?') ? '&' : '?') + `mode=${mode}` + frag;
}

function chartWidgetUrl(widget) {
	// Chart items use /chart?item=NAME&period=PERIOD&mode=light|dark&title=TITLE
	const itemName = safeText(widget?.item?.name || '').trim();
	const period = safeText(widget?.period || '').trim();
	if (!itemName || !period) return '';
	const mode = getThemeMode();
	const labelParts = splitLabelState(widget?.label || '');
	const title = labelParts.title || '';
	let url = `chart?item=${encodeURIComponent(itemName)}&period=${encodeURIComponent(period)}&mode=${mode}`;
	if (title) url += `&title=${encodeURIComponent(title)}`;
	return url;
}

function withCacheBust(url) {
	if (!url) return url;
	const hashIdx = url.indexOf('#');
	const base = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
	const frag = hashIdx >= 0 ? url.slice(hashIdx) : '';
	return base + (base.includes('?') ? '&' : '?') + `_ts=${Date.now()}` + frag;
}

function appendProxyWidth(proxyUrl, width) {
	if (!proxyUrl || !Number.isFinite(width) || width <= 0) return proxyUrl;
	let proxy;
	try {
		proxy = new URL(proxyUrl, window.location.origin);
	} catch (err) {
		logJsError(`appendProxyWidth invalid proxyUrl ${proxyUrl}`, err);
		return proxyUrl;
	}
	const encoded = proxy.searchParams.get('url');
	if (!encoded) return proxyUrl;
	let targetText = encoded;
	try { targetText = decodeURIComponent(encoded); } catch (err) {
		logJsError('appendProxyWidth decodeURIComponent failed', err);
	}
	let target;
	try {
		target = new URL(targetText);
	} catch (err) {
		logJsError(`appendProxyWidth invalid target ${targetText}`, err);
		return proxyUrl;
	}
	if (!target.searchParams.has('width')) {
		target.searchParams.set('width', String(Math.round(width)));
		proxy.searchParams.set('url', target.toString());
	}
	const params = proxy.searchParams.toString();
	const path = `${proxy.pathname}${params ? `?${params}` : ''}${proxy.hash || ''}`;
	return stripLeadingSlash(path);
}

function resolveImageUrl(imgEl, url) {
	if (!imgEl) return url;
	const rect = imgEl.getBoundingClientRect();
	const width = Math.round(rect.width || 0);
	if (width <= 0) return url;
	return appendProxyWidth(url, width);
}

function resolveChartUrl(imgEl, url) {
	if (!imgEl) return url;
	const rect = imgEl.getBoundingClientRect();
	const width = Math.round(rect.width || 0);
	if (width <= 0) return url;
	const separator = url.includes('?') ? '&' : '?';
	return `${url}${separator}width=${width}`;
}

function isChartUrl(url) {
	return typeof url === 'string' && url.startsWith('chart?');
}

function resolveMediaUrl(imgEl, url) {
	if (isChartUrl(url)) return resolveChartUrl(imgEl, url);
	return resolveImageUrl(imgEl, url);
}

function clearImageTimer(el) {
	if (!el || !el._ohTimer) return;
	clearInterval(el._ohTimer);
	const idx = imageTimers.indexOf(el._ohTimer);
	if (idx !== -1) imageTimers.splice(idx, 1);
	el._ohTimer = null;
}

function clearImageTimers() {
	for (const t of imageTimers) clearInterval(t);
	imageTimers = [];
	imageLoadQueue = [];
	imageLoadProcessing = false;
}

function hasProxyImagesInView() {
	const imgs = Array.from(document.querySelectorAll('.card-image'));
	if (!imgs.length) return false;
	const viewTop = 0;
	const viewBottom = window.innerHeight || document.documentElement.clientHeight || 0;
	for (const img of imgs) {
		const url = safeText(img.dataset.mediaUrl || img.src || '');
		if (!url.includes('proxy?url=') && !isChartUrl(url)) continue;
		const rect = img.getBoundingClientRect();
		if (rect.bottom >= viewTop && rect.top <= viewBottom) return true;
	}
	return false;
}

function refreshVisibleProxyImages() {
	const imgs = Array.from(document.querySelectorAll('.card-image'));
	if (!imgs.length) return;
	const viewBottom = window.innerHeight || document.documentElement.clientHeight || 0;
	const epoch = imageResizeEpoch;
	for (const img of imgs) {
		const url = safeText(img.dataset.mediaUrl || img.src || '');
		if (!url.includes('proxy?url=') && !isChartUrl(url)) continue;
		const rect = img.getBoundingClientRect();
		if (rect.bottom < 0 || rect.top > viewBottom) continue;
		if (epoch && img.dataset.resizeEpoch === String(epoch)) continue;
		const resolved = resolveMediaUrl(img, url);
		img.src = withCacheBust(resolved);
		if (epoch) img.dataset.resizeEpoch = String(epoch);
	}
}

function hasStaleProxyImages() {
	const epoch = imageResizeEpoch;
	if (!epoch) return false;
	const imgs = Array.from(document.querySelectorAll('.card-image'));
	for (const img of imgs) {
		const url = safeText(img.dataset.mediaUrl || img.src || '');
		if (!url.includes('proxy?url=') && !isChartUrl(url)) continue;
		if (img.dataset.resizeEpoch !== String(epoch)) return true;
	}
	return false;
}

function scheduleImageResizeRefresh() {
	if (imageResizeTimer) clearTimeout(imageResizeTimer);
	imageResizeTimer = setTimeout(() => {
		imageResizeTimer = null;
		imageResizeEpoch += 1;
		imageResizePending = true;
		if (imageViewer && !imageViewer.classList.contains('hidden') && imageViewerFitMode === 'real') {
			updateImageViewerFrameSize();
		}
		if (!hasProxyImagesInView()) {
			if (!hasStaleProxyImages()) imageResizePending = false;
			return;
		}
		refreshVisibleProxyImages();
		if (!hasStaleProxyImages()) imageResizePending = false;
	}, 250);
}

// Recalculate stretch card spans based on their position in the grid row
let stretchResizeTimer = null;
function recalculateStretchCards() {
	if (!els.grid) return;
	const children = Array.from(els.grid.children);
	if (!children.length) return;
	// Determine column count based on viewport (matches Tailwind breakpoints: lg:3, sm:2, default:1)
	const cols = window.matchMedia('(min-width: 1024px)').matches ? 3
		: window.matchMedia('(min-width: 640px)').matches ? 2 : 1;
	let currentCol = 0;
	for (const el of children) {
		// Section headers span full width, reset column counter
		if (el.classList.contains('section-header')) {
			currentCol = 0;
			continue;
		}
		// Only process widget cards (have data-widget-key)
		if (!el.dataset.widgetKey) continue;
		// Check full width based on active breakpoint
		const isFullWidth = (cols === 3 && el.classList.contains('lg:col-span-3')) ||
			(cols === 2 && el.classList.contains('sm:col-span-2'));
		const isStretch = el.classList.contains('card-stretch');
		if (isStretch) {
			const remaining = cols - currentCol;
			el.style.gridColumn = remaining > 1 ? `span ${remaining}` : '';
			currentCol = 0; // Stretch fills to end of row
		} else if (isFullWidth) {
			el.style.gridColumn = '';
			currentCol = 0; // Full width uses entire row
		} else {
			el.style.gridColumn = '';
			currentCol = (currentCol + 1) % cols;
		}
	}
}

function scheduleStretchRecalc() {
	if (stretchResizeTimer) clearTimeout(stretchResizeTimer);
	stretchResizeTimer = setTimeout(() => {
		stretchResizeTimer = null;
		recalculateStretchCards();
	}, 100);
}

function scheduleImageScrollRefresh() {
	if (!imageResizePending) return;
	if (imageScrollTimer) clearTimeout(imageScrollTimer);
	imageScrollTimer = setTimeout(() => {
		imageScrollTimer = null;
		if (!hasProxyImagesInView()) return;
		refreshVisibleProxyImages();
		if (!hasStaleProxyImages()) imageResizePending = false;
	}, 150);
}

function processImageQueue() {
	if (imageLoadProcessing || imageLoadQueue.length === 0) return;
	imageLoadProcessing = true;
	const entry = imageLoadQueue.shift();
	const imgEl = entry?.imgEl;
	if (!imgEl || !imgEl.isConnected) {
		imageLoadProcessing = false;
		processImageQueue();
		return;
	}
	imgEl._ohLoading = true;
	const url = entry.url;
	const refreshMs = entry.refreshMs;
	let ms = Number(refreshMs);
	if (state.isSlim && Number.isFinite(ms) && ms > 0 && ms < MIN_IMAGE_REFRESH_MS) {
		ms = MIN_IMAGE_REFRESH_MS;
	}
	const resolved = resolveMediaUrl(imgEl, url);
	let done = false;
	let timeoutId = null;
	const finish = () => {
		if (done) return;
		done = true;
		if (timeoutId) clearTimeout(timeoutId);
		imgEl.removeEventListener('load', handleLoad);
		imgEl.removeEventListener('error', handleError);
		imgEl.dataset.loaded = 'true';
		const card = imgEl.closest('.image-card, .chart-card');
		if (card) card.classList.remove('image-loading');
		if (Number.isFinite(ms) && ms > 0) {
			const update = () => {
				const freshUrl = resolveMediaUrl(imgEl, url);
				imgEl.src = withCacheBust(freshUrl);
				if (imageResizeEpoch) imgEl.dataset.resizeEpoch = String(imageResizeEpoch);
			};
			const timer = setInterval(update, ms);
			imgEl._ohTimer = timer;
			imageTimers.push(timer);
		}
		imgEl._ohLoading = false;
		imageLoadProcessing = false;
		processImageQueue();
		const pending = imgEl._ohPendingImage;
		if (pending) {
			imgEl._ohPendingImage = null;
			setupImage(imgEl, pending.url, pending.refreshMs);
		}
	};
	const handleLoad = () => finish();
	const handleError = () => finish();
	imgEl.addEventListener('load', handleLoad);
	imgEl.addEventListener('error', handleError);
	if (IMAGE_LOAD_TIMEOUT_MS > 0) {
		timeoutId = setTimeout(finish, IMAGE_LOAD_TIMEOUT_MS);
	}
	imgEl.src = withCacheBust(resolved);
	if (imageResizeEpoch) imgEl.dataset.resizeEpoch = String(imageResizeEpoch);
}

function setupImage(imgEl, url, refreshMs) {
	if (imgEl._ohTimer) {
		clearInterval(imgEl._ohTimer);
		imgEl._ohTimer = null;
	}
	if (imgEl._ohLoading) {
		imgEl._ohPendingImage = { url, refreshMs };
		return;
	}
	const existing = imageLoadQueue.find((entry) => entry.imgEl === imgEl);
	if (existing) {
		existing.url = url;
		existing.refreshMs = refreshMs;
		return;
	}
	imageLoadQueue.push({ imgEl, url, refreshMs });
	if (typeof requestAnimationFrame === 'function') {
		requestAnimationFrame(processImageQueue);
	} else {
		processImageQueue();
	}
}

let imageViewer = null;
let imageViewerFrame = null;
let imageViewerImg = null;
let imageViewerClose = null;
let imageViewerZoomed = false;
let imageViewerTimer = null;
let imageViewerUrl = '';
let imageViewerRefreshMs = null;
let imageViewerInitialLoadPending = false;
let imageViewerFitMode = 'real';
let imageResizeEpoch = 0;
let imageResizeTimer = null;
let imageScrollTimer = null;
let imageResizePending = false;

const chartAnimSeen = new Set();

function getChartAnimKey(chartUrl) {
	if (!chartUrl) return null;
	try {
		const url = new URL(chartUrl, window.location.origin);
		const item = url.searchParams.get('item') || '';
		const period = url.searchParams.get('period') || '';
		if (!item || !period) return null;
		return `${item}|${period}`;
	} catch (err) {
		logJsError(`getChartAnimKey failed for ${chartUrl}`, err);
		return null;
	}
}

function setChartIframeAnimState(iframe, chartUrl) {
	const key = getChartAnimKey(chartUrl);
	if (!key) {
		iframe.name = 'chart';
		return;
	}
	if (chartAnimSeen.has(key)) {
		iframe.name = 'noanim';
	} else {
		iframe.name = 'chart';
		chartAnimSeen.add(key);
	}
}

function resetChartAnimState() {
	chartAnimSeen.clear();
	chartHashes.clear();
}


function snapshotHistoryState() {
	const stack = Array.isArray(state.stack)
		? state.stack.map((entry) => ({
			pageUrl: entry?.pageUrl || '',
			pageTitle: entry?.pageTitle || '',
		}))
		: [];
	return {
		pageUrl: state.pageUrl,
		pageTitle: state.pageTitle,
		stack,
	};
}

function pushImageViewerHistory(url, refreshMs) {
	if (!window.history) return;
	const pageUrl = state.pageUrl;
	if (!pageUrl) return;
	const current = window.history.state;
	const nextUrl = safeText(url);
	if (current?.imageViewer && safeText(current.imageViewer.url) === nextUrl) return;
	const payload = {
		...snapshotHistoryState(),
		imageViewer: {
			url: nextUrl,
			refreshMs: Number.isFinite(Number(refreshMs)) ? Number(refreshMs) : null,
		},
	};
	history.pushState(payload, '', window.location.pathname + window.location.search + window.location.hash);
}

// Card Config Modal
let cardConfigModal = null;
let cardConfigWidgetKey = '';
let cardConfigWidgetLabel = '';
let historyOffsetStack = [];
let historyMappings = [];
let historyCursorStack = [];
let historyGlowColor = null;
let historyAbort = null;
let cardConfigInitialStateJson = null;

function makeFrameDraggable(frame, handle) {
	let dragging = false;
	let startX = 0, startY = 0;
	let offsetX = 0, offsetY = 0;

	function onPointerDown(e) {
		dragging = true;
		startX = e.clientX - offsetX;
		startY = e.clientY - offsetY;
		handle.setPointerCapture(e.pointerId);
		handle.style.cursor = 'move';
		// Close any open select dropdown menus inside the frame
		frame.querySelectorAll('.glow-select-wrap.menu-open, .admin-select-wrap.menu-open').forEach(w => {
			if (typeof w._closeMenu === 'function') w._closeMenu();
		});
	}

	function onPointerMove(e) {
		if (!dragging) return;
		let newX = e.clientX - startX;
		let newY = e.clientY - startY;
		// Clamp so all 4 edges stay within viewport
		const rect = frame.getBoundingClientRect();
		const fw = rect.width, fh = rect.height;
		const vw = window.innerWidth, vh = window.innerHeight;
		// Natural center (where the frame sits at zero offset)
		const centerX = (rect.left + rect.right) / 2 - offsetX;
		const centerY = (rect.top + rect.bottom) / 2 - offsetY;
		// Clamp: left edge >= 0, right edge <= vw
		const minX = -centerX + fw / 2;
		const maxX = vw - centerX - fw / 2;
		const minY = -centerY + fh / 2;
		const maxY = vh - centerY - fh / 2;
		newX = Math.max(minX, Math.min(maxX, newX));
		newY = Math.max(minY, Math.min(maxY, newY));
		offsetX = newX;
		offsetY = newY;
		frame.style.transform = 'translate(' + offsetX + 'px, ' + offsetY + 'px)';
	}

	function onPointerUp() {
		dragging = false;
		handle.style.cursor = '';
	}

	handle.addEventListener('pointerdown', onPointerDown);
	handle.addEventListener('pointermove', onPointerMove);
	handle.addEventListener('pointerup', onPointerUp);

	frame._resetDragPosition = function() {
		offsetX = 0;
		offsetY = 0;
		frame.style.transform = '';
	};
}

function ensureCardConfigModal() {
	if (cardConfigModal) return;
	const wrap = document.createElement('div');
	wrap.id = 'cardConfigModal';
	wrap.className = 'card-config-modal hidden';
	const cc = ohLang.cardConfig;
	wrap.innerHTML = `
		<div class="card-config-frame glass">
			<div class="card-config-header">
				<h2>${cc.title}</h2>
				<button type="button" class="card-config-close">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M18 6L6 18M6 6l12 12"/>
					</svg>
				</button>
			</div>
			<div class="card-config-body">
				<div class="history-section" style="display:none;">
					<div class="item-config-section-header">${cc.historyHeader}</div>
					<div class="history-entries"></div>
					<div class="history-nav" style="display:none;"></div>
				</div>
				<div class="default-sound-section" style="display:none;">
					<div class="item-config-section-header">${cc.soundHeader}</div>
					<div class="item-config-visibility">
						<label class="item-config-radio">
							<input type="radio" name="defaultSound" value="muted" checked>
							<span>${cc.soundMuted}</span>
						</label>
						<label class="item-config-radio">
							<input type="radio" name="defaultSound" value="unmuted">
							<span>${cc.soundUnmuted}</span>
						</label>
					</div>
				</div>
				<div class="iframe-height-section" style="display:none;">
					<div class="item-config-section-header">${cc.heightHeader}</div>
					<input type="text" class="iframe-height-input" placeholder="${cc.heightPlaceholder}" inputmode="numeric">
				</div>
				<div class="proxy-cache-section" style="display:none;">
					<div class="item-config-section-header">${cc.cacheHeader}</div>
					<input type="text" class="proxy-cache-input" placeholder="${cc.cachePlaceholder}" inputmode="numeric">
				</div>
				<div class="visibility-section">
					<div class="item-config-section-header">${cc.visibilityHeader}</div>
					<div class="item-config-visibility">
						<label class="item-config-radio">
							<input type="radio" name="visibility" value="all" checked>
							<span>${cc.visAll}</span>
						</label>
						<label class="item-config-radio">
							<input type="radio" name="visibility" value="normal">
							<span>${cc.visNormal}</span>
						</label>
						<label class="item-config-radio">
							<input type="radio" name="visibility" value="admin">
							<span>${cc.visAdmin}</span>
						</label>
					</div>
				</div>
				<div class="card-width-section" style="display:none;">
					<div class="item-config-section-header">${cc.cardWidthHeader}</div>
					<div class="item-config-visibility">
						<label class="item-config-radio">
							<input type="radio" name="cardWidth" value="standard" checked>
							<span>${cc.widthStandard}</span>
						</label>
						<label class="item-config-radio">
							<input type="radio" name="cardWidth" value="stretch">
							<span>${cc.widthStretch}</span>
						</label>
						<label class="item-config-radio">
							<input type="radio" name="cardWidth" value="full">
							<span>${cc.widthFull}</span>
						</label>
					</div>
				</div>
				<div class="glow-rules-section">
					<div class="item-config-section-header">${cc.glowHeader}</div>
					<div class="card-config-rules"></div>
					<button type="button" class="card-config-add">${cc.addRuleBtn}</button>
				</div>
			</div>
			<div class="card-config-footer">
				<span class="card-config-status"></span>
				<button type="button" class="card-config-cancel">${cc.closeBtn}</button>
				<button type="button" class="card-config-save">${cc.saveBtn}</button>
			</div>
		</div>
	`;
	document.body.appendChild(wrap);
	cardConfigModal = wrap;

	// Event listeners
	wrap.querySelector('.card-config-close').addEventListener('click', () => { haptic(); closeCardConfigModal(); });
	wrap.querySelector('.card-config-cancel').addEventListener('click', () => { haptic(); closeCardConfigModal(); });
	wrap.querySelector('.card-config-save').addEventListener('click', async () => {
		haptic();
		await saveCardConfig();
	});
	wrap.querySelector('.card-config-add').addEventListener('click', () => { haptic(); addGlowRuleRow(); });
	// Sync checked class on radio labels for browsers without :has() support
	wrap.addEventListener('change', (e) => {
		if (e.target.type !== 'radio') return;
		haptic();
		const group = e.target.name;
		wrap.querySelectorAll(`input[name="${group}"]`).forEach(r => r.closest('.item-config-radio')?.classList.toggle('checked', r.checked));
	});
	wrap.addEventListener('click', (e) => {
		if (e.target === wrap) { haptic(); closeCardConfigModal(); }
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && cardConfigModal && !cardConfigModal.classList.contains('hidden')) {
			haptic();
			closeCardConfigModal();
		}
	});
	makeFrameDraggable(wrap.querySelector('.card-config-frame'), wrap.querySelector('.card-config-header h2'));
}

function createCustomSelect(options, initialValue, className) {
	const wrap = document.createElement('div');
	wrap.className = `glow-select-wrap ${className}`;

	const current = options.find(o => o.value === initialValue) || options[0];
	wrap.dataset.value = current.value;

	const fakeSelect = document.createElement('button');
	fakeSelect.type = 'button';
	fakeSelect.className = 'glow-fake-select';
	fakeSelect.textContent = current.label;
	if (className === 'glow-color-select') {
		fakeSelect.dataset.color = current.value;
	}

	const menu = document.createElement('div');
	menu.className = 'glow-select-menu';

	const needsScroll = options.length > 5;
	let scrollInner = null;
	if (needsScroll) {
		menu.classList.add('scrollable');
		scrollInner = document.createElement('div');
		scrollInner.className = 'glow-select-menu-scroll';
		menu.appendChild(scrollInner);
	}

	let scrollParent = null;
	const onScrollParent = () => closeMenu();

	const closeMenu = () => {
		menu.style.display = 'none';
		wrap.classList.remove('menu-open');
		if (scrollParent) { scrollParent.removeEventListener('scroll', onScrollParent); scrollParent = null; }
	};

	for (const opt of options) {
		const optBtn = document.createElement('button');
		optBtn.type = 'button';
		optBtn.className = 'glow-select-option';
		if (opt.value === current.value) optBtn.classList.add('active');
		optBtn.textContent = opt.label;
		optBtn.dataset.value = opt.value;
		if (className === 'glow-color-select') {
			optBtn.dataset.color = opt.value;
		}
		optBtn.onclick = (e) => {
			haptic();
			e.preventDefault();
			e.stopPropagation();
			wrap.dataset.value = opt.value;
			fakeSelect.textContent = opt.label;
			if (className === 'glow-color-select') {
				fakeSelect.dataset.color = opt.value;
			}
			menu.querySelectorAll('.glow-select-option').forEach(b => b.classList.remove('active'));
			optBtn.classList.add('active');
			closeMenu();
		};
		(scrollInner || menu).appendChild(optBtn);
	}

	const openMenu = () => {
		const rect = fakeSelect.getBoundingClientRect();
		menu.style.position = 'fixed';
		menu.style.display = 'block';
		wrap.classList.add('menu-open');

		if (needsScroll && scrollInner && !scrollInner.style.maxHeight) {
			const btns = scrollInner.querySelectorAll('.glow-select-option');
			if (btns.length > 1) {
				const btnH = btns[0].offsetHeight;
				const btnM = parseFloat(getComputedStyle(btns[1]).marginTop || 0);
				scrollInner.style.maxHeight = `${(btnH * 5) + (btnM * 5)}px`;
			}
			const scrollStyle = getComputedStyle(scrollInner);
			const scrollPad = parseFloat(scrollStyle.paddingRight || 0);
			const scrollbarW = scrollInner.offsetWidth - scrollInner.clientWidth;
			const menuStyle = getComputedStyle(menu);
			const menuPad = parseFloat(menuStyle.paddingLeft || 0) + parseFloat(menuStyle.paddingRight || 0);
			menu.style.minWidth = `${rect.width + scrollPad + scrollbarW + menuPad}px`;
		}

		const menuPadLeft = parseFloat(getComputedStyle(menu).paddingLeft || 0);
		menu.style.left = (rect.left - menuPadLeft) + 'px';
		if (!needsScroll) {
			menu.style.minWidth = (rect.width + menuPadLeft * 2) + 'px';
		}

		// Measure menu height to decide direction
		menu.style.top = '-9999px';
		const menuH = menu.offsetHeight;
		const spaceBelow = window.innerHeight - rect.bottom - 4;
		const spaceAbove = rect.top - 4;

		if (spaceBelow >= menuH || spaceBelow >= spaceAbove) {
			menu.style.top = (rect.bottom + 4) + 'px';
			menu.style.bottom = '';
		} else {
			menu.style.top = '';
			menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
		}

		// Close on scroll of nearest scrollable ancestor
		scrollParent = fakeSelect.closest('.card-config-frame, .admin-config-sections');
		if (scrollParent) scrollParent.addEventListener('scroll', onScrollParent, { passive: true });
	};

	fakeSelect.onclick = (e) => {
		haptic();
		e.preventDefault();
		e.stopPropagation();
		// Close other open menus (properly removes scroll listeners)
		document.querySelectorAll('.glow-select-wrap.menu-open').forEach(w => {
			if (w !== wrap && typeof w._closeMenu === 'function') w._closeMenu();
		});
		if (wrap.classList.contains('menu-open')) {
			closeMenu();
		} else {
			openMenu();
		}
	};

	// Close on click outside (auto-removes when wrap is detached from DOM)
	const onDocClick = (e) => {
		if (!wrap.isConnected) {
			document.removeEventListener('click', onDocClick);
			return;
		}
		if (!wrap.contains(e.target) && !menu.contains(e.target)) {
			closeMenu();
		}
	};
	document.addEventListener('click', onDocClick);

	wrap.appendChild(fakeSelect);
	wrap._glowMenu = menu;
	wrap._closeMenu = closeMenu;
	document.body.appendChild(menu);
	return wrap;
}

function createGlowRuleRow(rule = {}) {
	const row = document.createElement('div');
	row.className = 'glow-rule-row';

	const operatorSelect = createCustomSelect(ohLang.cardConfig.glowOperators, rule.operator || '=', 'glow-operator-select');
	const colorSelect = createCustomSelect(ohLang.cardConfig.glowColors, rule.color || 'green', 'glow-color-select');

	const valueInput = document.createElement('input');
	valueInput.type = 'text';
	valueInput.className = 'glow-rule-value';
	valueInput.placeholder = ohLang.cardConfig.glowValuePlaceholder;
	if (rule.value !== undefined) valueInput.value = rule.value;

	const deleteBtn = document.createElement('button');
	deleteBtn.type = 'button';
	deleteBtn.className = 'glow-rule-delete';
	deleteBtn.innerHTML = '<img src="icons/image-viewer-close.svg" alt="X" />';
	deleteBtn.onclick = () => {
		haptic();
		row.querySelectorAll('.glow-select-wrap').forEach(w => {
			if (typeof w._closeMenu === 'function') w._closeMenu();
			if (w._glowMenu) { w._glowMenu.remove(); w._glowMenu = null; }
		});
		row.remove();
	};

	row.appendChild(operatorSelect);
	row.appendChild(valueInput);
	row.appendChild(colorSelect);
	row.appendChild(deleteBtn);

	return row;
}

function addGlowRuleRow() {
	const rulesContainer = cardConfigModal.querySelector('.card-config-rules');
	rulesContainer.appendChild(createGlowRuleRow());
}

function collectCardConfigValues() {
	if (!cardConfigModal || !cardConfigWidgetKey) return null;

	// Get visibility
	const visRadio = cardConfigModal.querySelector('input[name="visibility"]:checked');
	const visibility = visRadio?.value || 'all';

	// Get defaultMuted for video widgets (only if section is visible)
	const defaultSoundSection = cardConfigModal.querySelector('.default-sound-section');
	let defaultMuted;
	if (defaultSoundSection && defaultSoundSection.style.display !== 'none') {
		const soundRadio = cardConfigModal.querySelector('input[name="defaultSound"]:checked');
		defaultMuted = soundRadio?.value === 'muted';
	}

	// Get iframeHeight for iframe cards (only if section is visible)
	const iframeHeightSection = cardConfigModal.querySelector('.iframe-height-section');
	let iframeHeight;
	if (iframeHeightSection && iframeHeightSection.style.display !== 'none') {
		const heightInput = iframeHeightSection.querySelector('.iframe-height-input');
		const rawValue = heightInput?.value?.trim() || '';
		// Pass empty string to clear, or the numeric value
		iframeHeight = rawValue;
	}

	// Get proxyCacheSeconds for image cards (only if section is visible)
	const proxyCacheSection = cardConfigModal.querySelector('.proxy-cache-section');
	let proxyCacheSeconds;
	if (proxyCacheSection && proxyCacheSection.style.display !== 'none') {
		const cacheInput = proxyCacheSection.querySelector('.proxy-cache-input');
		const rawValue = cacheInput?.value?.trim() || '';
		// Pass empty string to clear, or the numeric value
		proxyCacheSeconds = rawValue;
	}

	// Get cardWidth for non-media cards (only if section is visible)
	const cardWidthSection = cardConfigModal.querySelector('.card-width-section');
	let cardWidth;
	if (cardWidthSection && cardWidthSection.style.display !== 'none') {
		const cardWidthRadio = cardConfigModal.querySelector('input[name="cardWidth"]:checked');
		cardWidth = cardWidthRadio?.value || 'standard';
	}

	// Get glow rules
	const rows = cardConfigModal.querySelectorAll('.glow-rule-row');
	const rules = [];
	for (const row of rows) {
		const operator = row.querySelector('.glow-operator-select')?.dataset.value || '=';
		const value = row.querySelector('.glow-rule-value').value;
		const color = row.querySelector('.glow-color-select')?.dataset.value || 'green';
		// Skip empty catch-all rules without color
		if (operator === '*' && !value) {
			rules.push({ operator, value: '', color });
		} else if (value || operator === '*') {
			rules.push({ operator, value, color });
		}
	}

	return { widgetId: cardConfigWidgetKey, rules, visibility, defaultMuted, iframeHeight, proxyCacheSeconds, cardWidth };
}

function openCardConfigModal(widget, card) {
	if (state.isSlim) return;
	if (getUserRole() !== 'admin') return;
	haptic();
	ensureCardConfigModal();
	const wKey = widgetKey(widget);
	cardConfigWidgetKey = wKey;
	cardConfigWidgetLabel = widget?.label || widget?.item?.label || widget?.item?.name || wKey;

	// Load existing visibility
	const visibility = widgetVisibilityMap.get(wKey) || 'all';
	const visRadio = cardConfigModal.querySelector(`input[name="visibility"][value="${visibility}"]`);
	if (visRadio) {
		visRadio.checked = true;
		cardConfigModal.querySelectorAll('input[name="visibility"]').forEach(r => r.closest('.item-config-radio')?.classList.toggle('checked', r.checked));
	}

	// Show/hide default sound section for video widgets
	const wType = (widget?.type || '').toLowerCase();
	const isVideoWidget = wType === 'video';
	const defaultSoundSection = cardConfigModal.querySelector('.default-sound-section');
	if (defaultSoundSection) {
		defaultSoundSection.style.display = isVideoWidget ? '' : 'none';
		if (isVideoWidget) {
			// Load existing video config
			const videoConfig = widgetVideoConfigMap.get(wKey);
			const defaultMutedValue = videoConfig?.defaultMuted !== false ? 'muted' : 'unmuted';
			const soundRadio = cardConfigModal.querySelector(`input[name="defaultSound"][value="${defaultMutedValue}"]`);
			if (soundRadio) {
				soundRadio.checked = true;
				cardConfigModal.querySelectorAll('input[name="defaultSound"]').forEach(r => r.closest('.item-config-radio')?.classList.toggle('checked', r.checked));
			}
		}
	}

	// Show/hide iframe height section for iframe cards (webview, video, chart)
	const isIframeWidget = wType === 'video' || wType.includes('webview') || wType === 'chart';
	const iframeHeightSection = cardConfigModal.querySelector('.iframe-height-section');
	if (iframeHeightSection) {
		iframeHeightSection.style.display = isIframeWidget ? '' : 'none';
		const heightInput = iframeHeightSection.querySelector('.iframe-height-input');
		if (heightInput) {
			// Load existing iframe config
			const iframeConfig = widgetIframeConfigMap.get(wKey);
			heightInput.value = iframeConfig?.height ? String(iframeConfig.height) : '';
		}
	}

	// Show/hide proxy cache section for image widgets
	const isImageWidget = wType.includes('image');
	const proxyCacheSection = cardConfigModal.querySelector('.proxy-cache-section');
	if (proxyCacheSection) {
		proxyCacheSection.style.display = isImageWidget ? '' : 'none';
		if (isImageWidget) {
			const cacheInput = proxyCacheSection.querySelector('.proxy-cache-input');
			if (cacheInput) {
				const cacheConfig = widgetProxyCacheConfigMap.get(wKey);
				cacheInput.value = cacheConfig?.cacheSeconds ? String(cacheConfig.cacheSeconds) : '';
			}
		}
	}

	// Card width section - show for non-media widgets (media widgets are already full width)
	const cardWidthSection = cardConfigModal.querySelector('.card-width-section');
	const isMediaWidget = wType.includes('image') || wType === 'chart' || wType.includes('webview') || wType === 'video';
	if (cardWidthSection) {
		cardWidthSection.style.display = isMediaWidget ? 'none' : '';
		if (!isMediaWidget) {
			const cardWidth = widgetCardWidthMap.get(wKey) || 'standard';
			const widthRadio = cardConfigModal.querySelector(`input[name="cardWidth"][value="${cardWidth}"]`);
			if (widthRadio) {
				widthRadio.checked = true;
				cardConfigModal.querySelectorAll('input[name="cardWidth"]').forEach(r =>
					r.closest('.item-config-radio')?.classList.toggle('checked', r.checked)
				);
			}
		}
	}

	// Check if widget should show glow rules
	// Any widget with subtext (state in label like "Title [State]") can have glow rules
	const isSection = !!widget?.__section;
	const labelParts = splitLabelState(widget?.label || '');
	const hasSubtext = !!labelParts.state;
	const glowRulesSection = cardConfigModal.querySelector('.glow-rules-section');
	if (glowRulesSection) {
		glowRulesSection.style.display = (hasSubtext && !isSection) ? '' : 'none';
	}

	// Load existing rules
	const rulesContainer = cardConfigModal.querySelector('.card-config-rules');
	rulesContainer.innerHTML = '';
	const existingRules = widgetGlowRulesMap.get(wKey) || [];
	if (existingRules.length) {
		for (const rule of existingRules) {
			rulesContainer.appendChild(createGlowRuleRow(rule));
		}
	} else {
		// Start with one empty row
		rulesContainer.appendChild(createGlowRuleRow());
	}

	// Build glow resolver for historical values
	const glowRules = widgetGlowRulesMap.get(wKey) || null;
	if (glowRules && glowRules.length) {
		historyGlowColor = (rawState) => getWidgetGlowOverride(wKey, rawState);
	} else {
		historyGlowColor = null;
	}

	// Show/hide history section for items with persistence
	const itemName = widget?.item?.name || '';
	const historySection = cardConfigModal.querySelector('.history-section');
	if (historySection) {
		if (itemName && !isSection) {
			historySection.style.display = '';
			historyOffsetStack = [];
			historyCursorStack = [];
			// Clear previous entries so loading state shows correctly
			const hContainer = historySection.querySelector('.history-entries');
			const hNav = historySection.querySelector('.history-nav');
			if (hContainer) hContainer.innerHTML = '';
			if (hNav) { hNav.innerHTML = ''; hNav.style.display = 'none'; }
			if (historyAbort) historyAbort.abort();
			if (GROUP_ITEMS_SET.has(itemName)) {
				historyMappings = [];
				loadGroupHistoryEntries(itemName, null);
			} else {
				historyMappings = normalizeMapping(widget?.mappings || widget?.mapping);
				loadHistoryEntries(itemName, 0);
			}
		} else {
			historySection.style.display = 'none';
		}
	}

	const statusEl = cardConfigModal.querySelector('.card-config-status');
	if (statusEl) {
		statusEl.className = 'card-config-status';
		statusEl.textContent = '';
	}
	const initialCardConfig = collectCardConfigValues();
	cardConfigInitialStateJson = initialCardConfig ? JSON.stringify(initialCardConfig) : null;

	cardConfigModal.classList.remove('hidden');
	cardConfigModal._savedScrollY = window.scrollY;
	document.body.style.top = `-${window.scrollY}px`;
	document.body.classList.add('card-config-open');
}

function formatHistoryTime(isoString) {
	const d = new Date(isoString);
	if (isNaN(d.getTime())) return isoString;
	const now = new Date();
	if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
		return 'Today ' + formatDT(d, TIME_FORMAT);
	}
	return formatDT(d, DATE_FORMAT + ' ' + TIME_FORMAT);
}

async function loadHistoryEntries(itemName, offset) {
	const section = cardConfigModal.querySelector('.history-section');
	const container = section.querySelector('.history-entries');
	const nav = section.querySelector('.history-nav');
	const isFirstLoad = !container.children.length;
	if (isFirstLoad) {
		container.innerHTML = '<div class="history-loading">' + ohLang.cardConfig.loading + '</div>';
		nav.style.display = 'none';
	}
	// Abort any previous pagination fetch
	if (historyAbort) historyAbort.abort();
	historyAbort = new AbortController();
	const signal = historyAbort.signal;
	try {
		let historyUrl = '/api/card-config/' + encodeURIComponent(itemName) + '/history?offset=' + offset;
		if (historyMappings.length) {
			historyUrl += '&commands=' + encodeURIComponent(historyMappings.map(m => m.command).join(','));
		}
		const resp = await fetch(historyUrl, { signal });
		const data = await resp.json();
		if (!data.ok || !data.entries.length) {
			section.style.display = 'none';
			return;
		}
		const frag = document.createDocumentFragment();
		for (const entry of data.entries) {
			const row = document.createElement('div');
			row.className = 'history-entry';
			const timeSpan = document.createElement('span');
			timeSpan.textContent = formatHistoryTime(entry.time);
			const stateSpan = document.createElement('span');
			stateSpan.className = 'history-state';
			const mapped = historyMappings.length ? historyMappings.find(m => m.command === entry.state) : null;
			const rawState = entry.state;
			stateSpan.textContent = mapped ? (mapped.label || mapped.command) : (/^[A-Z][A-Z_]+$/.test(rawState) ? rawState.split('_').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ') : rawState);
			row.appendChild(timeSpan);
			if (historyGlowColor) {
				const color = historyGlowColor(rawState);
				if (color) {
					const solid = colorToRgba(color, 1);
					const glow = colorToRgba(color, 0.6);
					if (solid && glow) {
						const dot = document.createElement('span');
						dot.className = 'history-glow-dot';
						dot.style.setProperty('--glow-solid', solid);
						dot.style.setProperty('--glow-color', glow);
						row.appendChild(dot);
					}
				}
			}
			row.appendChild(stateSpan);
			frag.appendChild(row);
		}
		container.innerHTML = '';
		container.appendChild(frag);
		const navFrag = document.createDocumentFragment();
		if (data.hasNewer || data.hasOlder) {
			if (data.hasNewer) {
				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'history-newer';
				btn.textContent = ohLang.cardConfig.newerBtn;
				btn.addEventListener('click', () => {
					haptic();
					const prevOffset = historyOffsetStack.pop() || 0;
					loadHistoryEntries(itemName, prevOffset);
				});
				navFrag.appendChild(btn);
			}
			if (data.hasOlder) {
				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'history-older';
				btn.textContent = ohLang.cardConfig.olderBtn;
				btn.addEventListener('click', () => {
					haptic();
					historyOffsetStack.push(offset);
					loadHistoryEntries(itemName, data.nextOffset);
				});
				navFrag.appendChild(btn);
			}
			nav.innerHTML = '';
			nav.appendChild(navFrag);
			nav.style.display = 'flex';
		} else {
			nav.style.display = 'none';
		}
	} catch (e) {
		if (e.name === 'AbortError') return;
		section.style.display = 'none';
	}
}

async function loadGroupHistoryEntries(itemName, cursor) {
	const section = cardConfigModal.querySelector('.history-section');
	const container = section.querySelector('.history-entries');
	const nav = section.querySelector('.history-nav');
	const isFirstLoad = !container.children.length;
	if (isFirstLoad) {
		container.innerHTML = '<div class="history-loading">' + ohLang.cardConfig.loading + '</div>';
		nav.style.display = 'none';
	}
	// Abort any previous pagination fetch
	if (historyAbort) historyAbort.abort();
	historyAbort = new AbortController();
	const signal = historyAbort.signal;
	try {
		let historyUrl = '/api/card-config/' + encodeURIComponent(itemName) + '/history';
		if (cursor) {
			historyUrl += '?before=' + encodeURIComponent(cursor);
		}
		const resp = await fetch(historyUrl, { signal });
		const data = await resp.json();
		if (!data.ok || !data.entries.length) {
			section.style.display = 'none';
			return;
		}
		const frag = document.createDocumentFragment();
		for (const entry of data.entries) {
			const row = document.createElement('div');
			row.className = 'history-entry';
			const timeSpan = document.createElement('span');
			timeSpan.textContent = formatHistoryTime(entry.time);
			const stateSpan = document.createElement('span');
			stateSpan.className = 'history-state';
			const rawState = entry.state;
			const displayState = /^[A-Z][A-Z_]+$/.test(rawState) ? rawState.split('_').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ') : rawState;
			stateSpan.textContent = (entry.member || '') + ' \u00B7 ' + displayState;
			row.appendChild(timeSpan);
			if (historyGlowColor) {
				const color = historyGlowColor(rawState);
				if (color) {
					const solid = colorToRgba(color, 1);
					const glow = colorToRgba(color, 0.6);
					if (solid && glow) {
						const dot = document.createElement('span');
						dot.className = 'history-glow-dot';
						dot.style.setProperty('--glow-solid', solid);
						dot.style.setProperty('--glow-color', glow);
						row.appendChild(dot);
					}
				}
			}
			row.appendChild(stateSpan);
			frag.appendChild(row);
		}
		container.innerHTML = '';
		container.appendChild(frag);
		const navFrag = document.createDocumentFragment();
		if (data.hasNewer || data.hasOlder) {
			if (data.hasNewer) {
				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'history-newer';
				btn.textContent = ohLang.cardConfig.newerBtn;
				btn.addEventListener('click', () => {
					haptic();
					const prevCursor = historyCursorStack.pop() || null;
					loadGroupHistoryEntries(itemName, prevCursor);
				});
				navFrag.appendChild(btn);
			}
			if (data.hasOlder) {
				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'history-older';
				btn.textContent = ohLang.cardConfig.olderBtn;
				btn.addEventListener('click', () => {
					haptic();
					historyCursorStack.push(cursor);
					loadGroupHistoryEntries(itemName, data.nextCursor);
				});
				navFrag.appendChild(btn);
			}
			nav.innerHTML = '';
			nav.appendChild(navFrag);
			nav.style.display = 'flex';
		} else {
			nav.style.display = 'none';
		}
	} catch (e) {
		if (e.name === 'AbortError') return;
		section.style.display = 'none';
	}
}

function closeCardConfigModal() {
	if (!cardConfigModal) return;
	// Abort any in-flight history fetches
	if (historyAbort) { historyAbort.abort(); historyAbort = null; }
	// Close any open select menus (removes scroll listeners) then remove from body
	cardConfigModal.querySelectorAll('.glow-select-wrap').forEach(w => {
		if (typeof w._closeMenu === 'function') w._closeMenu();
		if (w._glowMenu) { w._glowMenu.remove(); w._glowMenu = null; }
	});
	cardConfigModal.classList.add('hidden');
	var cardFrame = cardConfigModal.querySelector('.card-config-frame');
	if (cardFrame._resetDragPosition) cardFrame._resetDragPosition();
	document.body.classList.remove('card-config-open');
	document.body.style.top = '';
	window.scrollTo(0, cardConfigModal._savedScrollY || 0);
	cardConfigWidgetKey = '';
	cardConfigWidgetLabel = '';
	historyGlowColor = null;
	cardConfigInitialStateJson = null;
}

async function saveCardConfig() {
	if (!cardConfigModal || !cardConfigWidgetKey) return;

	const statusEl = cardConfigModal.querySelector('.card-config-status');
	const saveBtn = cardConfigModal.querySelector('.card-config-save');
	if (statusEl) { statusEl.className = 'card-config-status'; statusEl.textContent = ''; }
	if (saveBtn) saveBtn.disabled = true;
	const payload = collectCardConfigValues();
	if (!payload) {
		if (saveBtn) saveBtn.disabled = false;
		return false;
	}
	const payloadJson = JSON.stringify(payload);
	if (cardConfigInitialStateJson !== null && payloadJson === cardConfigInitialStateJson) {
		if (statusEl) {
			statusEl.className = 'card-config-status success';
			statusEl.textContent = ohLang.cardConfig.noChanges;
		}
		if (saveBtn) saveBtn.disabled = false;
		return false;
	}
	const { visibility, defaultMuted, iframeHeight, proxyCacheSeconds, cardWidth, rules } = payload;

	try {
		// Save widget config (rules, visibility, etc.)
		const resp = await fetch('/api/card-config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		if (!resp.ok) {
			let msg = ohLang.cardConfig.saveFailed;
			try { const body = await resp.json(); if (body.error) msg = body.error; } catch (e) {}
			if (statusEl) { statusEl.className = 'card-config-status error'; statusEl.textContent = msg; }
			if (saveBtn) saveBtn.disabled = false;
			return false;
		}

		// Update local glow rules map
		if (rules.length) {
			widgetGlowRulesMap.set(cardConfigWidgetKey, rules);
		} else {
			widgetGlowRulesMap.delete(cardConfigWidgetKey);
		}

		// Update local visibility map
		if (visibility !== 'all') {
			widgetVisibilityMap.set(cardConfigWidgetKey, visibility);
		} else {
			widgetVisibilityMap.delete(cardConfigWidgetKey);
		}

		// Update local video config map
		if (defaultMuted !== undefined) {
			if (defaultMuted) {
				// Muted is default, remove entry
				widgetVideoConfigMap.delete(cardConfigWidgetKey);
			} else {
				widgetVideoConfigMap.set(cardConfigWidgetKey, { widgetId: cardConfigWidgetKey, defaultMuted });
			}
		}

		// Update local iframe config map
		if (iframeHeight !== undefined) {
			const heightNum = parseInt(iframeHeight, 10);
			if (!heightNum || heightNum <= 0) {
				// Empty or zero means use default, remove entry
				widgetIframeConfigMap.delete(cardConfigWidgetKey);
			} else {
				widgetIframeConfigMap.set(cardConfigWidgetKey, { widgetId: cardConfigWidgetKey, height: heightNum });
			}
		}

		// Update local proxy cache config map
		if (proxyCacheSeconds !== undefined) {
			const cacheNum = parseInt(proxyCacheSeconds, 10);
			if (!cacheNum || cacheNum <= 0) {
				// Empty or zero means no caching, remove entry
				widgetProxyCacheConfigMap.delete(cardConfigWidgetKey);
			} else {
				widgetProxyCacheConfigMap.set(cardConfigWidgetKey, { widgetId: cardConfigWidgetKey, cacheSeconds: cacheNum });
			}
		}

		// Update local card width map
		if (cardWidth !== undefined) {
			if (cardWidth !== 'standard') {
				widgetCardWidthMap.set(cardConfigWidgetKey, cardWidth);
			} else {
				widgetCardWidthMap.delete(cardConfigWidgetKey);
			}
		}

		// Apply glow to the card immediately
		let card = null;
		for (const node of document.querySelectorAll('.glass[data-widget-key]')) {
			if (node.dataset.widgetKey === cardConfigWidgetKey) {
				card = node;
				break;
			}
		}
		if (card) {
			clearGlow(card);
			const meta = card.querySelector('.meta');
			const stateValue = meta ? meta.textContent : '';
			const glowColor = getWidgetGlowOverride(cardConfigWidgetKey, stateValue);
			if (glowColor) {
				applyGlowStyle(card, glowColor);
			}
		}

		// Re-render to apply visibility changes
		render();
		cardConfigInitialStateJson = payloadJson;
		if (statusEl) { statusEl.className = 'card-config-status success'; statusEl.textContent = ohLang.cardConfig.savedOk; }
		if (saveBtn) saveBtn.disabled = false;
		return true;
	} catch (e) {
		logJsError('applyGlowConfig failed', e);
		if (statusEl) { statusEl.className = 'card-config-status error'; statusEl.textContent = ohLang.cardConfig.saveFailed; }
		if (saveBtn) saveBtn.disabled = false;
		return false;
	}
}

// ========== Admin Config Modal ==========

const ADMIN_CONFIG_SCHEMA = [
	{
		id: 'user-preferences', group: 'user', reloadRequired: true,
		fields: [
			{ key: 'user.trackGps', type: 'toggle' },
			{ key: 'user.voiceModel', type: 'select', options: ['system', 'browser', 'vosk'] },
		],
	},
	{
		id: 'listeners', group: 'server', restartRequired: true,
		fields: [
			{ key: 'server.http.enabled', type: 'toggle' },
			{ key: 'server.http.host', type: 'text' },
			{ key: 'server.http.port', type: 'number', min: 1, max: 65535 },
			{ key: 'server.https.enabled', type: 'toggle' },
			{ key: 'server.https.host', type: 'text' },
			{ key: 'server.https.port', type: 'number', min: 1, max: 65535 },
			{ key: 'server.https.certFile', type: 'text' },
			{ key: 'server.https.keyFile', type: 'text' },
			{ key: 'server.https.http2', type: 'toggle' },
		],
	},
	{
		id: 'openhab', group: 'server',
		fields: [
			{ key: 'server.openhab.target', type: 'text' },
			{ key: 'server.openhab.user', type: 'text', allowEmpty: true },
			{ key: 'server.openhab.pass', type: 'secret', allowEmpty: true },
			{ key: 'server.openhab.apiToken', type: 'secret', allowEmpty: true },
			{ key: 'server.openhab.timeoutMs', type: 'number', min: 0 },
		],
	},
	{
		id: 'database', group: 'server', restartRequired: true,
		fields: [
			{ key: 'server.mysql.socket', type: 'text', allowEmpty: true },
			{ key: 'server.mysql.host', type: 'text', allowEmpty: true },
			{ key: 'server.mysql.port', type: 'text', allowEmpty: true },
			{ key: 'server.mysql.database', type: 'text', allowEmpty: true },
			{ key: 'server.mysql.username', type: 'text', allowEmpty: true },
			{ key: 'server.mysql.password', type: 'secret', allowEmpty: true },
		],
	},
	{
		id: 'auth', group: 'server',
		fields: [
			{ key: 'server.auth.mode', type: 'select', options: ['basic', 'html'] },
			{ key: 'server.auth.realm', type: 'text' },
			{ key: 'server.auth.cookieName', type: 'text', allowEmpty: true },
			{ key: 'server.auth.cookieDays', type: 'number', min: 0 },
			{ key: 'server.auth.cookieKey', type: 'secret', allowEmpty: true },
			{ key: 'server.auth.authFailNotifyCmd', type: 'text', allowEmpty: true },
			{ key: 'server.auth.authFailNotifyIntervalMins', type: 'number', min: 1 },
		],
	},
	{
		id: 'access', group: 'server',
		fields: [
			{ key: 'server.allowSubnets', type: 'list' },
			{ key: 'server.trustProxy', type: 'toggle' },
			{ key: 'server.denyXFFSubnets', type: 'list', allowEmpty: true },
		],
	},
	{
		id: 'security', group: 'server',
		fields: [
			{ key: 'server.securityHeaders.enabled', type: 'toggle' },
			{ key: 'server.securityHeaders.hsts.enabled', type: 'toggle' },
			{ key: 'server.securityHeaders.hsts.maxAge', type: 'number', min: 0 },
			{ key: 'server.securityHeaders.hsts.includeSubDomains', type: 'toggle' },
			{ key: 'server.securityHeaders.hsts.preload', type: 'toggle' },
			{ key: 'server.securityHeaders.csp.enabled', type: 'toggle' },
			{ key: 'server.securityHeaders.csp.reportOnly', type: 'toggle' },
			{ key: 'server.securityHeaders.csp.policy', type: 'textarea', allowEmpty: true },
			{ key: 'server.securityHeaders.referrerPolicy', type: 'select', options: ['', 'same-origin', 'no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url'] },
		],
	},
	{
		id: 'proxy', group: 'server',
		fields: [
			{ key: 'server.proxyAllowlist', type: 'list' },
			{ key: 'server.webviewNoProxy', type: 'list', allowEmpty: true },
			{ key: 'server.userAgent', type: 'text' },
		],
	},
	{
		id: 'assets', group: 'server',
		fields: [
			{ key: 'server.assets.assetVersion', type: 'text' },
			{ key: 'server.assets.appleTouchIconVersion', type: 'text' },
			{ key: 'server.assets.iconVersion', type: 'text' },
		],
	},
	{
		id: 'icons', group: 'server',
		fields: [
			{ key: 'server.iconSize', type: 'number', min: 1 },
			{ key: 'server.iconCacheConcurrency', type: 'number', min: 1 },
			{ key: 'server.deltaCacheLimit', type: 'number', min: 1 },
		],
	},
	{
		id: 'logging', group: 'server',
		fields: [
			{ key: 'server.logFile', type: 'text', allowEmpty: true },
			{ key: 'server.accessLog', type: 'text', allowEmpty: true },
			{ key: 'server.jsLogFile', type: 'text', allowEmpty: true },
			{ key: 'server.jsLogEnabled', type: 'toggle' },
			{ key: 'server.accessLogLevel', type: 'select', options: ['all', '400+'] },
			{ key: 'server.proxyMiddlewareLogLevel', type: 'select', options: ['silent', 'error', 'warn', 'info', 'debug'] },
			{ key: 'server.slowQueryMs', type: 'number', min: 0 },
		],
	},
	{
		id: 'sessions', group: 'server',
		fields: [
			{ key: 'server.sessionMaxAgeDays', type: 'number', min: 1 },
			{ key: 'server.backgroundTasks.sitemapRefreshMs', type: 'number', min: 1000 },
			{ key: 'server.backgroundTasks.structureMapRefreshMs', type: 'number', min: 0 },
		],
	},
	{
		id: 'websocket', group: 'server',
		fields: [
			{ key: 'server.websocket.mode', type: 'select', options: ['polling', 'atmosphere', 'sse'] },
			{ key: 'server.websocket.pollingIntervalMs', type: 'number', min: 100 },
			{ key: 'server.websocket.pollingIntervalBgMs', type: 'number', min: 100 },
			{ key: 'server.websocket.atmosphereNoUpdateWarnMs', type: 'number', min: 0 },
			{ key: 'server.websocket.backendRecoveryDelayMs', type: 'number', min: 0 },
		],
	},
	{
		id: 'features', group: 'server',
		fields: [
			{ key: 'server.groupItems', type: 'list', allowEmpty: true },
			{ key: 'server.videoPreview.intervalMs', type: 'number', min: 0 },
			{ key: 'server.videoPreview.pruneAfterHours', type: 'number', min: 1 },
			{ key: 'server.cmdapi.enabled', type: 'toggle' },
			{ key: 'server.cmdapi.allowedSubnets', type: 'list', allowEmpty: true },
			{ key: 'server.cmdapi.allowedItems', type: 'list', allowEmpty: true },
		],
	},
	{
		id: 'gps', group: 'server',
		fields: [
			{ key: 'server.gps.homeLat', type: 'text', allowEmpty: true },
			{ key: 'server.gps.homeLon', type: 'text', allowEmpty: true },
		],
	},
	{
		id: 'system', group: 'server',
		fields: [
			{ key: 'server.binaries.ffmpeg', type: 'text' },
			{ key: 'server.binaries.convert', type: 'text' },
			{ key: 'server.binaries.shell', type: 'text' },
			{ key: 'server.paths.rrd', type: 'text', allowEmpty: true },
		],
	},
	{
		id: 'external', group: 'server',
		fields: [
			{ key: 'server.apiKeys.anthropic', type: 'secret', allowEmpty: true },
			{ key: 'server.weatherbit.apiKey', type: 'secret', allowEmpty: true },
			{ key: 'server.weatherbit.latitude', type: 'text', allowEmpty: true },
			{ key: 'server.weatherbit.longitude', type: 'text', allowEmpty: true },
			{ key: 'server.weatherbit.units', type: 'select', options: ['M', 'I'] },
			{ key: 'server.weatherbit.refreshIntervalMs', type: 'number', min: 1 },
			{ key: 'server.voice.model', type: 'select', options: ['browser', 'vosk'] },
			{ key: 'server.voice.voskHost', type: 'text', allowEmpty: true },
		],
	},
	{
		id: 'client-ui', group: 'client', reloadRequired: true,
		fields: [
			{ key: 'client.siteName', type: 'text', allowEmpty: true },
			{ key: 'client.statusNotification', type: 'toggle' },
			{ key: 'client.touchReloadMinHiddenMs', type: 'number', min: 0 },
		],
	},
	{
		id: 'client-timing', group: 'client', reloadRequired: true,
		fields: [
			{ key: 'client.pageFadeOutMs', type: 'number', min: 0 },
			{ key: 'client.pageFadeInMs', type: 'number', min: 0 },
			{ key: 'client.loadingDelayMs', type: 'number', min: 0 },
			{ key: 'client.minImageRefreshMs', type: 'number', min: 0 },
			{ key: 'client.imageLoadTimeoutMs', type: 'number', min: 0 },
			{ key: 'client.sliderDebounceMs', type: 'number', min: 0 },
			{ key: 'client.idleAfterMs', type: 'number', min: 0 },
			{ key: 'client.activityThrottleMs', type: 'number', min: 0 },
			{ key: 'client.voiceResponseTimeoutMs', type: 'number', min: 0 },
		],
	},
	{
		id: 'client-polling', group: 'client', reloadRequired: true,
		fields: [
			{ key: 'client.pollIntervalsMs.default.active', type: 'number', min: 1 },
			{ key: 'client.pollIntervalsMs.default.idle', type: 'number', min: 1 },
			{ key: 'client.pollIntervalsMs.slim.active', type: 'number', min: 1 },
			{ key: 'client.pollIntervalsMs.slim.idle', type: 'number', min: 1 },
			{ key: 'client.searchDebounceMs.default', type: 'number', min: 0 },
			{ key: 'client.searchDebounceMs.slim', type: 'number', min: 0 },
			{ key: 'client.searchStateMinIntervalMs.default', type: 'number', min: 0 },
			{ key: 'client.searchStateMinIntervalMs.slim', type: 'number', min: 0 },
			{ key: 'client.searchStateConcurrency.default', type: 'number', min: 1 },
			{ key: 'client.searchStateConcurrency.slim', type: 'number', min: 1 },
		],
	},
	{
		id: 'client-format', group: 'client', reloadRequired: true,
		fields: [
			{ key: 'client.dateFormat', type: 'text' },
			{ key: 'client.timeFormat', type: 'text' },
		],
	},
];

const ADMIN_CONFIG_GROUP_LABELS = {
	user: 'groupUser',
	server: 'groupServer',
	client: 'groupClient',
};

let adminConfigModal = null;
let adminConfigAbort = null;
const adminSelectMenus = [];
let adminConfigInitialStateJson = null;

function adminGetNested(obj, path) {
	return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

function adminSetNested(obj, path, value) {
	const keys = path.split('.');
	let cur = obj;
	for (let i = 0; i < keys.length - 1; i++) {
		if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
		cur = cur[keys[i]];
	}
	cur[keys[keys.length - 1]] = value;
}

function createAdminSelect(options, initialValue) {
	const wrap = document.createElement('div');
	wrap.className = 'admin-select-wrap';
	const current = options.find(o => o === initialValue) || options[0];
	wrap.dataset.value = current;

	const displayLabel = (v) => v || '(none)';
	const fakeSelect = document.createElement('button');
	fakeSelect.type = 'button';
	fakeSelect.className = 'admin-fake-select';
	fakeSelect.textContent = displayLabel(current);

	const menu = document.createElement('div');
	menu.className = 'glow-select-menu';

	const needsScroll = options.length > 5;
	let scrollInner = null;
	if (needsScroll) {
		menu.classList.add('scrollable');
		scrollInner = document.createElement('div');
		scrollInner.className = 'glow-select-menu-scroll';
		menu.appendChild(scrollInner);
	}

	let scrollParent = null;
	const onScrollParent = () => closeMenu();

	const closeMenu = () => {
		menu.style.display = 'none';
		wrap.classList.remove('menu-open');
		if (scrollParent) { scrollParent.removeEventListener('scroll', onScrollParent); scrollParent = null; }
	};

	for (const opt of options) {
		const optBtn = document.createElement('button');
		optBtn.type = 'button';
		optBtn.className = 'glow-select-option';
		if (opt === current) optBtn.classList.add('active');
		optBtn.textContent = displayLabel(opt);
		optBtn.dataset.value = opt;
		optBtn.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			haptic();
			wrap.dataset.value = opt;
			fakeSelect.textContent = displayLabel(opt);
			menu.querySelectorAll('.glow-select-option').forEach(b => b.classList.remove('active'));
			optBtn.classList.add('active');
			closeMenu();
		};
		(scrollInner || menu).appendChild(optBtn);
	}

	const openMenu = () => {
		const rect = fakeSelect.getBoundingClientRect();
		menu.style.position = 'fixed';
		menu.style.display = 'block';
		wrap.classList.add('menu-open');

		if (needsScroll && scrollInner && !scrollInner.style.maxHeight) {
			const btns = scrollInner.querySelectorAll('.glow-select-option');
			if (btns.length > 1) {
				const btnH = btns[0].offsetHeight;
				const btnM = parseFloat(getComputedStyle(btns[1]).marginTop || 0);
				scrollInner.style.maxHeight = `${(btnH * 5) + (btnM * 5)}px`;
			}
			const scrollStyle = getComputedStyle(scrollInner);
			const scrollPad = parseFloat(scrollStyle.paddingRight || 0);
			const scrollbarW = scrollInner.offsetWidth - scrollInner.clientWidth;
			const menuStyle = getComputedStyle(menu);
			const menuPad = parseFloat(menuStyle.paddingLeft || 0) + parseFloat(menuStyle.paddingRight || 0);
			menu.style.minWidth = `${rect.width + scrollPad + scrollbarW + menuPad}px`;
		}

		const menuPadLeft = parseFloat(getComputedStyle(menu).paddingLeft || 0);
		menu.style.left = (rect.left - menuPadLeft) + 'px';
		if (!needsScroll) {
			menu.style.minWidth = (rect.width + menuPadLeft * 2) + 'px';
		}

		// Measure menu height to decide direction
		menu.style.top = '-9999px';
		const menuH = menu.offsetHeight;
		const spaceBelow = window.innerHeight - rect.bottom - 4;
		const spaceAbove = rect.top - 4;

		if (spaceBelow >= menuH || spaceBelow >= spaceAbove) {
			menu.style.top = (rect.bottom + 4) + 'px';
			menu.style.bottom = '';
		} else {
			menu.style.top = '';
			menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
		}

		// Close on scroll of nearest scrollable ancestor
		scrollParent = fakeSelect.closest('.card-config-frame, .admin-config-sections');
		if (scrollParent) scrollParent.addEventListener('scroll', onScrollParent, { passive: true });
	};

	fakeSelect.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		haptic();
		// Close other open menus (properly removes scroll listeners)
		document.querySelectorAll('.admin-select-wrap.menu-open').forEach(w => {
			if (w !== wrap && typeof w._closeMenu === 'function') w._closeMenu();
		});
		if (wrap.classList.contains('menu-open')) {
			closeMenu();
		} else {
			openMenu();
		}
	};

	// Close on click outside (auto-removes when wrap is detached from DOM)
	const onDocClick = (e) => {
		if (!wrap.isConnected) {
			document.removeEventListener('click', onDocClick);
			return;
		}
		if (!wrap.contains(e.target) && !menu.contains(e.target)) {
			closeMenu();
		}
	};
	document.addEventListener('click', onDocClick);

	wrap.appendChild(fakeSelect);
	wrap._closeMenu = closeMenu;
	document.body.appendChild(menu);
	adminSelectMenus.push(menu);
	return wrap;
}

function autoResizeTextarea(ta) {
	ta.style.height = 'auto';
	ta.style.height = ta.scrollHeight + 'px';
}

function createAdminListRow(value, placeholder, wrap) {
	const row = document.createElement('div');
	row.className = 'admin-list-row';
	const input = document.createElement('input');
	input.type = 'text';
	input.className = 'admin-list-input';
	input.value = value;
	if (placeholder) input.placeholder = placeholder;
	row.appendChild(input);
	const del = document.createElement('button');
	del.type = 'button';
	del.className = 'admin-list-delete';
	del.innerHTML = '<img src="icons/image-viewer-close.svg" alt="X" />';
	del.addEventListener('click', () => {
		haptic();
		row.remove();
		if (!wrap.querySelector('.admin-list-row')) {
			wrap.insertBefore(createAdminListRow('', placeholder, wrap), wrap.querySelector('.admin-list-add'));
		}
	});
	row.appendChild(del);
	return row;
}

function createAdminField(field, value) {
	const isStacked = field.type === 'list';
	const row = document.createElement('div');
	row.className = 'admin-config-field' + (isStacked ? ' stacked' : '');

	const fieldLabel = ohLang.adminConfig.fieldLabels[field.key] || field.key;
	const fieldDesc = ohLang.adminConfig.fieldDescs[field.key];
	const fieldPlaceholder = ohLang.adminConfig.fieldPlaceholders[field.key];

	const label = document.createElement('label');
	label.textContent = fieldLabel;
	if (fieldDesc) {
		const desc = document.createElement('span');
		desc.className = 'admin-field-desc';
		const parts = fieldDesc.split('. ');
		parts.forEach((part, i) => {
			if (i > 0) desc.appendChild(document.createElement('br'));
			desc.appendChild(document.createTextNode(i < parts.length - 1 ? part + '.' : part));
		});
		label.appendChild(desc);
	}
	row.appendChild(label);

	const control = document.createElement('div');
	control.className = 'admin-field-control';

	if (field.type === 'toggle') {
		const toggle = document.createElement('label');
		toggle.className = 'admin-toggle';
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.checked = value === true;
		input.dataset.key = field.key;
		input.addEventListener('change', () => haptic());
		const track = document.createElement('span');
		track.className = 'admin-toggle-track';
		const dot = document.createElement('span');
		dot.className = 'admin-toggle-dot';
		toggle.appendChild(input);
		toggle.appendChild(track);
		toggle.appendChild(dot);
		control.appendChild(toggle);
	} else if (field.type === 'number') {
		const input = document.createElement('input');
		input.type = 'number';
		input.dataset.key = field.key;
		if (field.min !== undefined) input.min = field.min;
		if (field.max !== undefined) input.max = field.max;
		input.value = value !== undefined && value !== null ? value : '';
		if (fieldPlaceholder) input.placeholder = fieldPlaceholder;
		control.appendChild(input);
	} else if (field.type === 'text') {
		const input = document.createElement('input');
		input.type = 'text';
		input.dataset.key = field.key;
		input.value = value !== undefined && value !== null ? String(value) : '';
		if (fieldPlaceholder) input.placeholder = fieldPlaceholder;
		control.appendChild(input);
	} else if (field.type === 'secret') {
		const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
		const wrap = document.createElement('div');
		wrap.className = 'admin-secret-wrap';
		const input = document.createElement('input');
		const rawVal = value !== undefined && value !== null ? String(value) : '';
		const isMasked = rawVal === MASK;
		input.type = 'password';
		input.dataset.key = field.key;
		if (isMasked) {
			input.value = '';
			input.placeholder = ohLang.adminConfig.secretPlaceholder;
			input.dataset.masked = '1';
			input.addEventListener('input', () => { delete input.dataset.masked; }, { once: true });
		} else {
			input.value = rawVal;
			if (fieldPlaceholder) input.placeholder = fieldPlaceholder;
		}
		const eyeBtn = document.createElement('button');
		eyeBtn.type = 'button';
		eyeBtn.className = 'admin-secret-eye';
		eyeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
		eyeBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			haptic();
			input.type = input.type === 'password' ? 'text' : 'password';
		});
		wrap.appendChild(input);
		wrap.appendChild(eyeBtn);
		control.appendChild(wrap);
	} else if (field.type === 'select') {
		const selectWrap = createAdminSelect(field.options, value !== undefined && value !== null ? String(value) : field.options[0]);
		selectWrap.dataset.key = field.key;
		control.appendChild(selectWrap);
	} else if (field.type === 'textarea') {
		const textarea = document.createElement('textarea');
		textarea.rows = 1;
		textarea.dataset.key = field.key;
		if (fieldPlaceholder) textarea.placeholder = fieldPlaceholder;
		// Arrays are displayed as newline-separated; strings as-is
		if (Array.isArray(value)) {
			textarea.value = value.join('\n');
		} else {
			textarea.value = value !== undefined && value !== null ? String(value) : '';
		}
		textarea.addEventListener('input', () => autoResizeTextarea(textarea));
		control.appendChild(textarea);
	} else if (field.type === 'list') {
		const wrap = document.createElement('div');
		wrap.className = 'admin-list-wrap';
		wrap.dataset.key = field.key;
		const items = Array.isArray(value) ? value : [];
		if (items.length === 0) {
			wrap.appendChild(createAdminListRow('', fieldPlaceholder, wrap));
		} else {
			for (const item of items) {
				wrap.appendChild(createAdminListRow(item, fieldPlaceholder, wrap));
			}
		}
		const addBtn = document.createElement('button');
		addBtn.type = 'button';
		addBtn.className = 'admin-list-add';
		addBtn.textContent = ohLang.adminConfig.listAddBtn;
		addBtn.addEventListener('click', () => {
			haptic();
			const newRow = createAdminListRow('', fieldPlaceholder, wrap);
			wrap.insertBefore(newRow, addBtn);
			newRow.querySelector('.admin-list-input').focus();
		});
		wrap.appendChild(addBtn);
		control.appendChild(wrap);
	}

	row.appendChild(control);

	return row;
}

function renderAdminConfigSection(section, config) {
	const sectionEl = document.createElement('div');
	sectionEl.className = 'admin-config-section collapsed';
	sectionEl.dataset.sectionId = section.id;

	const header = document.createElement('div');
	header.className = 'admin-config-section-header';
	header.onclick = () => {
		haptic();
		const wasCollapsed = sectionEl.classList.toggle('collapsed');
		if (!wasCollapsed) {
			sectionEl.querySelectorAll('textarea').forEach(autoResizeTextarea);
			requestAnimationFrame(() => {
				sectionEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
			});
		}
	};

	const title = document.createElement('span');
	title.className = 'admin-config-section-title';
	title.textContent = ohLang.adminConfig.sectionTitles[section.id] || section.id;
	header.appendChild(title);

	if (section.restartRequired) {
		const badge = document.createElement('span');
		badge.className = 'admin-restart-badge';
		badge.textContent = ohLang.adminConfig.restartBadge;
		header.appendChild(badge);
	}
	if (section.reloadRequired) {
		const badge = document.createElement('span');
		badge.className = 'admin-reload-badge';
		badge.textContent = ohLang.adminConfig.reloadBadge;
		header.appendChild(badge);
	}

	const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	chevron.setAttribute('viewBox', '0 0 24 24');
	chevron.setAttribute('fill', 'none');
	chevron.setAttribute('stroke', 'currentColor');
	chevron.setAttribute('stroke-width', '2');
	chevron.classList.add('admin-config-chevron');
	const chevPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	chevPath.setAttribute('d', 'M6 9l6 6 6-6');
	chevron.appendChild(chevPath);
	header.appendChild(chevron);

	sectionEl.appendChild(header);

	const body = document.createElement('div');
	body.className = 'admin-config-section-body';

	for (const field of section.fields) {
		const value = adminGetNested(config, field.key);
		body.appendChild(createAdminField(field, value));
	}

	sectionEl.appendChild(body);
	return sectionEl;
}

function ensureAdminConfigModal() {
	if (adminConfigModal) return;
	const wrap = document.createElement('div');
	wrap.id = 'adminConfigModal';
	wrap.className = 'admin-config-modal hidden';
	wrap.innerHTML = `
		<div class="admin-config-frame glass">
			<div class="admin-config-header">
				<h2>${ohLang.adminConfig.title}</h2>
				<button type="button" class="admin-config-close">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M18 6L6 18M6 6l12 12"/>
					</svg>
				</button>
			</div>
			<div class="admin-config-sections"></div>
			<div class="admin-config-footer">
				<div class="admin-config-status"></div>
				<button type="button" class="admin-config-cancel">${ohLang.adminConfig.closeBtn}</button>
				<button type="button" class="admin-config-save">${ohLang.adminConfig.saveBtn}</button>
			</div>
		</div>
	`;
	document.body.appendChild(wrap);
	adminConfigModal = wrap;

	wrap.querySelector('.admin-config-close').addEventListener('click', () => { haptic(); closeAdminConfigModal(); });
	wrap.querySelector('.admin-config-cancel').addEventListener('click', () => { haptic(); closeAdminConfigModal(); });
	wrap.querySelector('.admin-config-save').addEventListener('click', () => { haptic(); saveAdminConfig(); });
	wrap.addEventListener('click', (e) => {
		if (e.target === wrap) { haptic(); closeAdminConfigModal(); }
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && adminConfigModal && !adminConfigModal.classList.contains('hidden')) {
			haptic();
			closeAdminConfigModal();
		}
	});
	makeFrameDraggable(wrap.querySelector('.admin-config-frame'), wrap.querySelector('.admin-config-header h2'));
}

async function openAdminConfigModal() {
	ensureAdminConfigModal();
	const statusEl = adminConfigModal.querySelector('.admin-config-status');
	const sectionsEl = adminConfigModal.querySelector('.admin-config-sections');
	const saveBtn = adminConfigModal.querySelector('.admin-config-save');

	statusEl.className = 'admin-config-status';
	statusEl.textContent = '';
	saveBtn.disabled = true;

	// Clean up any select menus from a previous open
	adminConfigModal.querySelectorAll('.admin-select-wrap.menu-open').forEach(w => {
		if (typeof w._closeMenu === 'function') w._closeMenu();
	});
	adminSelectMenus.forEach(m => m.remove());
	adminSelectMenus.length = 0;

	// Show modal immediately with loading state
	sectionsEl.innerHTML = '';
	adminConfigModal.classList.remove('hidden');
	adminConfigModal._savedScrollY = window.scrollY;
	document.body.style.top = `-${window.scrollY}px`;
	document.body.classList.add('admin-config-open');

	// Abort any in-flight config fetch
	if (adminConfigAbort) adminConfigAbort.abort();
	adminConfigAbort = new AbortController();
	const signal = adminConfigAbort.signal;

	// Fetch config
	let config;
	try {
		const resp = await fetch('/api/admin/config', { signal });
		if (!resp.ok) {
			const err = await resp.json().catch(() => ({}));
			throw new Error(err.error || `HTTP ${resp.status}`);
		}
		config = await resp.json();
	} catch (e) {
		if (e.name === 'AbortError') return;
		statusEl.className = 'admin-config-status error';
		statusEl.textContent = ohLang.adminConfig.loadFailed + e.message;
		return;
	}

	// Render sections grouped by user/server/client
	let currentGroup = '';
	for (const section of ADMIN_CONFIG_SCHEMA) {
		if (section.group && section.group !== currentGroup) {
			currentGroup = section.group;
			const groupHeader = document.createElement('div');
			groupHeader.className = 'admin-config-group-header';
			const groupLabelKey = ADMIN_CONFIG_GROUP_LABELS[currentGroup];
			groupHeader.textContent = (groupLabelKey && ohLang.adminConfig[groupLabelKey]) || currentGroup;
			sectionsEl.appendChild(groupHeader);
		}
		sectionsEl.appendChild(renderAdminConfigSection(section, config));
	}
	adminConfigInitialStateJson = JSON.stringify(collectAdminConfigValues());

	saveBtn.disabled = false;
}

function closeAdminConfigModal() {
	if (!adminConfigModal) return;
	// Abort any in-flight config fetch
	if (adminConfigAbort) { adminConfigAbort.abort(); adminConfigAbort = null; }
	// Close any open select menus (removes scroll listeners)
	document.querySelectorAll('.admin-select-wrap.menu-open').forEach(w => {
		if (typeof w._closeMenu === 'function') w._closeMenu();
	});
	// Remove admin select menus from body
	adminSelectMenus.forEach(m => m.remove());
	adminSelectMenus.length = 0;
	adminConfigModal.classList.add('hidden');
	var adminFrame = adminConfigModal.querySelector('.admin-config-frame');
	if (adminFrame._resetDragPosition) adminFrame._resetDragPosition();
	document.body.classList.remove('admin-config-open');
	document.body.style.top = '';
	window.scrollTo(0, adminConfigModal._savedScrollY || 0);
	adminConfigInitialStateJson = null;
}

function collectAdminConfigValues() {
	const config = {};
	for (const section of ADMIN_CONFIG_SCHEMA) {
		for (const field of section.fields) {
			const key = field.key;
			let value;

			if (field.type === 'toggle') {
				const input = adminConfigModal.querySelector(`input[data-key="${key}"]`);
				value = input ? input.checked : false;
			} else if (field.type === 'number') {
				const input = adminConfigModal.querySelector(`input[data-key="${key}"]`);
				const raw = input ? input.value.trim() : '';
				value = raw === '' ? 0 : Number(raw);
			} else if (field.type === 'text') {
				const input = adminConfigModal.querySelector(`input[data-key="${key}"]`);
				value = input ? input.value : '';
			} else if (field.type === 'secret') {
				const input = adminConfigModal.querySelector(`input[data-key="${key}"]`);
				const raw = input ? input.value : '';
				if (raw === '' && input && input.dataset.masked === '1') {
					value = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
				} else {
					value = raw;
				}
			} else if (field.type === 'select') {
				const selectWrap = adminConfigModal.querySelector(`.admin-select-wrap[data-key="${key}"]`);
				value = selectWrap ? selectWrap.dataset.value : field.options[0];
			} else if (field.type === 'textarea') {
				const textarea = adminConfigModal.querySelector(`textarea[data-key="${key}"]`);
				value = textarea ? textarea.value : '';
			} else if (field.type === 'list') {
				const wrap = adminConfigModal.querySelector(`.admin-list-wrap[data-key="${key}"]`);
				if (wrap) {
					value = Array.from(wrap.querySelectorAll('.admin-list-input'))
						.map(i => i.value.trim())
						.filter(Boolean);
				} else {
					value = [];
				}
			}

			adminSetNested(config, key, value);
		}
	}
	return config;
}

async function saveAdminConfig() {
	const statusEl = adminConfigModal.querySelector('.admin-config-status');
	const saveBtn = adminConfigModal.querySelector('.admin-config-save');

	statusEl.className = 'admin-config-status';
	statusEl.textContent = '';
	saveBtn.disabled = true;

	const config = collectAdminConfigValues();
	const configJson = JSON.stringify(config);
	if (adminConfigInitialStateJson !== null && configJson === adminConfigInitialStateJson) {
		statusEl.className = 'admin-config-status warning';
		statusEl.textContent = ohLang.adminConfig.noChanges;
		saveBtn.disabled = false;
		return;
	}

	try {
		const resp = await fetch('/api/admin/config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(config),
		});
		const result = await resp.json();

		if (!resp.ok) {
			const msg = result.errors ? result.errors.join('; ') : (result.error || ohLang.adminConfig.saveFailedGeneric);
			statusEl.className = 'admin-config-status error';
			statusEl.textContent = msg;
			saveBtn.disabled = false;
			return;
		}

		if (result.restartRequired) {
			statusEl.className = 'admin-config-status warning';
			statusEl.textContent = ohLang.adminConfig.savedRestart;
		} else if (result.reloadRequired) {
			statusEl.className = 'admin-config-status warning';
			statusEl.textContent = ohLang.adminConfig.savedReload;
		} else {
			statusEl.className = 'admin-config-status success';
			statusEl.textContent = ohLang.adminConfig.savedOk;
		}
		adminConfigInitialStateJson = configJson;
	} catch (e) {
		statusEl.className = 'admin-config-status error';
		statusEl.textContent = ohLang.adminConfig.saveFailed + e.message;
	}

	saveBtn.disabled = false;
}

function updateAdminConfigBtnVisibility() {
	const btn = document.getElementById('adminConfigBtn');
	if (!btn) return;
	if (getUserRole() === 'admin') {
		btn.classList.remove('hidden');
	} else {
		btn.classList.add('hidden');
	}
	scheduleSearchPlaceholderUpdate();
}

function updateLogoutBtnVisibility() {
	if (!els.logout) return;
	if (getUserRole() === 'admin') {
		els.logout.classList.remove('hidden');
	} else {
		els.logout.classList.add('hidden');
	}
	scheduleSearchPlaceholderUpdate();
}

// ========== End Admin Config Modal ==========

function ensureImageViewer() {
	if (imageViewer) return;
	const wrap = document.createElement('div');
	wrap.id = 'imageViewer';
	wrap.className = 'image-viewer hidden';
	wrap.innerHTML = `
			<div class="image-viewer-frame glass">
				<div class="image-viewer-actions">
					<button type="button" class="image-viewer-download" aria-label="Download image">
						<img src="icons/image-viewer-download.svg" alt="" aria-hidden="true" />
					</button>
					<button type="button" class="image-viewer-close" aria-label="Close image">
						<img src="icons/image-viewer-close.svg" alt="" aria-hidden="true" />
					</button>
				</div>
			<img class="image-viewer-img" />
		</div>
	`;
	document.body.appendChild(wrap);
	imageViewer = wrap;
	imageViewerFrame = wrap.querySelector('.image-viewer-frame');
	imageViewerImg = wrap.querySelector('.image-viewer-img');
	imageViewerClose = wrap.querySelector('.image-viewer-close');
	if (imageViewerClose) {
		imageViewerClose.addEventListener('click', () => { haptic(); requestCloseImageViewer(); });
	}
	const imageViewerDownload = wrap.querySelector('.image-viewer-download');
	if (imageViewerDownload) {
		imageViewerDownload.addEventListener('click', () => { haptic(); downloadImageViewerImage(); });
	}
	if (imageViewerImg) {
		imageViewerImg.addEventListener('load', () => {
			updateImageViewerFrameSize();
			const finalize = () => {
				if (!imageViewerInitialLoadPending || !imageViewer) return;
				imageViewer.classList.remove('loading');
				imageViewerInitialLoadPending = false;
			};
			finalize();
		});
		imageViewerImg.addEventListener('error', () => {
			if (!imageViewerInitialLoadPending || !imageViewer) return;
			imageViewer.classList.remove('loading');
			imageViewerInitialLoadPending = false;
		});
		const isTouch = isTouchDevice();
		// Click-to-zoom and pointer pan only for non-touch devices
		if (!isTouch) {
			imageViewerImg.addEventListener('click', (e) => {
				if (state.isSlim) return;
				haptic();
				e.preventDefault();
				e.stopPropagation();
				toggleImageViewerZoom();
			});
			imageViewerImg.addEventListener('pointermove', (e) => {
				if (state.isSlim) return;
				if (!imageViewerZoomed) return;
				const rect = imageViewerImg.getBoundingClientRect();
				const x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100));
				const y = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100));
				imageViewerImg.style.transformOrigin = `${x}% ${y}%`;
			});
		} else {
			// Pinch-to-zoom and pan for touch devices
			let pinchStartDist = 0;
			let pinchStartScale = 1;
			let currentScale = 1;
			let translateX = 0;
			let translateY = 0;
			let panStartX = 0;
			let panStartY = 0;
			let panStartTranslateX = 0;
			let panStartTranslateY = 0;
			let isPanning = false;

			const clampTranslate = () => {
				// Limit panning so image stays within view
				const rect = imageViewerImg.getBoundingClientRect();
				const imgWidth = rect.width / currentScale;
				const imgHeight = rect.height / currentScale;
				const maxX = (imgWidth * (currentScale - 1)) / 2;
				const maxY = (imgHeight * (currentScale - 1)) / 2;
				translateX = Math.min(maxX, Math.max(-maxX, translateX));
				translateY = Math.min(maxY, Math.max(-maxY, translateY));
			};

			const updateTransform = () => {
				if (currentScale > 1) {
					clampTranslate();
					imageViewerImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${currentScale})`;
				} else {
					imageViewerImg.style.transform = '';
				}
			};

			imageViewerImg.addEventListener('touchstart', (e) => {
				if (e.touches.length === 2) {
					// Pinch start
					e.preventDefault();
					isPanning = false;
					const dx = e.touches[0].clientX - e.touches[1].clientX;
					const dy = e.touches[0].clientY - e.touches[1].clientY;
					pinchStartDist = Math.hypot(dx, dy);
					pinchStartScale = currentScale;
				} else if (e.touches.length === 1 && currentScale > 1) {
					// Pan start (only when zoomed)
					isPanning = true;
					panStartX = e.touches[0].clientX;
					panStartY = e.touches[0].clientY;
					panStartTranslateX = translateX;
					panStartTranslateY = translateY;
				}
			}, { passive: false });

			imageViewerImg.addEventListener('touchmove', (e) => {
				if (e.touches.length === 2 && pinchStartDist > 0) {
					// Pinch zoom
					e.preventDefault();
					const dx = e.touches[0].clientX - e.touches[1].clientX;
					const dy = e.touches[0].clientY - e.touches[1].clientY;
					const dist = Math.hypot(dx, dy);
					const scale = Math.min(4, Math.max(1, pinchStartScale * (dist / pinchStartDist)));
					currentScale = scale;
					imageViewerZoomed = scale > 1;
					imageViewerImg.classList.toggle('zoomed', imageViewerZoomed);
					updateTransform();
				} else if (e.touches.length === 1 && isPanning && currentScale > 1) {
					// Pan (1.5x speed multiplier)
					e.preventDefault();
					const dx = (e.touches[0].clientX - panStartX) * 1.5;
					const dy = (e.touches[0].clientY - panStartY) * 1.5;
					translateX = panStartTranslateX + dx;
					translateY = panStartTranslateY + dy;
					updateTransform();
				}
			}, { passive: false });

			imageViewerImg.addEventListener('touchend', (e) => {
				if (e.touches.length < 2) {
					pinchStartDist = 0;
				}
				if (e.touches.length === 0) {
					isPanning = false;
					// Reset if scale is close to 1
					if (currentScale < 1.1) {
						currentScale = 1;
						translateX = 0;
						translateY = 0;
						updateTransform();
						setImageViewerZoom(false);
					}
				}
			});
		}
	}
	wrap.addEventListener('click', (e) => {
		if (e.target === wrap) { haptic(); requestCloseImageViewer(); }
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') requestCloseImageViewer();
	});
}

function openImageViewer(url, refreshMs, options = {}) {
	if (state.isSlim) return;
	const target = safeText(url).trim();
	if (!target) return;
	haptic();
	ensureImageViewer();
	if (!imageViewer || !imageViewerImg) return;
	imageViewerFitMode = 'real';
	setImageViewerZoom(false);
	imageViewerInitialLoadPending = true;
	imageViewer.classList.add('loading');
	imageViewer.classList.remove('hidden');
	document.body.classList.add('image-viewer-open');
	updateImageViewerFrameSize();
	setImageViewerSource(target, refreshMs);
	if (!options.skipHistory) {
		pushImageViewerHistory(target, refreshMs);
	}
}

function closeImageViewer() {
	if (!imageViewer) return;
	haptic();
	imageViewer.classList.add('hidden');
	document.body.classList.remove('image-viewer-open');
	setImageViewerZoom(false);
	imageViewerInitialLoadPending = false;
	imageViewer.classList.remove('loading');
	clearImageViewerTimer();
	imageViewerUrl = '';
	imageViewerRefreshMs = null;
	if (imageViewerImg) {
		imageViewerImg.removeAttribute('src');
		imageViewerImg.style.transform = '';
	}
}

function requestCloseImageViewer() {
	if (window.history?.state?.imageViewer) {
		history.back();
		return;
	}
	closeImageViewer();
}

function downloadImageViewerImage() {
	if (!imageViewerUrl) return;
	haptic();
	const a = document.createElement('a');
	a.href = imageViewerUrl;
	const filename = imageViewerUrl.split('/').pop().split('?')[0] || 'image';
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
}

function clearImageViewerTimer() {
	if (imageViewerTimer) {
		clearInterval(imageViewerTimer);
		imageViewerTimer = null;
	}
}

function setImageViewerSource(url, refreshMs) {
	if (!imageViewerImg) return;
	clearImageViewerTimer();
	imageViewerUrl = url;
	imageViewerRefreshMs = refreshMs;
	let ms = Number(refreshMs);
	if (state.isSlim && Number.isFinite(ms) && ms > 0 && ms < MIN_IMAGE_REFRESH_MS) {
		ms = MIN_IMAGE_REFRESH_MS;
	}
	const update = () => {
		if (!imageViewerImg) return;
		const resolved = resolveMediaUrl(imageViewerImg, url);
		imageViewerImg.src = withCacheBust(resolved);
	};
	const start = () => {
		update();
		if (Number.isFinite(ms) && ms > 0) {
			imageViewerTimer = setInterval(update, ms);
		}
	};
	if (typeof requestAnimationFrame === 'function') {
		requestAnimationFrame(start);
	} else {
		start();
	}
}

function updateImageViewerFrameSize() {
	if (!imageViewerFrame || !imageViewerImg) return;
	const maxW = Math.max(0, Math.round((window.innerWidth || 0) * IMAGE_VIEWER_MAX_VIEWPORT));
	const maxH = Math.max(0, Math.round((window.innerHeight || 0) * IMAGE_VIEWER_MAX_VIEWPORT));
	if (!maxW || !maxH) return;
	const naturalW = imageViewerImg.naturalWidth;
	const naturalH = imageViewerImg.naturalHeight;
	if (!Number.isFinite(naturalW) || !Number.isFinite(naturalH) || naturalW <= 0 || naturalH <= 0) {
		imageViewerFrame.style.width = `${maxW}px`;
		imageViewerFrame.style.height = `${maxH}px`;
		return;
	}
	const ratio = naturalW / naturalH;
	let width = maxW;
	let height = Math.round(width / ratio);
	if (height > maxH) {
		height = maxH;
		width = Math.round(height * ratio);
	}
	imageViewerFrame.style.width = `${width}px`;
	imageViewerFrame.style.height = `${height}px`;
}

function setImageViewerZoom(zoomed) {
	if (state.isSlim) zoomed = false;
	imageViewerZoomed = !!zoomed;
	if (!imageViewerImg) return;
	imageViewerImg.classList.toggle('zoomed', imageViewerZoomed);
	if (!imageViewerZoomed) {
		imageViewerImg.style.transformOrigin = '50% 50%';
	}
}

function toggleImageViewerZoom() {
	haptic();
	setImageViewerZoom(!imageViewerZoomed);
}

function syncAuthFromHeaders(res) {
	if (!res || !res.headers) return;
	const rawAuth = safeText(res.headers.get('X-OhProxy-Authenticated') || '').trim().toLowerCase();
	const rawUser = safeText(res.headers.get('X-OhProxy-Username') || '').trim();
	if (!rawAuth && !rawUser) return;
	const authenticated = ['true', '1', 'yes', 'authenticated'].includes(rawAuth);
	const nextAuth = authenticated ? 'authenticated' : 'unauthenticated';
	const nextUser = authenticated ? rawUser : '';
	const changed = nextAuth !== state.proxyAuth || nextUser !== state.proxyUser;
	state.proxyAuth = nextAuth;
	state.proxyUser = nextUser;
	if (changed) updateStatusBar();
}

function pendingUntilAbort(signal) {
	const mkAbortErr = () => typeof DOMException !== 'undefined'
		? new DOMException('Aborted', 'AbortError')
		: Object.assign(new Error('Aborted'), { name: 'AbortError' });
	return new Promise((_, reject) => {
		if (!signal) return reject(mkAbortErr());
		if (signal.aborted) return reject(mkAbortErr());
		signal.addEventListener('abort', () => reject(mkAbortErr()), { once: true });
	});
}

async function fetchWithAuth(url, options) {
	const res = await fetch(url, options);
	syncAuthFromHeaders(res);
	// Detect 401 - session expired or account was deleted - redirect to login
	if (res.status === 401) {
		// Check if account was deleted
		try {
			const clone = res.clone();
			const data = await clone.json();
			if (data?.error === 'account-deleted') {
				window.location.href = '/login';
				return pendingUntilAbort(options?.signal);
			}
		} catch (err) {
			logJsError('fetchWithAuth account-deleted parse failed', err);
		}
		// Normal 401 - reload to show login prompt
		try {
			if (window.parent !== window && window.parent.__ohProxyIframeWrapper) {
				window.parent.location.href = '/';
				return pendingUntilAbort(options?.signal);
			}
		} catch (e) { /* cross-origin parent */ }
		triggerReload();
		return pendingUntilAbort(options?.signal);
	}
	return res;
}

async function fetchJson(url) {
	const res = await fetchWithAuth(url, { headers: { 'Accept': 'application/json' } });
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch (err) {
		logJsError(`fetchJson JSON parse failed for ${url}`, err);
		// openHAB should return JSON when using ?type=json, so if we’re here,
		// show a useful error (no silent failures).
		throw new Error(`Non-JSON response from ${url} (did you enable REST + ?type=json?)`);
	}
}

async function refreshSearchStates(matches) {
	if (!state.filter.trim() || !state.searchIndexReady) return false;
	const now = Date.now();
	const minInterval = state.isSlim ? SEARCH_STATE_MIN_SLIM_MS : SEARCH_STATE_MIN_DEFAULT_MS;
	if (now - state.lastSearchStateSync < minInterval) return false;
	const token = state.searchStateToken;
	if (state.searchStateInFlight) {
		if (searchStateActiveToken === token) return false;
		if (searchStateAbort) searchStateAbort.abort();
	}
	const controller = new AbortController();
	searchStateAbort = controller;
	searchStateActiveToken = token;
	const names = new Set();
	for (const w of matches || []) {
		if (w?.__section) continue;
		const name = safeText(w?.item?.name || w?.itemName || '');
		if (name) names.add(name);
	}
	if (!names.size) return false;

	state.searchStateInFlight = true;
	const filterAtStart = state.filter;
	try {
		const stateMap = new Map();
		const list = Array.from(names);
		const concurrency = state.isSlim ? SEARCH_STATE_CONCURRENCY_SLIM : SEARCH_STATE_CONCURRENCY_DEFAULT;
		let cursor = 0;
		const worker = async () => {
			while (cursor < list.length) {
				if (controller.signal.aborted) return;
				const index = cursor;
				cursor += 1;
				const name = list[index];
				if (!name) continue;
				try {
					const res = await fetchWithAuth(`rest/items/${encodeURIComponent(name)}/state`, {
						headers: { 'Accept': 'text/plain' },
						signal: controller.signal,
					});
					if (!res.ok) continue;
					const txt = await res.text();
					stateMap.set(name, safeText(txt));
				} catch (err) {
					if (controller.signal.aborted) return;
					logJsError(`syncSearchState fetch failed for ${name}`, err);
				}
			}
		};
		const workers = Array.from({ length: Math.min(concurrency, list.length) }, () => worker());
		await Promise.all(workers);
		if (!stateMap.size) return false;
		if (token !== state.searchStateToken || filterAtStart !== state.filter || !state.filter.trim()) {
			return false;
		}
		state.lastSearchStateSync = Date.now();
		let updated = false;
		if (Array.isArray(state.searchWidgets)) {
			for (const w of state.searchWidgets) {
				const name = safeText(w?.item?.name || w?.itemName || '');
				if (!name || !stateMap.has(name)) continue;
				const nextState = stateMap.get(name);
				if (safeText(widgetState(w)) !== safeText(nextState)) {
					updateWidgetState(w, nextState);
					updated = true;
				}
			}
		}
		return updated;
	} catch (err) {
		logJsError('syncSearchState failed', err);
		return false;
	} finally {
		if (searchStateAbort === controller) {
			searchStateAbort = null;
			searchStateActiveToken = 0;
			state.searchStateInFlight = false;
		}
	}
}

function pageCacheKey(url) {
	return ensureJsonParam(toRelativeRestLink(url));
}

// Track in-flight fetch requests to prevent concurrent fetches for same URL
const fetchPageInflight = new Map();
const WS_DELTA_TIMEOUT_MS = 1500; // Fast timeout, falls back to XHR
const XHR_DELTA_TIMEOUT_MS = 3000; // Timeout for XHR fallback
const FETCH_PAGE_TIMEOUT_MS = WS_DELTA_TIMEOUT_MS + XHR_DELTA_TIMEOUT_MS + 500; // Outer safety net

// Clear all in-flight fetches on network state change to prevent deadlocks
function clearInflightFetches() {
	fetchPageInflight.clear();
}

async function fetchPage(url, options) {
	const opts = options || {};
	const key = pageCacheKey(url);

	// If a fetch is already in flight for this URL, wait for it instead of making a duplicate request
	const existing = fetchPageInflight.get(key);
	if (existing) {
		return existing.promise;
	}

	// Create fetch with timeout to prevent deadlocks on spotty connections
	const fetchSignal = { aborted: false };
	let timeoutId;
	const timeoutPromise = new Promise((_, reject) => {
		timeoutId = setTimeout(() => {
			fetchSignal.aborted = true;
			reject(new Error('Fetch timeout'));
		}, FETCH_PAGE_TIMEOUT_MS);
	});

	const fetchPromise = fetchPageInternal(url, opts, fetchSignal);
	const racedPromise = Promise.race([fetchPromise, timeoutPromise]).finally(() => {
		clearTimeout(timeoutId);
	});

	fetchPageInflight.set(key, { promise: racedPromise, timestamp: Date.now() });
	try {
		return await racedPromise;
	} finally {
		fetchPageInflight.delete(key);
	}
}

async function fetchPageInternal(url, opts, fetchSignal) {
	const key = pageCacheKey(url);
	const since = opts.forceFull ? '' : (state.deltaTokens.get(key) || '');

	// Try WebSocket first if connected
	if (wsConnected && wsConnection && wsConnection.readyState === WebSocket.OPEN) {
		try {
			const data = await fetchDeltaViaWs(url, since);
			if (data && data.delta === true) {
				if (data.hash && !fetchSignal.aborted) state.deltaTokens.set(key, data.hash);
				return { delta: true, title: data.title || '', changes: data.changes || [] };
			}
			if (data && data.delta === false && data.page) {
				if (data.hash && !fetchSignal.aborted) state.deltaTokens.set(key, data.hash);
				return { delta: false, page: data.page };
			}
			// Fallback: unexpected format
			return { delta: false, page: data.page || data };
		} catch (err) {
			logJsError('fetchPageInternal WS delta failed', err);
			// WS failed, fall through to XHR
		}
	}

	// XHR fallback
	const deltaUrl = new URL(url, window.location.href);
	deltaUrl.searchParams.set('delta', '1');
	if (since) {
		deltaUrl.searchParams.set('since', since);
	}

	const xhrController = new AbortController();
	const xhrTimer = setTimeout(() => xhrController.abort(), XHR_DELTA_TIMEOUT_MS);
	let data;
	try {
		const res = await fetchWithAuth(deltaUrl.toString(), {
			headers: { 'Accept': 'application/json' },
			cache: 'no-store',
			signal: xhrController.signal,
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}
		const text = await res.text();
		try {
			data = JSON.parse(text);
		} catch (parseErr) {
			logJsError(`fetchPageInternal JSON parse failed for ${deltaUrl.toString()}`, parseErr);
			throw new Error(`Non-JSON response from ${deltaUrl.toString()} (did you enable REST + ?type=json?)`);
		}
	} catch (err) {
		if (err?.name === 'AbortError') {
			throw new Error('XHR delta timeout');
		}
		throw err;
	} finally {
		clearTimeout(xhrTimer);
	}

	if (data && data.delta === true) {
		if (data.hash && !fetchSignal.aborted) state.deltaTokens.set(key, data.hash);
		return { delta: true, title: data.title || '', changes: data.changes || [] };
	}
	if (data && data.delta === false && data.page) {
		if (data.hash && !fetchSignal.aborted) state.deltaTokens.set(key, data.hash);
		return { delta: false, page: data.page };
	}

	// Fallback: server returned a full page JSON
	return { delta: false, page: data };
}

function sectionLabel(widget) {
	return safeText(widget?.label || widget?.item?.label || widget?.item?.name || '');
}

function flattenWidgets(list, out, ctx) {
	const frameLabel = safeText(ctx?.frame || '');
	const path = ctx?.path;
	for (const w of list) {
		if (w?.type === 'Frame') {
			const label = sectionLabel(w);
			if (label) out.push({ __section: true, label });
			// Support both 'widget' (OH 1.x) and 'widgets' (OH 3.x+)
			let kids = w.widgets || w.widget;
			if (kids) {
				if (Array.isArray(kids)) {
					// ok
				} else if (Array.isArray(kids.item)) {
					kids = kids.item;
				} else {
					kids = [kids];
				}
				flattenWidgets(kids, out, { frame: label || frameLabel, path });
			}
			continue;
		}
		if (path) w.__path = path;
		if (frameLabel) w.__frame = frameLabel;
		out.push(w);
	}
}

function normalizeWidgets(page, ctx) {
	// openHAB sitemap JSON structures vary a bit; handle a few shapes.
	// OH 1.x: { id, title, widget: [ ... ] } or { widget: { item: [...] } }
	// OH 3.x+: { id, title, widgets: [ ... ] }
	let w = page?.widgets || page?.widget;

	if (!w) return [];

	if (!Array.isArray(w)) {
		// sometimes "widget" is an object with "item"
		if (w && Array.isArray(w.item)) w = w.item;
		else w = [w];
	}

	const out = [];
	flattenWidgets(w, out, ctx);
	return out;
}

function widgetLabel(widget) {
	// Prefer widget.label, else item.label, else item.name
	if (widget?.label) return safeText(widget.label);
	if (widget?.item?.label) return safeText(widget.item.label);
	return safeText(widget?.item?.name || widget?.name || 'Item');
}

function widgetState(widget) {
	return safeText(widget?.item?.state ?? widget?.state ?? '');
}

function updateWidgetState(widget, nextState) {
	if (!widget || nextState === undefined) return;
	const prevState = widget?.item?.state ?? widget?.state;
	if (widget.item && typeof widget.item === 'object') {
		widget.item.state = nextState;
	} else if ('state' in widget) {
		widget.state = nextState;
	}
	// Update label if it contains bracketed state (e.g., "Front Door [Locked + Closed]")
	// Only update if the label's bracketed value matches the previous state - this avoids
	// overwriting transformed values like counts (e.g., "[3]" from GroupItem with OPEN state)
	if (widget.label && widget.label.includes('[') && widget.label.includes(']')) {
		const parts = splitLabelState(widget.label);
		if (parts.state && parts.title && parts.state === prevState) {
			widget.label = `${parts.title} [${nextState}]`;
		}
	}
}

function updateItemState(itemName, nextState) {
	if (!itemName) return;
	const name = safeText(itemName);
	const lists = [state.rawWidgets, state.searchWidgets];
	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		for (const w of list) {
			if (safeText(w?.item?.name) === name) updateWidgetState(w, nextState);
		}
	}
}

function findWidgetByKey(key) {
	if (!key) return null;
	const lists = [state.rawWidgets, state.searchWidgets];
	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		for (const w of list) {
			if (widgetKey(w) === key) return w;
		}
	}
	return null;
}

async function fetchItemState(itemName) {
	if (!itemName) return null;
	try {
		const res = await fetchWithAuth(`rest/items/${encodeURIComponent(itemName)}/state`, {
			headers: { 'Accept': 'text/plain' },
		});
		if (!res.ok) return null;
		return await res.text();
	} catch (err) {
		logJsError(`fetchItemState failed for ${itemName}`, err);
		return null;
	}
}

function applyDeltaChanges(changes) {
	if (!Array.isArray(changes) || !changes.length) return false;
	let updated = false;
	const lists = [state.rawWidgets, state.searchWidgets];
	for (const list of lists) {
		if (!Array.isArray(list)) continue;
		const keyIndex = new Map();
		const itemIndex = new Map();
		for (const w of list) {
			if (w?.__section) continue;
			const key = deltaKey(w);
			if (key) {
				if (!keyIndex.has(key)) keyIndex.set(key, []);
				keyIndex.get(key).push(w);
			}
			const itemName = safeText(w?.item?.name || w?.itemName || '');
			if (itemName) {
				if (!itemIndex.has(itemName)) itemIndex.set(itemName, []);
				itemIndex.get(itemName).push(w);
			}
		}

		for (const change of changes) {
			const changeKey = safeText(change?.key || '');
			const changeItem = safeText(change?.itemName || '');
			let targets = changeKey ? keyIndex.get(changeKey) : null;
			if ((!targets || !targets.length) && changeItem) targets = itemIndex.get(changeItem);
			if (!targets) continue;
			for (const w of targets) {
				if (change.label !== undefined) w.label = change.label;
				if (change.state !== undefined) updateWidgetState(w, change.state);
				if (change.icon !== undefined) {
					w.icon = change.icon;
					if (w.item) w.item.icon = change.icon;
				}
				if (change.mapping !== undefined) {
					if (w.mappings) w.mappings = change.mapping;
					else w.mapping = change.mapping;
				}
				updated = true;
			}
		}
	}
	return updated;
}

// Sync delta changes to the sitemap cache so navigating back shows updated data
function syncDeltaToCache(pageUrl, changes) {
	if (!state.sitemapCacheReady || !Array.isArray(changes) || !changes.length) return;
	const cachedPage = getPageFromCache(pageUrl);
	if (!cachedPage) return;

	// Build a map of changes by key for quick lookup
	const changeMap = new Map();
	for (const change of changes) {
		const key = safeText(change?.key || '');
		if (key) changeMap.set(key, change);
	}

	// Recursively update widgets in the cached page structure
	const updateWidgets = (widgets) => {
		if (!widgets) return;
		const list = Array.isArray(widgets) ? widgets : (widgets.item ? (Array.isArray(widgets.item) ? widgets.item : [widgets.item]) : [widgets]);
		for (const w of list) {
			if (!w) continue;
			const key = deltaKey(w);
			if (key && changeMap.has(key)) {
				const change = changeMap.get(key);
				if (change.label !== undefined) w.label = change.label;
				if (change.state !== undefined) {
					if (w.item) w.item.state = change.state;
					w.state = change.state;
				}
				if (change.icon !== undefined) {
					w.icon = change.icon;
					if (w.item) w.item.icon = change.icon;
				}
				if (change.mapping !== undefined) {
					if (w.mappings) w.mappings = change.mapping;
					else w.mapping = change.mapping;
				}
			}
			// Recurse into nested widgets (Frames, etc.)
			if (w.widget) updateWidgets(w.widget);
			if (w.widgets) updateWidgets(w.widgets);
		}
	};

	// Support both OH 1.x 'widget' and OH 3.x+ 'widgets'
	updateWidgets(cachedPage?.widgets || cachedPage?.widget);
	// No need to call updatePageInCache - we modified the object in place
}

// Sync item state changes to ALL cached pages (for WebSocket item updates)
function syncItemsToAllCachedPages(changes) {
	if (!state.sitemapCacheReady || !state.sitemapCache || !Array.isArray(changes) || !changes.length) return;

	// Build a map of changes by itemName
	const changeMap = new Map();
	for (const change of changes) {
		const itemName = safeText(change?.itemName || '');
		if (itemName) changeMap.set(itemName, change);
	}
	if (changeMap.size === 0) return;

	// Recursively update widgets matching item names
	const updateWidgets = (widgets) => {
		if (!widgets) return;
		const list = Array.isArray(widgets) ? widgets : (widgets.item ? (Array.isArray(widgets.item) ? widgets.item : [widgets.item]) : [widgets]);
		for (const w of list) {
			if (!w) continue;
			const itemName = safeText(w?.item?.name || w?.name || '');
			if (itemName && changeMap.has(itemName)) {
				const change = changeMap.get(itemName);
				if (change.state !== undefined) {
					if (w.item) w.item.state = change.state;
					w.state = change.state;
					// Only update label for numeric states (group counts like "0", "1", "2")
					// Don't update for raw states like "OPEN"/"CLOSED" which have transformers
					if (w.label && w.label.includes('[') && /^\d+$/.test(change.state)) {
						w.label = w.label.replace(/\[[^\]]*\]/, `[${change.state}]`);
					}
				}
			}
			if (w.widget) updateWidgets(w.widget);
			if (w.widgets) updateWidgets(w.widgets);
		}
	};

	// Update all cached pages - support both OH 1.x 'widget' and OH 3.x+ 'widgets'
	for (const page of state.sitemapCache.values()) {
		const widgetSource = page?.widgets || page?.widget;
		if (widgetSource) updateWidgets(widgetSource);
	}
}

function widgetType(widget) {
	return safeText(widget?.type || widget?.widgetType || widget?.item?.type || '');
}

function widgetLink(widget) {
	return safeText(widget?.linkedPage?.link || widget?.link || '');
}

function deltaKey(widget) {
	const id = safeText(widget?.widgetId || widget?.id || '');
	if (id) return `id:${id}`;
	const itemName = safeText(widget?.item?.name || widget?.itemName || '');
	const type = widgetType(widget);
	const link = widgetLink(widget);
	if (itemName) return `item:${itemName}|${type}|${link}`;
	const label = safeText(widget?.label || widget?.item?.label || widget?.item?.name || '');
	return `label:${label}|${type}|${link}`;
}

function widgetIconName(widget) {
	// In many sitemap JSON payloads, icon is in widget.icon
	// Fallback to item.category/icon if present.
	return safeText(widget?.icon || widget?.item?.icon || widget?.item?.category || '');
}

function widgetKey(widget) {
	if (widget?.__section) return `section:${safeText(widget.label)}`;
	// Don't use widgetId - it's positional and changes when visibility shifts widgets
	const item = safeText(widget?.item?.name || '');
	// Use title only (without state) so key is stable when state changes
	const fullLabel = safeText(widget?.label || '');
	const label = splitLabelState(fullLabel).title || fullLabel;
	const type = widgetType(widget);
	const link = safeText(widgetPageLink(widget) || '');
	return `widget:${item}|${label}|${type}|${link}`;
}

function splitLabelState(label) {
	const raw = safeText(label);
	// Strip trailing empty brackets [] or [-] (openHAB uses these when no state)
	const cleaned = raw.replace(/\s*\[\s*-?\s*\]\s*$/, '');
	const match = cleaned.match(/^(.*)\s*\[(.+)\]\s*$/);
	if (!match) return { title: cleaned, state: '' };
	return { title: match[1].trim(), state: match[2].trim() };
}

function labelPathSegments(label) {
	const parts = splitLabelState(label);
	const segs = [];
	if (parts.title && parts.title !== '-') segs.push(parts.title);
	if (parts.state && parts.state !== '-') segs.push(parts.state);
	return segs;
}

function searchGroupLabel(widget) {
	const path = Array.isArray(widget?.__path) ? widget.__path : [];
	const frame = safeText(widget?.__frame || '');
	if (!path.length) return frame ? `Home · ${frame}` : 'Home';
	const parts = path.slice();
	if (frame) parts.push(frame);
	return parts.join(' · ');
}

function frameKeyFor(path, frameLabel) {
	const safePath = Array.isArray(path) ? path : [];
	const frame = safeText(frameLabel || '');
	return `${safePath.join('>')}|${frame}`;
}

function searchWidgetKey(widget) {
	const base = widgetKey(widget);
	const path = Array.isArray(widget?.__path) ? widget.__path.join('>') : '';
	const frame = safeText(widget?.__frame || '');
	return `${base}|${path}|${frame}`;
}

function normalizeMapping(mapping) {
	if (!mapping) return [];
	if (Array.isArray(mapping)) {
		return mapping
			.map((m) => {
				if (!m || typeof m !== 'object') return null;
				const command = safeText(m.command ?? '');
				const label = safeText(m.label ?? m.command ?? '');
				if (!command) return null;
				return { command, label: label || command };
			})
			.filter(Boolean);
	}
	if (typeof mapping === 'object') {
		if ('command' in mapping || 'label' in mapping) {
			const command = safeText(mapping.command ?? '');
			const label = safeText(mapping.label ?? mapping.command ?? '');
			if (!command) return [];
			return [{ command, label: label || command }];
		}
		return Object.entries(mapping)
			.filter(([command]) => safeText(command))
			.map(([command, label]) => ({
				command: safeText(command),
				label: safeText(label) || safeText(command),
			}));
	}
	return [];
}

function iconCandidates(icon) {
	// openHAB 1.x icons are mostly static; avoid state-suffixed probes to reduce 404 noise.
	const cands = [];
	if (icon) {
		cands.push(`images/${ICON_VERSION}/${icon}.png`);
		cands.push(`openhab.app/images/${ICON_VERSION}/${icon}.png`);
		cands.push(`openhab.app/images/${ICON_VERSION}/${icon}.svg`);
	}
	return cands;
}

function loadBestIcon(imgEl, candidates) {
	const cacheKey = imgEl.dataset.iconKey;
	if (cacheKey && MAX_ICON_CACHE > 0 && iconCache.has(cacheKey)) {
		const cachedUrl = iconCache.get(cacheKey);
		if (cachedUrl) {
			setBoundedCache(iconCache, cacheKey, cachedUrl, MAX_ICON_CACHE);
			imgEl.src = cachedUrl;
			imgEl.classList.add('icon-ready');
			return;
		}
		iconCache.delete(cacheKey);
	}
	imgEl.classList.remove('icon-ready');
	const token = `${Date.now()}-${Math.random()}`;
	imgEl.dataset.iconLoadToken = token;
	let i = 0;
	const tryNext = () => {
		if (imgEl.dataset.iconLoadToken !== token) return;
		if (i >= candidates.length) return;
		const url = candidates[i++];
		imgEl.onload = () => {
			if (imgEl.dataset.iconLoadToken !== token) return;
			if (cacheKey && MAX_ICON_CACHE > 0) {
				setBoundedCache(iconCache, cacheKey, url, MAX_ICON_CACHE);
			}
			imgEl.classList.add('icon-ready');
		};
		imgEl.onerror = () => {
			if (imgEl.dataset.iconLoadToken !== token) return;
			tryNext();
		};
		imgEl.src = url;
	};
	tryNext();
}

async function sendCommand(itemName, command, options = {}) {
	// openHAB REST: POST /rest/items/<item> with text/plain body
	const opts = (options && typeof options === 'object') ? options : {};
	const optimistic = opts.optimistic !== false;
	const res = await fetchWithAuth(`rest/items/${encodeURIComponent(itemName)}`, {
		method: 'POST',
		headers: { 'Content-Type': 'text/plain' },
		body: String(command),
	});
	if (!res.ok) {
		const txt = await res.text().catch(() => '');
		throw new Error(`Command failed (${res.status}): ${txt || res.statusText}`);
	}
	if (itemName) {
		if (optimistic) {
			updateItemState(itemName, String(command));
			if (state.filter.trim() && state.suppressRefreshCount === 0) render();
		}
		void fetchItemState(itemName).then((nextState) => {
			if (nextState == null) return;
			updateItemState(itemName, nextState);
			if (state.filter.trim() && state.suppressRefreshCount === 0) render();
		});
	}
}

// --- Rendering ---
const CARD_TEMPLATE_HTML = `
	<div class="glass rounded-2xl p-4 group">
		<div class="cardRow flex items-start gap-3">
			<div class="iconWrap h-12 w-12 rounded-xl flex items-center justify-center shrink-0 overflow-hidden">
				<img class="h-9 w-9 opacity-90 object-contain object-center block" />
			</div>
			<div class="flex-1 min-w-0">
				<div class="labelRow flex items-center justify-between gap-2">
					<div class="labelStack min-w-0">
						<div class="font-semibold truncate title"></div>
						<div class="text-xs text-slate-300 truncate meta"></div>
					</div>
					<div class="navHint text-slate-300 text-xl font-semibold leading-none">
						<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" transform="rotate(180)">
							<path d="M8 10L8 14L6 14L-2.62268e-07 8L6 2L8 2L8 6L16 6L16 10L8 10Z" fill="#000000"></path>
						</svg>
					</div>
				</div>
				<div class="controls"></div>
			</div>
		</div>
	</div>
`;

const cardTemplate = (() => {
	const template = document.createElement('template');
	template.innerHTML = CARD_TEMPLATE_HTML.trim();
	return template;
})();

function createCardElement() {
	if (cardTemplate.content && cardTemplate.content.firstElementChild) {
		return cardTemplate.content.firstElementChild.cloneNode(true);
	}
	const wrap = document.createElement('div');
	wrap.innerHTML = CARD_TEMPLATE_HTML.trim();
	return wrap.firstElementChild;
}

function clearGlow(card) {
	card.classList.remove('glow-card');
	const dot = card.querySelector('.glow-dot');
	if (dot) dot.remove();
}

function resetCardInteractions(card) {
	runCardCleanups(card);
	card.onclick = null;
	card.onkeydown = null;
	card.onpointerdown = null;
	card.onpointerup = null;
	card.onpointerleave = null;
}

function resetLabelRow(labelRow, labelStack, navHint, preserve = null) {
	if (!labelRow) return;
	for (const child of Array.from(labelRow.children)) {
		if (child === labelStack || child === navHint) continue;
		if (preserve && child === preserve) continue;
		child.remove();
	}
}

function animateSliderValue(input, targetValue, valueBubble = null, positionCallback = null, durationMs = 400) {
	if (!input) return;
	const startValue = Number(input.value);
	const endValue = Number(targetValue);
	if (startValue === endValue || !Number.isFinite(startValue) || !Number.isFinite(endValue)) {
		input.value = targetValue;
		if (valueBubble) valueBubble.textContent = targetValue;
		if (positionCallback) positionCallback();
		return;
	}
	const step = Number(input.step) || 1;
	const snap = (v) => Math.round(v / step) * step;
	const startTime = performance.now();
	const animate = (now) => {
		const elapsed = now - startTime;
		const progress = Math.min(elapsed / durationMs, 1);
		// Ease-out cubic for smooth deceleration
		const eased = 1 - Math.pow(1 - progress, 3);
		const currentValue = progress >= 1 ? endValue : snap(startValue + (endValue - startValue) * eased);
		input.value = currentValue;
		if (valueBubble) valueBubble.textContent = currentValue;
		if (positionCallback) positionCallback();
		if (progress < 1) {
			requestAnimationFrame(animate);
		}
	};
	requestAnimationFrame(animate);
}

function crossfadeText(element, newText, fadeOutMs = 200, fadeInMs = 200) {
	if (!element) return;
	const oldText = element.textContent;
	if (oldText === newText) return;

	// Increment token to invalidate any pending animation
	const token = (element.__crossfadeToken || 0) + 1;
	element.__crossfadeToken = token;

	// If empty, just set directly (no animation needed for initial render)
	if (!oldText) {
		element.textContent = newText;
		return;
	}

	// Create old text span for fading out
	const oldSpan = document.createElement('span');
	oldSpan.textContent = oldText;
	oldSpan.style.cssText = 'transition:opacity ' + fadeOutMs + 'ms ease;';

	// Setup container
	const originalPosition = getComputedStyle(element).position;
	if (originalPosition === 'static') element.style.position = 'relative';
	element.textContent = '';
	element.appendChild(oldSpan);

	// Phase 1: Fade out old text
	requestAnimationFrame(() => {
		if (element.__crossfadeToken !== token) return;
		oldSpan.style.opacity = '0';
		setTimeout(() => {
			if (element.__crossfadeToken !== token) return;
			// Phase 2: Replace with new text and fade in
			oldSpan.remove();
			const newSpan = document.createElement('span');
			newSpan.textContent = newText;
			newSpan.style.cssText = 'opacity:0;transition:opacity ' + fadeInMs + 'ms ease;';
			element.appendChild(newSpan);
			requestAnimationFrame(() => {
				if (element.__crossfadeToken !== token) return;
				newSpan.style.opacity = '1';
				setTimeout(() => {
					if (element.__crossfadeToken !== token) return;
					element.textContent = newText;
					if (originalPosition === 'static') element.style.position = '';
				}, fadeInMs);
			});
		}, fadeOutMs);
	});
}

function removeOverlaySelects(card) {
	for (const el of card.querySelectorAll('select.select-overlay')) {
		el.remove();
	}
}

function getWidgetRenderInfo(w) {
	const type = widgetType(w);
	const t = type.toLowerCase();
	const isImage = t.includes('image');
	const isChart = t === 'chart';
	const isText = t.includes('text');
	const isGroup = t.includes('group');
	const isWebview = t.includes('webview');
	const isVideo = t === 'video';
	const isSelection = t.includes('selection');
	const label = isImage || isVideo || isChart ? safeText(w?.label || '') : widgetLabel(w);
	const st = widgetState(w);
	const icon = widgetIconName(w);
	const itemName = safeText(w?.item?.name || w?.itemName || '');
	// Support both OH 1.x 'mapping' and OH 3.x+ 'mappings'
	const mapping = normalizeMapping(w?.mappings || w?.mapping);
	const pageLink = widgetPageLink(w);
	const labelParts = splitLabelState(label);
	const wKey = widgetKey(w);
	// Check for proxy cache config and add cache param to image URL
	const proxyCacheConfig = isImage ? widgetProxyCacheConfigMap.get(wKey) : null;
	const cacheParam = proxyCacheConfig?.cacheSeconds ? `&cache=${proxyCacheConfig.cacheSeconds}` : '';
	const rawMediaUrl = isImage ? normalizeMediaUrl(imageWidgetUrl(w)) : '';
	const mediaUrl = rawMediaUrl ? rawMediaUrl + cacheParam : '';
	const chartUrl = isChart ? normalizeMediaUrl(chartWidgetUrl(w)) : '';
	const rawWebviewUrl = isWebview ? safeText(w?.label || '') : '';
	const themeMode = getThemeMode();
	const webviewUrl = rawWebviewUrl
		? (shouldBypassProxy(rawWebviewUrl)
			? appendModeParam(rawWebviewUrl, themeMode)
			: `/proxy?url=${encodeURIComponent(rawWebviewUrl)}&mode=${themeMode}`)
		: '';
	// Check for iframe config height override
	const iframeConfig = widgetIframeConfigMap.get(wKey);
	const iframeHeightOverride = iframeConfig?.height || 0;
	const webviewHeight = isWebview ? (iframeHeightOverride || parseInt(w?.height, 10) || 0) : 0;
	const rawVideoUrl = isVideo ? safeText(w?.label || '') : '';
	const videoUrl = rawVideoUrl ? `/proxy?url=${encodeURIComponent(rawVideoUrl)}&mode=${themeMode}` : '';
	const videoHeight = isVideo ? (iframeHeightOverride || parseInt(w?.height, 10) || 0) : 0;
	const chartHeight = isChart ? (iframeHeightOverride || parseInt(w?.height, 10) || 0) : 0;
	const mappingSig = mapping.map((m) => `${m.command}:${m.label}`).join('|');
	const path = Array.isArray(w?.__path) ? w.__path.join('>') : '';
	const frame = safeText(w?.__frame || '');
	// Get config values that affect rendering
	const cardWidthConfig = widgetCardWidthMap.get(wKey) || 'standard';
	const videoConfig = isVideo ? widgetVideoConfigMap.get(wKey) : null;
	const defaultMutedConfig = videoConfig ? String(videoConfig.defaultMuted) : '';
	const signature = [
		type,
		label,
		st,
		icon,
		itemName,
		pageLink || '',
		mappingSig,
		mediaUrl,
		chartUrl,
		String(chartHeight),
		webviewUrl,
		String(webviewHeight),
		videoUrl,
		String(videoHeight),
		safeText(w?.refresh ?? ''),
		state.isSlim ? 'slim' : '',
		state.headerMode === 'small' ? 'header-small' : '',
		state.headerMode === 'none' ? 'header-none' : '',
		path,
		frame,
		cardWidthConfig,
		defaultMutedConfig,
	].join('||');
	return {
		type,
		t,
		isImage,
		isChart,
		isText,
		isGroup,
		isWebview,
		isVideo,
		isSelection,
		label,
		st,
		icon,
		itemName,
		mapping,
		pageLink,
		labelParts,
		mediaUrl,
		chartUrl,
		chartHeight,
		webviewUrl,
		webviewHeight,
		videoUrl,
		videoHeight,
		rawVideoUrl,
		signature,
	};
}

function updateCard(card, w, info) {
	const data = info || getWidgetRenderInfo(w);
	if (!card) return false;

	const titleEl = card.querySelector('.title');
	const metaEl = card.querySelector('.meta');
	const labelRow = card.querySelector('.labelRow');
	const labelStack = card.querySelector('.labelStack');
	const navHint = card.querySelector('.navHint');
	const controls = card.querySelector('.controls');
	const row = card.querySelector('.cardRow');
	const iconWrap = card.querySelector('.iconWrap');
	const iconImg = iconWrap ? iconWrap.querySelector('img') : null;

	if (!titleEl || !metaEl || !labelRow || !labelStack || !navHint || !controls || !row) {
		return false;
	}

	const {
		t,
		isImage,
		isChart,
		isText,
		isGroup,
		isWebview,
		isVideo,
		isSelection,
		label,
		st,
		icon,
		itemName,
		mapping,
		pageLink,
		labelParts,
		mediaUrl,
		chartUrl,
		chartHeight,
		webviewUrl,
		webviewHeight,
		videoUrl,
		videoHeight,
		rawVideoUrl,
		signature,
	} = data;

	card.dataset.widgetKey = widgetKey(w);
	card.dataset.renderSig = signature;

	resetCardInteractions(card);
	card.removeAttribute('role');
	card.removeAttribute('tabindex');

	clearGlow(card);
	card.classList.remove(
		'nav-card',
		'selection-card',
		'switch-card',
		'slider-card',
		'image-card',
		'chart-card',
		'image-loading',
		'webview-card',
		'video-card',
		'menu-open',
		'cursor-pointer',
		'has-meta',
		'switch-many',
		'switch-single'
	);
	const cardWidth = widgetCardWidthMap.get(card.dataset.widgetKey);
	const cardWidthFull = cardWidth === 'full';
	const cardWidthStretch = cardWidth === 'stretch';
	card.classList.toggle('sm:col-span-2', isImage || isChart || isWebview || isVideo || cardWidthFull);
	card.classList.toggle('lg:col-span-3', isImage || isChart || isWebview || isVideo || cardWidthFull);
	card.classList.toggle('card-stretch', cardWidthStretch);
	// Reset webview/video inline styles
	card.style.padding = '';
	card.style.overflow = '';
	// Stop any active video stream to terminate FFmpeg process
	const existingVideo = card.querySelector('video.video-stream');
	if (existingVideo && existingVideo.src) {
		setVideoZoomReady(existingVideo, false);
		resetVideoZoom(existingVideo);
		existingVideo.src = '';
		existingVideo.load();
	}
	// Remove video container if switching to non-video widget
	if (!isVideo) {
		const existingContainer = card.querySelector('.video-container');
		if (existingContainer) existingContainer.remove();
	}

	row.classList.remove('items-center', 'hidden');
	row.classList.add('items-start');
	controls.classList.remove('hidden', 'mt-3');
	labelRow.classList.remove('hidden');
	if (iconWrap) iconWrap.classList.remove('hidden');
	navHint.classList.add('hidden');
	// Capture slider state before removal for smooth transition animation
	const isSliderType = t.includes('dimmer') || t.includes('roller') || t.includes('slider');
	const existingSliderWrap = isSliderType ? labelRow.querySelector('.inline-slider') : null;
	const existingSliderInput = existingSliderWrap ? existingSliderWrap.querySelector('input[type="range"]') : null;
	const previousSliderValue = existingSliderInput ? Number(existingSliderInput.value) : null;
	// If user is actively dragging the slider, preserve it entirely (don't interrupt drag)
	const sliderIsDragging = existingSliderWrap && existingSliderWrap.dataset.dragging === 'true';
	// Capture switch controls for smooth state transitions
	const isSwitchType = t.includes('switch') || t === 'switch';
	const existingSwitchControls = isSwitchType ? labelRow.querySelector('.inline-controls') : null;
	// Determine what to preserve
	let preserveElement = null;
	if (sliderIsDragging) preserveElement = existingSliderWrap;
	else if (existingSwitchControls) preserveElement = existingSwitchControls;
	resetLabelRow(labelRow, labelStack, navHint, preserveElement);
	removeOverlaySelects(card);

	if (!isImage && !isChart) {
		for (const child of Array.from(controls.children)) clearImageTimer(child);
		controls.innerHTML = '';
	} else {
		for (const child of Array.from(controls.children)) {
			if (!child.classList || (!child.classList.contains('card-image') && !child.classList.contains('chart-frame-container'))) {
				clearImageTimer(child);
				child.remove();
			}
		}
	}

	titleEl.textContent = labelParts.title;
	if (isText || isGroup) {
		crossfadeText(metaEl, labelParts.state);
	} else if (!isSelection && !isSwitchType) {
		// Don't show meta text for Selection/Switch - their controls already show the value
		metaEl.textContent = labelParts.state;
	}
	if (labelParts.state && !isSelection && !isSwitchType) card.classList.add('has-meta');
	// Apply glow from ohProxy rules
	const glowColor = getWidgetGlowOverride(widgetKey(w), labelParts.state || st);
	if (glowColor) {
		applyGlowStyle(card, glowColor);
	}

	if (isImage || isChart || isWebview || isVideo) {
		labelRow.classList.add('hidden');
		if (iconWrap) iconWrap.classList.add('hidden');
	} else {
		if (iconWrap) iconWrap.classList.remove('hidden');
		if (iconImg) {
			if (icon) {
				if (iconImg.dataset.iconKey !== icon) {
					iconImg.dataset.iconKey = icon;
					loadBestIcon(iconImg, iconCandidates(icon));
				}
			} else {
				// No icon defined - clear and hide
				iconImg.dataset.iconKey = '';
				iconImg.removeAttribute('src');
				iconImg.classList.remove('icon-ready');
			}
		}
	}

	if (pageLink && typeof pageLink === 'string' && pageLink.includes('/rest/sitemaps/')) {
		const target = ensureJsonParam(toRelativeRestLink(pageLink));
		card.classList.add('nav-card', 'cursor-pointer');
		navHint.classList.remove('hidden');
		row.classList.remove('items-start');
		row.classList.add('items-center');
		controls.classList.add('hidden');
		card.setAttribute('role', 'button');
		card.setAttribute('tabindex', '0');
		const go = () => { haptic(); pushPage(target, labelParts.title || label); };
		card.onclick = (e) => {
			if (e.target.closest('button, a, input, select, textarea')) return;
			go();
		};
		card.onkeydown = (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				go();
			}
		};
		return true;
	}

	if (isImage) {
		card.classList.add('image-card');
		if (!mediaUrl) {
			controls.classList.add('mt-3');
			controls.innerHTML = `<div class="text-sm text-slate-400">Image not available</div>`;
			card.classList.remove('image-loading');
			return true;
		}
		let imgEl = controls.querySelector('img.card-image');
		if (!imgEl) {
			imgEl = document.createElement('img');
			controls.appendChild(imgEl);
		}
		imgEl.className = 'card-image w-full rounded-xl border border-white/10 bg-white/5' + (state.isSlim ? '' : ' image-viewer-trigger');
		imgEl.onclick = state.isSlim ? null : (e) => {
			e.preventDefault();
			e.stopPropagation();
			openImageViewer(imgEl.dataset.mediaUrl || mediaUrl, w?.refresh);
		};

		const refreshKey = safeText(w?.refresh ?? '');
		const refreshChanged = imgEl.dataset.refreshMs !== refreshKey;
		if (refreshChanged) imgEl.dataset.refreshMs = refreshKey;

		const urlChanged = imgEl.dataset.mediaUrl !== mediaUrl;
		if (urlChanged) {
			imgEl.dataset.mediaUrl = mediaUrl;
			imgEl.dataset.loaded = '';
			card.classList.add('image-loading');
		} else if (imgEl.dataset.loaded !== 'true') {
			card.classList.add('image-loading');
		} else {
			card.classList.remove('image-loading');
		}
		if (urlChanged || refreshChanged || imgEl.dataset.loaded !== 'true') {
			setupImage(imgEl, mediaUrl, w?.refresh);
		}
		return true;
	}

	if (isChart) {
		card.classList.add('chart-card');
		if (!chartUrl) {
			controls.classList.add('mt-3');
			controls.innerHTML = `<div class="text-sm text-slate-400">Chart not available</div>`;
			return true;
		}
		// Use iframe for HTML charts with 16:9 aspect ratio (or custom height if configured)
		let frameContainer = controls.querySelector('.chart-frame-container');
		if (!frameContainer) {
			frameContainer = document.createElement('div');
			frameContainer.className = 'chart-frame-container';
			controls.appendChild(frameContainer);
		}
		// Apply height override if configured
		if (chartHeight > 0) {
			frameContainer.style.height = `${chartHeight}px`;
			frameContainer.style.aspectRatio = 'auto';
			frameContainer.style.paddingBottom = '0';
		} else {
			frameContainer.style.height = '';
			if (supportsAspectRatio) {
				frameContainer.style.aspectRatio = '16 / 9';
				frameContainer.style.paddingBottom = '';
			} else {
				// Fallback for older browsers (Chrome <88)
				frameContainer.style.aspectRatio = '';
				frameContainer.style.paddingBottom = '56.25%';
			}
		}
		let iframeEl = frameContainer.querySelector('iframe.chart-frame');
		if (!iframeEl) {
			iframeEl = document.createElement('iframe');
			iframeEl.className = 'chart-frame';
			iframeEl.setAttribute('frameborder', '0');
			iframeEl.setAttribute('scrolling', 'no');
			frameContainer.appendChild(iframeEl);
		}

		const fullUrl = '/' + chartUrl;
		const urlChanged = iframeEl.dataset.chartUrl !== fullUrl;
		if (urlChanged) {
			setChartIframeAnimState(iframeEl, fullUrl);
			iframeEl.dataset.chartUrl = fullUrl;
			iframeEl.src = fullUrl;
		}
		return true;
	}

	if (isWebview) {
		card.classList.add('webview-card');
		// Hide title and icon for webview cards
		labelRow.classList.add('hidden');
		if (iconWrap) iconWrap.classList.add('hidden');
		row.classList.add('hidden');
		if (!webviewUrl) {
			row.classList.remove('hidden');
			controls.classList.add('mt-3');
			controls.innerHTML = `<div class="text-sm text-slate-400">Webview URL not available</div>`;
			return true;
		}
		let frameContainer = card.querySelector('.webview-frame-container');
		if (!frameContainer) {
			frameContainer = document.createElement('div');
			frameContainer.className = 'webview-frame-container';
			card.appendChild(frameContainer);
		}
		let iframeEl = frameContainer.querySelector('iframe.webview-frame');
		if (!iframeEl) {
			iframeEl = document.createElement('iframe');
			iframeEl.className = 'webview-frame';
			iframeEl.setAttribute('frameborder', '0');
			iframeEl.setAttribute('allowfullscreen', 'true');
			frameContainer.appendChild(iframeEl);
		}
		card.style.padding = '0';
		card.style.overflow = 'hidden';
		// Height: if 0, use 16:9 aspect ratio; otherwise use specified height
		if (webviewHeight > 0) {
			frameContainer.style.height = `${webviewHeight}px`;
			frameContainer.style.aspectRatio = 'auto';
			frameContainer.style.paddingBottom = '0';
		} else {
			frameContainer.style.height = '';
			if (supportsAspectRatio) {
				frameContainer.style.aspectRatio = '16 / 9';
				frameContainer.style.paddingBottom = '';
			} else {
				frameContainer.style.aspectRatio = '';
				frameContainer.style.paddingBottom = '56.25%';
			}
		}
		const resolvedWebviewUrl = new URL(webviewUrl, location.href).href;
		if (iframeEl.src !== resolvedWebviewUrl) {
			iframeEl.src = webviewUrl;
		}
		return true;
	}

	if (isVideo) {
		card.classList.add('video-card');
		// Hide title and icon for video cards
		labelRow.classList.add('hidden');
		if (iconWrap) iconWrap.classList.add('hidden');
		row.classList.add('hidden');
		if (!videoUrl) {
			const staleContainer = card.querySelector('.video-container');
			if (staleContainer) {
				const staleVideo = staleContainer.querySelector('video.video-stream');
				if (staleVideo && staleVideo.src) {
					setVideoZoomReady(staleVideo, false);
					resetVideoZoom(staleVideo);
					staleVideo.src = '';
					staleVideo.load();
				}
				staleContainer.remove();
			}
			row.classList.remove('hidden');
			controls.classList.add('mt-3');
			controls.innerHTML = `<div class="text-sm text-slate-400">Video URL not available</div>`;
			return true;
		}
		card.style.padding = '0';
		card.style.overflow = 'hidden';

		// Get or create video container
		let videoContainer = card.querySelector('.video-container');
		if (!videoContainer) {
			videoContainer = document.createElement('div');
			videoContainer.className = 'video-container relative w-full rounded-2xl overflow-hidden';
			card.appendChild(videoContainer);
		}

		// Get or create preview placeholder with 50% opacity
		let previewDiv = videoContainer.querySelector('.video-preview');
		if (!previewDiv) {
			previewDiv = document.createElement('div');
			previewDiv.className = 'video-preview';
			previewDiv.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background-size:cover;background-position:center;opacity:0.75;z-index:10;';
			videoContainer.appendChild(previewDiv);
		}
		// Set preview background if RTSP URL available
		if (rawVideoUrl && rawVideoUrl.startsWith('rtsp://')) {
			const previewUrl = `/video-preview?url=${encodeURIComponent(rawVideoUrl)}`;
			previewDiv.style.backgroundImage = `url('${previewUrl}')`;
			previewDiv.classList.remove('hidden');
		} else {
			previewDiv.classList.add('hidden');
		}

		// Get or create spinner overlay
		let spinner = videoContainer.querySelector('.video-spinner');
		if (!spinner) {
			// Ensure spin keyframes exist
			if (!document.getElementById('video-spinner-keyframes')) {
				const style = document.createElement('style');
				style.id = 'video-spinner-keyframes';
				style.textContent = '@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
				document.head.appendChild(style);
			}
			spinner = document.createElement('div');
			spinner.className = 'video-spinner';
			spinner.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;z-index:12;display:flex;align-items:center;justify-content:center;';
			const spinnerInner = document.createElement('div');
			spinnerInner.className = 'video-spinner-ring';
			spinnerInner.style.cssText = 'width:3rem;height:3rem;border-radius:50%;animation:spin 1s linear infinite;';
			spinner.appendChild(spinnerInner);
			videoContainer.appendChild(spinner);
		}
		// Get or create zoom stage + video element
		let zoomStage = videoContainer.querySelector('.video-zoom-stage');
		if (!zoomStage) {
			zoomStage = document.createElement('div');
			zoomStage.className = 'video-zoom-stage';
			videoContainer.appendChild(zoomStage);
		}
		let videoEl = videoContainer.querySelector('video.video-stream');
		const isNewVideo = !videoEl;
		if (isNewVideo) {
			videoEl = document.createElement('video');
			videoEl.className = 'video-stream w-full block';
			videoEl.style.cssText = 'position:relative;z-index:15;';
			videoEl.setAttribute('autoplay', '');
			videoEl.setAttribute('playsinline', '');
			// Apply video config for muted state
			const videoConfig = widgetVideoConfigMap.get(widgetKey(w));
			const shouldMute = videoConfig?.defaultMuted !== false; // Default to muted
			if (shouldMute) {
				videoEl.setAttribute('muted', '');
			}
			videoEl.muted = shouldMute;
		}

		// Video z-15 covers preview z-10 and spinner z-12 when playing

		if (isNewVideo) {
			const disableVideoZoom = () => setVideoZoomReady(videoEl, false);
			videoEl.addEventListener('loadstart', disableVideoZoom);
			videoEl.addEventListener('waiting', disableVideoZoom);
			videoEl.addEventListener('stalled', disableVideoZoom);
			videoEl.addEventListener('pause', disableVideoZoom);
			videoEl.addEventListener('ended', disableVideoZoom);
			videoEl.addEventListener('emptied', disableVideoZoom);
			videoEl.addEventListener('abort', disableVideoZoom);
			videoEl.addEventListener('error', disableVideoZoom);

			// Auto-reconnect on error - aggressive retry
			videoEl.addEventListener('error', () => {
				const retry = () => {
					if (videosPausedForVisibility) return;
					if (videoEl.src && document.contains(videoEl)) {
						setVideoZoomReady(videoEl, false);
						resetVideoZoom(videoEl);
						const src = videoEl.src;
						videoEl.src = '';
						videoEl.src = src;
						videoEl.play().catch(() => {});
					}
				};
				setTimeout(retry, 1000);
			});
			// Auto-reconnect on stall/ended
			videoEl.addEventListener('stalled', () => {
				setTimeout(() => {
					if (videosPausedForVisibility) return;
					if (videoEl.src) {
						videoEl.play().catch(() => {});
					}
				}, 500);
			});
			videoEl.addEventListener('ended', () => {
				setTimeout(() => {
					if (videosPausedForVisibility) return;
					if (videoEl.src && document.contains(videoEl)) {
						setVideoZoomReady(videoEl, false);
						resetVideoZoom(videoEl);
						const src = videoEl.src;
						videoEl.src = '';
						videoEl.src = src;
						videoEl.play().catch(() => {});
					}
				}, 500);
			});
			// Periodic health check - retry if video is stuck
			const healthCheck = setInterval(() => {
				if (!document.contains(videoEl)) {
					clearInterval(healthCheck);
					return;
				}
				if (videosPausedForVisibility) return;
				if (videoEl.src && videoEl.paused && !videoEl.ended) {
					videoEl.play().catch(() => {
						setVideoZoomReady(videoEl, false);
						resetVideoZoom(videoEl);
						const src = videoEl.src;
						videoEl.src = '';
						videoEl.src = src;
						videoEl.play().catch(() => {});
					});
				}
			}, 3000);

			// Create mute/unmute button (hidden until video plays)
			const muteBtn = document.createElement('button');
			muteBtn.type = 'button';
			muteBtn.className = 'video-mute-btn';
			muteBtn.innerHTML = '<img src="icons/video-unmute.svg" alt="Unmute" />';
			muteBtn.title = 'Unmute';
			videoContainer.appendChild(muteBtn);

			const updateMuteBtn = () => {
				const isMuted = videoEl.muted;
				// Show action icon: unmute (green) when muted, mute (red) when playing sound
				muteBtn.innerHTML = isMuted
					? '<img src="icons/video-unmute.svg" alt="Unmute" />'
					: '<img src="icons/video-mute.svg" alt="Mute" />';
				muteBtn.title = isMuted ? 'Unmute' : 'Mute';
			};

			muteBtn.addEventListener('click', (e) => {
				haptic();
				e.stopPropagation();
				videoEl.muted = !videoEl.muted;
				updateMuteBtn();
			});

			// Set initial button state to match video muted state
			updateMuteBtn();

			// Show mute button when video starts playing
			videoEl.addEventListener('playing', () => {
				setVideoZoomReady(videoEl, true);
				muteBtn.style.opacity = '1';
				muteBtn.style.pointerEvents = 'auto';
			});

			// Create fullscreen button (hidden until video plays)
			const fsBtn = document.createElement('button');
			fsBtn.type = 'button';
			fsBtn.className = 'video-fullscreen-btn';
			fsBtn.innerHTML = '<img src="icons/video-fullscreen.svg" alt="Fullscreen" />';
			fsBtn.title = 'Fullscreen';
			videoContainer.appendChild(fsBtn);

			fsBtn.addEventListener('click', (e) => {
				haptic();
				e.stopPropagation();
				resetVideoZoom(videoEl);
				if (videoFullscreenActive) exitVideoFullscreen();
				else enterVideoFullscreen(videoEl, videoContainer);
			});

			// Show fullscreen button when video starts playing
			videoEl.addEventListener('playing', () => {
				setVideoZoomReady(videoEl, true);
				fsBtn.style.opacity = '1';
				fsBtn.style.pointerEvents = 'auto';
			});

		}
		if (videoEl.parentNode !== zoomStage) zoomStage.appendChild(videoEl);
		initVideoZoom(videoEl, zoomStage);
		setVideoZoomReady(videoEl, !videoEl.paused && !videoEl.ended);

		// Height: if 0, use 16:9 aspect ratio; otherwise use specified height
		if (videoHeight > 0) {
			videoContainer.style.height = `${videoHeight}px`;
			videoContainer.style.aspectRatio = '';
			zoomStage.style.height = '100%';
			videoEl.style.height = '100%';
			videoEl.style.aspectRatio = '';
		} else {
			videoContainer.style.height = '';
			videoContainer.style.aspectRatio = '16 / 9';
			zoomStage.style.height = '100%';
			videoEl.style.height = '';
			videoEl.style.aspectRatio = '';
		}
		// Append container width to URL for potential future transcoding
		// Defer to next frame so container has layout dimensions
		if (videoEl.dataset.baseUrl !== videoUrl) {
			videoEl.dataset.baseUrl = videoUrl;
			setVideoZoomReady(videoEl, false);
			resetVideoZoom(videoEl);
			requestAnimationFrame(() => {
				const containerWidth = videoContainer.offsetWidth || videoContainer.clientWidth || 640;
				const videoSrc = `${videoUrl}&w=${containerWidth}`;
				videoEl.src = videoSrc;
				videoEl.play().catch(() => {});
			});
		}
		return true;
	}

	if (!itemName) {
		if (!isText) {
			navHint.classList.add('hidden');
			controls.classList.add('mt-3');
			controls.innerHTML = `<div class="text-sm text-slate-400">No item bound</div>`;
		}
		return true;
	}

	navHint.classList.add('hidden');
	// Heuristic controls by widget/item type
	if (t.includes('selection')) {
		if (!mapping.length) {
			controls.classList.add('mt-3');
			controls.innerHTML = `<div class="text-sm text-slate-400">No selection options available</div>`;
		} else {
			// Slim/small-header/small-touch use native overlay; all others use custom dropdown
			const isSmallTouch = window.matchMedia('(max-width: 768px)').matches &&
				('ontouchstart' in window || navigator.maxTouchPoints > 0);
			const useOverlay = state.isSlim || state.headerMode === 'small' || isSmallTouch;
			const inlineControls = document.createElement('div');
			inlineControls.className = 'inline-controls flex items-center gap-2 flex-1 min-w-0';
			card.classList.add('selection-card');
			if (navHint && navHint.parentElement === labelRow) {
				labelRow.insertBefore(inlineControls, navHint);
			} else {
				labelRow.appendChild(inlineControls);
			}

			const selectWrap = document.createElement('div');
			selectWrap.className = 'select-wrap';
			inlineControls.appendChild(selectWrap);

			const select = document.createElement('select');
			select.className = 'oh-select';

			for (const m of mapping) {
				const opt = document.createElement('option');
				opt.value = m.command;
				opt.textContent = m.label || m.command;
				select.appendChild(opt);
			}

			const current = mapping.find(m => safeText(m.command) === safeText(st));
			select.value = current ? current.command : '';
			const currentLabel = current ? (current.label || current.command) : safeText(st);

			const releaseRefresh = () => {
				state.suppressRefreshCount = Math.max(0, state.suppressRefreshCount - 1);
				if (state.pendingRefresh) {
					state.pendingRefresh = false;
					refresh(false);
				}
			};

			let sending = false;
			const sendSelection = async (command, disableEl) => {
				if (!command || safeText(command) === safeText(widgetState(w)) || sending) return false;
				sending = true;
				if (disableEl) disableEl.disabled = true;
				try { await sendCommand(itemName, command); await refresh(false); return true; }
				catch (e) {
					logJsError(`sendSelection failed for ${itemName}`, e);
					alert(e.message);
					return false;
				}
				finally {
					if (disableEl) disableEl.disabled = false;
					sending = false;
				}
			};

			card.classList.add('cursor-pointer');
			if (useOverlay) {
				const fakeSelect = document.createElement('div');
				fakeSelect.className = 'fake-select';
				const syncFake = () => {
					const opt = select.options[select.selectedIndex];
					fakeSelect.textContent = opt ? opt.textContent : currentLabel;
				};
				syncFake();
				let released = false;
				select.onfocus = () => {
					state.suppressRefreshCount += 1;
					released = false;
				};
				select.onblur = () => {
					if (!released) releaseRefresh();
				};
				select.onclick = () => haptic();
				select.onchange = async () => {
					haptic();
					const prevValue = st;
					released = true;
					try {
						const ok = await sendSelection(select.value, select);
						if (ok) { syncFake(); }
						else { select.value = prevValue; syncFake(); }
					} finally {
						releaseRefresh();
					}
				};
				selectWrap.appendChild(fakeSelect);
				select.classList.add('select-overlay');
				card.appendChild(select);
			} else {
				const fakeSelect = document.createElement('button');
				fakeSelect.type = 'button';
				fakeSelect.className = 'fake-select';
				fakeSelect.textContent = currentLabel || safeText(select.value);

				const menu = document.createElement('div');
				menu.className = 'select-menu';
				const optionButtons = [];
				const needsScroll = mapping.length > 5;
				let scrollInner = null;

				if (needsScroll) {
					menu.classList.add('scrollable');
					scrollInner = document.createElement('div');
					scrollInner.className = 'select-menu-scroll';
					menu.appendChild(scrollInner);
				}

				const setActive = (command) => {
					for (const btn of optionButtons) {
						btn.classList.toggle('active', safeText(btn.dataset.command) === safeText(command));
					}
				};

				for (const m of mapping) {
					const optBtn = document.createElement('button');
					optBtn.type = 'button';
					optBtn.className = 'select-option';
					optBtn.textContent = m.label || m.command;
					optBtn.dataset.command = m.command;
					optBtn.onclick = async (e) => {
						haptic();
						e.preventDefault();
						e.stopPropagation();
						if (safeText(m.command) === safeText(widgetState(w))) {
							closeMenu();
							return;
						}
						const ok = await sendSelection(m.command);
						if (ok) {
							fakeSelect.textContent = m.label || m.command;
							setActive(m.command);
						}
						closeMenu();
					};
					(scrollInner || menu).appendChild(optBtn);
					optionButtons.push(optBtn);
				}

				setActive(current ? current.command : '');

				let menuOpen = false;
				let scrollHeightSet = false;
				let docClickController = null;
				const onDocClick = (e) => {
					if (!card.contains(e.target)) closeMenu();
				};

				const addDocClickListener = () => {
					if (docClickController) docClickController.abort();
					docClickController = new AbortController();
					document.addEventListener('click', onDocClick, { capture: true, signal: docClickController.signal });
				};

				const removeDocClickListener = () => {
					if (!docClickController) return;
					docClickController.abort();
					docClickController = null;
				};

				const openMenu = () => {
					if (menuOpen) return;
					menuOpen = true;
					card.classList.add('menu-open');
					state.suppressRefreshCount += 1;
					addDocClickListener();
					// Decide whether to show menu above or below
					requestAnimationFrame(() => {
						const btnRect = fakeSelect.getBoundingClientRect();
						const menuHeight = menu.offsetHeight;
						const spaceBelow = window.innerHeight - btnRect.bottom - 10;
						const spaceAbove = btnRect.top - 10;
						if (spaceBelow < menuHeight && spaceAbove > spaceBelow) {
							card.classList.add('menu-above');
						} else {
							card.classList.remove('menu-above');
						}
					});
					// Calculate scroll dimensions on first open based on actual sizes
					if (!scrollHeightSet && scrollInner && optionButtons.length > 1) {
						scrollHeightSet = true;
						requestAnimationFrame(() => {
							const btn = optionButtons[0];
							const btnHeight = btn.offsetHeight;
							const btn2Style = getComputedStyle(optionButtons[1]);
							const btnMargin = parseFloat(btn2Style.marginTop || 0);
							// 5 buttons + 5 margins
							scrollInner.style.maxHeight = `${(btnHeight * 5) + (btnMargin * 5)}px`;
							// Width: fakeSelect width + scroll padding + scrollbar + menu padding
							const scrollStyle = getComputedStyle(scrollInner);
							const scrollPadding = parseFloat(scrollStyle.paddingRight || 0);
							const scrollbarWidth = scrollInner.offsetWidth - scrollInner.clientWidth;
							const menuStyle = getComputedStyle(menu);
							const menuPadding = parseFloat(menuStyle.paddingLeft || 0) + parseFloat(menuStyle.paddingRight || 0);
							menu.style.minWidth = `${fakeSelect.offsetWidth + scrollPadding + scrollbarWidth + menuPadding}px`;
						});
					}
				};

				const closeMenu = () => {
					if (!menuOpen) return;
					menuOpen = false;
					card.classList.remove('menu-open', 'menu-above');
					removeDocClickListener();
					releaseRefresh();
				};

				const toggleMenu = () => {
					haptic();
					if (menuOpen) closeMenu();
					else openMenu();
				};

				fakeSelect.onclick = (e) => {
					e.preventDefault();
					e.stopPropagation();
					toggleMenu();
				};

				card.onclick = (e) => {
					if (e.target.closest('.select-menu')) return;
					if (e.target.closest('button, a, input, select, textarea')) return;
					toggleMenu();
				};

				registerCardCleanup(card, closeMenu);
				selectWrap.appendChild(fakeSelect);
				selectWrap.appendChild(menu);
			}
		}
	} else if (t.includes('switch') || t === 'switch') {
		card.classList.add('switch-card');
		const currentState = safeText(st);
		const switchButtonCount = mapping.length ? mapping.length : 1;
		if (switchButtonCount >= 3) card.classList.add('switch-many');
		if (switchButtonCount === 1) card.classList.add('switch-single');

		// Check if we can reuse existing switch controls for smooth transitions
		const existingButtons = existingSwitchControls ? existingSwitchControls.querySelectorAll('.switch-btn') : null;
		const canReuse = existingButtons && existingButtons.length === switchButtonCount;

		if (canReuse) {
			// Reuse existing controls - update text, command, and is-active class
			if (mapping.length) {
				let i = 0;
				for (const btn of existingButtons) {
					const m = mapping[i++];
					if (m) {
						btn.textContent = m.label || m.command;
						btn.dataset.command = m.command;
						const shouldBeActive = safeText(m.command) === currentState;
						btn.classList.toggle('is-active', shouldBeActive);
						// Update onclick with current command (closure would have stale value)
						const cmd = m.command;
						btn.onclick = async () => {
							haptic();
							btn.disabled = true;
							try { await sendCommand(itemName, cmd); await refresh(false); }
							catch (e) {
								logJsError(`sendSwitchCommand failed for ${itemName}`, e);
								alert(e.message);
							}
							finally { btn.disabled = false; }
						};
					}
				}
				if (existingButtons.length === 1) {
					card.classList.add('cursor-pointer');
					card.onclick = (e) => {
						if (e.target.closest('button, a, input, select, textarea')) return;
						const btn = existingButtons[0];
						if (btn && !btn.disabled) btn.click();
					};
				}
			} else {
				// Single ON/OFF switch - update class, text, and click handler
				const isOn = st.toUpperCase() === 'ON';
				const btn = existingButtons[0];
				btn.classList.toggle('is-active', isOn);
				btn.textContent = isOn ? 'Turn OFF' : 'Turn ON';
				// Update onclick with current state (closure would have stale value)
				btn.onclick = async () => {
					haptic();
					btn.disabled = true;
					try { await sendCommand(itemName, isOn ? 'OFF' : 'ON'); await refresh(false); }
					catch (e) {
						logJsError(`sendSwitchCommand failed for ${itemName}`, e);
						alert(e.message);
					}
					finally { btn.disabled = false; }
				};
				// Ensure card click handler is set for single switch
				card.classList.add('cursor-pointer');
				card.onclick = (e) => {
					if (e.target.closest('button, a, input, select, textarea')) return;
					if (btn && !btn.disabled) btn.click();
				};
			}
			return true;
		}

		// No existing controls or count mismatch - create new
		if (existingSwitchControls) existingSwitchControls.remove();

		const inlineControls = document.createElement('div');
		inlineControls.className = 'inline-controls flex items-center gap-2 flex-1 min-w-0';
		if (navHint && navHint.parentElement === labelRow) {
			labelRow.insertBefore(inlineControls, navHint);
		} else {
			labelRow.appendChild(inlineControls);
		}

		if (mapping.length) {
			const btnClass = 'switch-btn';

			for (const m of mapping) {
				const b = document.createElement('button');
				b.className = btnClass;
				b.textContent = m.label || m.command;
				b.dataset.command = m.command;
				if (safeText(m.command) === currentState) b.classList.add('is-active');
				b.onclick = async () => {
					haptic();
					b.disabled = true;
					try { await sendCommand(itemName, m.command); await refresh(false); }
					catch (e) {
						logJsError(`sendSwitchCommand failed for ${itemName}`, e);
						alert(e.message);
					}
					finally { b.disabled = false; }
				};
				inlineControls.appendChild(b);
			}
		} else {
			const isOn = st.toUpperCase() === 'ON';
			const btn = document.createElement('button');
			btn.className = 'switch-btn';
			btn.textContent = isOn ? 'Turn OFF' : 'Turn ON';
			if (isOn) btn.classList.add('is-active');
			btn.onclick = async () => {
				haptic();
				btn.disabled = true;
				try { await sendCommand(itemName, isOn ? 'OFF' : 'ON'); await refresh(false); }
				catch (e) {
					logJsError(`sendSwitchCommand failed for ${itemName}`, e);
					alert(e.message);
				}
				finally { btn.disabled = false; }
			};
			inlineControls.appendChild(btn);
		}

		if (inlineControls.children.length === 1) {
			const clickButton = () => {
				const btn = inlineControls.querySelector('button');
				if (btn && !btn.disabled) btn.click();
			};
			card.classList.add('cursor-pointer');
			card.onclick = (e) => {
				if (e.target.closest('button, a, input, select, textarea')) return;
				clickButton();
			};
		}
	} else if (t.includes('dimmer') || t.includes('roller') || t.includes('slider')) {
		// If user is actively dragging, skip recreation entirely to preserve drag
		if (sliderIsDragging) {
			card.classList.add('slider-card');
			return true;
		}

		const sliderMin = Number.isFinite(Number(w?.minValue)) ? Number(w.minValue) : 0;
		const sliderMax = Number.isFinite(Number(w?.maxValue)) ? Number(w.maxValue) : 100;
		const sliderStep = Number.isFinite(Number(w?.step)) && Number(w.step) > 0 ? Number(w.step) : 1;
		const val = parseFloat(st);
		const current = Number.isFinite(val) ? Math.max(sliderMin, Math.min(sliderMax, val)) : sliderMin;

		const inlineSlider = document.createElement('div');
		inlineSlider.className = 'inline-slider flex items-center min-w-0';
		card.classList.add('slider-card');
		if (navHint && navHint.parentElement === labelRow) {
			labelRow.insertBefore(inlineSlider, navHint);
		} else {
			labelRow.appendChild(inlineSlider);
		}

		const input = document.createElement('input');
		input.type = 'range';
		input.min = String(sliderMin);
		input.max = String(sliderMax);
		input.step = String(sliderStep);
		// Start at previous value if available (for smooth animation), otherwise use current
		const startValue = (previousSliderValue !== null && Number.isFinite(previousSliderValue))
			? previousSliderValue : current;
		input.value = String(startValue);
		input.className = 'w-full';

		let sliderHeld = false;
		const releaseSliderRefresh = () => {
			if (!sliderHeld) return;
			sliderHeld = false;
			state.suppressRefreshCount = Math.max(0, state.suppressRefreshCount - 1);
			if (state.pendingRefresh) {
				state.pendingRefresh = false;
				refresh(false);
			}
		};

		const holdSliderRefresh = () => {
			if (sliderHeld) return;
			sliderHeld = true;
			state.suppressRefreshCount += 1;
		};

		const ACTIVATION_TIMEOUT_MS = 800;
		const ACTIVATION_CHECK_MS = 80;
		const isDimmer = t.includes('dimmer');
		const startedOff = isDimmer && (!Number.isFinite(val) || val <= 0);
		let activationPending = false;
		let activationValue = null;
		let activationPendingValue = null;
		let activationStartedAt = 0;
		let activationTimer = null;
		let lastSentValue = current;
		let lastSentAt = 0;
		let pendingValue = null;
		let pendingOptions = null;
		let sendTimer = null;

		const sendValue = async (value, options = {}) => {
			const optimistic = options.optimistic !== false;
			const force = options.force === true;
			if (!force && value === lastSentValue) return;
			lastSentValue = value;
			lastSentAt = Date.now();
			try { await sendCommand(itemName, String(value), { optimistic }); }
			catch (e) {
				lastSentValue = null;
				logJsError(`sendSliderValue failed for ${itemName}`, e);
				console.error(e);
			}
		};

		const queueSend = (value, immediate, options = {}) => {
			pendingValue = value;
			pendingOptions = options;
			if (sendTimer) return;
			const now = Date.now();
			const delay = immediate ? 0 : Math.max(0, SLIDER_DEBOUNCE_MS - (now - lastSentAt));
			sendTimer = setTimeout(() => {
				sendTimer = null;
				const next = pendingValue;
				const opts = pendingOptions || {};
				pendingValue = null;
				pendingOptions = null;
				if (next === null) return;
				void sendValue(next, opts);
			}, delay);
		};

		const flushSend = () => {
			if (sendTimer) {
				clearTimeout(sendTimer);
				sendTimer = null;
			}
			const next = pendingValue;
			const opts = pendingOptions || {};
			pendingValue = null;
			pendingOptions = null;
			if (next === null) return;
			void sendValue(next, opts);
		};

		const clearActivationTimer = () => {
			if (activationTimer) {
				clearTimeout(activationTimer);
				activationTimer = null;
			}
		};

		const finishActivation = () => {
			if (!activationPending) return;
			activationPending = false;
			clearActivationTimer();
			if (activationPendingValue != null && activationPendingValue !== activationValue) {
				queueSend(activationPendingValue, true, { force: true });
			}
			activationPendingValue = null;
			activationValue = null;
		};

		const checkActivation = () => {
			if (!activationPending) return;
			const live = parseFloat(widgetState(w));
			const isOn = Number.isFinite(live) && live > 0;
			if (isOn || (Date.now() - activationStartedAt) > ACTIVATION_TIMEOUT_MS) {
				finishActivation();
				return;
			}
			activationTimer = setTimeout(checkActivation, ACTIVATION_CHECK_MS);
		};

		const beginActivation = (value) => {
			if (activationPending) {
				activationPendingValue = value;
				return;
			}
			haptic();
			activationPending = true;
			activationValue = value;
			activationPendingValue = value;
			activationStartedAt = Date.now();
			void sendValue(value, { optimistic: false, force: true });
			if (!activationTimer) activationTimer = setTimeout(checkActivation, ACTIVATION_CHECK_MS);
		};

		input.addEventListener('input', () => {
			const value = Number(input.value);
			if (!Number.isFinite(value)) return;
			if (activationPending) {
				activationPendingValue = value;
				return;
			}
			if (isDimmer) {
				const live = parseFloat(widgetState(w));
				const isOff = Number.isFinite(live) ? live <= 0 : startedOff;
				if (isOff && value > 0) {
					beginActivation(value);
					return;
				}
			}
			// Haptic when turning off (going to min from above min)
			if (value === sliderMin && lastSentValue > sliderMin) haptic();
			queueSend(value, false);
		});
		input.addEventListener('change', () => {
			flushSend();
			releaseSliderRefresh();
			// Refresh after slider change to pick up visibility changes in sitemap
			setTimeout(() => refresh(false), 150);
		});
		const startDrag = () => {
			holdSliderRefresh();
			inlineSlider.dataset.dragging = 'true';
		};
		const endDrag = () => {
			releaseSliderRefresh();
			delete inlineSlider.dataset.dragging;
		};
		input.addEventListener('pointerdown', startDrag);
		input.addEventListener('pointerup', endDrag);
		input.addEventListener('pointercancel', endDrag);
		input.addEventListener('touchstart', startDrag, { passive: true });
		input.addEventListener('touchend', endDrag, { passive: true });
		input.addEventListener('touchcancel', endDrag, { passive: true });
		input.addEventListener('mousedown', startDrag);
		input.addEventListener('mouseup', endDrag);
		input.addEventListener('blur', endDrag);

		const valueBubble = document.createElement('span');
		valueBubble.className = 'slider-bubble';
		valueBubble.textContent = current;
		inlineSlider.appendChild(input);
		inlineSlider.appendChild(valueBubble);

		// Position bubble above thumb (account for thumb width ~16px)
		const positionBubble = () => {
			const val = Number(input.value);
			const min = Number(input.min) || 0;
			const max = Number(input.max) || 100;
			const pct = (val - min) / (max - min);
			const thumbWidth = 16;
			const trackWidth = input.offsetWidth - thumbWidth;
			const offset = thumbWidth / 2 + pct * trackWidth;
			valueBubble.style.left = offset + 'px';
		};
		// Defer initial positioning until element is rendered
		requestAnimationFrame(positionBubble);

		// Update label and position when slider value changes
		input.addEventListener('input', () => {
			valueBubble.textContent = input.value;
			positionBubble();
		});

		// Animate slider from previous value to current value
		if (startValue !== current) {
			animateSliderValue(input, current, valueBubble, positionBubble);
		}

		const toggleSlider = async () => {
			haptic();
			const next = current > sliderMin ? sliderMin : sliderMax;
			try { await sendCommand(itemName, String(next)); await refresh(false); }
			catch (e) {
				logJsError(`toggleSlider failed for ${itemName}`, e);
				alert(e.message);
			}
		};
		card.classList.add('cursor-pointer');
		card.onclick = (e) => {
			if (e.target.closest('button, a, input, select, textarea')) return;
			haptic();
			toggleSlider();
		};

		// Extra buttons for rollershutter-like controls
		if (t.includes('roller') || t.includes('rollershutter')) {
			const btns = document.createElement('div');
			btns.className = 'grid grid-cols-3 gap-2';
			for (const [txt, cmd] of [['Up','UP'], ['Stop','STOP'], ['Down','DOWN']]) {
				const b = document.createElement('button');
				b.className = 'px-3 py-2 rounded-xl border transition bg-emerald-500/15 border-emerald-400/30 hover:bg-emerald-500/20';
				b.textContent = txt;
				b.onclick = async () => {
					haptic();
					b.disabled = true;
					try { await sendCommand(itemName, cmd); await refresh(false); }
					catch (e) {
						logJsError(`sendRollerCommand failed for ${itemName}`, e);
						alert(e.message);
					}
					finally { b.disabled = false; }
				};
				btns.appendChild(b);
			}
			controls.classList.add('mt-3');
			controls.appendChild(btns);
		}
	} else {
		if (!labelParts.state) {
			controls.classList.add('mt-3');
			controls.innerHTML = `
				<div class="stateValue text-sm text-slate-300 font-semibold break-words overflow-hidden">${escapeHtml(st) || '—'}</div>
			`;
		} else {
			controls.innerHTML = '';
		}
	}

	return true;
}

function buildCard(w) {
	const card = createCardElement();
	updateCard(card, w);
	return card;
}

function patchWidgets(widgets, nodes) {
	for (let i = 0; i < widgets.length; i += 1) {
		const w = widgets[i];
		const node = nodes[i];
		if (w?.__section) {
			if (node.textContent !== w.label) node.textContent = w.label;
			continue;
		}
		const info = getWidgetRenderInfo(w);
		if (node && node.dataset.renderSig !== info.signature) {
			if (!updateCard(node, w, info)) {
				const card = buildCard(w);
				node.replaceWith(card);
			}
		}
	}
}

function render() {
	const q = state.filter.trim().toLowerCase();
	const rawSource = q ? (state.searchWidgets || state.rawWidgets) : state.rawWidgets;

	// Filter by visibility - sections can be hidden, and their children follow
	const source = [];
	let currentSectionHidden = false;
	for (const w of rawSource) {
		if (w?.__section) {
			const visible = isWidgetVisible(w);
			currentSectionHidden = !visible;
			if (visible) source.push(w);
		} else {
			if (!currentSectionHidden && isWidgetVisible(w)) source.push(w);
		}
	}

	const matches = source.filter(w => {
		if (!q) return true;
		const hay = `${widgetLabel(w)} ${widgetState(w)} ${widgetType(w)} ${w?.item?.name || ''}`.toLowerCase();
		return hay.includes(q);
	});

	let widgets = matches;
	if (q) {
		const frameKeys = new Set();
		for (const f of state.searchFrames || []) {
			const frameLabel = safeText(f?.label || '');
			if (!frameLabel) continue;
			if (!frameLabel.toLowerCase().includes(q)) continue;
			frameKeys.add(frameKeyFor(f.path, frameLabel));
		}

		const extra = [];
		if (frameKeys.size && Array.isArray(state.searchWidgets)) {
			for (const w of state.searchWidgets) {
				const key = frameKeyFor(w?.__path, w?.__frame);
				if (frameKeys.has(key) && isWidgetVisible(w)) extra.push(w);
			}
		}

		const unique = new Map();
		for (const w of matches.concat(extra)) {
			unique.set(searchWidgetKey(w), w);
		}
		const combined = Array.from(unique.values());

		const groups = new Map();
		const order = [];
		for (const w of combined) {
			const label = searchGroupLabel(w);
			if (!groups.has(label)) {
				groups.set(label, []);
				order.push(label);
			}
			groups.get(label).push(w);
		}
		const frameMatches = [];
		for (const f of state.searchFrames || []) {
			const frameLabel = safeText(f?.label || '');
			if (!frameLabel) continue;
			if (!frameLabel.toLowerCase().includes(q)) continue;
			const groupLabel = searchGroupLabel({ __path: f.path, __frame: frameLabel });
			frameMatches.push(groupLabel);
		}
		for (const label of frameMatches) {
			if (!groups.has(label)) {
				groups.set(label, []);
				order.push(label);
			}
		}
		const grouped = [];
		for (const label of order) {
			grouped.push({ __section: true, label });
			grouped.push(...groups.get(label));
		}
		widgets = grouped;
		widgets._matchCount = combined.length;
	}

	const siteName = CLIENT_CONFIG.siteName || state.rootPageTitle || state.pageTitle || 'openHAB';
	const isRoot = state.rootPageUrl && state.pageUrl && state.rootPageUrl === state.pageUrl;
	const pageLabel = isRoot ? 'Home' : (state.pageTitle || siteName);
	const pageParts = splitLabelState(pageLabel);
	const pageTitleText = `${siteName} · ${pageParts.title || pageLabel}`;
	if (els.title) {
		els.title.innerHTML = '';
		const siteSpan = document.createElement('span');
		siteSpan.className = 'font-semibold';
		siteSpan.textContent = siteName;
		els.title.appendChild(siteSpan);

		const pageSpan = document.createElement('span');
		pageSpan.className = 'font-light text-slate-300';
		pageSpan.textContent = ` · ${pageParts.title || pageLabel}`;
		els.title.appendChild(pageSpan);

	}
	document.title = pageTitleText;

	const nodes = Array.from(els.grid.children);
	const canPatch = nodes.length === widgets.length && widgets.every((w, i) => {
		const node = nodes[i];
		if (!node) return false;
		if (w?.__section) return node.dataset.section === w.label;
		return node.dataset.widgetKey === widgetKey(w);
	});

	if (canPatch) {
		patchWidgets(widgets, nodes);
	} else {
		nodes.forEach(runCardCleanups);
		clearImageTimers();
		const fragment = document.createDocumentFragment();
		for (const w of widgets) {
			if (w?.__section) {
				const header = document.createElement('div');
				header.className = 'sm:col-span-2 lg:col-span-3 mt-0 text-xs uppercase tracking-widest text-slate-400 section-header';
				header.textContent = w.label;
				header.dataset.section = w.label;
				header.addEventListener('click', (e) => {
					if ((e.ctrlKey || e.metaKey) && getUserRole() === 'admin') {
						e.preventDefault();
						openCardConfigModal(w, header);
					}
				});
				fragment.appendChild(header);
				continue;
			}

			const card = buildCard(w);
			fragment.appendChild(card);
		}
		els.grid.innerHTML = '';
		els.grid.appendChild(fragment);
	}

	if (q && !state.searchIndexReady) {
		setStatus('Indexing…');
	} else if (q) {
		const count = widgets._matchCount ?? matches.length;
		setStatus(count ? '' : 'No matching items found');
	} else {
		setStatus('');
	}

	if (q && state.searchIndexReady) {
		refreshSearchStates(widgets).then((updated) => {
			if (updated) render();
		});
	}

	// Recalculate stretch card spans after grid is populated
	recalculateStretchCards();
}

// --- Navigation / Data ---
function updateNavButtons() {
	const hasSearch = !!state.filter.trim();
	els.back.disabled = (state.stack.length === 0 && !hasSearch) || !state.connectionOk;
	els.home.disabled = !state.rootPageUrl || (!hasSearch && state.pageUrl === state.rootPageUrl) || !state.connectionOk;
	if (els.voice) els.voice.disabled = !state.connectionOk;
}

function clearSearchFilter() {
	if (!state.filter.trim()) return false;
	state.filter = '';
	if (els.search) els.search.value = '';
	state.searchStateToken += 1;
	cancelSearchStateRequests();
	if (searchDebounceTimer) {
		clearTimeout(searchDebounceTimer);
		searchDebounceTimer = null;
	}
	updateNavButtons();
	render();
	return true;
}

function syncHistory(replace) {
	if (!state.pageUrl || !window.history) return;
	const payload = {
		pageUrl: state.pageUrl,
		pageTitle: state.pageTitle,
		stack: state.stack,
	};
	const historyUrl = window.location.pathname + window.location.search + window.location.hash;
	if (replace) {
		history.replaceState(payload, '', historyUrl);
	} else {
		history.pushState(payload, '', historyUrl);
	}
}

async function pushPage(pageUrl, pageTitle) {
	// Block navigation when offline
	if (!state.connectionOk) return;
	if (state.filter.trim()) {
		state.filter = '';
		if (els.search) els.search.value = '';
	}
	if (state.pageUrl) state.stack.push({ pageUrl: state.pageUrl, pageTitle: state.pageTitle });
	state.pageUrl = ensureJsonParam(toRelativeRestLink(pageUrl));
	state.pageTitle = pageTitle || 'openHAB';
	resetChartAnimState();
	updateNavButtons();
	syncHistory(false);
	queueScrollTop();
	state.suppressRefreshCount += 1;
	try {
		await refresh(true);
	} finally {
		state.suppressRefreshCount = Math.max(0, state.suppressRefreshCount - 1);
	}
}

function popPage() {
	if (!state.stack.length) return;
	history.back();
}

async function loadDefaultSitemap() {
	// Get list of sitemaps in JSON mode
	const data = await fetchJson('rest/sitemaps?type=json');

	// Try common shapes
	let sitemaps = [];
	if (Array.isArray(data)) sitemaps = data;
	else if (Array.isArray(data?.sitemaps)) sitemaps = data.sitemaps;
	else if (Array.isArray(data?.sitemaps?.sitemap)) sitemaps = data.sitemaps.sitemap;
	else if (Array.isArray(data?.sitemap)) sitemaps = data.sitemap;
	else if (data?.sitemap && typeof data.sitemap === 'object') sitemaps = [data.sitemap];
	else if (data?.sitemaps && typeof data.sitemaps === 'object') sitemaps = [data.sitemaps];

	const first = Array.isArray(sitemaps) ? sitemaps[0] : null;
	const name = first?.name || first?.id || first?.homepage?.link?.split('/').pop();

	if (!name) {
		throw new Error('Could not determine sitemap name. Check /rest/sitemaps?type=json output.');
	}
	state.sitemapName = name;
	state.ohOrigin = null;
	try {
		const originSource = first?.link || first?.homepage?.link;
		if (originSource) state.ohOrigin = new URL(originSource).origin;
	} catch (err) {
		logJsError('loadDefaultSitemap origin parse failed', err);
		state.ohOrigin = null;
	}

	const nameEnc = encodeURIComponent(name);
	let pageLink = first?.homepage?.link;
	if (!pageLink && typeof first?.link === 'string') {
		const rel = toRelativeRestLink(first.link);
		if (rel.includes('/rest/sitemaps/')) {
			pageLink = rel.endsWith(`/${nameEnc}`) ? rel : `${rel.replace(/\/$/, '')}/${nameEnc}`;
		} else {
			pageLink = rel;
		}
	}
	if (!pageLink) pageLink = `rest/sitemaps/${nameEnc}/${nameEnc}`;

	state.pageUrl = ensureJsonParam(toRelativeRestLink(pageLink));
	state.pageTitle = first?.label || first?.title || name;
	state.rootPageUrl = state.pageUrl;
	state.rootPageTitle = state.pageTitle;
}

async function fetchSearchIndexAggregate() {
	const params = new URLSearchParams();
	if (state.rootPageUrl) params.set('root', state.rootPageUrl);
	if (state.sitemapName) params.set('sitemap', state.sitemapName);
	if (!params.toString()) return null;
	const data = await fetchJson(`search-index?${params.toString()}`);
	if (!data || !Array.isArray(data.widgets)) return null;
	return {
		widgets: data.widgets,
		frames: Array.isArray(data.frames) ? data.frames : [],
	};
}

function resetSitemapCacheRetry() {
	sitemapCacheRetryMs = SITEMAP_CACHE_RETRY_BASE_MS;
	if (sitemapCacheRetryTimer) {
		clearTimeout(sitemapCacheRetryTimer);
		sitemapCacheRetryTimer = null;
	}
}

function scheduleSitemapCacheRetry() {
	if (sitemapCacheRetryTimer || state.sitemapCacheReady) return;
	const delay = sitemapCacheRetryMs;
	sitemapCacheRetryMs = Math.min(sitemapCacheRetryMs * 2, SITEMAP_CACHE_RETRY_MAX_MS);
	sitemapCacheRetryTimer = setTimeout(() => {
		sitemapCacheRetryTimer = null;
		if (!state.connectionOk || state.sitemapCacheReady) return;
		fetchFullSitemap();
	}, delay);
}

async function fetchFullSitemap() {
	if (state.sitemapCacheReady) return true;
	if (sitemapCacheInFlight) return false;
	const params = new URLSearchParams();
	if (state.rootPageUrl) params.set('root', state.rootPageUrl);
	if (state.sitemapName) params.set('sitemap', state.sitemapName);
	if (!params.toString()) return false;
	sitemapCacheInFlight = true;
	try {
		const data = await fetchJson(`sitemap-full?${params.toString()}`);
		if (!data || !data.pages) {
			throw new Error('Invalid sitemap cache response');
		}
		state.sitemapCache.clear();
		for (const [url, page] of Object.entries(data.pages)) {
			state.sitemapCache.set(url, page);
		}
		state.sitemapCacheReady = true;
		resetSitemapCacheRetry();
		return true;
	} catch (err) {
		logJsError('fetchFullSitemap failed', err);
		if (!state.sitemapCacheReady && state.connectionOk) {
			scheduleSitemapCacheRetry();
		}
		return false;
	} finally {
		sitemapCacheInFlight = false;
	}
}

function getPageFromCache(url) {
	let key = ensureJsonParam(toRelativeRestLink(url));
	// Normalize: ensure leading slash to match server cache keys
	if (key && !key.startsWith('/')) key = '/' + key;
	return state.sitemapCache.get(key) || null;
}

function updatePageInCache(url, page) {
	let key = ensureJsonParam(toRelativeRestLink(url));
	// Normalize: ensure leading slash to match server cache keys
	if (key && !key.startsWith('/')) key = '/' + key;
	state.sitemapCache.set(key, page);
}

async function buildSearchIndex() {
	if (state.searchIndexBuilding || !state.rootPageUrl) return;
	state.searchIndexBuilding = true;
	state.searchIndexReady = false;
	state.searchFrames = [];
	state.searchWidgets = [];
	let aggregated = null;
	try {
		aggregated = await fetchSearchIndexAggregate();
	} catch (err) {
		logJsError('buildSearchIndex aggregate fetch failed', err);
		aggregated = null;
	}

	if (aggregated) {
		state.searchWidgets = aggregated.widgets;
		state.searchFrames = aggregated.frames;
		state.searchIndexReady = true;
		state.searchIndexBuilding = false;
		if (state.filter.trim()) render();
		return;
	}

	const queue = [{ url: state.rootPageUrl, path: [] }];
	const seenPages = new Set();
	const seenWidgets = new Set();
	const seenFrames = new Set();
	const all = [];
	const frames = [];

	while (queue.length) {
		const next = queue.shift();
		const url = ensureJsonParam(toRelativeRestLink(next.url));
		const pagePath = Array.isArray(next.path) ? next.path : [];
		if (seenPages.has(url)) continue;
		seenPages.add(url);

		let page;
		try {
			page = await fetchJson(url);
		} catch (err) {
			logJsError(`buildSearchIndex page fetch failed for ${url}`, err);
			continue;
		}

		const normalized = normalizeWidgets(page, { path: pagePath });
		for (const f of normalized) {
			if (!f || !f.__section) continue;
			const frameLabel = safeText(f.label);
			if (!frameLabel) continue;
			const frameKey = `${pagePath.join('>')}|${frameLabel}`;
			if (seenFrames.has(frameKey)) continue;
			seenFrames.add(frameKey);
			frames.push({ label: frameLabel, path: pagePath.slice() });
		}

		const widgets = normalized.filter(w => !w.__section);
		for (const w of widgets) {
			const link = widgetPageLink(w);
			if (link) {
				const segs = labelPathSegments(widgetLabel(w));
				const nextPath = pagePath.concat(segs.length ? segs : [widgetLabel(w)]).filter(s => s && s !== '-');
				queue.push({ url: link, path: nextPath });
			}
			const key = w?.widgetId || `${w?.item?.name || ''}|${w?.label || ''}|${link || ''}`;
			if (seenWidgets.has(key)) continue;
			seenWidgets.add(key);
			all.push(w);
		}
	}

	state.searchWidgets = all;
	state.searchFrames = frames;
	state.searchIndexReady = true;
	state.searchIndexBuilding = false;
	if (state.filter.trim()) render();
}

async function refresh(showLoading) {
	clearLoadingStatusTimer();
	if (showLoading) scheduleLoadingStatus();
	if (state.suppressRefreshCount > 0 && !showLoading) {
		state.pendingRefresh = true;
		return;
	}

	state.isRefreshing = true;
	updateStatusBar();
	const refreshUrl = state.pageUrl; // Capture URL at start to detect stale responses
	const isPageChange = state.lastPageUrl && state.pageUrl !== state.lastPageUrl;
	if (isPageChange) stopAllVideoStreams();
	const fade = (!state.isSlim && isPageChange) ? beginPageFadeOut() : null;
	const shouldScroll = state.pendingScrollTop;
	state.pendingScrollTop = false;

	// For page changes with cache: use cache for instant display, then background refresh
	// to get fresh transformed labels from the server (skip cache if connection is fast)
	if (isPageChange && state.sitemapCacheReady && !isFastConnection()) {
		const cachedPage = getPageFromCache(state.pageUrl);
		if (cachedPage) {
			state.pageTitle = cachedPage?.title || state.pageTitle;
			state.rawWidgets = normalizeWidgets(cachedPage);
			state.lastPageUrl = state.pageUrl;
			if (fade) await fade.promise;
			if (shouldScroll) scrollToTop();
			render();
			saveHomeSnapshot();
			clearLoadingStatusTimer();
			if (fade) runPageFadeIn(fade.token);
			state.isRefreshing = false;
			// Background refresh to get fresh transformed labels
			setTimeout(() => refresh(false), 100);
			return;
		}
	}

	try {
		const result = await fetchPage(state.pageUrl, { forceFull: showLoading || isPageChange });
		// Abort if user navigated away during fetch (stale response)
		// Still restore connection status since fetch succeeded
		if (state.pageUrl !== refreshUrl) {
			state.isRefreshing = false;
			clearLoadingStatusTimer();
			setConnectionStatus(true);
			return;
		}
		if (result.delta) {
			if (result.title) state.pageTitle = result.title;
			const updated = applyDeltaChanges(result.changes);
			syncDeltaToCache(state.pageUrl, result.changes);
			if (!state.lastPageUrl) state.lastPageUrl = state.pageUrl;
			if (updated || result.title) render();
			state.isRefreshing = false;
			clearLoadingStatusTimer();
			setConnectionStatus(true);
			saveHomeSnapshot();
			// After soft reset, start ping once first delta succeeds
			if (resumePingPending) {
				resumePingPending = false;
				startPingDelayed(RESUME_PING_DELAY_MS);
			}
			return;
		}
		const page = result.page;
		state.pageTitle = page?.title || state.pageTitle;
		state.rawWidgets = normalizeWidgets(page);
		state.lastPageUrl = state.pageUrl;
		// Update cache with fresh page data
		updatePageInCache(state.pageUrl, page);
		if (fade) await fade.promise;
		if (shouldScroll) scrollToTop();
		render();
		saveHomeSnapshot();
		clearLoadingStatusTimer();
		if (fade) runPageFadeIn(fade.token);
		state.isRefreshing = false;
		setConnectionStatus(true);
	} catch (e) {
		console.error(e);
		logJsError('refresh failed', e);
		clearLoadingStatusTimer();

		// Try sitemap cache (allows offline navigation)
		if (state.sitemapCacheReady) {
			const cachedPage = getPageFromCache(state.pageUrl);
			if (cachedPage) {
				state.pageTitle = cachedPage?.title || state.pageTitle;
				state.rawWidgets = normalizeWidgets(cachedPage);
				state.lastPageUrl = state.pageUrl;
				if (fade) await fade.promise;
				if (shouldScroll) scrollToTop();
				render();
				saveHomeSnapshot();
				if (fade) runPageFadeIn(fade.token);
				state.isRefreshing = false;
				setConnectionStatus(false, e.message);
				return;
			}
		}

		setConnectionStatus(false, e.message);
		const hasContent = !!state.lastPageUrl;
		let usedSnapshot = false;
		if (!hasContent && canRestoreHomeSnapshot()) {
			const snapshot = loadHomeSnapshot();
			if (snapshot) usedSnapshot = applyHomeSnapshot(snapshot);
		}
		const hasFallback = hasContent || usedSnapshot;
		setStatus(hasFallback ? '' : `Error: ${e.message}`);
		state.isRefreshing = false;
		setConnectionStatus(false, e.message);
		if (fade) await fade.promise;
		if (!hasFallback) {
			if (shouldScroll) scrollToTop();
			els.grid.innerHTML = `
				<div class="glass rounded-2xl p-5 sm:col-span-2 lg:col-span-3">
					<div class="font-semibold">Couldn't load sitemap page</div>
					<div class="mt-2 text-sm text-slate-300">${escapeHtml(e.message)}</div>
					<div class="mt-4 text-xs text-slate-500">
						Try opening <code class="text-slate-300">${escapeHtml(state.pageUrl)}</code> in the browser to see what openHAB returns.
					</div>
				</div>
			`;
		} else if (usedSnapshot) {
			if (shouldScroll) scrollToTop();
			render();
		}
		if (fade) runPageFadeIn(fade.token);
	}
}

function startPolling() {
	stopPolling();
	setPollInterval(activeInterval());
	armIdleTimer();
	startChartHashCheck();
}

function stopPolling() {
	if (state.pollTimer) clearInterval(state.pollTimer);
	state.pollTimer = null;
	if (state.idleTimer) clearTimeout(state.idleTimer);
	state.idleTimer = null;
	state.pollInterval = 0;
	stopChartHashCheck();
}

function setPollInterval(ms) {
	if (state.pollTimer) clearInterval(state.pollTimer);
	state.pollInterval = ms;
	state.pollTimer = setInterval(() => refresh(false), ms);
}

function activeInterval() {
	return state.isSlim ? POLL_SLIM_ACTIVE_MS : POLL_ACTIVE_MS;
}

function idleInterval() {
	return state.isSlim ? POLL_SLIM_IDLE_MS : POLL_IDLE_MS;
}

function armIdleTimer() {
	if (state.idleTimer) clearTimeout(state.idleTimer);
	state.idleTimer = setTimeout(() => {
		state.isIdle = true;
		// Don't change polling if WebSocket is connected
		if (!wsConnected) {
			const next = idleInterval();
			if (state.pollInterval !== next) setPollInterval(next);
		}
	}, IDLE_AFTER_MS);
}

function noteActivity() {
	const now = Date.now();
	const throttle = state.isSlim ? 1000 : ACTIVITY_THROTTLE_MS;
	if (now - state.lastActivity < throttle) return;
	state.lastActivity = now;
	state.isIdle = false;
	// Don't speed up polling if WebSocket is connected
	if (!wsConnected) {
		const next = activeInterval();
		if (state.pollInterval !== next) setPollInterval(next);
	}
	armIdleTimer();
}

// --- Chart Hash Check (smart iframe refresh) ---
let chartHashCheckInProgress = false;
const chartTouchActive = new WeakSet();

function setupChartInteractionTracking(iframe) {
	if (iframe.dataset.interactionTracked) return;
	iframe.dataset.interactionTracked = 'true';
	iframe.addEventListener('touchstart', () => chartTouchActive.add(iframe), { passive: true });
	iframe.addEventListener('touchend', () => chartTouchActive.delete(iframe), { passive: true });
	iframe.addEventListener('touchcancel', () => chartTouchActive.delete(iframe), { passive: true });
}

function isChartBeingInteracted(iframe) {
	// Check for touch interaction
	if (chartTouchActive.has(iframe)) return true;
	// Check for mouse hover
	try {
		if (iframe.matches(':hover')) return true;
	} catch { /* ignore */ }
	return false;
}

function readIframeChartHash(iframe) {
	try {
		const doc = iframe.contentDocument;
		if (!doc || !doc.documentElement) return null;
		return doc.documentElement.dataset.hash || null;
	} catch (err) {
		logJsError('readIframeChartHash failed', err);
		return null;
	}
}

function buildChartReloadUrl(chartUrl, dataHash) {
	try {
		const url = new URL(chartUrl, window.location.origin);
		if (dataHash) url.searchParams.set('_t', dataHash);
		return url.pathname + url.search;
	} catch (err) {
		logJsError(`buildChartReloadUrl failed for ${chartUrl}`, err);
		const sep = chartUrl.includes('?') ? '&' : '?';
		const hashPart = dataHash ? `&_t=${encodeURIComponent(dataHash)}` : '';
		if (!hashPart) return chartUrl;
		return `${chartUrl}${sep}${hashPart.replace(/^&/, '')}`;
	}
}

function swapChartIframe(iframe, newSrc, baseUrl) {
	if (!iframe || !newSrc) return;
	const container = iframe.parentElement;
	if (!container) {
		iframe.dataset.chartUrl = baseUrl || newSrc;
		setChartIframeAnimState(iframe, baseUrl || newSrc);
		iframe.src = newSrc;
		return;
	}

	const newIframe = document.createElement('iframe');
	newIframe.className = iframe.className;
	setChartIframeAnimState(newIframe, baseUrl || newSrc);
	newIframe.setAttribute('frameborder', iframe.getAttribute('frameborder') || '0');
	newIframe.setAttribute('scrolling', iframe.getAttribute('scrolling') || 'no');
	if (iframe.getAttribute('allowfullscreen')) {
		newIframe.setAttribute('allowfullscreen', iframe.getAttribute('allowfullscreen'));
	}
	newIframe.dataset.chartUrl = baseUrl || iframe.dataset.chartUrl || newSrc;
	newIframe.style.opacity = '0';
	newIframe.style.transition = `opacity ${CHART_IFRAME_CROSSFADE_MS}ms ease-out`;
	newIframe.style.position = 'absolute';
	newIframe.style.top = '0';
	newIframe.style.left = '0';
	newIframe.style.width = '100%';
	newIframe.style.height = '100%';
	newIframe.src = newSrc;

	// Ensure container has relative positioning for absolute child
	if (getComputedStyle(container).position === 'static') {
		container.style.position = 'relative';
	}
	container.appendChild(newIframe);
	setupChartInteractionTracking(newIframe);

	const timeoutId = setTimeout(() => {
		// Timeout - remove new iframe, keep old
		if (container.contains(newIframe)) newIframe.remove();
	}, CHART_IFRAME_SWAP_TIMEOUT_MS);

	newIframe.addEventListener('load', () => {
		clearTimeout(timeoutId);
		// Crossfade: fade in new iframe
		newIframe.style.opacity = '1';
		// After transition completes, remove old iframe and reset positioning
		setTimeout(() => {
			if (container.contains(iframe)) iframe.remove();
			newIframe.style.position = '';
			newIframe.style.top = '';
			newIframe.style.left = '';
			newIframe.style.width = '';
			newIframe.style.height = '';
			newIframe.style.transition = '';
		}, CHART_IFRAME_CROSSFADE_MS);
	}, { once: true });
}

async function checkChartHashes() {
	if (chartHashCheckInProgress) return;
	const iframes = document.querySelectorAll('iframe.chart-frame');
	if (iframes.length === 0) return;

	chartHashCheckInProgress = true;
	const mode = getThemeMode();
	const assetVersion = OH_CONFIG.assetVersion || 'v1';

	try {
		for (const iframe of iframes) {
			// Setup interaction tracking on first encounter
			setupChartInteractionTracking(iframe);

			const chartUrl = iframe.dataset.chartUrl || '';
			if (!chartUrl) continue;

			// Parse item, period, title from URL: /chart?item=X&period=Y&title=Z&...
			const urlObj = new URL(chartUrl, window.location.origin);
			const item = urlObj.searchParams.get('item') || '';
			const period = urlObj.searchParams.get('period') || '';
			const title = urlObj.searchParams.get('title') || '';
			if (!item || !period) continue;

			// Cache key includes assetVersion to match server
			const cacheKey = `${item}|${period}|${mode}|${assetVersion}`;
			const prevHash = chartHashes.get(cacheKey) || null;

			try {
				const hashUrl = `/api/chart-hash?item=${encodeURIComponent(item)}&period=${period}&mode=${mode}` +
					(title ? `&title=${encodeURIComponent(title)}` : '');
				const res = await fetch(hashUrl, { cache: 'no-store' });
				if (!res.ok) continue;
				const data = await res.json();
				if (!data.hash) continue;

				// On first check, read hash from iframe and compare
				let swapped = false;
				if (!prevHash) {
					const iframeHash = readIframeChartHash(iframe);
					if (iframeHash && iframeHash !== data.hash) {
						// Skip if user is interacting with chart
						if (!isChartBeingInteracted(iframe)) {
							const newUrl = buildChartReloadUrl(chartUrl, data.hash);
							swapChartIframe(iframe, newUrl, chartUrl);
							swapped = true;
						}
					} else {
						swapped = true; // No swap needed, consider it done
					}
				} else if (prevHash !== data.hash) {
					// Skip if user is interacting with chart
					if (!isChartBeingInteracted(iframe)) {
						const newUrl = buildChartReloadUrl(chartUrl, data.hash);
						swapChartIframe(iframe, newUrl, chartUrl);
						swapped = true;
					}
				} else {
					swapped = true; // Hashes match, no swap needed
				}

				// Only update cache if swap happened or wasn't needed
				if (swapped && MAX_CHART_HASHES > 0) {
					setBoundedCache(chartHashes, cacheKey, data.hash, MAX_CHART_HASHES);
				}
			} catch (e) {
				logJsError('checkChartHashes failed', e);
			}
		}
	} finally {
		chartHashCheckInProgress = false;
	}
}

function startChartHashCheck() {
	if (chartHashTimer) clearInterval(chartHashTimer);
	chartHashTimer = setInterval(checkChartHashes, CHART_HASH_CHECK_MS);
}

function stopChartHashCheck() {
	if (chartHashTimer) {
		clearInterval(chartHashTimer);
		chartHashTimer = null;
	}
}

// --- Heartbeat Check ---
let heartbeatInProgress = false;
const HEARTBEAT_TIMEOUT_MS = 5000;

async function checkHeartbeat() {
	if (heartbeatInProgress) return;
	heartbeatInProgress = true;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);
	try {
		const res = await fetch('/api/heartbeat', { cache: 'no-store', signal: controller.signal });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		// Connection is alive - ensure we're not in error state
		if (!state.connectionOk) {
			setConnectionStatus(true);
		}
	} catch (e) {
		if (e.name === 'AbortError') {
			console.warn('Heartbeat timed out');
			setConnectionStatus(false, 'Connection timeout');
		} else {
			console.warn('Heartbeat failed:', e.message);
			logJsError('checkHeartbeat failed', e);
			setConnectionStatus(false, 'Connection lost');
		}
	} finally {
		clearTimeout(timeoutId);
		heartbeatInProgress = false;
	}
}

// --- Ping / Latency Tracking ---
const PING_INTERVAL_MS = 5000;
const PING_TIMEOUT_MS = 1000;
const PING_SAMPLE_COUNT = 5;
const FAST_CONNECTION_ENABLE_MS = 100;  // Enter fast mode below this
const FAST_CONNECTION_DISABLE_MS = 130; // Exit fast mode above this
let pingSamples = [];
let pingTimer = null;
let forceFastMode = false;
let isLanClient = null;  // null = unknown, true = LAN, false = WAN (set by server via WS)
let fastConnectionActive = false;
let pingNeedsPrefill = true;
let notificationPermission = 'default';
const STATUS_NOTIFICATION_TAG = 'ohproxy-status';

function invalidatePing() {
	const wasFast = fastConnectionActive;
	pingSamples = [];
	fastConnectionActive = false;
	pingNeedsPrefill = true;
	if (wasFast) updateStatusBar();
	// Update tooltip if visible (skip if LAN client - already showing "LAN")
	if (!isLanClient && els.statusTooltip && els.statusTooltip.classList.contains('visible')) {
		const valueEl = els.statusTooltip.querySelector('.status-tooltip-value');
		if (valueEl) {
			valueEl.textContent = '';
			valueEl.classList.add('loading');
		}
	}
}

function getRollingLatency() {
	if (pingSamples.length < PING_SAMPLE_COUNT) return null;
	return Math.round(pingSamples.reduce((a, b) => a + b, 0) / pingSamples.length * 100) / 100;
}

function getDisplayLatency() {
	if (pingSamples.length === 0) return null;
	return Math.round(pingSamples.reduce((a, b) => a + b, 0) / pingSamples.length * 100) / 100;
}

function isFastConnection() {
	return forceFastMode || isLanClient === true || fastConnectionActive;
}

function updateFastConnectionState() {
	const latency = getRollingLatency();
	const wasFast = fastConnectionActive;
	if (latency === null) {
		fastConnectionActive = false;
	} else if (fastConnectionActive) {
		// Hysteresis: exit at >80ms
		if (latency > FAST_CONNECTION_DISABLE_MS) {
			fastConnectionActive = false;
		}
	} else {
		// Hysteresis: enter at <50ms
		if (latency < FAST_CONNECTION_ENABLE_MS) {
			fastConnectionActive = true;
		}
	}
	if (wasFast !== fastConnectionActive) {
		updateStatusBar();
	}
	// Update notification with latest latency
	if (state.connectionOk) showStatusNotification();
	// Update tooltip if visible (skip if LAN client - already showing "LAN")
	if (!isLanClient && els.statusTooltip && els.statusTooltip.classList.contains('visible')) {
		const displayLatency = getDisplayLatency();
		const valueEl = els.statusTooltip.querySelector('.status-tooltip-value');
		if (valueEl) {
			if (displayLatency !== null) {
				valueEl.textContent = displayLatency + 'ms';
				valueEl.classList.remove('loading');
			} else {
				valueEl.textContent = '';
				valueEl.classList.add('loading');
			}
		}
	}
}

function doPing() {
	if (forceFastMode) return;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
	const start = performance.now();

	fetch('/api/ping', { signal: controller.signal, cache: 'no-store' })
		.then((res) => {
			clearTimeout(timeoutId);
			if (res.status === 401) {
				syncAuthFromHeaders(res);
				triggerReload();
				return;
			}
			if (!res.ok) throw new Error('Ping failed');
			const latency = performance.now() - start;
			if (latency > PING_TIMEOUT_MS) {
				invalidatePing();
				return;
			}
			// If first ping after invalidation and it's good, prefill the samples
			if (pingNeedsPrefill) {
				pingNeedsPrefill = false;
				pingSamples = [];
				for (let i = 0; i < PING_SAMPLE_COUNT; i++) {
					pingSamples.push(latency);
				}
			} else {
				pingSamples.push(latency);
				if (pingSamples.length > PING_SAMPLE_COUNT) {
					pingSamples.shift();
				}
			}
			updateFastConnectionState();
		})
		.catch(() => {
			clearTimeout(timeoutId);
			invalidatePing();
		});
}

let pingStartDelayTimer = null;
const PING_START_DELAY_MS = 500;
const RESUME_PING_DELAY_MS = 5000;

function startPing() {
	stopPing();
	invalidatePing();
	if (forceFastMode) return;
	doPing();
	pingTimer = setInterval(doPing, PING_INTERVAL_MS);
}

function startPingDelayed(delayMs = PING_START_DELAY_MS) {
	stopPing();
	invalidatePing();
	if (forceFastMode) return;
	if (pingStartDelayTimer) clearTimeout(pingStartDelayTimer);
	pingStartDelayTimer = setTimeout(() => {
		pingStartDelayTimer = null;
		startPing();
	}, delayMs);
}

function stopPing() {
	if (pingStartDelayTimer) {
		clearTimeout(pingStartDelayTimer);
		pingStartDelayTimer = null;
	}
	if (pingTimer) {
		clearInterval(pingTimer);
		pingTimer = null;
	}
}

// --- WebSocket Push ---
let wsConnection = null;
let wsConnected = false;
let wsReconnectTimer = null;
let wsFailCount = 0;
const WS_RECONNECT_MS = 1000;
const WS_CONNECT_TIMEOUT_MS = 1000;
const WS_FALLBACK_POLL_MS = 30000;
const WS_MAX_FAILURES = 5; // Stop trying WebSocket after this many consecutive failures
let wsConnectTimer = null;
let wsConnectToken = 0;
let wsTimedOutToken = 0;
let wsDeltaRequestId = 0;
const wsDeltaPending = new Map(); // requestId -> { resolve, reject, timer }

function fetchDeltaViaWs(url, since) {
	return new Promise((resolve, reject) => {
		if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) {
			reject(new Error('WebSocket not connected'));
			return;
		}
		const requestId = ++wsDeltaRequestId;
		const timer = setTimeout(() => {
			const pending = wsDeltaPending.get(requestId);
			if (pending) {
				wsDeltaPending.delete(requestId);
				pending.reject(new Error('WS delta timeout'));
			}
		}, WS_DELTA_TIMEOUT_MS);
		wsDeltaPending.set(requestId, { resolve, reject, timer });
		wsConnection.send(JSON.stringify({
			event: 'fetchDelta',
			data: { url, since, requestId },
		}));
	});
}

function handleWsDeltaResponse(data) {
	const { requestId, error, ...result } = data;
	const pending = wsDeltaPending.get(requestId);
	if (!pending) return;
	wsDeltaPending.delete(requestId);
	clearTimeout(pending.timer);
	if (error) {
		pending.reject(new Error(error));
	} else {
		pending.resolve(result);
	}
}

function clearPendingDeltaRequests() {
	for (const [id, pending] of wsDeltaPending) {
		clearTimeout(pending.timer);
		pending.reject(new Error('WebSocket closed'));
	}
	wsDeltaPending.clear();
}

function clearWsConnectTimer() {
	if (wsConnectTimer) {
		clearTimeout(wsConnectTimer);
		wsConnectTimer = null;
	}
}

let wsRefreshTimer = null;
const WS_REFRESH_DEBOUNCE_MS = 300;

function applyWsUpdate(data) {
	if (!data || data.type !== 'items' || !Array.isArray(data.changes)) return;
	const deltaChanges = data.changes.map(item => ({
		itemName: item.name,
		state: item.state,
	}));
	const didUpdate = applyDeltaChanges(deltaChanges);
	// Also sync to sitemap cache so navigation shows updated states
	syncItemsToAllCachedPages(deltaChanges);
	if (didUpdate) {
		render();
		// Debounced refresh to catch visibility-triggered sitemap changes
		if (wsRefreshTimer) clearTimeout(wsRefreshTimer);
		wsRefreshTimer = setTimeout(() => {
			wsRefreshTimer = null;
			refresh(false);
		}, WS_REFRESH_DEBOUNCE_MS);
	}
}

// --- Client Focus Tracking ---
let lastFocusState = null;
let focusListenersInitialized = false;
let externalFocusOverride = null;  // Set by postMessage from WebView2 container


function isClientFocused() {
	// Use external override if set, otherwise use visibilityState
	if (externalFocusOverride !== null) return externalFocusOverride;
	return document.visibilityState === 'visible';
}

function sendClientState(stateData) {
	if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;
	try {
		wsConnection.send(JSON.stringify({ event: 'clientState', data: stateData }));
	} catch {}
}

function sendFocusState() {
	const focused = isClientFocused();
	if (focused !== lastFocusState) {
		lastFocusState = focused;
		sendClientState({ focused });
		// Pause/resume video streams on desktop focus change
		if (!isTouchDevice()) {
			if (focused) {
				resumeVideoStreamsFromVisibility();
			} else {
				pauseVideoStreamsForVisibility();
			}
		}
	}
}

function initFocusTracking() {
	if (focusListenersInitialized) return;
	focusListenersInitialized = true;
	document.addEventListener('visibilitychange', sendFocusState);
	// Listen for external focus control via postMessage (e.g., from WebView2 container)
	// Send ohProxyFocus: true/false to override, or ohProxyFocus: null to clear and use visibilityState
	window.addEventListener('message', (e) => {
		if (e.data && 'ohProxyFocus' in e.data) {
			const val = e.data.ohProxyFocus;
			externalFocusOverride = (val === true || val === false) ? val : null;
			sendFocusState();
		}
	});
}

function getWsUrl() {
	const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${proto}//${window.location.host}/ws`;
}

function connectWs() {
	if (wsConnection) return;
	if (CLIENT_CONFIG.websocketDisabled === true) return;
	if (wsFailCount >= WS_MAX_FAILURES) return;

	try {
		wsConnection = new WebSocket(getWsUrl());
		const connectToken = ++wsConnectToken;
		wsConnection.__ohProxyToken = connectToken;
		clearWsConnectTimer();
		// Guard against sockets stuck in CONNECTING (no open/close events).
		wsConnectTimer = setTimeout(() => {
			if (!wsConnection || wsConnection.__ohProxyToken !== connectToken) return;
			if (wsConnection.readyState !== WebSocket.CONNECTING) return;
			wsTimedOutToken = connectToken;
			wsFailCount++;
			if (wsFailCount >= WS_MAX_FAILURES) {
				restoreNormalPolling();
				closeWs();
				return;
			}
			closeWs();
			scheduleWsReconnect();
		}, WS_CONNECT_TIMEOUT_MS);

		wsConnection.onopen = () => {
			clearWsConnectTimer();
			wsConnected = true;
			wsFailCount = 0;
			if (wsReconnectTimer) {
				clearTimeout(wsReconnectTimer);
				wsReconnectTimer = null;
			}
			if (state.pollTimer && state.pollInterval < WS_FALLBACK_POLL_MS) {
				setPollInterval(WS_FALLBACK_POLL_MS);
			}
			// Update connection status and refresh data
			setConnectionStatus(true);
			refresh(false);
			// Initialize focus tracking and send initial state
			initFocusTracking();
			lastFocusState = null;  // Reset to ensure initial state is sent
			sendFocusState();
		};

		wsConnection.onmessage = (event) => {
			try {
				const msg = JSON.parse(event.data);
				if (msg.event === 'connected' && msg.data?.assetVersion) {
					if (msg.data.assetVersion !== OH_CONFIG.assetVersion) {
						console.log('Asset version mismatch on reconnect, reloading...');
						triggerReload();
						return;
					}
				}
				if (msg.event === 'account-deleted') {
					// Account was deleted - redirect to login
					window.location.href = '/login';
					return;
				}
				if (msg.event === 'assetVersionChanged') {
					// Server assets updated - reload to get new version
					console.log('Asset version changed, reloading...');
					triggerReload();
					return;
				}
				if (msg.event === 'pong' && msg.data) {
					handleWsPong(msg.data);
					return;
				}
				if (msg.event === 'chartHashResponse' && msg.data) {
					handleWsChartHashResponse(msg.data);
					return;
				}
				if (msg.event === 'backendStatus' && msg.data) {
					// Backend (OpenHAB) connection status changed
					if (msg.data.ok) {
						setConnectionStatus(true);
					} else {
						setConnectionStatus(false, msg.data.error || 'Backend unavailable');
					}
					return;
				}
				if (msg.event === 'lanStatus' && msg.data) {
					// Server indicates whether client is on LAN or WAN
					const wasLan = isLanClient;
					isLanClient = msg.data.isLan === true;
					if (isLanClient) {
						// LAN client: skip ping, assume fast connection
						stopPing();
						if (!wasLan) updateStatusBar();
					} else {
						// WAN client: use ping to measure connection speed
						if (wasLan !== false) {
							invalidatePing();
							startPingDelayed();
						}
						if (wasLan) updateStatusBar();
					}
					return;
				}
				if (msg.event === 'update' && msg.data) {
					applyWsUpdate(msg.data);
				} else if (msg.event === 'deltaResponse' && msg.data) {
					handleWsDeltaResponse(msg.data);
				}
			} catch (err) {
				logJsError('wsConnection onmessage failed', err);
			}
		};

		wsConnection.onclose = (event) => {
			clearWsConnectTimer();
			const wasConnected = wsConnected;
			const token = event?.target?.__ohProxyToken;
			const timedOut = token && token === wsTimedOutToken;
			if (timedOut) wsTimedOutToken = 0;
			wsConnected = false;
			wsConnection = null;
			isLanClient = null;  // Reset LAN status; will be set on reconnect
			// Don't count as failure if clean close or timeout
			if (!timedOut && (!wasConnected || event.code === 1002 || event.code === 1006)) {
				wsFailCount++;
				invalidatePing();
				if (wsFailCount >= WS_MAX_FAILURES) {
					restoreNormalPolling();
					return;
				}
			}
			if (!timedOut) {
				scheduleWsReconnect();
			}
		};

		wsConnection.onerror = (err) => {
			// Only log here - onclose will handle fail count and reconnection
			console.warn('WebSocket error:', err);
			logJsError('WebSocket error', err);
			// Check if server is reachable
			checkHeartbeat();
		};
	} catch (err) {
		logJsError('connectWs failed', err);
		wsConnected = false;
		wsFailCount++;
		scheduleWsReconnect();
	}
}

function closeWs() {
	clearWsConnectTimer();
	clearPendingDeltaRequests();
	if (wsConnection) {
		try { wsConnection.close(); } catch (err) { logJsError('closeWs failed', err); }
		wsConnection = null;
	}
	wsConnected = false;
}

function scheduleWsReconnect() {
	if (wsReconnectTimer) return;
	wsReconnectTimer = setTimeout(() => {
		wsReconnectTimer = null;
		connectWs();
	}, WS_RECONNECT_MS);
}

function stopWs() {
	if (wsReconnectTimer) {
		clearTimeout(wsReconnectTimer);
		wsReconnectTimer = null;
	}
	closeWs();
}

function restoreNormalPolling() {
	// Restore normal polling interval since WebSocket isn't working
	const normalInterval = state.isIdle ? idleInterval() : activeInterval();
	if (state.pollInterval !== normalInterval) {
		setPollInterval(normalInterval);
	}
}

// --- Boot ---
(async function init() {
	try {
		const params = new URLSearchParams(window.location.search);
		forceFastMode = params.get('fast') === 'true';
		state.isSlim = params.get('slim') === 'true';
		const headerParam = (params.get('header') || '').toLowerCase();
		state.headerMode = (headerParam === 'small' || headerParam === 'none') ? headerParam : 'full';
		const modeParam = params.get('mode');
		state.forcedMode = (modeParam === 'dark' || modeParam === 'light') ? modeParam : null;
		if (state.isSlim) document.documentElement.classList.add('slim');
		if (state.headerMode === 'small') document.documentElement.classList.add('header-small');
		if (state.headerMode === 'none') document.documentElement.classList.add('header-none');
		if (!('ontouchstart' in window) && navigator.maxTouchPoints === 0) document.documentElement.classList.add('hover-device');
	} catch (err) {
		logJsError('init failed', err);
	}
	// Show voice button if Speech Recognition API and microphone permission available
	var voiceModel = (window.__OH_CONFIG__?.voiceModel || 'browser').toLowerCase();
	var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (els.voice && (voiceModel === 'vosk' || SpeechRecognition)) {
		(async () => {
			try {
				// Try permissions API first
				if (navigator.permissions) {
					try {
						const result = await navigator.permissions.query({ name: 'microphone' });
						if (result.state === 'denied') return;
						els.voice.classList.remove('hidden');
						return;
					} catch {
						// Permissions API doesn't support microphone query, fall through
					}
				}
				// Fallback: check for audio input devices
				if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
					const devices = await navigator.mediaDevices.enumerateDevices();
					const hasMic = devices.some(d => d.kind === 'audioinput');
					if (hasMic) els.voice.classList.remove('hidden');
				} else {
					// No way to check, just show the button
					els.voice.classList.remove('hidden');
				}
			} catch {}
		})();
	}
	if (els.search) {
		els.search.setAttribute('autocomplete', 'off');
		els.search.setAttribute('name', `oh-search-${Date.now()}`);
		scheduleSearchPlaceholderUpdate();
	}
	if (state.headerMode === 'small') applyHeaderSmallLayout();
	syncSearchFocusedLayout();
	window.addEventListener('mousemove', noteActivity, { passive: true });
	window.addEventListener('scroll', noteActivity, { passive: true });
	window.addEventListener('scroll', scheduleImageScrollRefresh, { passive: true });
	window.addEventListener('touchstart', noteActivity, { passive: true });
	window.addEventListener('touchstart', handleBounceTouchStart, { passive: true });
	window.addEventListener('touchmove', handleBounceTouchMove, { passive: false });
	window.addEventListener('touchend', handleBounceTouchEnd, { passive: true });
	window.addEventListener('touchcancel', handleBounceTouchEnd, { passive: true });
	window.addEventListener('click', noteActivity, { passive: true });
	// Status tooltip interactions
	if (els.statusDotWrap) {
		els.statusDotWrap.addEventListener('mouseenter', showStatusTooltip);
		els.statusDotWrap.addEventListener('mousemove', positionStatusTooltip);
		els.statusDotWrap.addEventListener('mouseleave', hideStatusTooltip);
	}
	if (isTouchDevice() && 'Notification' in window && 'serviceWorker' in navigator) {
		Notification.requestPermission().then(perm => {
			notificationPermission = perm;
			if (perm === 'granted') showStatusNotification();
		}).catch(() => {});
	}
	// Ctrl+click on cards opens item config modal
	document.addEventListener('click', (e) => {
		if (!(e.ctrlKey || e.metaKey) || state.isSlim) return;
		if (getUserRole() !== 'admin') return;
		// Cards are .glass elements with data-widget-key attribute inside #grid
		const card = e.target.closest('#grid > .glass[data-widget-key]');
		if (!card) return;
		const key = card.dataset.widgetKey;
		if (!key || !key.startsWith('widget:')) return;
		// Find widget in current page
		const widget = findWidgetByKey(key);
		if (!widget) return;
		e.preventDefault();
		e.stopPropagation();
		openCardConfigModal(widget, card);
	}, true);
	// Right-click on non-iframe cards opens item config modal
	document.addEventListener('contextmenu', (e) => {
		if (state.isSlim) return;
		if (getUserRole() !== 'admin') return;
		const card = e.target.closest('#grid > .glass[data-widget-key]');
		if (!card) return;
		// Don't intercept right-click on iframe-based cards (webview, chart)
		if (card.querySelector('iframe')) return;
		const key = card.dataset.widgetKey;
		if (!key || !key.startsWith('widget:')) return;
		const widget = findWidgetByKey(key);
		if (!widget) return;
		e.preventDefault();
		openCardConfigModal(widget, card);
	}, true);
	// Two-finger long press (2s) on cards opens item config modal (touch devices)
	let twoFingerTimer = null;
	let twoFingerCard = null;
	let twoFingerStartTouches = null;
	const TWO_FINGER_HOLD_MS = 2000;
	const TWO_FINGER_MOVE_THRESHOLD = 30;
	function clearTwoFingerHold() {
		if (twoFingerTimer) { clearTimeout(twoFingerTimer); twoFingerTimer = null; }
		twoFingerCard = null;
		twoFingerStartTouches = null;
	}
	document.addEventListener('touchstart', (e) => {
		if (e.touches.length !== 2) { clearTwoFingerHold(); return; }
		if (getUserRole() !== 'admin') return;
		const card = e.target.closest('#grid > .glass[data-widget-key]');
		if (!card) return;
		const key = card.dataset.widgetKey;
		if (!key || !key.startsWith('widget:')) return;
		// Verify both touches are on same card
		const touch1El = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
		const touch2El = document.elementFromPoint(e.touches[1].clientX, e.touches[1].clientY);
		const card1 = touch1El?.closest('#grid > .glass[data-widget-key]');
		const card2 = touch2El?.closest('#grid > .glass[data-widget-key]');
		if (card1 !== card2 || card1 !== card) return;
		twoFingerCard = card;
		twoFingerStartTouches = [
			{ x: e.touches[0].clientX, y: e.touches[0].clientY },
			{ x: e.touches[1].clientX, y: e.touches[1].clientY }
		];
		twoFingerTimer = setTimeout(() => {
			const widget = findWidgetByKey(key);
			if (widget && twoFingerCard) {
				haptic();
				openCardConfigModal(widget, twoFingerCard);
			}
			clearTwoFingerHold();
		}, TWO_FINGER_HOLD_MS);
	}, { passive: true });
	document.addEventListener('touchmove', (e) => {
		if (!twoFingerTimer || !twoFingerStartTouches) return;
		if (e.touches.length !== 2) { clearTwoFingerHold(); return; }
		// Check if fingers moved too far
		for (let i = 0; i < 2; i++) {
			const dx = e.touches[i].clientX - twoFingerStartTouches[i].x;
			const dy = e.touches[i].clientY - twoFingerStartTouches[i].y;
			if (Math.sqrt(dx * dx + dy * dy) > TWO_FINGER_MOVE_THRESHOLD) {
				clearTwoFingerHold();
				return;
			}
		}
	}, { passive: true });
	document.addEventListener('touchend', clearTwoFingerHold, { passive: true });
	document.addEventListener('touchcancel', clearTwoFingerHold, { passive: true });
	// Disable pointer-events on iframes when ctrl/meta held so clicks pass through to cards
	const setIframePointerEvents = (enabled) => {
		const value = enabled ? '' : 'none';
		document.querySelectorAll('#grid iframe').forEach(f => f.style.pointerEvents = value);
	};
	window.addEventListener('keydown', (e) => {
		if (e.ctrlKey || e.metaKey) setIframePointerEvents(false);
	}, { passive: true });
	window.addEventListener('keyup', (e) => {
		if (e.key === 'Control' || e.key === 'Meta') setIframePointerEvents(true);
	}, { passive: true });
	window.addEventListener('blur', () => setIframePointerEvents(true), { passive: true });
	window.addEventListener('keydown', noteActivity, { passive: true });
	window.addEventListener('resize', scheduleImageResizeRefresh, { passive: true });
	window.addEventListener('orientationchange', scheduleImageResizeRefresh, { passive: true });
	window.addEventListener('resize', scheduleStretchRecalc, { passive: true });
	window.addEventListener('orientationchange', scheduleStretchRecalc, { passive: true });
	window.addEventListener('resize', scheduleSearchPlaceholderUpdate, { passive: true });
	window.addEventListener('orientationchange', scheduleSearchPlaceholderUpdate, { passive: true });
	window.addEventListener('resize', syncSearchFocusedLayout, { passive: true });
	window.addEventListener('orientationchange', syncSearchFocusedLayout, { passive: true });
	// Instant offline/online detection
	window.addEventListener('offline', () => {
		clearInflightFetches(); // Clear stuck requests to prevent deadlocks
		invalidatePing();
		setConnectionStatus(false, 'Network offline');
	});
	window.addEventListener('online', () => {
		clearInflightFetches(); // Clear any timed-out requests before retrying
		// Network back - trigger refresh to verify and restore connection
		refresh(false);
	});
	// Helper to calculate time since page was last active
	function getHiddenDuration() {
		const now = Date.now();
		// Prefer lastHiddenTime, fall back to lastActivity
		if (lastHiddenTime) return now - lastHiddenTime;
		if (state.lastActivity) return now - state.lastActivity;
		return 0;
	}

	function markPageHidden() {
		if (resumeReloadArmed) return;
		resumeReloadArmed = true;
		lastHiddenTime = Date.now();
		// Also update lastActivity as backup timestamp
		state.lastActivity = lastHiddenTime;
		stopPing();
		closeStatusNotification();
		if (isTouchDevice()) pauseVideoStreamsForVisibility();
	}

	function handlePageVisible() {
		resumeReloadArmed = false;
		videosPausedForVisibility = false;
		const minHiddenMs = CLIENT_CONFIG.touchReloadMinHiddenMs ?? 60000;
		const hiddenDuration = getHiddenDuration();
		if (isTouchDevice() && hiddenDuration >= minHiddenMs) {
			// Hidden long enough - soft reset to home
			softReset();
		} else {
			// Brief hide - resume where we left off
			resumeVideoStreamsFromVisibility();
			noteActivity();
			refresh(false);
			if (!wsConnection) connectWs();
			startPingDelayed();
		}
		if (state.connectionOk) showStatusNotification();
	}

	// Initialize lastHiddenTime if page loads while hidden
	if (document.visibilityState === 'hidden') {
		lastHiddenTime = Date.now();
		resumeReloadArmed = true;
	}

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') {
			markPageHidden();
		} else {
			handlePageVisible();
		}
	});

	// pagehide is more reliable than visibilitychange on some mobile browsers
	window.addEventListener('pagehide', () => markPageHidden());
	window.addEventListener('beforeunload', () => closeStatusNotification());

	// Handle bfcache restoration (browser killed and reopened)
	window.addEventListener('pageshow', (event) => {
		if (event.persisted && isTouchDevice()) {
			const minHiddenMs = CLIENT_CONFIG.touchReloadMinHiddenMs ?? 60000;
			const hiddenDuration = getHiddenDuration();
			if (hiddenDuration >= minHiddenMs) {
				softReset();
			}
		}
	});
	// Exit video fullscreen on fullscreenchange (browser ESC, back button, etc.)
	document.addEventListener('fullscreenchange', () => {
		if (!document.fullscreenElement) cleanupVideoFullscreen();
	});
	document.addEventListener('webkitfullscreenchange', () => {
		if (!document.webkitFullscreenElement) cleanupVideoFullscreen();
	});

	window.addEventListener('popstate', (event) => {
		const next = event.state;
		if (!next) {
			if (videoFullscreenActive) {
				exitVideoFullscreen();
				return;
			}
			if (imageViewer && !imageViewer.classList.contains('hidden')) {
				closeImageViewer();
				return;
			}
			if (state.stack.length > 0) {
				const prev = state.stack.pop();
				if (prev?.pageUrl) {
					state.pageUrl = prev.pageUrl;
					state.pageTitle = prev.pageTitle || state.pageTitle;
					resetChartAnimState();
					updateNavButtons();
					syncHistory(true);
					queueScrollTop();
					refresh(true);
				} else {
					updateNavButtons();
				}
			}
			return;
		}
		if (next.imageViewer) {
			if (next.pageUrl) {
				state.pageUrl = next.pageUrl;
				state.pageTitle = next.pageTitle || state.pageTitle;
				state.stack = Array.isArray(next.stack) ? next.stack : [];
				updateNavButtons();
			}
			openImageViewer(
				next.imageViewer.url,
				next.imageViewer.refreshMs,
				{ skipHistory: true }
			);
			return;
		}
		if (imageViewer && !imageViewer.classList.contains('hidden')) {
			closeImageViewer();
			if (next.pageUrl && next.pageUrl === state.pageUrl) return;
		}
		if (!next.pageUrl) return;
		state.pageUrl = next.pageUrl;
		state.pageTitle = next.pageTitle || state.pageTitle;
		state.stack = Array.isArray(next.stack) ? next.stack : [];
		resetChartAnimState();
		updateNavButtons();
		queueScrollTop();
		refresh(true);
	});
	els.search.addEventListener('input', () => {
		state.filter = els.search.value;
		updateNavButtons();
		state.searchStateToken += 1;
		cancelSearchStateRequests();
		if (state.filter.trim() && !state.searchIndexReady) buildSearchIndex();
		if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
		const delay = state.isSlim ? SEARCH_DEBOUNCE_SLIM_MS : SEARCH_DEBOUNCE_DEFAULT_MS;
		searchDebounceTimer = setTimeout(() => {
			searchDebounceTimer = null;
			render();
		}, delay);
	});
	els.search.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			e.target.blur();
		}
	});
	els.search.addEventListener('focus', () => {
		syncSearchFocusedLayout();
		if (!state.isSlim && !state.searchIndexReady && !state.searchIndexBuilding) {
			buildSearchIndex();
		}
	});
	els.search.addEventListener('blur', () => {
		syncSearchFocusedLayout();
	});

	els.back.addEventListener('click', () => {
		haptic();
		if (clearSearchFilter()) return;
		popPage();
	});
	els.home.addEventListener('click', () => {
		haptic();
		if (!state.rootPageUrl) return;
		els.search.value = '';
		state.filter = '';
		state.stack = [];
		state.pageUrl = state.rootPageUrl;
		state.pageTitle = state.rootPageTitle || state.pageTitle;
		updateNavButtons();
		syncHistory(false);
		queueScrollTop();
		refresh(true);
	});
	const adminConfigBtn = document.getElementById('adminConfigBtn');
	if (adminConfigBtn) {
		adminConfigBtn.addEventListener('click', () => {
			haptic();
			openAdminConfigModal();
		});
	}
	if (els.logout) {
		els.logout.addEventListener('click', async () => {
			haptic();
			try {
				const res = await fetch('/api/logout', { method: 'POST' });
				const data = await res.json();
				if (data.basicLogout) {
					window.location.href = '/api/logout';
					return;
				}
			} catch (e) {}
			window.location.href = '/';
		});
	}
	updateAdminConfigBtnVisibility();
	updateLogoutBtnVisibility();
	window.addEventListener('resize', updateAdminConfigBtnVisibility);
	window.addEventListener('resize', updateLogoutBtnVisibility);
	if (els.voice) {
		var useVosk = voiceModel === 'vosk';
		if (useVosk || SpeechRecognition) {
			var VOICE_RESPONSE_TIMEOUT_MS = configNumber(CLIENT_CONFIG.voiceResponseTimeoutMs, 10000);

			var recognition = null;
			var isListening = false;
			var isProcessing = false;
			var voiceRequestId = 0;
			var voiceTimeoutId = null;

			// Vosk recording state
			var voskStream = null;
			var voskAudioCtx = null;
			var voskProcessor = null;
			var voskChunks = [];

			// Text-to-speech
			function speakText(text) {
				if (!window.speechSynthesis || !text) return;
				var utterance = new SpeechSynthesisUtterance(text);
				utterance.lang = navigator.language || 'en-US';
				speechSynthesis.speak(utterance);
			}

			// Send transcript to voice command API and handle response
			async function sendVoiceCommand(transcript) {
				isListening = false;
				els.voice.classList.remove('listening');
				els.voice.classList.add('processing');
				isProcessing = true;

				var currentRequestId = ++voiceRequestId;

				voiceTimeoutId = setTimeout(function() {
					if (voiceRequestId === currentRequestId) {
						els.voice.classList.remove('processing');
						isProcessing = false;
						voiceRequestId++;
					}
				}, VOICE_RESPONSE_TIMEOUT_MS);

				try {
					var response = await fetch('/api/voice', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ command: transcript }),
					});
					var data = await response.json();

					clearTimeout(voiceTimeoutId);
					voiceTimeoutId = null;

					if (voiceRequestId !== currentRequestId) return;

					els.voice.classList.remove('processing');
					isProcessing = false;

					if (data.response) {
						speakText(data.response);
					}
				} catch (err) {
					logJsError('voice request failed', err);
					if (voiceTimeoutId) {
						clearTimeout(voiceTimeoutId);
						voiceTimeoutId = null;
					}
					if (voiceRequestId === currentRequestId) {
						els.voice.classList.remove('processing');
						isProcessing = false;
					}
				}
			}

			// Stop Vosk recording and clean up audio resources
			function stopVoskRecording() {
				if (voskProcessor) {
					voskProcessor.disconnect();
					voskProcessor = null;
				}
				if (voskStream) {
					voskStream.getTracks().forEach(function(t) { t.stop(); });
					voskStream = null;
				}
				if (voskAudioCtx) {
					voskAudioCtx.close().catch(function() {});
					voskAudioCtx = null;
				}
			}

			// Reset all voice states to passive
			function resetVoiceState() {
				if (voiceTimeoutId) {
					clearTimeout(voiceTimeoutId);
					voiceTimeoutId = null;
				}
				voiceRequestId++;
				isListening = false;
				isProcessing = false;
				els.voice.classList.remove('listening', 'processing');
				if (recognition) {
					try { recognition.abort(); } catch (e) {}
					recognition = null;
				}
				stopVoskRecording();
				voskChunks = [];
			}

			els.voice.addEventListener('click', function() {
				haptic();

				// If processing, cancel wait and reset to passive
				if (isProcessing) {
					resetVoiceState();
					return;
				}

				if (useVosk) {
					// --- Vosk mode ---
					if (isListening) {
						// Second click: stop recording and send to Vosk
						isListening = false;
						els.voice.classList.remove('listening');

						// Gather collected chunks
						var totalLen = 0;
						for (var i = 0; i < voskChunks.length; i++) totalLen += voskChunks[i].length;
						var pcm = new Int16Array(totalLen);
						var offset = 0;
						for (var j = 0; j < voskChunks.length; j++) {
							pcm.set(voskChunks[j], offset);
							offset += voskChunks[j].length;
						}
						voskChunks = [];
						stopVoskRecording();

						if (pcm.length === 0) return;

						// Transition to processing
						els.voice.classList.add('processing');
						isProcessing = true;
						var currentRequestId = ++voiceRequestId;

						voiceTimeoutId = setTimeout(function() {
							if (voiceRequestId === currentRequestId) {
								els.voice.classList.remove('processing');
								isProcessing = false;
								voiceRequestId++;
							}
						}, VOICE_RESPONSE_TIMEOUT_MS);

						fetch('/api/voice/transcribe', {
							method: 'POST',
							headers: { 'Content-Type': 'application/octet-stream' },
							body: pcm.buffer,
						}).then(function(r) { return r.json(); }).then(function(data) {
							clearTimeout(voiceTimeoutId);
							voiceTimeoutId = null;
							if (voiceRequestId !== currentRequestId) return;
							els.voice.classList.remove('processing');
							isProcessing = false;

							if (data.text && data.text.trim()) {
								sendVoiceCommand(data.text.trim());
							}
						}).catch(function(err) {
							logJsError('vosk transcribe failed', err);
							if (voiceTimeoutId) {
								clearTimeout(voiceTimeoutId);
								voiceTimeoutId = null;
							}
							if (voiceRequestId === currentRequestId) {
								els.voice.classList.remove('processing');
								isProcessing = false;
							}
						});
						return;
					}

					// First click: start recording
					navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } }).then(function(stream) {
						voskStream = stream;
						var AudioCtx = window.AudioContext || window.webkitAudioContext;
						voskAudioCtx = new AudioCtx({ sampleRate: 16000 });
						var source = voskAudioCtx.createMediaStreamSource(stream);
						var actualRate = voskAudioCtx.sampleRate;
						var downsampleRatio = Math.round(actualRate / 16000);
						voskProcessor = voskAudioCtx.createScriptProcessor(4096, 1, 1);
						voskChunks = [];

						// Silence detection: auto-stop after speech ends
						var silenceThreshold = 0.015;
						var silenceDurationMs = 1500;
						var minRecordMs = 500;
						var hadSpeech = false;
						var silenceStart = 0;
						var recordStart = Date.now();

						voskProcessor.onaudioprocess = function(e) {
							var input = e.inputBuffer.getChannelData(0);
							var samples;
							if (downsampleRatio > 1) {
								var outLen = Math.floor(input.length / downsampleRatio);
								samples = new Int16Array(outLen);
								for (var k = 0; k < outLen; k++) {
									var s = input[k * downsampleRatio];
									samples[k] = s < 0 ? Math.max(-32768, s * 32768 | 0) : Math.min(32767, s * 32768 | 0);
								}
							} else {
								samples = new Int16Array(input.length);
								for (var m = 0; m < input.length; m++) {
									var v = input[m];
									samples[m] = v < 0 ? Math.max(-32768, v * 32768 | 0) : Math.min(32767, v * 32768 | 0);
								}
							}
							voskChunks.push(samples);

							// Compute RMS for silence detection
							var sum = 0;
							for (var r = 0; r < input.length; r++) sum += input[r] * input[r];
							var rms = Math.sqrt(sum / input.length);
							var now = Date.now();

							if (rms > silenceThreshold) {
								hadSpeech = true;
								silenceStart = 0;
							} else if (hadSpeech && (now - recordStart) > minRecordMs) {
								if (!silenceStart) silenceStart = now;
								if ((now - silenceStart) >= silenceDurationMs) {
									// Auto-stop: simulate voice button click
									els.voice.click();
								}
							}
						};

						source.connect(voskProcessor);
						voskProcessor.connect(voskAudioCtx.destination);

						isListening = true;
						els.voice.classList.add('listening');
					}).catch(function(err) {
						logJsError('vosk getUserMedia failed', err);
						resetVoiceState();
					});
				} else {
					// --- Browser mode (existing SpeechRecognition flow) ---
					if (isListening) {
						resetVoiceState();
						return;
					}

					recognition = new SpeechRecognition();
					recognition.lang = navigator.language || 'en-US';
					recognition.interimResults = false;
					recognition.maxAlternatives = 1;

					isListening = true;
					els.voice.classList.add('listening');

					recognition.onresult = function(event) {
						var transcript = event.results[0][0].transcript;
						sendVoiceCommand(transcript);
					};

					recognition.onerror = function(e) {
						console.log('Speech recognition error:', e.error);
						logJsError('speech recognition error: ' + (e.error || 'unknown'), e);
						resetVoiceState();
					};

					recognition.onend = function() {
						if (!isProcessing) {
							isListening = false;
							els.voice.classList.remove('listening');
						}
						recognition = null;
					};

					try {
						recognition.start();
					} catch (err) {
						logJsError('speech recognition start failed', err);
						resetVoiceState();
					}
				}
			});
		}
	}
	if (els.themeToggle) els.themeToggle.addEventListener('click', () => { haptic(); toggleTheme(); });
	if (els.lightMode) els.lightMode.addEventListener('click', () => { haptic(); setTheme('light'); });
	if (els.darkMode) els.darkMode.addEventListener('click', () => { haptic(); setTheme('dark'); });
	initTheme(state.forcedMode);
	state.initialStatusText = safeText(els.statusText ? els.statusText.textContent : '');
	scheduleConnectionPending();
	updateStatusBar();

	updateNavButtons();

	try {
		if (window.__OH_HOMEPAGE__) {
			// Use embedded homepage data - no fetch needed
			const hp = window.__OH_HOMEPAGE__;
			state.sitemapName = hp.sitemapName;
			state.pageUrl = hp.pageUrl;
			state.rootPageUrl = hp.pageUrl;
			state.pageTitle = hp.pageTitle;
			state.rootPageTitle = hp.pageTitle;
			state.rawWidgets = hp.widgets;

			syncHistory(true);
			setConnectionStatus(true);
			render();

			// Use embedded sitemap cache if available, otherwise fetch
			if (window.__OH_SITEMAP_CACHE__?.pages) {
				const cache = window.__OH_SITEMAP_CACHE__;
				state.sitemapCache.clear();
				for (const [url, page] of Object.entries(cache.pages)) {
					state.sitemapCache.set(url, page);
				}
				state.sitemapCacheReady = true;
			} else {
				fetchFullSitemap().catch(() => {});
			}
		} else {
			// Fallback: fetch sitemap data
			await loadDefaultSitemap();
			syncHistory(true);
			fetchFullSitemap().catch(() => {});
			await refresh(true);
		}

		startPolling();
		connectWs();
		startPingDelayed();

		reportGps();
	} catch (e) {
		console.error(e);
		logJsError('init bootstrap failed', e);
		const snapshot = loadHomeSnapshot();
		if (snapshot && applyHomeSnapshot(snapshot)) {
			setStatus('');
			setConnectionStatus(false, e.message);
			render();
			startPolling();
			startPingDelayed();
			connectWs();
		} else {
			setStatus(`Init failed: ${e.message}`);
			setConnectionStatus(false, e.message);
		}
	}
})();
