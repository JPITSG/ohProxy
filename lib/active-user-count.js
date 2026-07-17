'use strict';

const fs = require('fs');
const path = require('path');

// A client counts as actively browsing only while its visibility reports stay
// fresh: the PWA reports focused=true on connect/visibilitychange and repeats
// it every ~10s while visible. Reports older than this TTL are ignored, so
// frozen or vanished clients drop out of the count even when their socket
// lingers half-open.
const VISIBILITY_TTL_MS = 30000;
// While the count is non-zero the writer re-evaluates on this interval, so
// expired clients are noticed without requiring a WebSocket event.
const RECHECK_INTERVAL_MS = 10000;

/**
 * Count the users actively browsing the PWA.
 *
 * A client is "active" only while its last explicit focused=true report
 * (clientState.visibleAt) is fresher than the TTL. Authenticated clients are
 * deduplicated by username so one person with the app visible on several
 * devices counts once; clients without a username each count individually.
 */
function countActiveUsers(clients, options) {
	const now = Number.isFinite(options?.now) ? options.now : Date.now();
	const ttlMs = Number.isFinite(options?.ttlMs) ? options.ttlMs : VISIBILITY_TTL_MS;
	const usernames = new Set();
	let anonymous = 0;
	if (!clients) return 0;
	for (const client of clients) {
		const visibleAt = client && client.clientState ? client.clientState.visibleAt : 0;
		if (!Number.isFinite(visibleAt) || visibleAt <= 0) continue;
		if (now - visibleAt > ttlMs) continue;
		const username = typeof client.ohProxyUser === 'string' ? client.ohProxyUser.trim() : '';
		if (username) {
			usernames.add(username);
		} else {
			anonymous++;
		}
	}
	return usernames.size + anonymous;
}

/**
 * Create a writer that persists the active user count to a target file.
 *
 * - Writes only when the count (or target file) changes.
 * - Writes atomically (temp file + rename) so readers never see partial data.
 * - Serializes writes so overlapping updates cannot interleave.
 * - Suppresses repeated identical error logs until a write succeeds again.
 * - Re-evaluates itself periodically while the count is non-zero so clients
 *   whose visibility reports expired are dropped without any socket event.
 *
 * @param {Object} deps
 * @param {Function} deps.getSettings - returns { enabled: boolean, filePath: string }
 * @param {Function} deps.getClients - returns an iterable of WebSocket clients
 * @param {Function} deps.log - log function for status/error messages
 * @param {Function} [deps.now] - clock override for tests (defaults to Date.now)
 */
function createActiveUserCountWriter({ getSettings, getClients, log, now }) {
	const logMessage = typeof log === 'function' ? log : () => {};
	const nowFn = typeof now === 'function' ? now : Date.now;
	let lastWrittenPath = null;
	let lastWrittenValue = null;
	let lastErrorText = '';
	let writeChain = Promise.resolve();
	let recheckTimer = null;

	function readSettings() {
		const settings = typeof getSettings === 'function' ? getSettings() : null;
		const enabled = !!(settings && settings.enabled === true);
		const filePath = settings && typeof settings.filePath === 'string' ? settings.filePath.trim() : '';
		return { enabled, filePath: enabled && path.isAbsolute(filePath) ? filePath : '' };
	}

	function currentCount() {
		return countActiveUsers(typeof getClients === 'function' ? getClients() : null, { now: nowFn() });
	}

	function clearRecheck() {
		if (recheckTimer) {
			clearTimeout(recheckTimer);
			recheckTimer = null;
		}
	}

	function scheduleRecheck() {
		if (recheckTimer) return;
		recheckTimer = setTimeout(() => {
			recheckTimer = null;
			update();
		}, RECHECK_INTERVAL_MS);
		// Never keep the process alive just for count expiry sweeps
		if (typeof recheckTimer.unref === 'function') recheckTimer.unref();
	}

	function writeCountToFile(filePath, count) {
		const tmpPath = filePath + '.tmp';
		return fs.promises.writeFile(tmpPath, String(count), 'utf8')
			.then(() => fs.promises.rename(tmpPath, filePath))
			.then(() => {
				lastWrittenPath = filePath;
				lastWrittenValue = count;
				if (lastErrorText) {
					logMessage(`[ActiveUsers] Recovered, wrote ${count} to ${filePath}`);
					lastErrorText = '';
				}
			})
			.catch((err) => {
				// Forget the last successful write so the next update retries,
				// and keep rechecking so the retry happens even without events
				lastWrittenPath = null;
				lastWrittenValue = null;
				scheduleRecheck();
				const errorText = `[ActiveUsers] Failed to write ${filePath}: ${err.message || err}`;
				if (errorText !== lastErrorText) {
					lastErrorText = errorText;
					logMessage(errorText);
				}
				fs.promises.unlink(tmpPath).catch(() => {});
			});
	}

	/**
	 * Recompute the active user count and persist it when it changed.
	 * Returns a promise that resolves once any triggered write settled.
	 */
	function update() {
		const { enabled, filePath } = readSettings();
		if (!enabled || !filePath) {
			// Forget prior writes so re-enabling always writes a fresh value
			lastWrittenPath = null;
			lastWrittenValue = null;
			clearRecheck();
			return writeChain;
		}
		const count = currentCount();
		// Visibility reports expire silently, so keep sweeping while anyone is
		// counted or a non-zero value is on disk waiting to decay to 0.
		if (count > 0 || (typeof lastWrittenValue === 'number' && lastWrittenValue > 0)) {
			scheduleRecheck();
		}
		if (filePath === lastWrittenPath && count === lastWrittenValue) {
			return writeChain;
		}
		writeChain = writeChain.then(() => {
			// Re-check inside the chain: a queued earlier write may have already
			// persisted this value, or settings may have changed meanwhile.
			const current = readSettings();
			if (!current.enabled || !current.filePath) return;
			const currentValue = currentCount();
			if (current.filePath === lastWrittenPath && currentValue === lastWrittenValue) return;
			return writeCountToFile(current.filePath, currentValue);
		});
		return writeChain;
	}

	/**
	 * Called after a config hot reload. Forces a fresh evaluation so a new
	 * target file receives the current count immediately.
	 */
	function handleSettingsChange() {
		lastWrittenPath = null;
		lastWrittenValue = null;
		lastErrorText = '';
		return update();
	}

	/**
	 * Synchronously write 0 during process shutdown: while the proxy is down
	 * nobody is browsing, and a stale non-zero count must not linger.
	 */
	function shutdownSync() {
		clearRecheck();
		const { enabled, filePath } = readSettings();
		if (!enabled || !filePath) return;
		const tmpPath = filePath + '.tmp';
		try {
			fs.writeFileSync(tmpPath, '0', 'utf8');
			fs.renameSync(tmpPath, filePath);
		} catch (err) {
			try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
		}
	}

	return { update, handleSettingsChange, shutdownSync };
}

module.exports = {
	VISIBILITY_TTL_MS,
	RECHECK_INTERVAL_MS,
	countActiveUsers,
	createActiveUserCountWriter,
};
