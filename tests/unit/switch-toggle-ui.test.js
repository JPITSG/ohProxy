'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');

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

function normalizeSwitchCommandToken(command) {
	return safeText(command).trim().toUpperCase();
}

function isOnOffCommandToken(command) {
	const token = normalizeSwitchCommandToken(command);
	return token === 'ON' || token === 'OFF';
}

function isExplicitOnOffSwitchMapping(parsed) {
	if (!parsed) return false;
	if (parsed.mode === 'dual') {
		const press = normalizeSwitchCommandToken(parsed.press);
		const release = normalizeSwitchCommandToken(parsed.release);
		if (!isOnOffCommandToken(press) || !isOnOffCommandToken(release)) return false;
		return press !== release;
	}
	return isOnOffCommandToken(parsed.press);
}

describe('Switch Toggle UI', () => {
	it('enables slider style only for explicit ON/OFF mappings', () => {
		assert.strictEqual(isExplicitOnOffSwitchMapping(parseSwitchMappingCommand('ON')), true);
		assert.strictEqual(isExplicitOnOffSwitchMapping(parseSwitchMappingCommand('off')), true);
		assert.strictEqual(isExplicitOnOffSwitchMapping(parseSwitchMappingCommand('ON:OFF')), true);
		assert.strictEqual(isExplicitOnOffSwitchMapping(parseSwitchMappingCommand('OFF:ON')), true);
		assert.strictEqual(isExplicitOnOffSwitchMapping(parseSwitchMappingCommand('ON:ON')), false);
		assert.strictEqual(isExplicitOnOffSwitchMapping(parseSwitchMappingCommand('DIM 50:DIM 0')), false);
		assert.strictEqual(isExplicitOnOffSwitchMapping(parseSwitchMappingCommand('TOGGLE')), false);
	});

	it('keeps dual hold/release support while adding ON/OFF slider presentation', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const singleOnOffToggle = mapping\.length === 1 && isExplicitOnOffSwitchMapping\(parsedSingleMapping\);/);
		assert.match(app, /if \(singleOnOffToggle\) \{\s*applySwitchToggleClass\(btn, true\);/);
		assert.match(app, /switchToggleDualAriaLabel\(parsed\)/);
		assert.match(app, /bindSwitchDualCommand\(btn, itemName, parsed\.press, parsed\.release, card\);/);
	});

	it('removes legacy Turn ON/OFF text assignments from switch button rendering', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.doesNotMatch(app, /btn\.textContent = isOn \? 'Turn OFF' : 'Turn ON';/);
	});

	it('defines switch-toggle style at 28px tall and right aligned', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(css, /\.switch-card \.inline-controls \.switch-btn\.switch-toggle \{[\s\S]*?height: 28px;/);
		assert.match(css, /\.switch-card \.inline-controls \.switch-btn\.switch-toggle \{[\s\S]*?margin-left: auto;/);
		assert.match(css, /\.switch-card \.inline-controls \.switch-btn\.switch-toggle::after \{/);
	});

	it('prevents premature title wrapping on single switch cards', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(css, /\.switch-card\.switch-single \.labelStack \{[\s\S]*?flex: 1 1 auto;/);
		assert.match(css, /\.switch-card\.switch-single \.title \{[\s\S]*?white-space: nowrap;/);
		assert.match(css, /\.switch-card\.switch-single \.inline-controls \{[\s\S]*?flex: 0 0 auto;/);
	});
});
