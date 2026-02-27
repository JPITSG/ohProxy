'use strict';

function toFiniteNumber(value, fallback = 0) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function cloneEntry(entry) {
	if (!entry) return null;
	return {
		failures: Array.isArray(entry.failures) ? entry.failures.slice() : [],
		lockUntil: toFiniteNumber(entry.lockUntil, 0),
		lastFailAt: toFiniteNumber(entry.lastFailAt, 0),
	};
}

function createAuthLockoutManager(options = {}) {
	const state = options.state instanceof Map ? options.state : new Map();
	const threshold = Math.max(1, toFiniteNumber(options.threshold, 3));
	const windowMs = Math.max(1000, toFiniteNumber(options.windowMs, 10 * 60 * 1000));
	const lockoutMs = Math.max(1000, toFiniteNumber(options.lockoutMs, 15 * 60 * 1000));
	const staleMs = Math.max(lockoutMs, toFiniteNumber(options.staleMs, lockoutMs));

	function normalizeFailures(failures, now) {
		if (!Array.isArray(failures) || !failures.length) return [];
		const cutoff = now - windowMs;
		const kept = [];
		for (const ts of failures) {
			const n = toFiniteNumber(ts, NaN);
			if (!Number.isFinite(n)) continue;
			if (n < cutoff || n > now) continue;
			kept.push(n);
		}
		return kept;
	}

	function normalizeEntry(rawEntry, now) {
		if (!rawEntry || typeof rawEntry !== 'object') return null;
		const failures = normalizeFailures(rawEntry.failures, now);
		let lockUntil = toFiniteNumber(rawEntry.lockUntil, 0);
		if (lockUntil && lockUntil <= now) {
			lockUntil = 0;
		}
		if (!lockUntil && failures.length === 0) {
			return null;
		}
		return {
			failures,
			lockUntil,
			lastFailAt: failures[failures.length - 1] || 0,
		};
	}

	function get(key, now = Date.now()) {
		if (!key) return null;
		const raw = state.get(key);
		const normalized = normalizeEntry(raw, toFiniteNumber(now, Date.now()));
		return cloneEntry(normalized);
	}

	function recordFailure(key, now = Date.now()) {
		if (!key) return null;
		const tsNow = toFiniteNumber(now, Date.now());
		const normalized = normalizeEntry(state.get(key), tsNow);
		const failures = normalized ? normalized.failures : [];
		failures.push(tsNow);
		const next = {
			failures,
			lockUntil: failures.length >= threshold ? tsNow + lockoutMs : 0,
			lastFailAt: tsNow,
		};
		state.set(key, next);
		return cloneEntry(next);
	}

	function clear(key) {
		if (!key) return;
		state.delete(key);
	}

	function prune(now = Date.now()) {
		const tsNow = toFiniteNumber(now, Date.now());
		for (const [key, raw] of state) {
			const normalized = normalizeEntry(raw, tsNow);
			if (!normalized) {
				state.delete(key);
				continue;
			}
			if (!normalized.lockUntil && normalized.lastFailAt && tsNow - normalized.lastFailAt > staleMs) {
				state.delete(key);
				continue;
			}
			state.set(key, normalized);
		}
	}

	function remainingSeconds(entry, now = Date.now()) {
		const until = toFiniteNumber(entry?.lockUntil, 0);
		if (!until) return 0;
		return Math.max(0, Math.ceil((until - toFiniteNumber(now, Date.now())) / 1000));
	}

	return {
		get,
		recordFailure,
		clear,
		prune,
		remainingSeconds,
		_state: state,
	};
}

module.exports = {
	createAuthLockoutManager,
};
