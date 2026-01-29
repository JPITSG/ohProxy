#!/usr/bin/env node
'use strict';

const sessions = require('./sessions');
const net = require('net');
const path = require('path');

const IPC_SOCKET_PATH = path.join(__dirname, 'ohproxy.sock');

const args = process.argv.slice(2);
const command = args[0];

function usage() {
	console.log(`
Users Manager CLI

Usage:
  node users-cli.js <command> [options]

Commands:
  list                              List all users
  add <username> <password> [role]  Create user (role: admin/normal/readonly, default: normal)
  remove <username>                 Delete user and their sessions
  passwd <username> <newpassword>   Change user password
  role <username> <role>            Change user role
  disable <username|*>              Disable user (* = all users)
  enable <username|*>               Enable user (* = all users)

Examples:
  node users-cli.js list
  node users-cli.js add john secret123 admin
  node users-cli.js passwd john newpass456
  node users-cli.js role john readonly
  node users-cli.js remove john
  node users-cli.js disable john
  node users-cli.js enable '*'
`);
}

function formatDate(timestamp) {
	if (!timestamp) return 'N/A';
	return new Date(timestamp * 1000).toISOString().replace('T', ' ').substring(0, 19);
}

function listUsers() {
	const users = sessions.getAllUsers();
	if (users.length === 0) {
		console.log('No users found.');
		return;
	}
	console.log('Username'.padEnd(20) + 'Role'.padEnd(12) + 'Status'.padEnd(10) + 'Created'.padEnd(22) + 'Last Active');
	console.log('-'.repeat(87));
	for (const user of users) {
		const status = user.disabled ? 'disabled' : 'active';
		console.log(
			user.username.padEnd(20) +
			user.role.padEnd(12) +
			status.padEnd(10) +
			formatDate(user.createdAt).padEnd(22) +
			formatDate(user.lastActive)
		);
	}
	console.log(`\nTotal: ${users.length} user(s)`);
}

function addUser(username, password, role = 'normal') {
	if (!username || !password) {
		console.error('Error: Username and password required');
		usage();
		process.exit(1);
	}
	if (!/^[a-zA-Z0-9_-]{1,20}$/.test(username)) {
		console.error('Error: Username can only contain a-z, A-Z, 0-9, underscore, and hyphen (max 20 chars)');
		process.exit(1);
	}
	if (!['admin', 'normal', 'readonly'].includes(role)) {
		console.error('Error: Role must be admin, normal, or readonly');
		process.exit(1);
	}
	if (sessions.createUser(username, password, role)) {
		console.log(`User '${username}' created with role '${role}'`);
	} else {
		console.error(`Error: Failed to create user (username may already exist)`);
		process.exit(1);
	}
}

function sendIpcMessage(action, payload) {
	return new Promise((resolve) => {
		const client = net.createConnection(IPC_SOCKET_PATH, () => {
			client.write(JSON.stringify({ action, payload }) + '\n');
		});
		let buffer = '';
		client.on('data', (data) => {
			buffer += data.toString();
			if (buffer.includes('\n')) {
				try {
					const response = JSON.parse(buffer.split('\n')[0]);
					resolve(response);
				} catch (err) {
					resolve({ ok: false, error: 'Invalid response' });
				}
				client.end();
			}
		});
		client.on('error', () => {
			// Server not running - that's okay, user is still deleted
			resolve({ ok: true, serverOffline: true });
		});
		client.setTimeout(2000, () => {
			client.destroy();
			resolve({ ok: false, error: 'Timeout' });
		});
	});
}

async function removeUser(username) {
	if (!username) {
		console.error('Error: Username required');
		usage();
		process.exit(1);
	}
	if (sessions.deleteUser(username)) {
		console.log(`User '${username}' and their sessions deleted`);
		// Notify server to disconnect active sessions
		const result = await sendIpcMessage('user-deleted', { username });
		if (result.serverOffline) {
			console.log('(Server not running - no active sessions to disconnect)');
		} else if (result.ok) {
			if (result.disconnected > 0) {
				console.log(`Disconnected ${result.disconnected} active session(s)`);
			}
		}
	} else {
		console.error(`Error: User '${username}' not found`);
		process.exit(1);
	}
}

async function changePassword(username, newPassword) {
	if (!username || !newPassword) {
		console.error('Error: Username and new password required');
		usage();
		process.exit(1);
	}
	if (sessions.updateUserPassword(username, newPassword)) {
		console.log(`Password updated for user '${username}'`);
		// Notify server to disconnect active sessions
		const result = await sendIpcMessage('password-changed', { username });
		if (result.serverOffline) {
			console.log('(Server not running - no active sessions to disconnect)');
		} else if (result.ok && result.disconnected > 0) {
			console.log(`Disconnected ${result.disconnected} active session(s)`);
		}
	} else {
		console.error(`Error: User '${username}' not found`);
		process.exit(1);
	}
}

function changeRole(username, newRole) {
	if (!username || !newRole) {
		console.error('Error: Username and role required');
		usage();
		process.exit(1);
	}
	if (!['admin', 'normal', 'readonly'].includes(newRole)) {
		console.error('Error: Role must be admin, normal, or readonly');
		process.exit(1);
	}
	if (sessions.updateUserRole(username, newRole)) {
		console.log(`Role updated to '${newRole}' for user '${username}'`);
	} else {
		console.error(`Error: User '${username}' not found`);
		process.exit(1);
	}
}

function disableUser(username) {
	if (!username) {
		console.error('Error: Username required (use * for all users)');
		usage();
		process.exit(1);
	}
	if (username === '*') {
		const count = sessions.disableAllUsers();
		console.log(`Disabled ${count} user(s)`);
	} else {
		if (sessions.disableUser(username)) {
			console.log(`User '${username}' disabled`);
		} else {
			console.error(`Error: User '${username}' not found`);
			process.exit(1);
		}
	}
}

function enableUser(username) {
	if (!username) {
		console.error('Error: Username required (use * for all users)');
		usage();
		process.exit(1);
	}
	if (username === '*') {
		const count = sessions.enableAllUsers();
		console.log(`Enabled ${count} user(s)`);
	} else {
		if (sessions.enableUser(username)) {
			console.log(`User '${username}' enabled`);
		} else {
			console.error(`Error: User '${username}' not found`);
			process.exit(1);
		}
	}
}

// Initialize DB
sessions.initDb();

// Route commands (async wrapper for remove command)
(async () => {
	switch (command) {
		case 'list':
			listUsers();
			break;
		case 'add':
			addUser(args[1], args[2], args[3]);
			break;
		case 'remove':
			await removeUser(args[1]);
			break;
		case 'passwd':
			await changePassword(args[1], args[2]);
			break;
		case 'role':
			changeRole(args[1], args[2]);
			break;
		case 'disable':
			disableUser(args[1]);
			break;
		case 'enable':
			enableUser(args[1]);
			break;
		default:
			usage();
			if (command) process.exit(1);
	}
	// Close DB
	sessions.closeDb();
})();
