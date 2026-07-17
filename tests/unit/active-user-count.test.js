'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
	VISIBILITY_TTL_MS,
	countActiveUsers,
	createActiveUserCountWriter,
} = require('../../lib/active-user-count');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

const NOW = 1_000_000_000;

function client(visibleAt, username) {
	return {
		clientState: { focused: visibleAt > 0, visibleAt },
		ohProxyUser: username === undefined ? null : username,
	};
}

describe('countActiveUsers', () => {
	it('returns 0 for missing or empty client sets', () => {
		assert.equal(countActiveUsers(null, { now: NOW }), 0);
		assert.equal(countActiveUsers(undefined, { now: NOW }), 0);
		assert.equal(countActiveUsers([], { now: NOW }), 0);
	});

	it('counts only clients with a fresh visibility report', () => {
		assert.equal(countActiveUsers([
			client(NOW, 'alice'),
			client(0, 'bob'),
		], { now: NOW }), 1);
	});

	it('expires reports older than the TTL', () => {
		const fresh = client(NOW - VISIBILITY_TTL_MS, 'alice');
		const stale = client(NOW - VISIBILITY_TTL_MS - 1, 'bob');
		assert.equal(countActiveUsers([fresh, stale], { now: NOW }), 1);
	});

	it('honors a custom ttlMs', () => {
		const c = client(NOW - 5000, 'alice');
		assert.equal(countActiveUsers([c], { now: NOW, ttlMs: 4000 }), 0);
		assert.equal(countActiveUsers([c], { now: NOW, ttlMs: 6000 }), 1);
	});

	it('deduplicates active clients by username', () => {
		assert.equal(countActiveUsers([
			client(NOW, 'alice'),
			client(NOW, 'alice'),
			client(NOW, 'bob'),
		], { now: NOW }), 2);
	});

	it('counts each anonymous active connection individually', () => {
		assert.equal(countActiveUsers([
			client(NOW, null),
			client(NOW, ''),
			client(NOW, '   '),
			client(NOW, 'alice'),
		], { now: NOW }), 4);
	});

	it('ignores malformed clients and missing client state', () => {
		assert.equal(countActiveUsers([
			null,
			{},
			{ clientState: null },
			{ clientState: { focused: true } },
			{ clientState: { focused: true, visibleAt: 'soon' } },
			client(NOW, 'alice'),
		], { now: NOW }), 1);
	});

	it('accepts any iterable, matching wss.clients (a Set)', () => {
		const clients = new Set([client(NOW, 'alice'), client(NOW, 'bob')]);
		assert.equal(countActiveUsers(clients, { now: NOW }), 2);
	});
});

