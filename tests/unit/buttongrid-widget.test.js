'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Replicated from server.js for unit testing

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function normalizeButtongridButtons(widget) {
	const buttons = [];
	if (Array.isArray(widget?.buttons)) {
		for (const b of widget.buttons) {
			if (!b || typeof b !== 'object') continue;
			const itemName = safeText(b?.itemName || b?.item?.name || '');
			buttons.push({
				row: parseInt(b?.row, 10) || 1,
				column: parseInt(b?.column, 10) || 1,
				command: safeText(b?.command || b?.cmd || ''),
				releaseCommand: safeText(b?.releaseCommand || b?.release || ''),
				label: safeText(b?.label || ''),
				icon: safeText(b?.icon || b?.staticIcon || ''),
				itemName,
				state: safeText(b?.state ?? b?.item?.state ?? ''),
				stateless: !!b?.stateless,
			});
		}
		return buttons;
	}
	const inlineButtons = widget?.mappings || widget?.mapping;
	if (Array.isArray(inlineButtons)) {
		for (const b of inlineButtons) {
			if (b?.row == null && b?.column == null) continue;
			const itemName = safeText(b?.itemName || b?.item?.name || '');
			buttons.push({
				row: parseInt(b?.row, 10) || 1,
				column: parseInt(b?.column, 10) || 1,
				command: safeText(b?.command || b?.cmd || ''),
				releaseCommand: safeText(b?.releaseCommand || b?.release || ''),
				label: safeText(b?.label || ''),
				icon: safeText(b?.icon || b?.staticIcon || ''),
				itemName,
				state: safeText(b?.state ?? b?.item?.state ?? ''),
				stateless: !!b?.stateless,
			});
		}
	}
	const children = widget?.widgets || widget?.widget;
	if (Array.isArray(children)) {
		for (const c of children) {
			if (safeText(c?.type).toLowerCase() !== 'button') continue;
			const itemName = safeText(c?.itemName || c?.item?.name || '');
			buttons.push({
				row: parseInt(c?.row, 10) || 1,
				column: parseInt(c?.column, 10) || 1,
				command: safeText(c?.command || c?.cmd || c?.click || ''),
				releaseCommand: safeText(c?.releaseCommand || c?.release || ''),
				label: safeText(c?.label || ''),
				icon: safeText(c?.icon || c?.staticIcon || ''),
				itemName,
				state: safeText(c?.state ?? c?.item?.state ?? ''),
				stateless: !!c?.stateless,
			});
		}
	}
	return buttons;
}

function buttonsSignature(buttons) {
	if (!buttons || !buttons.length) return '';
	return buttons.map((b) =>
		`${b.row}:${b.column}:${b.command}:${b.releaseCommand}:${b.label}:${b.icon}:${b.itemName}:${b.state || ''}:${b.stateless}`
	).join('|');
}

