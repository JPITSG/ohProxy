'use strict';

module.exports = {
	// Server configuration.
	server: {
		// === Listeners ===
		http: {
			// Enable HTTP listener (true/false).
			enabled: false,
			// HTTP bind address (IP/hostname, e.g. 0.0.0.0).
			host: '',
			// HTTP bind port (1-65535).
			port: 0,
		},
		https: {
			// Enable HTTPS listener (true/false).
			enabled: false,
			// HTTPS bind address (IP/hostname, e.g. 0.0.0.0).
			host: '',
			// HTTPS bind port (1-65535).
			port: 0,
			// TLS certificate file (absolute path).
			certFile: '',
			// TLS key file (absolute path).
			keyFile: '',
			// Enable HTTP/2 via ALPN (true/false).
			http2: false,
		},

		// === Upstream Connection ===
		openhab: {
			// openHAB base URL (http/https URL, e.g. http://127.0.0.1:8080).
			target: '',
			// openHAB username (optional, for Basic Auth).
			user: '',
			// openHAB password (optional, for Basic Auth).
			pass: '',
			// openHAB 3.x API token (optional, takes precedence over user/pass).
			// Generate via openHAB UI: Settings > API Security > Create new API token.
			apiToken: '',
		},

		// === Database ===
		mysql: {
			// Unix socket path (if set, host/port ignored).
			socket: '',
			// MySQL host.
			host: '',
			// MySQL port.
			port: '',
			// MySQL database name.
			database: '',
			// MySQL username.
			username: '',
			// MySQL password.
			password: '',
		},

		// === Authentication & Access Control ===
		auth: {
			// Auth mode ('basic' for HTTP Basic Auth, 'html' for HTML form login).
			mode: 'basic',
			// Basic auth realm label (string; non-empty).
			realm: 'openHAB Proxy',
			// Auth cookie name (string; empty disables cookie auth).
			cookieName: 'AuthStore',
			// Auth cookie lifetime days (integer; >=0, must be >0 when cookieKey set).
			cookieDays: 365,
			// Auth cookie HMAC key (string; empty disables cookie auth).
			cookieKey: '',
			// Auth failure notify command (shell; {IP} placeholder; empty disables).
			authFailNotifyCmd: '',
			// Auth failure notify interval (minutes; >=1; rate limit for notification commands).
			authFailNotifyIntervalMins: 15,
		},
		// Access control for the wrapper server (IPv4 CIDR list; required, use 0.0.0.0/0 to allow all).
		allowSubnets: [],

		// === Security Headers ===
		securityHeaders: {
			// Enable security headers (true/false).
			enabled: true,
			// HSTS settings (HTTPS only).
			hsts: {
				// Enable HSTS header (true/false).
				enabled: true,
				// HSTS max-age in seconds (int; >=0).
				maxAge: 31536000,
				// Include subdomains in HSTS (true/false).
				includeSubDomains: true,
				// Enable preload directive (true/false).
				preload: false,
			},
			// Content-Security-Policy settings.
			csp: {
				// Enable CSP header (true/false).
				enabled: true,
				// Use report-only mode (true/false).
				reportOnly: false,
				// CSP policy string (empty disables).
				policy: "default-src 'self'; img-src 'self' data: https: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https:; font-src 'self' data:; frame-src 'self' https:;",
			},
			// Referrer-Policy value (same-origin|no-referrer|strict-origin-when-cross-origin|etc).
			// Note: 'same-origin' is required for auth-exempt assets to work correctly.
			referrerPolicy: 'same-origin',
		},

		// === Proxy Settings ===
		// Allowlist for /proxy?url= (host or host:port; required, non-empty).
		proxyAllowlist: [],
		// Webview URLs matching these hosts bypass /proxy and load directly (host or host:port).
		webviewNoProxy: [],
		// Proxy user-agent (string; non-empty).
		userAgent: 'ohProxy/1.0',

		// === Assets ===
		assets: {
			// Combined version for JS, CSS, and service worker (v### or ###).
			// When any asset changes, increment this to bust all caches together.
			assetVersion: 'v1',
			// Apple touch icon version (v### or ###).
			appleTouchIconVersion: 'v1',
			// Icon cache version (v### or ###).
			iconVersion: 'v1',
		},

		// === Icons ===
		// Icon size in pixels (integer >=1).
		iconSize: 64,
		// Max concurrent icon conversions (integer >=1).
		iconCacheConcurrency: 5,

		// === Caching ===
		// Max delta cache size (integer >=1).
		deltaCacheLimit: 50,

		// === Logging ===
		// Log file path (absolute; empty disables).
		logFile: '',
		// Access log file path (absolute; empty disables).
		accessLog: '',
		// JavaScript error log file path (absolute; empty disables).
		jsLogFile: '',
		// Access log verbosity (all or 400+).
		accessLogLevel: 'all',
		// Proxy middleware logging level (silent|error|warn|info|debug).
		proxyMiddlewareLogLevel: 'warn',
		// Slow query threshold (ms; 0 disables; logs requests exceeding this duration).
		slowQueryMs: 0,

		// === Sessions ===
		// Session max age in days before cleanup (integer; >=1).
		sessionMaxAgeDays: 14,

		// === Background Tasks ===
		backgroundTasks: {
			// Sitemap refresh interval (ms; >=1000).
			sitemapRefreshMs: 60000,
		},

		// === WebSocket ===
		websocket: {
			// WebSocket update mode ('polling', 'atmosphere', or 'sse').
			// polling: Polls openHAB REST API at interval, compares states, sends only changes.
			// atmosphere: Uses openHAB 1.x/2.x Atmosphere long-polling for real-time updates.
			// sse: Uses openHAB 3.x Server-Sent Events for real-time updates.
			mode: 'polling',
			// Polling interval in ms when clients are focused (>=100).
			pollingIntervalMs: 500,
			// Polling interval in ms when all clients are unfocused/background (>=100).
			pollingIntervalBgMs: 2000,
			// Warn if no Atmosphere item updates are received for this many ms (0 disables).
			atmosphereNoUpdateWarnMs: 5000,
			// Delay before marking backend as OK after recovery (ms; 0 disables).
			// Gives OpenHAB time to fully initialize before clients refresh.
			backendRecoveryDelayMs: 0,
		},

		// === Features ===
		// Group items whose state is calculated from member states.
		// For each group name listed, the proxy fetches member items and counts
		// those with state "OPEN" (OPEN=+1, CLOSED=0). The calculated count
		// replaces the group's native state in sitemap responses.
		groupItems: [],
		// Video preview screenshot configuration.
		videoPreview: {
			// Interval to capture preview frames from RTSP streams (ms; 0 = disabled).
			intervalMs: 900000,
			// Delete preview images older than this (hours; >=1).
			pruneAfterHours: 24,
		},
		// Command API configuration.
		cmdapi: {
			// Enable /CMD endpoint (true/false).
			enabled: false,
			// Allowed subnets for /CMD requests (IPv4 CIDR list; empty blocks all).
			allowedSubnets: [],
			// Allowed items for /CMD requests (item names; '*' allows all; empty blocks all).
			allowedItems: [],
		},

		// === System ===
		binaries: {
			// FFmpeg binary path (used for RTSP streaming and video previews).
			ffmpeg: '/usr/bin/ffmpeg',
			// ImageMagick convert binary path (used for icon conversion).
			convert: '/usr/bin/convert',
			// Shell binary path (used for auth failure notification commands).
			shell: '/bin/sh',
		},
		paths: {
			// RRD4J persistence directory (for chart generation).
			rrd: '',
		},

		// === External Services ===
		apiKeys: {
			// Anthropic API key (for Claude AI integration).
			anthropic: '',
		},
		weatherbit: {
			// Weatherbit API key (get from weatherbit.io).
			apiKey: '',
			// Location latitude (decimal, e.g. 51.5074).
			latitude: '',
			// Location longitude (decimal, e.g. -0.1278).
			longitude: '',
			// Temperature units ('M' = Celsius, 'I' = Fahrenheit).
			units: 'M',
			// Data refresh interval in milliseconds (default: 1 hour).
			refreshIntervalMs: 3600000,
		},
	},

	// Client-visible settings.
	client: {
		// Site name override for header display (empty string uses sitemap name).
		siteName: '',

		// === Page Transitions ===
		// Section fade-out duration (ms; >=0).
		pageFadeOutMs: 250,
		// Section fade-in duration (ms; >=0).
		pageFadeInMs: 250,
		// Loading label delay (ms; >=0).
		loadingDelayMs: 1000,

		// === Images ===
		// Minimum image refresh (ms; >=0).
		minImageRefreshMs: 5000,
		// Image load timeout (ms; >=0).
		imageLoadTimeoutMs: 15000,

		// === Polling ===
		// Polling intervals (ms; default/slim; active/idle >=1).
		pollIntervalsMs: {
			// Default mode polling (ms; >=1).
			default: { active: 2000, idle: 10000 },
			// Slim mode polling (ms; >=1).
			slim: { active: 10000, idle: 20000 },
		},

		// === Search ===
		// Search debounce timing (ms; default/slim; >=0).
		searchDebounceMs: {
			// Default mode debounce (ms; >=0).
			default: 250,
			// Slim mode debounce (ms; >=0).
			slim: 500,
		},
		// Search state refresh timing (ms; default/slim; >=0).
		searchStateMinIntervalMs: {
			// Default mode minimum (ms; >=0).
			default: 10000,
			// Slim mode minimum (ms; >=0).
			slim: 20000,
		},
		// Search concurrency limits (int; default/slim; >=1).
		searchStateConcurrency: {
			// Default mode concurrency (int; >=1).
			default: 4,
			// Slim mode concurrency (int; >=1).
			slim: 2,
		},

		// === UI Behavior ===
		// Slider debounce delay (ms; >=0).
		sliderDebounceMs: 250,
		// Idle threshold (ms; >=0).
		idleAfterMs: 60000,
		// Activity throttle window (ms; >=0).
		activityThrottleMs: 250,
		// Items with hidden titles (item names; case-insensitive; empty allowed).
		hideTitleItems: [],
		// Minimum time app must be hidden before visibility-triggered reload (ms; >=0).
		// Prevents unnecessary reloads when quickly switching apps.
		iframeReloadMinHiddenMs: 60000,

		// === Voice ===
		// Voice response timeout (ms; >=0).
		voiceResponseTimeoutMs: 10000,
	},
};
