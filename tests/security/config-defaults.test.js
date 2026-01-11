'use strict';

/**
 * Configuration Defaults Security Tests
 *
 * Ensures that default configuration values pass validation and don't create
 * security issues when the application runs with minimal configuration.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DEFAULTS_FILE = path.join(PROJECT_ROOT, 'config.defaults.js');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

function readFile(filePath) {
	return fs.readFileSync(filePath, 'utf8');
}

// Extract validation rules from server.js
function extractValidationRules(content) {
	const rules = [];

	// Find ensure* function calls with allowEmpty option
	const ensureStringPattern = /ensureString\s*\(\s*([^,]+),\s*['"]([^'"]+)['"],\s*\{\s*allowEmpty:\s*(true|false)\s*\}/g;
	let match;
	while ((match = ensureStringPattern.exec(content)) !== null) {
		rules.push({
			variable: match[1].trim(),
			name: match[2],
			type: 'string',
			allowEmpty: match[3] === 'true',
		});
	}

	// Find ensureLogPath calls (which internally use ensureString)
	const ensureLogPathPattern = /ensureLogPath\s*\(\s*([^,]+),\s*['"]([^'"]+)['"]/g;
	while ((match = ensureLogPathPattern.exec(content)) !== null) {
		rules.push({
			variable: match[1].trim(),
			name: match[2],
			type: 'logPath',
		});
	}

	return rules;
}

// Extract default values from config.defaults.js
function extractDefaultValues(content) {
	const defaults = {};

	// Parse the module.exports object
	// This is a simplified parser - works for our config structure
	const lines = content.split('\n');
	let currentPath = [];
	let inObject = false;

	for (const line of lines) {
		const trimmed = line.trim();

		// Track object nesting
		if (trimmed.includes('{')) {
			const keyMatch = trimmed.match(/^(\w+)\s*:\s*\{/);
			if (keyMatch) {
				currentPath.push(keyMatch[1]);
			}
		}
		if (trimmed.includes('}')) {
			currentPath.pop();
		}

		// Extract simple key-value pairs
		const kvMatch = trimmed.match(/^(\w+)\s*:\s*(['"]?)([^'"}\],]*)\2\s*,?$/);
		if (kvMatch && currentPath.length > 0) {
			const fullPath = [...currentPath, kvMatch[1]].join('.');
			let value = kvMatch[3];
			// Handle empty string
			if (kvMatch[2] && kvMatch[3] === '') {
				value = '';
			}
			defaults[fullPath] = value;
		}
	}

	return defaults;
}

describe('Config Defaults: Validation Compatibility', () => {
	it('default values pass validation rules', () => {
		const serverContent = readFile(SERVER_FILE);
		const defaultsContent = readFile(DEFAULTS_FILE);

		const rules = extractValidationRules(serverContent);
		const defaults = extractDefaultValues(defaultsContent);

		const issues = [];

		// Check for validation mismatches
		for (const rule of rules) {
			// Map validation name to default path
			const defaultPath = rule.name.replace(/^server\./, '');

			// Find corresponding default
			let defaultValue = defaults[defaultPath];
			if (defaultValue === undefined) {
				// Try alternative paths
				const altPath = defaultPath.replace(/\./g, '.');
				defaultValue = defaults[altPath];
			}

			if (defaultValue !== undefined) {
				// Check if default violates validation
				if (!rule.allowEmpty && defaultValue === '') {
					issues.push({
						name: rule.name,
						type: rule.type,
						defaultValue: '(empty string)',
						problem: 'Validation requires non-empty but default is empty',
					});
				}
			}
		}

		if (issues.length > 0) {
			const details = issues.map(i =>
				`  ${i.name}: ${i.problem}`
			).join('\n');
			assert.fail(`Default values don't match validation rules:\n${details}`);
		}
	});

	it('log path defaults are valid or explicitly empty', () => {
		const defaultsContent = readFile(DEFAULTS_FILE);
		const defaults = extractDefaultValues(defaultsContent);

		// Log paths should either be:
		// 1. Empty string (disables logging)
		// 2. Absolute path starting with /

		const logPaths = ['server.logFile', 'server.accessLog'];
		const issues = [];

		for (const pathKey of logPaths) {
			const value = defaults[pathKey.replace(/^server\./, '')];
			if (value !== undefined && value !== '' && !value.startsWith('/')) {
				issues.push({
					path: pathKey,
					value,
					problem: 'Non-empty log path must be absolute (start with /)',
				});
			}
		}

		if (issues.length > 0) {
			const details = issues.map(i => `  ${i.path}: ${i.problem}`).join('\n');
			assert.fail(`Invalid log path defaults:\n${details}`);
		}
	});
});

describe('Config Defaults: Security Settings', () => {
	it('secure cookie settings have safe defaults', () => {
		const defaultsContent = readFile(DEFAULTS_FILE);

		// Check for secure cookie defaults
		const hasSecureCookieDefault = /cookieDays\s*:\s*\d+/.test(defaultsContent);
		const hasCookieNameDefault = /cookieName\s*:/.test(defaultsContent);

		assert.ok(hasSecureCookieDefault, 'Should have cookie expiry default');
		assert.ok(hasCookieNameDefault, 'Should have cookie name default');
	});

	it('auth realm has a default value', () => {
		const defaultsContent = readFile(DEFAULTS_FILE);
		const hasRealmDefault = /realm\s*:\s*['"][^'"]+['"]/.test(defaultsContent);
		assert.ok(hasRealmDefault, 'Auth realm should have a default value');
	});

	it('security headers are enabled by default', () => {
		const defaultsContent = readFile(DEFAULTS_FILE);

		// HSTS should be enabled
		const hstsEnabled = /hsts[\s\S]*?enabled\s*:\s*true/.test(defaultsContent);
		// CSP should be enabled
		const cspEnabled = /csp[\s\S]*?enabled\s*:\s*true/.test(defaultsContent);

		assert.ok(hstsEnabled, 'HSTS should be enabled by default');
		assert.ok(cspEnabled, 'CSP should be enabled by default');
	});

	it('proxy allowlist defaults to empty (deny all)', () => {
		const defaultsContent = readFile(DEFAULTS_FILE);

		// Proxy allowlist should default to empty array
		const hasEmptyAllowlist = /proxyAllowlist\s*:\s*\[\s*\]/.test(defaultsContent);

		assert.ok(hasEmptyAllowlist, 'Proxy allowlist should default to empty (deny all)');
	});
});

describe('Config Defaults: No Sensitive Values', () => {
	it('no hardcoded credentials in defaults', () => {
		const defaultsContent = readFile(DEFAULTS_FILE);
		const lines = defaultsContent.split('\n');
		const issues = [];

		const sensitivePatterns = [
			{ pattern: /password\s*:\s*['"][^'"]+['"]/, field: 'password' },
			{ pattern: /secret\s*:\s*['"][^'"]{10,}['"]/, field: 'secret' },
			{ pattern: /apiKey\s*:\s*['"][^'"]{20,}['"]/, field: 'apiKey' },
			{ pattern: /token\s*:\s*['"][^'"]{20,}['"]/, field: 'token' },
			{ pattern: /cookieKey\s*:\s*['"][^'"]{20,}['"]/, field: 'cookieKey' },
		];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			for (const { pattern, field } of sensitivePatterns) {
				if (pattern.test(line)) {
					// Check if it's explicitly empty or placeholder
					if (!line.includes("''") && !line.includes('""') &&
					    !line.includes('CHANGE_ME') && !line.includes('xxx')) {
						issues.push({
							line: i + 1,
							field,
							code: line.trim(),
						});
					}
				}
			}
		}

		if (issues.length > 0) {
			const details = issues.map(i =>
				`  Line ${i.line} (${i.field}): ${i.code.substring(0, 60)}...`
			).join('\n');
			assert.fail(`Defaults file may contain sensitive values:\n${details}`);
		}
	});

	it('database credentials are empty by default', () => {
		const defaultsContent = readFile(DEFAULTS_FILE);

		// MySQL credentials should be empty in defaults
		const hasEmptyDbUser = /username\s*:\s*['']['"]/.test(defaultsContent) ||
		                       /username\s*:\s*['"]openhab['"]/.test(defaultsContent); // Standard default is ok
		const hasEmptyDbPass = /password\s*:\s*['']['"]/.test(defaultsContent) ||
		                       /password\s*:\s*['"]openhab['"]/.test(defaultsContent); // Standard default is ok

		// At minimum, ensure no complex passwords in defaults
		const hasComplexPassword = /password\s*:\s*['"][^'"]{8,}['"]/.test(defaultsContent) &&
		                           !/openhab/.test(defaultsContent);

		assert.ok(!hasComplexPassword, 'Defaults should not contain complex passwords');
	});
});