describe('Buttongrid Widget', () => {
	describe('normalizeButtongridButtons', () => {
		it('normalizes inline buttons from mappings array', () => {
			const widget = {
				type: 'Buttongrid',
				mappings: [
					{ row: 1, column: 1, command: 'POWER', label: 'Power', icon: 'material:power_settings_new' },
					{ row: 1, column: 2, command: 'UP', label: 'Up', icon: 'material:keyboard_arrow_up' },
					{ row: 2, column: 2, command: 'OK', label: 'OK' },
				],
			};
			const buttons = normalizeButtongridButtons(widget);
			assert.strictEqual(buttons.length, 3);
			assert.strictEqual(buttons[0].row, 1);
			assert.strictEqual(buttons[0].column, 1);
			assert.strictEqual(buttons[0].command, 'POWER');
			assert.strictEqual(buttons[0].label, 'Power');
			assert.strictEqual(buttons[0].icon, 'material:power_settings_new');
			assert.strictEqual(buttons[2].icon, '');
		});

		it('normalizes child Button widgets from widgets array', () => {
			const widget = {
				type: 'Buttongrid',
				mappings: [],
				widgets: [
					{ type: 'Button', row: 1, column: 1, command: 'PLAY', label: 'Play', icon: 'material:play_arrow', stateless: true },
					{ type: 'Button', row: 1, column: 2, click: 'PAUSE', label: 'Pause', staticIcon: 'material:pause' },
					{ type: 'Text', row: 2, column: 1, label: 'Ignored' },
				],
			};
			const buttons = normalizeButtongridButtons(widget);
			assert.strictEqual(buttons.length, 2);
			assert.strictEqual(buttons[0].command, 'PLAY');
			assert.strictEqual(buttons[0].stateless, true);
			assert.strictEqual(buttons[1].command, 'PAUSE');
			assert.strictEqual(buttons[1].icon, 'material:pause');
		});

		it('prefers normalized buttons payload when provided', () => {
			const widget = {
				type: 'Buttongrid',
				buttons: [
					{ row: 1, column: 1, command: 'POWER', label: 'Power', itemName: 'RemoteItem', state: 'POWER' },
				],
				mappings: [
					{ row: 9, column: 9, command: 'SHOULD_NOT_USE', label: 'Ignored' },
				],
			};
			const buttons = normalizeButtongridButtons(widget);
			assert.strictEqual(buttons.length, 1);
			assert.strictEqual(buttons[0].command, 'POWER');
			assert.strictEqual(buttons[0].itemName, 'RemoteItem');
			assert.strictEqual(buttons[0].state, 'POWER');
		});

		it('skips mappings without row or column (regular Switch mappings)', () => {
			const widget = {
				type: 'Switch',
				mappings: [
					{ command: 'ON', label: 'On' },
					{ command: 'OFF', label: 'Off' },
				],
			};
			const buttons = normalizeButtongridButtons(widget);
			assert.strictEqual(buttons.length, 0);
		});

		it('handles empty widget', () => {
			assert.deepStrictEqual(normalizeButtongridButtons({}), []);
			assert.deepStrictEqual(normalizeButtongridButtons(null), []);
			assert.deepStrictEqual(normalizeButtongridButtons(undefined), []);
		});

		it('parses row and column as integers', () => {
			const widget = {
				mappings: [
					{ row: '3', column: '4', command: 'TEST' },
				],
			};
			const buttons = normalizeButtongridButtons(widget);
			assert.strictEqual(buttons[0].row, 3);
			assert.strictEqual(buttons[0].column, 4);
		});

		it('defaults row/column to 1 for invalid values', () => {
			const widget = {
				mappings: [
					{ row: 'abc', column: 0, command: 'TEST' },
				],
			};
			const buttons = normalizeButtongridButtons(widget);
			assert.strictEqual(buttons.length, 1);
			assert.strictEqual(buttons[0].row, 1); // parseInt('abc') is NaN → ||1
			assert.strictEqual(buttons[0].column, 1); // parseInt(0) is 0 → ||1
		});

		it('handles releaseCommand for press-and-hold buttons', () => {
			const widget = {
				mappings: [
					{ row: 1, column: 1, command: 'VOL_UP', releaseCommand: 'VOL_STOP', label: 'Volume Up' },
				],
			};
			const buttons = normalizeButtongridButtons(widget);
			assert.strictEqual(buttons[0].releaseCommand, 'VOL_STOP');
		});

		it('extracts itemName from button item', () => {
			const widget = {
				widgets: [
					{ type: 'Button', row: 1, column: 1, command: 'ON', item: { name: 'CustomItem', state: 'ON' } },
				],
			};
			const buttons = normalizeButtongridButtons(widget);
			assert.strictEqual(buttons[0].itemName, 'CustomItem');
			assert.strictEqual(buttons[0].state, 'ON');
		});

		it('handles mixed inline and child buttons', () => {
			const widget = {
				mappings: [
					{ row: 1, column: 1, command: 'INLINE', label: 'Inline' },
				],
				widgets: [
					{ type: 'Button', row: 2, column: 1, command: 'CHILD', label: 'Child' },
				],
			};
			const buttons = normalizeButtongridButtons(widget);
			assert.strictEqual(buttons.length, 2);
			assert.strictEqual(buttons[0].command, 'INLINE');
			assert.strictEqual(buttons[1].command, 'CHILD');
		});
	});

	describe('buttonsSignature', () => {
		it('returns empty string for empty array', () => {
			assert.strictEqual(buttonsSignature([]), '');
			assert.strictEqual(buttonsSignature(null), '');
			assert.strictEqual(buttonsSignature(undefined), '');
		});

		it('generates deterministic signature', () => {
			const buttons = [
				{ row: 1, column: 1, command: 'POWER', releaseCommand: '', label: 'Power', icon: 'material:power', itemName: '', state: 'POWER', stateless: true },
				{ row: 1, column: 2, command: 'UP', releaseCommand: '', label: 'Up', icon: '', itemName: '', state: '', stateless: false },
			];
			const sig = buttonsSignature(buttons);
			assert.strictEqual(sig, '1:1:POWER::Power:material:power::POWER:true|1:2:UP::Up::::false');
		});

		it('changes when button properties change', () => {
			const buttons1 = [{ row: 1, column: 1, command: 'A', releaseCommand: '', label: 'A', icon: '', itemName: '', stateless: false }];
			const buttons2 = [{ row: 1, column: 1, command: 'B', releaseCommand: '', label: 'B', icon: '', itemName: '', stateless: false }];
			assert.notStrictEqual(buttonsSignature(buttons1), buttonsSignature(buttons2));
		});
	});
});