describe('createActiveUserCountWriter', () => {
	let tmpDir;
	let targetFile;
	let settings;
	let clients;
	let logs;
	let writer;
	let fakeNow;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-user-count-'));
		targetFile = path.join(tmpDir, 'state.OHProxyActiveUsers');
		settings = { enabled: true, filePath: targetFile };
		clients = [];
		logs = [];
		fakeNow = NOW;
		writer = createActiveUserCountWriter({
			getSettings: () => settings,
			getClients: () => clients,
			log: (message) => logs.push(message),
			now: () => fakeNow,
		});
	});

	afterEach(() => {
		// Disable before shutdown so the sweep timer is cleared without a write
		settings = { enabled: false, filePath: '' };
		writer.shutdownSync();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('writes the current count without a trailing newline', async () => {
		clients = [client(fakeNow, 'alice'), client(fakeNow, 'bob')];
		await writer.update();
		assert.equal(fs.readFileSync(targetFile, 'utf8'), '2');
	});

	it('writes 0 when no clients are connected', async () => {
		await writer.update();
		assert.equal(fs.readFileSync(targetFile, 'utf8'), '0');
	});

	it('skips the write when the count is unchanged', async () => {
		clients = [client(fakeNow, 'alice')];
		await writer.update();
		fs.unlinkSync(targetFile);
		await writer.update();
		assert.equal(fs.existsSync(targetFile), false);
	});

	it('writes again when the count changes', async () => {
		clients = [client(fakeNow, 'alice')];
		await writer.update();
		clients = [client(fakeNow, 'alice'), client(fakeNow, 'bob')];
		await writer.update();
		assert.equal(fs.readFileSync(targetFile, 'utf8'), '2');
	});

	it('drops the count when a client reports hidden', async () => {
		const alice = client(fakeNow, 'alice');
		clients = [alice];
		await writer.update();
		alice.clientState.visibleAt = 0;
		await writer.update();
		assert.equal(fs.readFileSync(targetFile, 'utf8'), '0');
	});

	it('drops silent clients once their visibility report expires', async () => {
		clients = [client(fakeNow, 'alice')];
		await writer.update();
		assert.equal(fs.readFileSync(targetFile, 'utf8'), '1');
		fakeNow += VISIBILITY_TTL_MS + 1;
		await writer.update();
		assert.equal(fs.readFileSync(targetFile, 'utf8'), '0');
	});

	it('keeps clients counted while heartbeats refresh the report', async () => {
		const alice = client(fakeNow, 'alice');
		clients = [alice];
		await writer.update();
		fakeNow += VISIBILITY_TTL_MS - 1000;
		alice.clientState.visibleAt = fakeNow; // heartbeat arrived
		await writer.update();
		assert.equal(fs.readFileSync(targetFile, 'utf8'), '1');
	});

	it('does not write when disabled', async () => {
		settings = { enabled: false, filePath: targetFile };
		clients = [client(fakeNow, 'alice')];
		await writer.update();
		assert.equal(fs.existsSync(targetFile), false);
	});

	it('does not write when the path is empty or relative', async () => {
		settings = { enabled: true, filePath: '' };
		await writer.update();
		settings = { enabled: true, filePath: 'relative/state.file' };
		await writer.update();
		assert.equal(fs.readdirSync(tmpDir).length, 0);
	});

	it('writes a fresh value after being re-enabled', async () => {
		clients = [client(fakeNow, 'alice')];
		await writer.update();
		settings = { enabled: false, filePath: targetFile };
		await writer.update();
		fs.unlinkSync(targetFile);
		settings = { enabled: true, filePath: targetFile };
		await writer.update();
		assert.equal(fs.readFileSync(targetFile, 'utf8'), '1');
	});

	it('writes to the new file after a settings change', async () => {
		clients = [client(fakeNow, 'alice')];
		await writer.update();
		const newTarget = path.join(tmpDir, 'state.Renamed');
		settings = { enabled: true, filePath: newTarget };
		await writer.handleSettingsChange();
		assert.equal(fs.readFileSync(newTarget, 'utf8'), '1');
	});

	it('leaves no temp file behind after writing', async () => {
		clients = [client(fakeNow, 'alice')];
		await writer.update();
		assert.deepEqual(fs.readdirSync(tmpDir).sort(), ['state.OHProxyActiveUsers']);
	});

	it('logs write failures once and retries after the failure', async () => {
		settings = { enabled: true, filePath: path.join(tmpDir, 'missing-dir', 'state.file') };
		clients = [client(fakeNow, 'alice')];
		await writer.update();
		await writer.update();
		const failures = logs.filter((m) => m.includes('Failed to write'));
		assert.equal(failures.length, 1);
		settings = { enabled: true, filePath: targetFile };
		await writer.update();
		assert.equal(fs.readFileSync(targetFile, 'utf8'), '1');
		assert.equal(logs.some((m) => m.includes('Recovered')), true);
	});

	it('shutdownSync resets the file to 0', async () => {
		clients = [client(fakeNow, 'alice'), client(fakeNow, 'bob')];
		await writer.update();
		writer.shutdownSync();
		assert.equal(fs.readFileSync(targetFile, 'utf8'), '0');
	});

	it('shutdownSync does nothing when disabled', () => {
		settings = { enabled: false, filePath: targetFile };
		writer.shutdownSync();
		assert.equal(fs.existsSync(targetFile), false);
	});
});

