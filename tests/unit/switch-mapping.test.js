'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

// Replicated from public/app.js.
function parseSwitchMappingCommand(rawMapping) {
	let command = '';
	let releaseCommand = '';
	if (rawMapping && typeof rawMapping === 'object') {
		command = safeText(rawMapping.command ?? '').trim();
		releaseCommand = safeText(rawMapping.releaseCommand ?? '').trim();
	} else {
		command = safeText(rawMapping).trim();
	}
	if (command && releaseCommand) return { mode: 'dual', press: command, release: releaseCommand };
	if (!command || !command.includes(':')) return { mode: 'single', press: command };
	const firstColon = command.indexOf(':');
	const lastColon = command.lastIndexOf(':');
	if (firstColon <= 0 || firstColon !== lastColon || firstColon >= command.length - 1) {
		return { mode: 'single', press: command };
	}
	const press = command.slice(0, firstColon).trim();
	const release = command.slice(firstColon + 1).trim();
	if (!press || !release) return { mode: 'single', press: command };
	return { mode: 'dual', press, release };
}

describe('Switch Mapping Parser', () => {
	it('treats plain command as single', () => {
		const parsed = parseSwitchMappingCommand('ON');
		assert.deepStrictEqual(parsed, { mode: 'single', press: 'ON' });
	});

	it('parses press:release command as dual', () => {
		const parsed = parseSwitchMappingCommand('ON:OFF');
		assert.deepStrictEqual(parsed, { mode: 'dual', press: 'ON', release: 'OFF' });
	});

	it('parses openHAB releaseCommand field as dual', () => {
		const parsed = parseSwitchMappingCommand({ command: 'ON', releaseCommand: 'OFF', label: 'Hold' });
		assert.deepStrictEqual(parsed, { mode: 'dual', press: 'ON', release: 'OFF' });
	});

	it('trims whitespace around dual commands', () => {
		const parsed = parseSwitchMappingCommand('  ON  :  OFF  ');
		assert.deepStrictEqual(parsed, { mode: 'dual', press: 'ON', release: 'OFF' });
	});

	it('falls back to single when missing release command', () => {
		const parsed = parseSwitchMappingCommand('ON:');
		assert.deepStrictEqual(parsed, { mode: 'single', press: 'ON:' });
	});

	it('falls back to single when missing press command', () => {
		const parsed = parseSwitchMappingCommand(':OFF');
		assert.deepStrictEqual(parsed, { mode: 'single', press: ':OFF' });
	});

	it('falls back to single when more than one separator is present', () => {
		const parsed = parseSwitchMappingCommand('A:B:C');
		assert.deepStrictEqual(parsed, { mode: 'single', press: 'A:B:C' });
	});

	it('does not special-case time values by itself', () => {
		const parsed = parseSwitchMappingCommand('03:30');
		assert.deepStrictEqual(parsed, { mode: 'dual', press: '03', release: '30' });
	});
});
