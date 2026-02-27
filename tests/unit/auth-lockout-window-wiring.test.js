'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAuthLockoutManager } = require('../../lib/auth-lockout');

const TEN_MINUTES_MS = 10 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function buildManager(state = new Map()) {
	return createAuthLockoutManager({
		state,
		threshold: 3,
		windowMs: TEN_MINUTES_MS,
		lockoutMs: FIFTEEN_MINUTES_MS,
		staleMs: FIFTEEN_MINUTES_MS,
	});
}

describe('Auth lockout manager behavior', () => {
	it('triggers lockout on the third failure within the 10-minute window', () => {
		const manager = buildManager();
		const key = '192.168.1.50';
		const start = 1_700_000_000_000;

		const first = manager.recordFailure(key, start);
		const second = manager.recordFailure(key, start + 1_000);
		const third = manager.recordFailure(key, start + 2_000);

		assert.equal(first.lockUntil, 0);
		assert.equal(second.lockUntil, 0);
		assert.equal(third.lockUntil, start + 2_000 + FIFTEEN_MINUTES_MS);
		assert.equal(third.failures.length, 3);
	});

	it('uses a sliding window so old failures do not count toward lockout', () => {
		const manager = buildManager();
		const key = '192.168.1.60';
		const start = 1_700_000_000_000;

		manager.recordFailure(key, start);
		manager.recordFailure(key, start + 1_000);

		const afterGap = manager.recordFailure(key, start + TEN_MINUTES_MS + 10_000);
		assert.equal(afterGap.lockUntil, 0);
		assert.equal(afterGap.failures.length, 1);
	});

	it('clears lockout state after lockout expiry time passes', () => {
		const manager = buildManager();
		const key = '192.168.1.61';
		const start = 1_700_000_000_000;

		manager.recordFailure(key, start);
		manager.recordFailure(key, start + 1_000);
		const third = manager.recordFailure(key, start + 2_000);
		assert.ok(third.lockUntil > 0);

		const duringLockout = manager.get(key, third.lockUntil - 1);
		assert.ok(duringLockout);
		assert.equal(duringLockout.lockUntil, third.lockUntil);

		const afterLockout = manager.get(key, third.lockUntil + 1);
		assert.equal(afterLockout, null);
	});

	it('get is read-only and returns a cloned entry', () => {
		const now = 1_700_000_000_000;
		const key = '192.168.1.70';
		const state = new Map();
		const raw = {
			failures: [now - 1_000, now + 1_000, 'bad'],
			lockUntil: now - 5_000,
			lastFailAt: now - 1_000,
		};
		state.set(key, raw);
		const manager = buildManager(state);
		const before = JSON.stringify(state.get(key));

		const entry = manager.get(key, now);
		assert.deepEqual(entry, {
			failures: [now - 1_000],
			lockUntil: 0,
			lastFailAt: now - 1_000,
		});
		assert.equal(JSON.stringify(state.get(key)), before);
		assert.strictEqual(state.get(key), raw);

		entry.failures.push(now - 500);
		assert.equal(raw.failures.length, 3);
	});

	it('prune removes invalid/stale entries and normalizes kept entries', () => {
		const now = 1_700_000_000_000;
		const state = new Map([
			['remove-empty', { failures: [], lockUntil: 0, lastFailAt: now - (30 * 60 * 1000) }],
			['remove-old', { failures: [now - TEN_MINUTES_MS - 1], lockUntil: 0, lastFailAt: now - TEN_MINUTES_MS - 1 }],
			['keep-locked', { failures: [now - 1_000], lockUntil: now + 60_000, lastFailAt: now - 1_000 }],
			['normalize', { failures: [now - 2_000, now + 5_000, 'bad'], lockUntil: 0, lastFailAt: now - 2_000 }],
		]);
		const manager = buildManager(state);

		manager.prune(now);

		assert.equal(state.has('remove-empty'), false);
		assert.equal(state.has('remove-old'), false);
		assert.equal(state.has('keep-locked'), true);
		assert.equal(state.has('normalize'), true);
		assert.deepEqual(state.get('normalize'), {
			failures: [now - 2_000],
			lockUntil: 0,
			lastFailAt: now - 2_000,
		});
	});

	it('remainingSeconds rounds up and never returns negative values', () => {
		const manager = buildManager();
		const now = 1_700_000_000_000;

		assert.equal(manager.remainingSeconds({ lockUntil: now + 1 }, now), 1);
		assert.equal(manager.remainingSeconds({ lockUntil: now + 1_001 }, now), 2);
		assert.equal(manager.remainingSeconds({ lockUntil: now - 1 }, now), 0);
		assert.equal(manager.remainingSeconds(null, now), 0);
	});
});
