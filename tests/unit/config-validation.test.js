'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// Validation functions replicated from server.js for testing

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function describeValue(value) {
	if (value === undefined) return '<undefined>';
	if (value === null) return '<null>';
	if (typeof value === 'string') {
		const text = value.replace(/[\r\n]+/g, ' ');
		return text === '' ? "''" : `'${text}'`;
	}
	try {
		const json = JSON.stringify(value);
		if (json !== undefined) return json;
	} catch {
		// ignore
	}
	return String(value);
}

function isPlainObject(value) {
	return value && typeof value === 'object' && !Array.isArray(value);
}

function ensureString(value, name, { allowEmpty = false } = {}, errors) {
	if (typeof value !== 'string') {
		errors.push(`${name} must be a string but currently is ${describeValue(value)}`);
		return;
	}
	if (!allowEmpty && value.trim() === '') {
		errors.push(`${name} is required but currently is ${describeValue(value)}`);
	}
}

function ensureNumber(value, name, { min, max, integer = true } = {}, errors) {
	if (!Number.isFinite(value)) {
		errors.push(`${name} must be a number but currently is ${describeValue(value)}`);
		return;
	}
	if (integer && !Number.isInteger(value)) {
		errors.push(`${name} must be an integer but currently is ${describeValue(value)}`);
		return;
	}
	if (min !== undefined && value < min) {
		errors.push(`${name} must be >= ${min} but currently is ${describeValue(value)}`);
	}
	if (max !== undefined && value > max) {
		errors.push(`${name} must be <= ${max} but currently is ${describeValue(value)}`);
	}
}

function ensureBoolean(value, name, errors) {
	if (typeof value !== 'boolean') {
		errors.push(`${name} must be true/false but currently is ${describeValue(value)}`);
	}
}

function ensureArray(value, name, { allowEmpty = false } = {}, errors) {
	if (!Array.isArray(value)) {
		errors.push(`${name} must be an array but currently is ${describeValue(value)}`);
		return false;
	}
	if (!allowEmpty && value.length === 0) {
		errors.push(`${name} must not be empty but currently is ${describeValue(value)}`);
		return false;
	}
	return true;
}

function isValidIpv4(value) {
	const parts = safeText(value).split('.');
	if (parts.length !== 4) return false;
	return parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isValidCidr(value) {
	const raw = safeText(value).trim();
	const parts = raw.split('/');
	if (parts.length !== 2) return false;
	if (!isValidIpv4(parts[0])) return false;
	const mask = Number(parts[1]);
	return Number.isInteger(mask) && mask >= 0 && mask <= 32;
}

function isAllowAllSubnet(value) {
	return safeText(value).trim() === '0.0.0.0';
}

function ensureUrl(value, name, errors) {
	ensureString(value, name, { allowEmpty: false }, errors);
	if (typeof value !== 'string' || value.trim() === '') return;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			errors.push(`${name} must use http or https but currently is ${describeValue(value)}`);
		}
	} catch {
		errors.push(`${name} must be a valid URL but currently is ${describeValue(value)}`);
	}
}

function ensureVersion(value, name, errors) {
	ensureString(value, name, { allowEmpty: false }, errors);
	if (typeof value !== 'string' || value.trim() === '') return;
	if (!/^v?\d+$/i.test(value.trim())) {
		errors.push(`${name} must be digits or v123 but currently is ${describeValue(value)}`);
	}
}

