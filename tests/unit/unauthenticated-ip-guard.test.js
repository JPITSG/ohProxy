'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createUnauthenticatedIpGuard } = require('../../lib/unauthenticated-ip-guard');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function read(relPath) {
	return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

function createHarness(config = {}) {
	let now = 100000;
	const logs = [];
	const blacklist = new Map();
	const guard = createUnauthenticatedIpGuard({
		config: {
			enabled: true,
			graceSeconds: 60,
			autoBlacklistTtlSeconds: 3600,
			maxPending: 100,
			...config,
		},
		nowMs: () => now,
		log: (message) => logs.push(message),
		isExemptIp: (ip) => ip.startsWith('203.0.113.'),
		getBlacklistEntry: (ip) => blacklist.get(ip) || null,
		addBlacklistEntry: (ip, entry) => blacklist.set(ip, { ip, ...entry }),
	});
	return {
		guard,
		logs,
		blacklist,
		advance: (ms) => { now += ms; },
	};
}

function request(ip, overrides = {}) {
	return {
		ip,
		authenticated: false,
		method: 'GET',
		path: '/',
		socketIp: '203.0.113.1',
		forwardedFor: ip,
		userAgent: 'test',
		...overrides,
	};
}

describe('Unauthenticated IP guard manager', () => {
	it('skips exempt resolved client IPs and logs the pass once', () => {
		const { guard, logs, blacklist } = createHarness();
		const first = guard.evaluate(request('203.0.113.44'));
		const second = guard.evaluate(request('203.0.113.44'));
		assert.strictEqual(first.allowed, true);
		assert.strictEqual(first.reason, 'exempt');
		assert.strictEqual(second.allowed, true);
		assert.strictEqual(blacklist.size, 0);
		assert.strictEqual(logs.filter((line) => line.includes('Exempt client 203.0.113.44 passed guard')).length, 1);
	});

	it('starts a fixed grace window and auto-blacklists after the deadline', () => {
		const { guard, logs, blacklist, advance } = createHarness({ graceSeconds: 2, autoBlacklistTtlSeconds: 10 });
		const first = guard.evaluate(request('198.51.100.10'));
		assert.strictEqual(first.allowed, true);
		assert.strictEqual(first.reason, 'pending');
		advance(1000);
		const second = guard.evaluate(request('198.51.100.10', { path: '/login.v1.js' }));
		assert.strictEqual(second.allowed, true);
		assert.strictEqual(second.reason, 'pending');
		advance(1000);
		const blocked = guard.evaluate(request('198.51.100.10', { path: '/api/data' }));
		assert.strictEqual(blocked.allowed, false);
		assert.strictEqual(blocked.reason, 'grace-expired');
		assert.strictEqual(blacklist.get('198.51.100.10').source, 'auto');
		assert.strictEqual(blacklist.get('198.51.100.10').expiresAt, 112);
		assert.ok(logs.some((line) => line.includes('Started 2s login grace window for 198.51.100.10')));
		assert.ok(logs.some((line) => line.includes('Blacklisted 198.51.100.10 after 2s')));
	});

	it('clears pending state when the client authenticates before expiry', () => {
		const { guard, blacklist, advance } = createHarness({ graceSeconds: 2 });
		assert.strictEqual(guard.evaluate(request('198.51.100.20')).allowed, true);
		advance(1000);
		const authed = guard.evaluate(request('198.51.100.20', { authenticated: true }));
		assert.strictEqual(authed.allowed, true);
		assert.strictEqual(authed.reason, 'authenticated');
		advance(5000);
		assert.strictEqual(guard.expirePending(), 0);
		assert.strictEqual(blacklist.size, 0);
		assert.deepStrictEqual(guard.listPending(), []);
	});

	it('blocks already-blacklisted IPs before creating pending state', () => {
		const { guard, blacklist } = createHarness();
		blacklist.set('198.51.100.30', { ip: '198.51.100.30', source: 'manual' });
		const blocked = guard.evaluate(request('198.51.100.30'));
		assert.strictEqual(blocked.allowed, false);
		assert.strictEqual(blocked.reason, 'blacklisted');
		assert.deepStrictEqual(guard.listPending(), []);
	});

	it('exposes the guard and trusted proxy settings in defaults and the admin schema', () => {
		const defaults = read('config.defaults.js');
		const app = read('public/app.js');
		const lang = read('public/lang.js');
		assert.match(defaults, /trustedProxySubnets:\s*\[\]/, 'missing trustedProxySubnets default');
		assert.match(defaults, /unauthenticatedIpGuard:\s*\{[\s\S]*graceSeconds:\s*60/, 'missing unauthenticated IP guard defaults');
		assert.match(app, /id:\s*'unauthenticated-ip-guard'/, 'missing admin settings section');
		assert.match(app, /server\.unauthenticatedIpGuard\.exemptSubnets/, 'missing guard exempt subnet field');
		assert.match(lang, /UNAUTHENTICATED IP GUARD/, 'missing guard settings title');
	});
});
