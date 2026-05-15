#!/usr/bin/env node
'use strict';

const net = require('net');
const path = require('path');
const sessions = require('./sessions');

const IPC_SOCKET_PATH = path.join(__dirname, 'ohproxy.sock');
const args = process.argv.slice(2);
const command = args[0];

function usage() {
	console.log(`
IP Blacklist CLI

Usage:
  node blacklist-cli.js <command> [options]

Commands:
  list [--all] [--json]                 List active blacklist entries
  pending [--json]                      List IPs inside the login grace window
  check <ip>                            Show blacklist and pending state for an IP
  add <ip> [--reason text] [--expires time|never]
                                        Add or update a manual blacklist entry
  remove <ip>                           Remove a blacklist entry and clear pending state
  clear expired|auto|manual|all         Clear blacklist entries by scope

Time format:
  Nsecs, Nmins, Nhours, Ndays, or never

Examples:
  node blacklist-cli.js list
  node blacklist-cli.js pending
  node blacklist-cli.js add 203.0.113.10 --reason "manual block" --expires 7days
  node blacklist-cli.js remove 203.0.113.10
  node blacklist-cli.js clear expired
`);
}

function fail(message) {
	console.error(`Error: ${message}`);
	process.exit(1);
}

function validateIp(ip) {
	const value = String(ip || '').trim();
	if (!value || !net.isIP(value)) fail('A valid IPv4 or IPv6 address is required');
	return value;
}

function formatDate(timestamp) {
	if (!timestamp) return 'never';
	return new Date(timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19);
}

function parseTimeString(value) {
	const text = String(value || '').trim().toLowerCase();
	if (!text || text === 'never') return null;
	const match = text.match(/^(\d+)(secs?|mins?|hours?|days?)$/);
	if (!match) return undefined;
	const amount = Number(match[1]);
	const unit = match[2];
	if (!Number.isInteger(amount) || amount < 1) return undefined;
	if (unit.startsWith('sec')) return amount;
	if (unit.startsWith('min')) return amount * 60;
	if (unit.startsWith('hour')) return amount * 60 * 60;
	if (unit.startsWith('day')) return amount * 24 * 60 * 60;
	return undefined;
}

function optionValue(name, fallback = '') {
	const index = args.indexOf(name);
	if (index < 0) return fallback;
	const value = args[index + 1];
	if (!value || value.startsWith('--')) fail(`${name} requires a value`);
	return value;
}

function hasFlag(name) {
	return args.includes(name);
}

function sendIpcMessage(action, payload = {}) {
	return new Promise((resolve) => {
		const client = net.createConnection(IPC_SOCKET_PATH, () => {
			client.write(JSON.stringify({ action, payload }) + '\n');
		});
		let buffer = '';
		client.on('data', (data) => {
			buffer += data.toString();
			if (!buffer.includes('\n')) return;
			const line = buffer.split('\n')[0];
			try {
				resolve(JSON.parse(line));
			} catch {
				resolve({ ok: false, error: 'Invalid response' });
			}
			client.end();
		});
		client.on('error', () => {
			resolve({ ok: false, serverOffline: true });
		});
		client.setTimeout(2000, () => {
			client.destroy();
			resolve({ ok: false, error: 'Timeout' });
		});
	});
}

async function getPendingRows() {
	const response = await sendIpcMessage('ip-guard-pending-list');
	if (!response.ok) return { rows: [], error: response.serverOffline ? 'Server is not running' : response.error || 'Pending state unavailable' };
	return { rows: Array.isArray(response.pending) ? response.pending : [], error: '' };
}

function printEntry(entry) {
	const expires = entry.expiresAt ? formatDate(entry.expiresAt) : 'never';
	console.log(
		entry.ip.padEnd(40) +
		entry.source.padEnd(9) +
		formatDate(entry.createdAt).padEnd(22) +
		expires.padEnd(22) +
		(entry.reason || '-')
	);
}

function listEntries() {
	const includeExpired = hasFlag('--all');
	const asJson = hasFlag('--json');
	const rows = sessions.listIpBlacklistEntries({ includeExpired });
	if (asJson) {
		console.log(JSON.stringify(rows, null, 2));
		return;
	}
	if (rows.length === 0) {
		console.log(includeExpired ? 'No blacklist entries found.' : 'No active blacklist entries found.');
		return;
	}
	console.log('IP'.padEnd(40) + 'Source'.padEnd(9) + 'Created'.padEnd(22) + 'Expires'.padEnd(22) + 'Reason');
	console.log('-'.repeat(120));
	for (const row of rows) printEntry(row);
	console.log(`\nTotal: ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`);
}