describe('Config Validation Functions', () => {
	describe('ensureString', () => {
		it('accepts valid string', () => {
			const errors = [];
			ensureString('test', 'field', {}, errors);
			assert.strictEqual(errors.length, 0);
		});

		it('rejects non-string (number)', () => {
			const errors = [];
			ensureString(123, 'field', {}, errors);
			assert.strictEqual(errors.length, 1);
			assert.ok(errors[0].includes('must be a string'));
		});

		it('rejects non-string (object)', () => {
			const errors = [];
			ensureString({}, 'field', {}, errors);
			assert.strictEqual(errors.length, 1);
		});

		it('rejects non-string (array)', () => {
			const errors = [];
			ensureString([], 'field', {}, errors);
			assert.strictEqual(errors.length, 1);
		});

		it('rejects empty when required (allowEmpty=false)', () => {
			const errors = [];
			ensureString('', 'field', { allowEmpty: false }, errors);
			assert.strictEqual(errors.length, 1);
			assert.ok(errors[0].includes('is required'));
		});

		it('rejects whitespace-only when required', () => {
			const errors = [];
			ensureString('   ', 'field', { allowEmpty: false }, errors);
			assert.strictEqual(errors.length, 1);
		});

		it('allows empty when optional (allowEmpty=true)', () => {
			const errors = [];
			ensureString('', 'field', { allowEmpty: true }, errors);
			assert.strictEqual(errors.length, 0);
		});

		it('rejects null', () => {
			const errors = [];
			ensureString(null, 'field', {}, errors);
			assert.strictEqual(errors.length, 1);
		});

		it('rejects undefined', () => {
			const errors = [];
			ensureString(undefined, 'field', {}, errors);
			assert.strictEqual(errors.length, 1);
		});
	});

	describe('ensureNumber', () => {
		it('accepts valid number', () => {
			const errors = [];
			ensureNumber(100, 'field', {}, errors);
			assert.strictEqual(errors.length, 0);
		});

		it('rejects non-number (string)', () => {
			const errors = [];
			ensureNumber('abc', 'field', {}, errors);
			assert.strictEqual(errors.length, 1);
			assert.ok(errors[0].includes('must be a number'));
		});

		it('rejects NaN', () => {
			const errors = [];
			ensureNumber(NaN, 'field', {}, errors);
			assert.strictEqual(errors.length, 1);
		});

		it('rejects Infinity', () => {
			const errors = [];
			ensureNumber(Infinity, 'field', {}, errors);
			assert.strictEqual(errors.length, 1);
		});

		it('enforces min bound', () => {
			const errors = [];
			ensureNumber(-1, 'field', { min: 0 }, errors);
			assert.strictEqual(errors.length, 1);
			assert.ok(errors[0].includes('must be >= 0'));
		});

		it('accepts value at min bound', () => {
			const errors = [];
			ensureNumber(0, 'field', { min: 0 }, errors);
			assert.strictEqual(errors.length, 0);
		});

		it('enforces max bound', () => {
			const errors = [];
			ensureNumber(100, 'field', { max: 50 }, errors);
			assert.strictEqual(errors.length, 1);
			assert.ok(errors[0].includes('must be <= 50'));
		});

		it('accepts value at max bound', () => {
			const errors = [];
			ensureNumber(50, 'field', { max: 50 }, errors);
			assert.strictEqual(errors.length, 0);
		});

		it('enforces integer requirement', () => {
			const errors = [];
			ensureNumber(3.14, 'field', { integer: true }, errors);
			assert.strictEqual(errors.length, 1);
			assert.ok(errors[0].includes('must be an integer'));
		});

		it('allows float when integer=false', () => {
			const errors = [];
			ensureNumber(3.14, 'field', { integer: false }, errors);
			assert.strictEqual(errors.length, 0);
		});

		it('handles negative numbers correctly', () => {
			const errors = [];
			ensureNumber(-10, 'field', { min: -20, max: 0 }, errors);
			assert.strictEqual(errors.length, 0);
		});
	});

	describe('ensureBoolean', () => {
		it('accepts true', () => {
			const errors = [];
			ensureBoolean(true, 'field', errors);
			assert.strictEqual(errors.length, 0);
		});

		it('accepts false', () => {
			const errors = [];
			ensureBoolean(false, 'field', errors);
			assert.strictEqual(errors.length, 0);
		});

		it('rejects string "true"', () => {
			const errors = [];
			ensureBoolean('true', 'field', errors);
			assert.strictEqual(errors.length, 1);
			assert.ok(errors[0].includes('must be true/false'));
		});

		it('rejects number 1', () => {
			const errors = [];
			ensureBoolean(1, 'field', errors);
			assert.strictEqual(errors.length, 1);
		});

		it('rejects null', () => {
			const errors = [];
			ensureBoolean(null, 'field', errors);
			assert.strictEqual(errors.length, 1);
		});

		it('rejects undefined', () => {
			const errors = [];
			ensureBoolean(undefined, 'field', errors);
			assert.strictEqual(errors.length, 1);
		});
	});

	describe('ensureArray', () => {
		it('accepts valid array', () => {
			const errors = [];
			const result = ensureArray([1, 2, 3], 'field', {}, errors);
			assert.strictEqual(result, true);
			assert.strictEqual(errors.length, 0);
		});

		it('rejects non-array (object)', () => {
			const errors = [];
			const result = ensureArray({}, 'field', {}, errors);
			assert.strictEqual(result, false);
			assert.strictEqual(errors.length, 1);
			assert.ok(errors[0].includes('must be an array'));
		});

		it('rejects non-array (string)', () => {
			const errors = [];
			const result = ensureArray('not array', 'field', {}, errors);
			assert.strictEqual(result, false);
		});

		it('rejects empty when required (allowEmpty=false)', () => {
			const errors = [];
			const result = ensureArray([], 'field', { allowEmpty: false }, errors);
			assert.strictEqual(result, false);
			assert.ok(errors[0].includes('must not be empty'));
		});

		it('allows empty when optional (allowEmpty=true)', () => {
			const errors = [];
			const result = ensureArray([], 'field', { allowEmpty: true }, errors);
			assert.strictEqual(result, true);
			assert.strictEqual(errors.length, 0);
		});

		it('rejects null', () => {
			const errors = [];
			ensureArray(null, 'field', {}, errors);
			assert.strictEqual(errors.length, 1);
		});
	});

	describe('isValidIpv4', () => {
		it('accepts valid IP 192.168.1.1', () => {
			assert.strictEqual(isValidIpv4('192.168.1.1'), true);
		});

		it('accepts 0.0.0.0', () => {
			assert.strictEqual(isValidIpv4('0.0.0.0'), true);
		});

		it('accepts 255.255.255.255', () => {
			assert.strictEqual(isValidIpv4('255.255.255.255'), true);
		});

		it('rejects too few octets (3)', () => {
			assert.strictEqual(isValidIpv4('192.168.1'), false);
		});

		it('rejects too many octets (5)', () => {
			assert.strictEqual(isValidIpv4('192.168.1.1.1'), false);
		});

		it('rejects octet > 255', () => {
			assert.strictEqual(isValidIpv4('192.168.1.256'), false);
		});

		it('rejects negative octet', () => {
			assert.strictEqual(isValidIpv4('192.168.1.-1'), false);
		});

		it('rejects non-numeric octet', () => {
			assert.strictEqual(isValidIpv4('192.168.1.abc'), false);
		});

		it('rejects empty string', () => {
			assert.strictEqual(isValidIpv4(''), false);
		});

		it('rejects IPv6 format', () => {
			assert.strictEqual(isValidIpv4('::1'), false);
		});
	});

	describe('isValidCidr', () => {
		it('accepts valid CIDR 192.168.1.0/24', () => {
			assert.strictEqual(isValidCidr('192.168.1.0/24'), true);
		});

		it('accepts /0 mask', () => {
			assert.strictEqual(isValidCidr('0.0.0.0/0'), true);
		});

		it('accepts /32 mask', () => {
			assert.strictEqual(isValidCidr('192.168.1.1/32'), true);
		});

		it('rejects missing mask', () => {
			assert.strictEqual(isValidCidr('192.168.1.0'), false);
		});

		it('rejects invalid mask (> 32)', () => {
			assert.strictEqual(isValidCidr('192.168.1.0/33'), false);
		});

		it('rejects negative mask', () => {
			assert.strictEqual(isValidCidr('192.168.1.0/-1'), false);
		});

		it('rejects non-numeric mask', () => {
			assert.strictEqual(isValidCidr('192.168.1.0/abc'), false);
		});

		it('rejects invalid IP in CIDR', () => {
			assert.strictEqual(isValidCidr('192.168.1.256/24'), false);
		});

		it('rejects empty string', () => {
			assert.strictEqual(isValidCidr(''), false);
		});
	});

	describe('isAllowAllSubnet', () => {
		it('detects 0.0.0.0', () => {
			assert.strictEqual(isAllowAllSubnet('0.0.0.0'), true);
		});

		it('rejects other IP', () => {
			assert.strictEqual(isAllowAllSubnet('192.168.1.0'), false);
		});

		it('rejects CIDR format', () => {
			assert.strictEqual(isAllowAllSubnet('0.0.0.0/0'), false);
		});

		it('handles whitespace', () => {
			assert.strictEqual(isAllowAllSubnet('  0.0.0.0  '), true);
		});

		it('rejects empty', () => {
			assert.strictEqual(isAllowAllSubnet(''), false);
		});
	});

	describe('ensureUrl', () => {
		it('accepts http URL', () => {
			const errors = [];
			ensureUrl('http://example.com', 'field', errors);
			assert.strictEqual(errors.length, 0);
		});

		it('accepts https URL', () => {
			const errors = [];
			ensureUrl('https://example.com', 'field', errors);
			assert.strictEqual(errors.length, 0);
		});

		it('accepts URL with port', () => {
			const errors = [];
			ensureUrl('http://localhost:8080', 'field', errors);
			assert.strictEqual(errors.length, 0);
		});

		it('accepts URL with path', () => {
			const errors = [];
			ensureUrl('http://example.com/path/to/resource', 'field', errors);
			assert.strictEqual(errors.length, 0);
		});

		it('rejects ftp URL', () => {
			const errors = [];
			ensureUrl('ftp://example.com', 'field', errors);
			assert.ok(errors.length > 0);
			assert.ok(errors.some(e => e.includes('http or https')));
		});

		it('rejects invalid URL', () => {
			const errors = [];
			ensureUrl('not-a-url', 'field', errors);
			assert.ok(errors.length > 0);
			assert.ok(errors.some(e => e.includes('valid URL')));
		});

		it('rejects empty URL', () => {
			const errors = [];
			ensureUrl('', 'field', errors);
			assert.ok(errors.length > 0);
		});
	});

	describe('ensureVersion', () => {
		it('accepts v-prefix version', () => {
			const errors = [];
			ensureVersion('v123', 'field', errors);
			assert.strictEqual(errors.length, 0);
		});

		it('accepts numeric version', () => {
			const errors = [];
			ensureVersion('123', 'field', errors);
			assert.strictEqual(errors.length, 0);
		});

		it('accepts single digit', () => {
			const errors = [];
			ensureVersion('1', 'field', errors);
			assert.strictEqual(errors.length, 0);
		});

		it('rejects semver format', () => {
			const errors = [];
			ensureVersion('1.2.3', 'field', errors);
			assert.ok(errors.length > 0);
		});

		it('rejects alpha characters', () => {
			const errors = [];
			ensureVersion('v1a', 'field', errors);
			assert.ok(errors.length > 0);
		});

		it('rejects empty', () => {
			const errors = [];
			ensureVersion('', 'field', errors);
			assert.ok(errors.length > 0);
		});
	});

	describe('Voice Model Validation', () => {
		const validModels = ['browser', 'vosk'];

		it('accepts browser', () => {
			assert.ok(validModels.includes('browser'));
		});

		it('accepts vosk', () => {
			assert.ok(validModels.includes('vosk'));
		});

		it('rejects adaptive', () => {
			assert.strictEqual(validModels.includes('adaptive'), false, 'adaptive should no longer be valid');
		});

		it('rejects empty string', () => {
			assert.strictEqual(validModels.includes(''), false);
		});

		it('rejects arbitrary string', () => {
			assert.strictEqual(validModels.includes('whisper'), false);
		});
	});

	describe('describeValue', () => {
		it('describes undefined', () => {
			assert.strictEqual(describeValue(undefined), '<undefined>');
		});

		it('describes null', () => {
			assert.strictEqual(describeValue(null), '<null>');
		});

		it('describes empty string', () => {
			assert.strictEqual(describeValue(''), "''");
		});

		it('describes string with value', () => {
			const result = describeValue('hello');
			assert.ok(result.includes('hello'));
		});

		it('describes number', () => {
			const result = describeValue(123);
			assert.strictEqual(result, '123');
		});

		it('describes boolean', () => {
			assert.strictEqual(describeValue(true), 'true');
			assert.strictEqual(describeValue(false), 'false');
		});

		it('describes array', () => {
			const result = describeValue([1, 2, 3]);
			assert.strictEqual(result, '[1,2,3]');
		});

		it('describes object', () => {
			const result = describeValue({ key: 'value' });
			assert.ok(result.includes('key'));
		});
	});
});
