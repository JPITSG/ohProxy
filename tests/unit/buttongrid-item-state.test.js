'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function widgetType(widget) {
	return safeText(widget?.type || widget?.widgetType || widget?.item?.type || '');
}

function normalizeButtongridButtons(widget) {
	const buttons = [];
	const inlineButtons = widget?.mappings || widget?.mapping;
	if (Array.isArray(inlineButtons)) {
		for (const b of inlineButtons) {
			if (b?.row == null && b?.column == null) continue;
			buttons.push({
				row: parseInt(b?.row, 10) || 1,
				column: parseInt(b?.column, 10) || 1,
				command: safeText(b?.command || ''),
				itemName: safeText(b?.itemName || b?.item?.name || ''),
				state: safeText(b?.state ?? b?.item?.state ?? ''),
			});
		}
	}
	return buttons;
}

function setButtongridButtonState(widget, itemName, nextState) {
	if (!widget) return false;
	if (widgetType(widget).toLowerCase() !== 'buttongrid') return false;
	const targetItem = safeText(itemName).trim();
	if (!targetItem) return false;
	let buttons = Array.isArray(widget?.buttons) ? widget.buttons : null;
	if (!buttons) {
		buttons = normalizeButtongridButtons(widget);
		if (!buttons.length) return false;
		widget.buttons = buttons;
	}
	const stateValue = safeText(nextState);
	let changed = false;
	for (const b of buttons) {
		const btnItemName = safeText(b?.itemName || b?.item?.name || '').trim();
		if (!btnItemName || btnItemName !== targetItem) continue;
		const prevState = safeText(b?.state ?? b?.item?.state ?? '');
		if (prevState !== stateValue) changed = true;
		b.state = stateValue;
	}
	return changed;
}

describe('Buttongrid Item State Updates', () => {
	it('updates matching button state in existing buttons payload', () => {
		const widget = {
			type: 'Buttongrid',
			buttons: [
				{ command: 'ON', itemName: 'LightA', state: 'OFF' },
				{ command: 'ON', itemName: 'LightB', state: 'OFF' },
			],
		};
		const changed = setButtongridButtonState(widget, 'LightA', 'ON');
		assert.strictEqual(changed, true);
		assert.strictEqual(widget.buttons[0].state, 'ON');
		assert.strictEqual(widget.buttons[1].state, 'OFF');
	});

	it('hydrates buttons from mappings when buttons payload is absent', () => {
		const widget = {
			type: 'Buttongrid',
			mappings: [
				{ row: 1, column: 1, command: 'ON', itemName: 'FanA' },
			],
		};
		const changed = setButtongridButtonState(widget, 'FanA', 'ON');
		assert.strictEqual(changed, true);
		assert.ok(Array.isArray(widget.buttons));
		assert.strictEqual(widget.buttons[0].state, 'ON');
	});

	it('returns false when widget is not buttongrid', () => {
		const widget = { type: 'Switch', item: { name: 'LightA', state: 'OFF' } };
		assert.strictEqual(setButtongridButtonState(widget, 'LightA', 'ON'), false);
	});
});
