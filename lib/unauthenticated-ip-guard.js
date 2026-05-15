'use strict';

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function normalizePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
	const num = Number(value);
	if (!Number.isFinite(num)) return fallback;
	const intVal = Math.floor(num);
	if (intVal < min) return fallback;
	return Math.min(intVal, max);
}

function normalizeNonNegativeInteger(value, fallback, { max = Number.MAX_SAFE_INTEGER } = {}) {
	const num = Number(value);
	if (!Number.isFinite(num)) return fallback;
	const intVal = Math.floor(num);
	if (intVal < 0) return fallback;
	return Math.min(intVal, max);
}

function createUnauthenticatedIpGuard(options = {}) {
	const nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now();
	const log = typeof options.log === 'function' ? options.log : () => {};
	const isExemptIp = typeof options.isExemptIp === 'function' ? options.isExemptIp : () => false;
	const getBlacklistEntry = typeof options.getBlacklistEntry === 'function' ? options.getBlacklistEntry : () => null;
	const addBlacklistEntry = typeof options.addBlacklistEntry === 'function' ? options.addBlacklistEntry : () => {};

	let config = {
		enabled: false,
		graceSeconds: 60,
		autoBlacklistTtlSeconds: 86400,
		maxPending: 10000,
	};

	const pending = new Map();
	const loggedExempt = new Set();
	const loggedAuthenticated = new Set();

	function configure(next = {}) {
		config = {
			enabled: next.enabled === true,
			graceSeconds: normalizePositiveInteger(next.graceSeconds, 60, { min: 1, max: 86400 }),
			autoBlacklistTtlSeconds: normalizeNonNegativeInteger(next.autoBlacklistTtlSeconds, 86400, { max: 315360000 }),
			maxPending: normalizePositiveInteger(next.maxPending, 10000, { min: 1, max: 1000000 }),
		};
		if (!config.enabled) {
			pending.clear();
			return;
		}
		prunePending();
	}

	function pendingDeadline(firstSeenMs) {
		return firstSeenMs + (config.graceSeconds * 1000);
	}

	function evictOldestPendingIfNeeded() {
		while (pending.size >= config.maxPending) {
			let oldestIp = '';
			let oldestTs = Infinity;
			for (const [ip, entry] of pending.entries()) {
				if (entry.firstSeenMs < oldestTs) {
					oldestTs = entry.firstSeenMs;
					oldestIp = ip;
				}
			}
			if (!oldestIp) break;
			pending.delete(oldestIp);
			log(`[UnauthGuard] Dropped oldest pending IP ${oldestIp} because maxPending=${config.maxPending} was reached`);
		}
	}

	function prunePending(now = nowMs()) {
		if (pending.size <= config.maxPending) return;
		const entries = Array.from(pending.entries())
			.sort((a, b) => a[1].firstSeenMs - b[1].firstSeenMs);
		const removeCount = pending.size - config.maxPending;
		for (let i = 0; i < removeCount; i++) {
			pending.delete(entries[i][0]);
		}
		for (const [ip, entry] of pending.entries()) {
			if (entry.deadlineMs && entry.deadlineMs < now - 60000) {
				pending.delete(ip);
			}
		}
	}

	function clearPending(ip, reason = 'authenticated') {
		const key = safeText(ip).trim();
		if (!key) return false;
		const existed = pending.delete(key);
		if (existed) {
			log(`[UnauthGuard] Cleared pending IP ${key} (${reason})`);
		}
		return existed;
	}

	function clearAllPending() {
		const count = pending.size;
		pending.clear();
		return count;
	}

	function listPending(now = nowMs()) {
		const rows = [];
		for (const [ip, entry] of pending.entries()) {
			rows.push({
				ip,
				firstSeen: Math.floor(entry.firstSeenMs / 1000),
				lastSeen: Math.floor(entry.lastSeenMs / 1000),
				deadline: Math.floor(entry.deadlineMs / 1000),
				remainingSeconds: Math.max(0, Math.ceil((entry.deadlineMs - now) / 1000)),
				requestCount: entry.requestCount,
				method: entry.method,
				path: entry.path,
				socketIp: entry.socketIp,
				forwardedFor: entry.forwardedFor,
				userAgent: entry.userAgent,
			});
		}
		rows.sort((a, b) => a.deadline - b.deadline || a.ip.localeCompare(b.ip));
		return rows;
	}

	function expirePending(now = nowMs()) {
		if (!config.enabled) return 0;
		let expired = 0;
		for (const [ip, entry] of Array.from(pending.entries())) {
			if (now < entry.deadlineMs) continue;
			pending.delete(ip);
			const nowSec = Math.floor(now / 1000);
			const expiresAt = config.autoBlacklistTtlSeconds > 0
				? nowSec + config.autoBlacklistTtlSeconds
				: null;
			addBlacklistEntry(ip, {
				source: 'auto',
				reason: `No successful authentication within ${config.graceSeconds}s`,
				createdAt: nowSec,
				expiresAt,
				firstSeen: Math.floor(entry.firstSeenMs / 1000),
				lastSeen: Math.floor(entry.lastSeenMs / 1000),
				path: entry.path,
				userAgent: entry.userAgent,
			});
			log(`[UnauthGuard] Blacklisted ${ip} after ${config.graceSeconds}s without successful authentication (deadline expired)`);
			expired += 1;
		}
		return expired;
	}

	function describeRequest(ctx) {
		const parts = [];
		const method = safeText(ctx.method).trim();
		const path = safeText(ctx.path || ctx.url).trim();
		if (method || path) parts.push(`${method || 'REQUEST'} ${path || '/'}`.trim());
		const socketIp = safeText(ctx.socketIp).trim();
		if (socketIp && socketIp !== ctx.ip) parts.push(`socket=${socketIp}`);
		const forwardedFor = safeText(ctx.forwardedFor).trim();
		if (forwardedFor) parts.push(`xff=${forwardedFor}`);
		return parts.length ? ` (${parts.join(', ')})` : '';
	}

	function blockDecision(ip, reason, entry = null) {
		return {
			allowed: false,
			status: 403,
			ip,
			reason,
			blacklistEntry: entry,
		};
	}

	function allowDecision(ip, reason, extra = {}) {
		return {
			allowed: true,
			status: 200,
			ip,
			reason,
			...extra,
		};
	}

	function evaluate(ctx = {}) {
		if (!config.enabled) return allowDecision('', 'disabled');

		const ip = safeText(ctx.ip).trim();
		if (!ip) {
			log(`[UnauthGuard] Passed request with unknown client IP${describeRequest(ctx)}`);
			return allowDecision('', 'unknown-ip');
		}

		if (isExemptIp(ip, ctx)) {
			clearPending(ip, 'exempt');
			if (!loggedExempt.has(ip)) {
				log(`[UnauthGuard] Exempt client ${ip} passed guard${describeRequest(ctx)}`);
				loggedExempt.add(ip);
			}
			return allowDecision(ip, 'exempt');
		}

		const blacklistEntry = getBlacklistEntry(ip, ctx);
		if (blacklistEntry) {
			log(`[UnauthGuard] Blocked blacklisted client ${ip}${describeRequest(ctx)}`);
			return blockDecision(ip, 'blacklisted', blacklistEntry);
		}

		if (ctx.authenticated === true) {
			clearPending(ip, 'authenticated');
			if (!loggedAuthenticated.has(ip)) {
				log(`[UnauthGuard] Authenticated client ${ip} passed guard${describeRequest(ctx)}`);
				loggedAuthenticated.add(ip);
			}
			return allowDecision(ip, 'authenticated');
		}

		const now = nowMs();
		let entry = pending.get(ip);
		if (!entry) {
			evictOldestPendingIfNeeded();
			const firstSeenMs = now;
			entry = {
				firstSeenMs,
				lastSeenMs: now,
				deadlineMs: pendingDeadline(firstSeenMs),
				requestCount: 0,
				method: safeText(ctx.method).trim(),
				path: safeText(ctx.path || ctx.url).trim(),
				socketIp: safeText(ctx.socketIp).trim(),
				forwardedFor: safeText(ctx.forwardedFor).trim(),
				userAgent: safeText(ctx.userAgent).trim(),
			};
			pending.set(ip, entry);
			log(`[UnauthGuard] Started ${config.graceSeconds}s login grace window for ${ip}${describeRequest(ctx)}`);
		}

		entry.lastSeenMs = now;
		entry.requestCount += 1;

		if (now >= entry.deadlineMs) {
			pending.delete(ip);
			const nowSec = Math.floor(now / 1000);
			const expiresAt = config.autoBlacklistTtlSeconds > 0
				? nowSec + config.autoBlacklistTtlSeconds
				: null;
			addBlacklistEntry(ip, {
				source: 'auto',
				reason: `No successful authentication within ${config.graceSeconds}s`,
				createdAt: nowSec,
				expiresAt,
				firstSeen: Math.floor(entry.firstSeenMs / 1000),
				lastSeen: Math.floor(entry.lastSeenMs / 1000),
				path: entry.path,
				userAgent: entry.userAgent,
			});
			log(`[UnauthGuard] Blacklisted ${ip} after ${config.graceSeconds}s without successful authentication${describeRequest(ctx)}`);
			return blockDecision(ip, 'grace-expired');
		}

		return allowDecision(ip, 'pending', {
			remainingSeconds: Math.max(0, Math.ceil((entry.deadlineMs - now) / 1000)),
		});
	}

	configure(options.config || {});

	return {
		configure,
		evaluate,
		clearPending,
		clearAllPending,
		listPending,
		expirePending,
		_pending: pending,
	};
}

module.exports = {
	createUnauthenticatedIpGuard,
};
