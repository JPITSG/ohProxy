'use strict';

module.exports = {
	// Server configuration.
	server: {
		// Bind address.
		listenHost: '',
		// Bind port.
		listenPort: 0,
		// openHAB target credentials.
		openhab: {
			// openHAB base URL.
			target: '',
			// openHAB username.
			user: '',
			// openHAB password.
			pass: '',
		},
		// Asset version strings.
		assets: {
			// App JS version.
			jsVersion: 'v149',
			// App CSS version.
			cssVersion: 'v146',
			// Apple touch icon version.
			appleTouchIconVersion: 'v1',
		},
		// Icon cache version.
		iconVersion: 'v3',
		// Proxy user-agent.
		userAgent: 'ohProxy/1.0',
		// Icon size in pixels.
		iconSize: 64,
		// Max delta cache size.
		deltaCacheLimit: 50,
		// Proxy logging level.
		proxyLogLevel: 'warn',
		// Log file path.
		logFile: '',
		// Access log file path.
		accessLog: '',
		// Background worker timing.
		backgroundTasks: {
			// Sitemap refresh interval.
			sitemapRefreshMs: 60000,
		},
	},

	// ohProxy.php settings.
	ohProxy: {
		// Config cache TTL.
		configTtlSeconds: 86400,
		// cURL connect timeout.
		connectTimeout: 5,
		// cURL request timeout.
		requestTimeout: 30,
		// Auth users file path.
		usersFile: '',
		// Subnets allowed without auth.
		whitelistSubnets: [],
		// Auth cookie name.
		authCookieName: 'AuthStore',
		// Auth cookie lifetime days.
		authCookieDays: 365,
		// Auth cookie HMAC key.
		authCookieKey: '',
		// Auth failure notify command.
		authFailNotifyCmd: '',
		// Auth failure notify cooldown.
		authFailNotifyCooldown: 900,
	},

	// Allowlist for /proxy?url=.
	proxyAllowlist: [],

	// Client-visible settings.
	client: {
		// LAN subnets for status UI.
		lanSubnets: [],
		// Subsections using valueColor glow.
		glowSections: [],
		// Section fade-out duration.
		pageFadeOutMs: 250,
		// Section fade-in duration.
		pageFadeInMs: 250,
		// Loading label delay.
		loadingDelayMs: 1000,
		// Minimum image refresh.
		minImageRefreshMs: 5000,
		// Image load timeout.
		imageLoadTimeoutMs: 15000,
		// Polling intervals.
		pollIntervalsMs: {
			// Default mode polling.
			default: { active: 2000, idle: 10000 },
			// Slim mode polling.
			slim: { active: 10000, idle: 20000 },
		},
		// Search debounce timing.
		searchDebounceMs: {
			// Default mode debounce.
			default: 250,
			// Slim mode debounce.
			slim: 500,
		},
		// Search state refresh timing.
		searchStateMinIntervalMs: {
			// Default mode minimum.
			default: 10000,
			// Slim mode minimum.
			slim: 20000,
		},
		// Search concurrency limits.
		searchStateConcurrency: {
			// Default mode concurrency.
			default: 4,
			// Slim mode concurrency.
			slim: 2,
		},
		// Slider debounce delay.
		sliderDebounceMs: 250,
		// Idle threshold.
		idleAfterMs: 60000,
		// Activity throttle window.
		activityThrottleMs: 250,
		// Items with hidden titles.
		hideTitleItems: [],
	},
};
