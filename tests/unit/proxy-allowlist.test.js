'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Proxy allowlist helpers replicated from server.js

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function parseProxyAllowEntry(value) {
	const raw = safeText(value).trim();
	if (!raw) return null;
	// Reject non-http/https/rtsp/rtsps schemes (must have :// to be a scheme)
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^(https?|rtsps?):\/\//i.test(raw)) return null;
	const candidate = /^(https?|rtsps?):\/\//i.test(raw) ? raw : `http://${raw}`;
	try {
		const url = new URL(candidate);
		let host = safeText(url.hostname).toLowerCase();
		if (!host) return null;
		// Strip brackets from IPv6 for consistent matching
		if (host.startsWith('[') && host.endsWith(']')) {
			host = host.slice(1, -1);
		}
		return { host, port: safeText(url.port) };
	} catch {
		return null;
	}
}

function normalizeProxyAllowlist(list) {
	if (!Array.isArray(list)) return [];
	const out = [];
	for (const entry of list) {
		const parsed = parseProxyAllowEntry(entry);
		if (parsed) out.push(parsed);
	}
	return out;
}

function targetPortForUrl(url) {
	if (url.port) return url.port;
	if (url.protocol === 'https:') return '443';
	if (url.protocol === 'rtsp:') return '554';
	if (url.protocol === 'rtsps:') return '322';
	return '80';
}

function isProxyTargetAllowed(url, allowlist) {
	if (!allowlist.length) return false;
	const host = safeText(url.hostname).toLowerCase();
	const port = targetPortForUrl(url);
	for (const entry of allowlist) {
		if (entry.host !== host) continue;
		if (!entry.port) return true;
		if (entry.port === port) return true;
	}
	return false;
}

function allowlistFrom(values) {
	return normalizeProxyAllowlist(values);
}

