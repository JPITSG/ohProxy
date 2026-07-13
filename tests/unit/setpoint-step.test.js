'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { formatSetpointStepCommand } = require('../../lib/widget-normalizer');

const APP_FILE = path.join(__dirname, '..', '..', 'public', 'app.js');

describe('Setpoint decimal stepping', () => {
	it('does not expose binary floating-point artifacts in commands', () => {
		assert.strictEqual(formatSetpointStepCommand(0.2, 0.1, 0, 1, 1), '0.3');
		assert.strictEqual(formatSetpointStepCommand(0.3, 0.1, 0, 1, -1), '0.2');
		assert.strictEqual(formatSetpointStepCommand(0.30000000000000004, 0.1, 0, 1, 1), '0.4');
	});

	it('preserves meaningful precision already present in the current value', () => {
		assert.strictEqual(formatSetpointStepCommand(0.25, 0.1, 0, 1, 1), '0.35');
		assert.strictEqual(formatSetpointStepCommand(1.005, 0.01, 0, 2, 1), '1.015');
		assert.strictEqual(formatSetpointStepCommand(1e-7, 1e-7, 0, 1, 1), '0.0000002');
	});

	it('clamps decimal commands to the configured bounds', () => {
		assert.strictEqual(formatSetpointStepCommand(0.95, 0.1, 0, 1, 1), '1');
		assert.strictEqual(formatSetpointStepCommand(0.05, 0.1, 0, 1, -1), '0');
	});

	it('handles negative values and normalizes negative zero', () => {
		assert.strictEqual(formatSetpointStepCommand(-0.2, 0.1, -1, 1, -1), '-0.3');
		assert.strictEqual(formatSetpointStepCommand(-0.1, 0.1, -1, 1, 1), '0');
	});

	it('wires both Setpoint buttons through the decimal-safe formatter', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /formatSetpointStepCommand\(current, spStep, spMin, spMax, -1\)/);
		assert.match(app, /formatSetpointStepCommand\(current, spStep, spMin, spMax, 1\)/);
		assert.doesNotMatch(app, /current [+-] spStep/);
	});
});
