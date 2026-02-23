'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

function readServer() {
	return fs.readFileSync(SERVER_FILE, 'utf8');
}

describe('System settings endpoint access control wiring', () => {
	it('allows non-admin users to read user settings only', () => {
		const content = readServer();
		assert.match(content, /app\.get\('\/api\/admin\/config', \(req, res\) => \{/, 'settings GET endpoint should not be wrapped in requireAdmin');
		assert.doesNotMatch(content, /app\.get\('\/api\/admin\/config', requireAdmin,/, 'settings GET should not require admin globally');
		assert.match(content, /const userConfig = \{[\s\S]*trackGps:[\s\S]*voiceModel:[\s\S]*password: ''[\s\S]*confirm: ''[\s\S]*\};/, 'settings GET should build user-only config payload');
		assert.match(content, /if \(user\.role !== 'admin'\) \{[\s\S]*res\.json\(\{ user: userConfig \}\);[\s\S]*return;/, 'non-admin GET should only return user settings');
	});

	it('blocks all non-admin non-user top-level writes while keeping admin-only secret and restart endpoints', () => {
		const content = readServer();
		assert.match(content, /app\.post\('\/api\/admin\/config', jsonParserLarge, \(req, res\) => \{/, 'settings POST endpoint should not be wrapped in requireAdmin');
		assert.doesNotMatch(content, /app\.post\('\/api\/admin\/config', jsonParserLarge, requireAdmin,/, 'settings POST should not require admin globally');
		assert.match(content, /const disallowedTopKey = topKeys\.find\(\(key\) => key !== 'user'\);[\s\S]*if \(disallowedTopKey\) \{[\s\S]*res\.status\(403\)\.json\(\{ error: 'Admin access required for non-user settings' \}\);[\s\S]*return;/, 'non-admin writes with any non-user top-level key must be forbidden');
		assert.match(content, /app\.get\('\/api\/admin\/config\/secret', requireAdmin, \(req, res\) => \{/, 'secret reveal endpoint must remain admin-only');
		assert.match(content, /app\.post\('\/api\/admin\/restart', jsonParserSmall, requireAdmin, \(req, res\) => \{/, 'restart endpoint must remain admin-only');
	});
});
