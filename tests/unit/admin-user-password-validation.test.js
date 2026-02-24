'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

function read(filePath) {
	return fs.readFileSync(filePath, 'utf8');
}

function extractFunctionSource(content, functionName) {
	const marker = `function ${functionName}(`;
	const start = content.indexOf(marker);
	assert.ok(start !== -1, `Function not found: ${functionName}`);

	const openBrace = content.indexOf('{', start);
	assert.ok(openBrace !== -1, `Opening brace not found for function: ${functionName}`);

	let depth = 0;
	for (let i = openBrace; i < content.length; i++) {
		const ch = content[i];
		if (ch === '{') depth++;
		if (ch === '}') {
			depth--;
			if (depth === 0) {
				return content.slice(start, i + 1);
			}
		}
	}

	assert.fail(`Unable to extract function body for ${functionName}`);
}

function loadValidateAdminUserConfig() {
	const serverContent = read(SERVER_FILE);
	const fnSource = extractFunctionSource(serverContent, 'validateAdminUserConfig');

	const sandbox = {
		module: { exports: null },
		exports: {},
		isPlainObject(value) {
			if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
			const proto = Object.getPrototypeOf(value);
			return proto === Object.prototype || proto === null;
		},
		hasAnyControlChars(value) {
			return /[\x00-\x1F\x7F]/.test(String(value));
		},
		isValidUserMapviewRendering(value) {
			return value === 'ohproxy' || value === 'openhab';
		},
	};

	vm.createContext(sandbox);
	vm.runInContext(`${fnSource}\nmodule.exports = validateAdminUserConfig;`, sandbox);
	return sandbox.module.exports;
}

const validateAdminUserConfig = loadValidateAdminUserConfig();

describe('Admin user password validation', () => {
	it('allows empty password fields when no password change is requested', () => {
		const errors = validateAdminUserConfig({
			trackGps: true,
			voiceModel: 'system',
			password: '',
			confirm: '',
		});
		assert.strictEqual(errors.length, 0);
	});

	it('requires password and confirm to both be present when changing password', () => {
		const errors = validateAdminUserConfig({ password: 'abc123', confirm: '' });
		assert.ok(errors.includes('user.password and user.confirm are required to change password'));
	});

	it('rejects mismatch between password and confirm', () => {
		const errors = validateAdminUserConfig({ password: 'abc123', confirm: 'xyz123' });
		assert.ok(errors.includes('user.password and user.confirm must match'));
	});

	it('rejects passwords that do not meet login format rules', () => {
		const withControlChars = validateAdminUserConfig({ password: 'abc\t123', confirm: 'abc\t123' });
		assert.ok(withControlChars.includes('user.password and user.confirm must match login password format'));

		const tooLong = 'p'.repeat(201);
		const withTooLong = validateAdminUserConfig({ password: tooLong, confirm: tooLong });
		assert.ok(withTooLong.includes('user.password and user.confirm must match login password format'));
	});

	it('accepts valid matching password and confirm values', () => {
		const valid = 'p'.repeat(200);
		const errors = validateAdminUserConfig({ password: valid, confirm: valid });
		assert.strictEqual(errors.length, 0);
	});

	it('accepts valid mapview rendering values', () => {
		const errors = validateAdminUserConfig({ mapviewRendering: 'openhab' });
		assert.strictEqual(errors.length, 0);
	});

	it('rejects invalid mapview rendering values', () => {
		const errors = validateAdminUserConfig({ mapviewRendering: 'custom' });
		assert.ok(errors.includes('user.mapviewRendering must be "ohproxy" or "openhab"'));
	});
});
