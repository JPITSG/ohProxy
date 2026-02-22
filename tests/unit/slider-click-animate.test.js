'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const appJs = fs.readFileSync(path.join(PROJECT_ROOT, 'public/app.js'), 'utf8');

describe('Slider click-to-position animation', () => {
	describe('animateSliderValue', () => {
		it('accepts a fromValue parameter', () => {
			const match = appJs.match(/function animateSliderValue\(([^)]+)\)/);
			assert.ok(match, 'animateSliderValue function not found');
			const params = match[1].split(',').map(p => p.trim());
			assert.ok(params.length >= 6, `expected at least 6 params, got ${params.length}`);
			assert.match(params[5], /fromValue/);
		});

		it('uses __sliderAnimId for cancellation tokens', () => {
			assert.match(appJs, /input\.__sliderAnimId/);
			assert.match(appJs, /const animId\s*=\s*\(input\.__sliderAnimId/);
		});

		it('stamps __lastAnimValue on each animation frame', () => {
			assert.match(appJs, /input\.__lastAnimValue\s*=\s*currentValue/);
		});
	});

	describe('cancelSliderAnimation', () => {
		it('exists as a helper function', () => {
			assert.match(appJs, /function cancelSliderAnimation\(input\)/);
		});

		it('increments __sliderAnimId', () => {
			const fnMatch = appJs.match(/function cancelSliderAnimation\(input\)\s*\{([\s\S]*?)\n\}/);
			assert.ok(fnMatch, 'cancelSliderAnimation body not found');
			assert.match(fnMatch[1], /__sliderAnimId/);
		});

		it('deletes __lastAnimValue', () => {
			const fnMatch = appJs.match(/function cancelSliderAnimation\(input\)\s*\{([\s\S]*?)\n\}/);
			assert.ok(fnMatch, 'cancelSliderAnimation body not found');
			assert.match(fnMatch[1], /delete input\.__lastAnimValue/);
		});
	});

	describe('createSliderDragKit return object', () => {
		it('exposes isTrackClick getter', () => {
			assert.match(appJs, /get isTrackClick\(\)/);
		});

		it('exposes onClickAnimate setter', () => {
			assert.match(appJs, /set onClickAnimate\(fn\)/);
		});
	});

	describe('startDrag and input-based track click detection', () => {
		it('calls cancelSliderAnimation in startDrag', () => {
			const kitMatch = appJs.match(/const startDrag\s*=\s*\(e\)\s*=>\s*\{([\s\S]*?)\n\t\};/);
			assert.ok(kitMatch, 'startDrag body not found');
			assert.match(kitMatch[1], /cancelSliderAnimation\(input\)/);
		});

		it('sets awaitingFirstInput in startDrag', () => {
			const kitMatch = appJs.match(/const startDrag\s*=\s*\(e\)\s*=>\s*\{([\s\S]*?)\n\t\};/);
			assert.ok(kitMatch, 'startDrag body not found');
			assert.match(kitMatch[1], /awaitingFirstInput\s*=\s*true/);
		});

		it('detects value jump in input listener and saves trackClickInfo', () => {
			assert.match(appJs, /trackClickInfo\s*=\s*\{\s*oldValue:\s*valueOnDown,\s*targetValue:\s*currentValue\s*\}/);
		});
	});

	describe('endDrag click-animate', () => {
		it('calls animateSliderValue with fromValue argument', () => {
			const endDragMatch = appJs.match(/const endDrag\s*=\s*\(e\)\s*=>\s*\{([\s\S]*?)\n\t\};/);
			assert.ok(endDragMatch, 'endDrag body not found');
			assert.match(endDragMatch[1], /animateSliderValue\(input,\s*target,\s*null,\s*updateVisuals,\s*400,\s*oldVal\)/);
		});
	});

	describe('widget handler guards', () => {
		it('dimmer input handler checks kit.isTrackClick', () => {
			const dimmerInput = appJs.match(/input\.addEventListener\('input',\s*\(\)\s*=>\s*\{\s*\n\t{3}if \(kit\.isTrackClick\) return;[\s\S]*?activationPending/);
			assert.ok(dimmerInput, 'dimmer input handler missing isTrackClick guard');
		});

		it('dimmer change handler checks kit.isTrackClick', () => {
			const dimmerChange = appJs.match(/input\.addEventListener\('change',\s*\(\)\s*=>\s*\{\s*\n\t{3}if \(kit\.isTrackClick\) return;\s*\n\t{3}if \(releaseOnly\)/);
			assert.ok(dimmerChange, 'dimmer change handler missing isTrackClick guard');
		});

		it('color temp input handler checks kit.isTrackClick', () => {
			const ctInput = appJs.match(/input\.addEventListener\('input',\s*\(\)\s*=>\s*\{\s*\n\t{3}if \(kit\.isTrackClick\) return;[\s\S]*?kit\.queueSend\(value,\s*false\);\s*\n\t{2}\}\);\s*\n\t{2}input\.addEventListener\('change'/);
			assert.ok(ctInput, 'color temp input handler missing isTrackClick guard');
		});

		it('color temp change handler checks kit.isTrackClick', () => {
			const ctChange = appJs.match(/input\.addEventListener\('change',\s*\(\)\s*=>\s*\{\s*\n\t{3}if \(kit\.isTrackClick\) return;\s*\n\t{3}kit\.flushSend\(\{\s*force:\s*true\s*\}\)/);
			assert.ok(ctChange, 'color temp change handler missing isTrackClick guard');
		});
	});
});
