#!/usr/bin/env node
'use strict';

const sessions = require('./sessions');

const args = process.argv.slice(2);
const command = args[0];

function usage() {
	console.log(`
Session Manager CLI

Usage:
  node session-cli.js <command> [options]

Commands:
  list                         List all sessions
  show <session_id>            Show session details
  set <session_id> <key=value> Update session setting (e.g., darkMode=true)
  delete <session_id>          Delete a session
  cleanup                      Run cleanup of expired sessions

Examples:
  node session-cli.js list
  node session-cli.js show abc-123-def
  node session-cli.js set abc-123-def darkMode=false
  node session-cli.js delete abc-123-def
`);
}

function formatDate(timestamp) {
	if (!timestamp) return 'N/A';
	return new Date(timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19);
}

function listSessions() {
	const db = sessions.initDb();
	const rows = db.prepare('SELECT * FROM sessions ORDER BY last_seen DESC').all();

	if (rows.length === 0) {
		console.log('No sessions found.');
		return;
	}

	console.log(`\nFound ${rows.length} session(s):\n`);
	console.log('ID'.padEnd(40) + 'Username'.padEnd(15) + 'Last IP'.padEnd(18) + 'Last Seen'.padEnd(22) + 'Settings');
	console.log('-'.repeat(115));

	for (const row of rows) {
		const id = (row.client_id || '').substring(0, 36).padEnd(40);
		const user = (row.username || '(LAN)').substring(0, 12).padEnd(15);
		const lastIp = (row.last_ip || '-').padEnd(18);
		const lastSeen = formatDate(row.last_seen).padEnd(22);
		const settings = row.settings || '{}';
		console.log(`${id}${user}${lastIp}${lastSeen}${settings}`);
	}
	console.log('');
}

function showSession(sessionId) {
	if (!sessionId) {
		console.error('Error: Session ID required');
		usage();
		process.exit(1);
	}

	const session = sessions.getSession(sessionId);
	if (!session) {
		console.error(`Session not found: ${sessionId}`);
		process.exit(1);
	}

	console.log('\nSession Details:');
	console.log('-'.repeat(50));
	console.log(`  ID:          ${session.clientId}`);
	console.log(`  Username:    ${session.username || '(LAN user)'}`);
	console.log(`  Created:     ${formatDate(session.createdAt)}`);
	console.log(`  Created IP:  ${session.createdIp || '-'}`);
	console.log(`  Last Seen:   ${formatDate(session.lastSeen)}`);
	console.log(`  Last IP:     ${session.lastIp || '-'}`);
	console.log(`  Settings:    ${JSON.stringify(session.settings, null, 2)}`);
	console.log('');
}

function updateSetting(sessionId, setting) {
	if (!sessionId || !setting) {
		console.error('Error: Session ID and setting required');
		usage();
		process.exit(1);
	}

	const [key, value] = setting.split('=');
	if (!key || value === undefined) {
		console.error('Error: Setting must be in format key=value');
		process.exit(1);
	}

	const session = sessions.getSession(sessionId);
	if (!session) {
		console.error(`Session not found: ${sessionId}`);
		process.exit(1);
	}

	// Parse value (handle booleans and numbers)
	let parsedValue = value;
	if (value === 'true') parsedValue = true;
	else if (value === 'false') parsedValue = false;
	else if (!isNaN(value) && value !== '') parsedValue = Number(value);

	const newSettings = { ...session.settings, [key]: parsedValue };
	const updated = sessions.updateSettings(sessionId, newSettings);

	if (updated) {
		console.log(`Updated ${key} = ${parsedValue}`);
		console.log(`New settings: ${JSON.stringify(newSettings)}`);
	} else {
		console.error('Failed to update settings');
		process.exit(1);
	}
}

function deleteSession(sessionId) {
	if (!sessionId) {
		console.error('Error: Session ID required');
		usage();
		process.exit(1);
	}

	const session = sessions.getSession(sessionId);
	if (!session) {
		console.error(`Session not found: ${sessionId}`);
		process.exit(1);
	}

	const db = sessions.initDb();
	const result = db.prepare('DELETE FROM sessions WHERE client_id = ?').run(sessionId);

	if (result.changes > 0) {
		console.log(`Deleted session: ${sessionId}`);
	} else {
		console.error('Failed to delete session');
		process.exit(1);
	}
}

function runCleanup() {
	const deleted = sessions.cleanupSessions();
	console.log(`Cleanup complete. Deleted ${deleted} expired session(s).`);
}

// Initialize DB
sessions.initDb();

// Route commands
switch (command) {
	case 'list':
		listSessions();
		break;
	case 'show':
		showSession(args[1]);
		break;
	case 'set':
		updateSetting(args[1], args[2]);
		break;
	case 'delete':
		deleteSession(args[1]);
		break;
	case 'cleanup':
		runCleanup();
		break;
	case 'help':
	case '--help':
	case '-h':
		usage();
		break;
	default:
		if (command) {
			console.error(`Unknown command: ${command}`);
		}
		usage();
		process.exit(command ? 1 : 0);
}

sessions.closeDb();