async function listPending() {
	const asJson = hasFlag('--json');
	const { rows, error } = await getPendingRows();
	if (asJson) {
		console.log(JSON.stringify({ pending: rows, error }, null, 2));
		return;
	}
	if (error) {
		console.log(`Pending state unavailable: ${error}`);
		return;
	}
	if (rows.length === 0) {
		console.log('No pending unauthenticated IPs.');
		return;
	}
	console.log('IP'.padEnd(40) + 'Remaining'.padEnd(12) + 'Requests'.padEnd(10) + 'First Seen'.padEnd(22) + 'Path');
	console.log('-'.repeat(120));
	for (const row of rows) {
		console.log(
			row.ip.padEnd(40) +
			String(row.remainingSeconds).padEnd(12) +
			String(row.requestCount).padEnd(10) +
			formatDate(row.firstSeen).padEnd(22) +
			(row.path || '-')
		);
	}
}

async function checkIp(ipArg) {
	const ip = validateIp(ipArg);
	const entry = sessions.getIpBlacklistEntry(ip);
	console.log(`IP: ${ip}`);
	if (entry) {
		console.log('Status: blacklisted');
		console.log(`Source: ${entry.source}`);
		console.log(`Created: ${formatDate(entry.createdAt)}`);
		console.log(`Expires: ${entry.expiresAt ? formatDate(entry.expiresAt) : 'never'}`);
		console.log(`Reason: ${entry.reason || '-'}`);
	} else {
		console.log('Status: not blacklisted');
	}
	const { rows, error } = await getPendingRows();
	if (!error) {
		const pending = rows.find((row) => row.ip === ip);
		if (pending) {
			console.log(`Pending: yes, ${pending.remainingSeconds}s remaining, ${pending.requestCount} request(s)`);
			console.log(`Pending path: ${pending.path || '-'}`);
		} else {
			console.log('Pending: no');
		}
	}
}

async function addEntry(ipArg) {
	const ip = validateIp(ipArg);
	const reason = optionValue('--reason', 'Manual blacklist entry');
	const expiresRaw = optionValue('--expires', 'never');
	const duration = parseTimeString(expiresRaw);
	if (duration === undefined) fail('Invalid --expires value; use Nsecs, Nmins, Nhours, Ndays, or never');
	const now = Math.floor(Date.now() / 1000);
	const expiresAt = duration === null ? null : now + duration;
	sessions.addIpBlacklistEntry(ip, {
		source: 'manual',
		reason,
		createdAt: now,
		expiresAt,
	});
	await sendIpcMessage('ip-blacklist-updated', { ip });
	console.log(`Blacklisted ${ip}${expiresAt ? ` until ${formatDate(expiresAt)}` : ' permanently'}.`);
}

async function removeEntry(ipArg) {
	const ip = validateIp(ipArg);
	const removed = sessions.removeIpBlacklistEntry(ip);
	await sendIpcMessage('ip-blacklist-updated', { ip });
	console.log(removed ? `Removed ${ip} from blacklist.` : `${ip} was not blacklisted.`);
}

async function clearEntries(scope) {
	const value = String(scope || '').trim().toLowerCase();
	if (!['expired', 'auto', 'manual', 'all'].includes(value)) {
		fail('clear requires one of: expired, auto, manual, all');
	}
	let count = 0;
	if (value === 'expired') {
		count = sessions.clearIpBlacklistEntries({ expiredOnly: true });
	} else if (value === 'all') {
		count = sessions.clearIpBlacklistEntries();
		await sendIpcMessage('ip-guard-clear-pending');
	} else {
		count = sessions.clearIpBlacklistEntries({ source: value });
		await sendIpcMessage('ip-guard-clear-pending');
	}
	console.log(`Cleared ${count} blacklist entr${count === 1 ? 'y' : 'ies'}.`);
}

sessions.initDb();

(async () => {
	try {
		switch (command) {
			case 'list':
				listEntries();
				break;
			case 'pending':
				await listPending();
				break;
			case 'check':
				await checkIp(args[1]);
				break;
			case 'add':
				await addEntry(args[1]);
				break;
			case 'remove':
				await removeEntry(args[1]);
				break;
			case 'clear':
				await clearEntries(args[1]);
				break;
			case 'help':
			case '--help':
			case '-h':
			case undefined:
				usage();
				process.exit(command ? 1 : 0);
				break;
			default:
				console.error(`Unknown command: ${command}`);
				usage();
				process.exit(1);
		}
	} finally {
		sessions.closeDb();
	}
})();
