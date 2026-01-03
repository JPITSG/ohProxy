'use strict';

module.exports = {
	// Server configuration.
	server: {
		// HTTP listener settings.
		http: {
			// Enable HTTP listener.
			enabled: false,
			// HTTP bind address.
			host: '',
			// HTTP bind port.
			port: 0,
		},
		// HTTPS listener settings.
		https: {
			// Enable HTTPS listener.
			enabled: false,
			// HTTPS bind address.
			host: '',
			// HTTPS bind port.
			port: 0,
			// TLS certificate path.
			certFile: '',
			// TLS key path.
			keyFile: '',
		},
		// Allowed client subnets.
		allowSubnets: [],
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
			jsVersion: 'v1',
			// App CSS version.
			cssVersion: 'v1',
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
		// Allowlist for /proxy?url=.
		proxyAllowlist: [],
		// LAN subnets for status UI.
		lanSubnets: [],
		// Basic auth settings.
		auth: {
			// Basic auth users file.
			usersFile: '',
			// Subnets that bypass auth.
			whitelistSubnets: [],
			// Basic auth realm label.
			realm: 'openHAB Proxy',
			// Auth cookie name.
			cookieName: 'AuthStore',
			// Auth cookie lifetime days.
			cookieDays: 365,
			// Auth cookie HMAC key.
			cookieKey: '',
		},
		// Background worker timing.
		backgroundTasks: {
			// Sitemap refresh interval.
			sitemapRefreshMs: 60000,
		},
	},

	// Client-visible settings.
	client: {
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