describe('Proxy Allowlist Helpers', () => {
	describe('parseProxyAllowEntry', () => {
		it('returns null for null', () => {
			assert.strictEqual(parseProxyAllowEntry(null), null);
		});

		it('returns null for undefined', () => {
			assert.strictEqual(parseProxyAllowEntry(undefined), null);
		});

		it('returns null for empty string', () => {
			assert.strictEqual(parseProxyAllowEntry(''), null);
		});

		it('returns null for whitespace', () => {
			assert.strictEqual(parseProxyAllowEntry('   '), null);
		});

		it('parses host only', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('example.com'), { host: 'example.com', port: '' });
		});

		it('lowercases host', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('EXAMPLE.COM'), { host: 'example.com', port: '' });
		});

		it('trims whitespace around host', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('  example.com  '), { host: 'example.com', port: '' });
		});

		it('parses host with port', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('example.com:8080'), { host: 'example.com', port: '8080' });
		});

		it('parses http scheme', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('http://example.com'), { host: 'example.com', port: '' });
		});

		it('parses https scheme with port', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('https://example.com:8443'), { host: 'example.com', port: '8443' });
		});

		it('parses rtsp scheme', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('rtsp://camera.local'), { host: 'camera.local', port: '' });
		});

		it('parses rtsps scheme with port', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('rtsps://camera.local:322'), { host: 'camera.local', port: '322' });
		});

		it('parses host with path', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('example.com/path'), { host: 'example.com', port: '' });
		});

		it('parses host with path and port', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('example.com:1234/path'), { host: 'example.com', port: '1234' });
		});

		it('parses host with query', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('example.com?x=1'), { host: 'example.com', port: '' });
		});

		it('parses IPv4 address', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('192.168.1.10'), { host: '192.168.1.10', port: '' });
		});

		it('parses IPv6 address in brackets', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('[::1]'), { host: '::1', port: '' });
		});

		it('rejects invalid URL', () => {
			assert.strictEqual(parseProxyAllowEntry('http://'), null);
		});

		it('rejects invalid port', () => {
			assert.strictEqual(parseProxyAllowEntry('example.com:abc'), null);
		});

		it('rejects unsupported scheme', () => {
			assert.strictEqual(parseProxyAllowEntry('ftp://example.com'), null);
		});

		it('accepts protocol-relative URL as host', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('//example.com'), { host: 'example.com', port: '' });
		});

		it('handles uppercase scheme', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('HTTP://Example.com'), { host: 'example.com', port: '' });
		});

		it('handles userinfo in URL', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('http://user:pass@example.com'), { host: 'example.com', port: '' });
		});

		it('accepts port 0 as string', () => {
			assert.deepStrictEqual(parseProxyAllowEntry('example.com:0'), { host: 'example.com', port: '0' });
		});
	});

	describe('normalizeProxyAllowlist', () => {
		it('returns empty array for null', () => {
			assert.deepStrictEqual(normalizeProxyAllowlist(null), []);
		});

		it('returns empty array for object', () => {
			assert.deepStrictEqual(normalizeProxyAllowlist({}), []);
		});

		it('returns empty array for empty list', () => {
			assert.deepStrictEqual(normalizeProxyAllowlist([]), []);
		});

		it('filters invalid entries', () => {
			const list = normalizeProxyAllowlist(['example.com', 'invalid://', '']);
			assert.strictEqual(list.length, 1);
			assert.strictEqual(list[0].host, 'example.com');
		});

		it('preserves order of valid entries', () => {
			const list = normalizeProxyAllowlist(['b.com', 'a.com']);
			assert.strictEqual(list[0].host, 'b.com');
			assert.strictEqual(list[1].host, 'a.com');
		});

		it('normalizes case and whitespace', () => {
			const list = normalizeProxyAllowlist(['  EXAMPLE.COM  ']);
			assert.deepStrictEqual(list, [{ host: 'example.com', port: '' }]);
		});

		it('keeps duplicates', () => {
			const list = normalizeProxyAllowlist(['example.com', 'example.com']);
			assert.strictEqual(list.length, 2);
		});

		it('handles mixed port and no-port entries', () => {
			const list = normalizeProxyAllowlist(['example.com', 'example.com:8080']);
			assert.strictEqual(list.length, 2);
			assert.strictEqual(list[0].port, '');
			assert.strictEqual(list[1].port, '8080');
		});
	});

	describe('targetPortForUrl', () => {
		it('returns explicit port', () => {
			const url = new URL('http://example.com:8080/path');
			assert.strictEqual(targetPortForUrl(url), '8080');
		});

		it('defaults to 443 for https', () => {
			const url = new URL('https://example.com/path');
			assert.strictEqual(targetPortForUrl(url), '443');
		});

		it('defaults to 80 for http', () => {
			const url = new URL('http://example.com/path');
			assert.strictEqual(targetPortForUrl(url), '80');
		});

		it('returns 443 when explicitly set', () => {
			const url = new URL('https://example.com:443/path');
			assert.strictEqual(targetPortForUrl(url), '443');
		});

		it('returns 80 when explicitly set', () => {
			const url = new URL('http://example.com:80/path');
			assert.strictEqual(targetPortForUrl(url), '80');
		});

		it('returns custom https port', () => {
			const url = new URL('https://example.com:8443/path');
			assert.strictEqual(targetPortForUrl(url), '8443');
		});

		it('defaults to 554 for rtsp', () => {
			const url = new URL('rtsp://camera.local/path');
			assert.strictEqual(targetPortForUrl(url), '554');
		});

		it('defaults to 322 for rtsps', () => {
			const url = new URL('rtsps://camera.local/path');
			assert.strictEqual(targetPortForUrl(url), '322');
		});
	});

	describe('isProxyTargetAllowed', () => {
		it('returns false for empty allowlist', () => {
			const url = new URL('http://example.com');
			assert.strictEqual(isProxyTargetAllowed(url, []), false);
		});

		it('allows host-only match for http', () => {
			const list = allowlistFrom(['example.com']);
			const url = new URL('http://example.com/path');
			assert.strictEqual(isProxyTargetAllowed(url, list), true);
		});

		it('allows host-only match for https', () => {
			const list = allowlistFrom(['example.com']);
			const url = new URL('https://example.com/path');
			assert.strictEqual(isProxyTargetAllowed(url, list), true);
		});

		it('rejects different host', () => {
			const list = allowlistFrom(['example.com']);
			const url = new URL('http://other.com/path');
			assert.strictEqual(isProxyTargetAllowed(url, list), false);
		});

		it('allows matching host and port', () => {
			const list = allowlistFrom(['example.com:8080']);
			const url = new URL('http://example.com:8080/path');
			assert.strictEqual(isProxyTargetAllowed(url, list), true);
		});

		it('rejects matching host with different port', () => {
			const list = allowlistFrom(['example.com:8080']);
			const url = new URL('http://example.com:9090/path');
			assert.strictEqual(isProxyTargetAllowed(url, list), false);
		});

		it('matches https default port 443', () => {
			const list = allowlistFrom(['example.com:443']);
			const url = new URL('https://example.com/path');
			assert.strictEqual(isProxyTargetAllowed(url, list), true);
		});

		it('matches http default port 80', () => {
			const list = allowlistFrom(['example.com:80']);
			const url = new URL('http://example.com/path');
			assert.strictEqual(isProxyTargetAllowed(url, list), true);
		});

		it('rejects when port-specific entry does not match scheme default', () => {
			const list = allowlistFrom(['example.com:8080']);
			const url = new URL('https://example.com/path');
			assert.strictEqual(isProxyTargetAllowed(url, list), false);
		});

		it('allows explicit port that matches allowlist', () => {
			const list = allowlistFrom(['example.com:8080']);
			const url = new URL('https://example.com:8080/path');
			assert.strictEqual(isProxyTargetAllowed(url, list), true);
		});

		it('matches host regardless of case', () => {
			const list = allowlistFrom(['example.com']);
			const url = new URL('http://EXAMPLE.COM/path');
			assert.strictEqual(isProxyTargetAllowed(url, list), true);
		});

		it('uses second entry when first does not match', () => {
			const list = allowlistFrom(['one.com', 'two.com']);
			const url = new URL('http://two.com/path');
			assert.strictEqual(isProxyTargetAllowed(url, list), true);
		});

		it('returns false when no entries match', () => {
			const list = allowlistFrom(['one.com', 'two.com']);
			const url = new URL('http://three.com/path');
			assert.strictEqual(isProxyTargetAllowed(url, list), false);
		});

		it('allows any port when allowlist port is empty', () => {
			const list = allowlistFrom(['example.com']);
			const url = new URL('http://example.com:1234/path');
			assert.strictEqual(isProxyTargetAllowed(url, list), true);
		});

		it('matches rtsp default port 554', () => {
			const list = allowlistFrom(['camera.local:554']);
			const url = new URL('rtsp://camera.local/path');
			assert.strictEqual(isProxyTargetAllowed(url, list), true);
		});

		it('matches rtsps default port 322', () => {
			const list = allowlistFrom(['camera.local:322']);
			const url = new URL('rtsps://camera.local/path');
			assert.strictEqual(isProxyTargetAllowed(url, list), true);
		});
	});
});
