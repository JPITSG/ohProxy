'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

// Replicated from public/app.js.
function switchSupportToggleCommand({ isDimmer, sliderMin, sliderMax, currentValue, liveState }) {
	const min = Number(sliderMin);
	const max = Number(sliderMax);
	const current = Number(currentValue);
	if (isDimmer) {
		const live = Number.parseFloat(safeText(liveState).trim());
		const isOn = Number.isFinite(live) ? live > min : (Number.isFinite(current) && current > min);
		return isOn ? 'OFF' : 'ON';
	}
	const next = current > min ? min : max;
	return String(next);
}

function parseSwitchSupport(rawValue) {
	return rawValue === true || rawValue === 'true';
}

describe('Slider switchSupport behavior', () => {
	it('enables only when switchSupport is true or "true"', () => {
		assert.strictEqual(parseSwitchSupport(true), true);
		assert.strictEqual(parseSwitchSupport('true'), true);
		assert.strictEqual(parseSwitchSupport(false), false);
		assert.strictEqual(parseSwitchSupport('false'), false);
		assert.strictEqual(parseSwitchSupport(undefined), false);
		assert.strictEqual(parseSwitchSupport(null), false);
	});

	it('toggles dimmer OFF when live state is above minimum', () => {
		const command = switchSupportToggleCommand({
			isDimmer: true,
			sliderMin: 0,
			sliderMax: 100,
			currentValue: 0,
			liveState: '35',
		});
		assert.strictEqual(command, 'OFF');
	});

	it('toggles dimmer ON when live state is at minimum', () => {
		const command = switchSupportToggleCommand({
			isDimmer: true,
			sliderMin: 0,
			sliderMax: 100,
			currentValue: 50,
			liveState: '0',
		});
		assert.strictEqual(command, 'ON');
	});

	it('falls back to current slider value when live dimmer state is not numeric', () => {
		assert.strictEqual(switchSupportToggleCommand({
			isDimmer: true,
			sliderMin: 0,
			sliderMax: 100,
			currentValue: 60,
			liveState: 'UNDEF',
		}), 'OFF');

		assert.strictEqual(switchSupportToggleCommand({
			isDimmer: true,
			sliderMin: 0,
			sliderMax: 100,
			currentValue: 0,
			liveState: 'UNDEF',
		}), 'ON');
	});

	it('keeps numeric min/max toggle behavior for non-dimmer sliders', () => {
		assert.strictEqual(switchSupportToggleCommand({
			isDimmer: false,
			sliderMin: 0,
			sliderMax: 100,
			currentValue: 70,
			liveState: '70',
		}), '0');

		assert.strictEqual(switchSupportToggleCommand({
			isDimmer: false,
			sliderMin: 0,
			sliderMax: 100,
			currentValue: 0,
			liveState: '0',
		}), '100');
	});

	it('handles custom slider ranges for fallback toggle', () => {
		assert.strictEqual(switchSupportToggleCommand({
			isDimmer: false,
			sliderMin: 10,
			sliderMax: 90,
			currentValue: 10,
			liveState: '10',
		}), '90');
		assert.strictEqual(switchSupportToggleCommand({
			isDimmer: false,
			sliderMin: 10,
			sliderMax: 90,
			currentValue: 40,
			liveState: '40',
		}), '10');
	});
});