describe('Active User Count Wiring', () => {
	const server = fs.readFileSync(path.join(PROJECT_ROOT, 'server.js'), 'utf8');

	it('creates the writer from liveConfig and wss clients', () => {
		assert.match(server, /require\('\.\/lib\/active-user-count'\)/);
		assert.match(server, /createActiveUserCountWriter\(\{\s*getSettings: \(\) => \(\{ enabled: liveConfig\.activeUsersEnabled, filePath: liveConfig\.activeUsersFile \}\),\s*getClients: \(\) => wss\.clients,/);
	});

	it('updates the count on connect, focus change, and disconnect', () => {
		assert.match(server, /startWsPushIfNeeded\(\);\s*activeUserCountWriter\.update\(\);/);
		assert.match(server, /adjustPollingForFocus\(\);\s*activeUserCountWriter\.update\(\);\s*\}/);
		assert.match(server, /ws\.clientState\.focused = null;\s*ws\.clientState\.visibleAt = 0;\s*stopWsPushIfUnneeded\(\);\s*adjustPollingForFocus\(\);\s*activeUserCountWriter\.update\(\);/);
	});

	it('tracks visibility from explicit client reports only', () => {
		assert.match(server, /ws\.clientState = \{ focused: true, visibleAt: 0 \};/);
		assert.match(server, /ws\.clientState\.visibleAt = msg\.data\.focused === true \? Date\.now\(\) : 0;/);
	});

	it('handles hot-reloaded settings and process shutdown', () => {
		assert.match(server, /liveConfig\.activeUsersEnabled = newServer\.activeUsers\?\.enabled === true;/);
		assert.match(server, /liveConfig\.activeUsersFile = safeText\(newServer\.activeUsers\?\.filePath \|\| ''\)\.trim\(\);/);
		assert.match(server, /activeUserCountWriter\.handleSettingsChange\(\);/);
		assert.match(server, /activeUserCountWriter\.shutdownSync\(\);/);
	});

	it('validates the settings at startup and on admin save', () => {
		assert.match(server, /ensureBoolean\(ACTIVE_USERS_CONFIG\.enabled, 'server\.activeUsers\.enabled', errors\);/);
		assert.match(server, /ensureLogPath\(ACTIVE_USERS_FILE, 'server\.activeUsers\.filePath', errors\);/);
		assert.match(server, /ensureBoolean\(s\.activeUsers\.enabled, 'server\.activeUsers\.enabled', errors\);/);
		assert.match(server, /ensureLogPath\(s\.activeUsers\.filePath, 'server\.activeUsers\.filePath', errors\);/);
		assert.equal((server.match(/filePath is required when server\.activeUsers\.enabled is true/g) || []).length, 2);
	});

	it('client heartbeats visibility while visible', () => {
		const app = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'app.js'), 'utf8');
		assert.match(app, /const FOCUS_HEARTBEAT_MS = 10000;/);
		assert.match(app, /function sendFocusHeartbeat\(\) \{[\s\S]*?if \(!isClientFocused\(\)\) return;\s*sendClientState\(\{ focused: true \}\);/);
		assert.match(app, /focusHeartbeatTimer = setInterval\(sendFocusHeartbeat, FOCUS_HEARTBEAT_MS\);/);
	});

	it('shared worker closes sockets with browser-legal close codes', () => {
		const worker = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'transport.sharedworker.js'), 'utf8');
		assert.match(worker, /function browserSafeCloseCode\(code\) \{[\s\S]*?code === 1000 \|\| \(Number\.isInteger\(code\) && code >= 3000 && code <= 4999\)/);
		assert.match(worker, /function forceCloseSocket\(key, code, reason, notifyPort\)/);
		// Pausing notifies the page so its socket facade observes the close
		assert.match(worker, /pausedPorts\.add\(portId\);[\s\S]{0,250}closePortSockets\(portId, 1001, safeText\(data\?\.reason \|\| 'Transport paused'\), true\);/);
	});

	it('exposes the settings in the config defaults and admin modal', () => {
		const defaults = fs.readFileSync(path.join(PROJECT_ROOT, 'config.defaults.js'), 'utf8');
		assert.match(defaults, /activeUsers: \{[\s\S]*?enabled: false,[\s\S]*?filePath: '',[\s\S]*?\}/);

		const app = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'app.js'), 'utf8');
		assert.match(app, /\{ key: 'server\.activeUsers\.enabled', type: 'toggle' \}/);
		assert.match(app, /\{ key: 'server\.activeUsers\.filePath', type: 'text', allowEmpty: true \}/);

		const lang = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'lang.js'), 'utf8');
		assert.match(lang, /'server\.activeUsers\.enabled': 'Active Users Export'/);
		assert.match(lang, /'server\.activeUsers\.filePath': 'Active Users File'/);
		assert.match(lang, /'server\.activeUsers\.enabled': 'Write the number of users actively browsing/);
	});
});
