'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Replicated from server.js for unit testing

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function isButtongridButtonVisible(button) {
	if (button?.visibility === false || button?.visibility === 0) return false;
	const raw = safeText(button?.visibility).trim().toLowerCase();
	if (raw === 'false' || raw === '0') return false;
	return true;
}

function normalizeButtongridRow(value) {
	const parsed = parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

function normalizeLegacyButtongridColumn(value) {
	const parsed = parseInt(value, 10);
	if (!Number.isFinite(parsed)) return 1;
	if (parsed < 1 || parsed > 12) return null;
	return parsed;
}

function normalizeChildButtongridColumn(value) {
	const parsed = parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

function normalizeButtongridButtons(widget) {
	const buttons = [];
	const parentItemName = safeText(widget?.item?.name || widget?.itemName || '');
	if (Array.isArray(widget?.buttons)) {
		for (const b of widget.buttons) {
			if (!b || typeof b !== 'object') continue;
			const source = safeText(b?.source).trim().toLowerCase() === 'child' ? 'child' : 'legacy';
			if (source === 'child') {
				const itemName = safeText(b?.itemName || b?.item?.name || '');
				buttons.push({
					row: normalizeButtongridRow(b?.row),
					column: normalizeChildButtongridColumn(b?.column),
					command: safeText(b?.command || b?.cmd || b?.click || ''),
					releaseCommand: safeText(b?.releaseCommand || b?.release || ''),
					label: safeText(b?.label || ''),
					icon: safeText(b?.icon || b?.staticIcon || ''),
					itemName,
					state: safeText(b?.state ?? b?.item?.state ?? ''),
					stateless: !!b?.stateless,
					source: 'child',
					labelcolor: safeText(b?.labelcolor || ''),
					iconcolor: safeText(b?.iconcolor || ''),
					visibility: isButtongridButtonVisible(b),
				});
				continue;
			}
			const column = normalizeLegacyButtongridColumn(b?.column);
			if (column == null) continue;
			buttons.push({
				row: normalizeButtongridRow(b?.row),
				column,
				command: safeText(b?.command || b?.cmd || ''),
				releaseCommand: '',
				label: safeText(b?.label || ''),
				icon: safeText(b?.icon || b?.staticIcon || ''),
				itemName: parentItemName,
				state: '',
				stateless: true,
				source: 'legacy',
				labelcolor: safeText(b?.labelcolor || ''),
				iconcolor: safeText(b?.iconcolor || ''),
				visibility: isButtongridButtonVisible(b),
			});
		}
		return buttons;
	}
	const inlineButtons = widget?.mappings || widget?.mapping;
	if (Array.isArray(inlineButtons)) {
		for (const b of inlineButtons) {
			if (b?.row == null && b?.column == null) continue;
			const column = normalizeLegacyButtongridColumn(b?.column);
			if (column == null) continue;
			buttons.push({
				row: normalizeButtongridRow(b?.row),
				column,
				command: safeText(b?.command || b?.cmd || ''),
				releaseCommand: '',
				label: safeText(b?.label || ''),
				icon: safeText(b?.icon || b?.staticIcon || ''),
				itemName: parentItemName,
				state: '',
				stateless: true,
				source: 'legacy',
				labelcolor: safeText(b?.labelcolor || ''),
				iconcolor: safeText(b?.iconcolor || ''),
				visibility: isButtongridButtonVisible(b),
			});
		}
	}
	const children = widget?.widgets || widget?.widget;
	if (Array.isArray(children)) {
		for (const c of children) {
			if (safeText(c?.type).toLowerCase() !== 'button') continue;
			const itemName = safeText(c?.itemName || c?.item?.name || '');
			buttons.push({
				row: normalizeButtongridRow(c?.row),
				column: normalizeChildButtongridColumn(c?.column),
				command: safeText(c?.command || c?.cmd || c?.click || ''),
				releaseCommand: safeText(c?.releaseCommand || c?.release || ''),
				label: safeText(c?.label || ''),
				icon: safeText(c?.icon || c?.staticIcon || ''),
				itemName,
				state: safeText(c?.state ?? c?.item?.state ?? ''),
				stateless: !!c?.stateless,
				source: 'child',
				labelcolor: safeText(c?.labelcolor || ''),
				iconcolor: safeText(c?.iconcolor || ''),
				visibility: isButtongridButtonVisible(c),
			});
		}
	}
	return buttons;
}

function buttonsSignature(buttons) {
	if (!buttons || !buttons.length) return '';
	return buttons.map((b) =>
		`${b.row}:${b.column}:${b.command}:${b.releaseCommand}:${b.label}:${b.icon}:${b.itemName}:${b.state || ''}:${b.stateless}:${safeText(b?.source || '')}:${safeText(b?.labelcolor || '')}:${safeText(b?.iconcolor || '')}:${isButtongridButtonVisible(b) ? '1' : '0'}`
	).join('|');
}

function shouldRenderActive(button) {
	const pressCommand = safeText(button?.command).trim();
	const buttonState = safeText(button?.state).trim();
	return safeText(button?.source).trim().toLowerCase() === 'child'
		&& button?.stateless !== true
		&& !!pressCommand
		&& buttonState === pressCommand;
}

describe('Buttongrid Widget', () => {
	describe('normalizeButtongridButtons', () => {
		it('normalizes inline buttons from mappings array', () => {
			const widget = {
				type: 'Buttongrid',
				item: { name: 'RemoteItem' },
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
			assert.strictEqual(buttons[0].itemName, 'RemoteItem');
			assert.strictEqual(buttons[0].releaseCommand, '');
			assert.strictEqual(buttons[0].stateless, true);
			assert.strictEqual(buttons[0].source, 'legacy');
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
			assert.strictEqual(buttons[0].source, 'child');
			assert.strictEqual(buttons[1].command, 'PAUSE');
			assert.strictEqual(buttons[1].icon, 'material:pause');
			assert.strictEqual(buttons[1].source, 'child');
		});

		it('normalizes child Button labelcolor/iconcolor/visibility', () => {
			const widget = {
				type: 'Buttongrid',
				widgets: [
					{ type: 'Button', row: 1, column: 1, command: 'ONE', label: 'One', labelcolor: 'red', iconcolor: 'blue', visibility: true },
					{ type: 'Button', row: 1, column: 2, command: 'TWO', label: 'Two', labelcolor: 'green', iconcolor: 'yellow', visibility: 'false' },
				],
			};
			const buttons = normalizeButtongridButtons(widget);
			assert.strictEqual(buttons.length, 2);
			assert.strictEqual(buttons[0].labelcolor, 'red');
			assert.strictEqual(buttons[0].iconcolor, 'blue');
			assert.strictEqual(buttons[0].visibility, true);
			assert.strictEqual(buttons[1].labelcolor, 'green');
			assert.strictEqual(buttons[1].iconcolor, 'yellow');
			assert.strictEqual(buttons[1].visibility, false);
		});

		it('prefers normalized buttons payload when provided', () => {
			const widget = {
				type: 'Buttongrid',
				item: { name: 'RemoteParent' },
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
			assert.strictEqual(buttons[0].itemName, 'RemoteParent');
			assert.strictEqual(buttons[0].state, '');
			assert.strictEqual(buttons[0].stateless, true);
			assert.strictEqual(buttons[0].source, 'legacy');
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

		it('defaults row/column to 1 for non-numeric values', () => {
			const widget = {
				mappings: [
					{ row: 'abc', column: 'xyz', command: 'TEST' },
				],
			};
			const buttons = normalizeButtongridButtons(widget);
			assert.strictEqual(buttons.length, 1);
			assert.strictEqual(buttons[0].row, 1);
			assert.strictEqual(buttons[0].column, 1);
		});

		it('drops legacy inline releaseCommand for click-only behavior', () => {
			const widget = {
				item: { name: 'Remote' },
				mappings: [
					{ row: 1, column: 1, command: 'VOL_UP', releaseCommand: 'VOL_STOP', label: 'Volume Up' },
				],
			};
			const buttons = normalizeButtongridButtons(widget);
			assert.strictEqual(buttons[0].releaseCommand, '');
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
			assert.strictEqual(buttons[0].source, 'child');
		});

		it('forces legacy inline button itemName to parent item', () => {
			const widget = {
				item: { name: 'RemoteParent' },
				mappings: [
					{ row: 1, column: 1, command: 'ON', itemName: 'PerButtonItem' },
				],
			};
			const buttons = normalizeButtongridButtons(widget);
			assert.strictEqual(buttons.length, 1);
			assert.strictEqual(buttons[0].itemName, 'RemoteParent');
		});

		it('skips legacy inline buttons with columns greater than 12', () => {
			const widget = {
				item: { name: 'RemoteParent' },
				mappings: [
					{ row: 1, column: 1, command: 'ONE' },
					{ row: 1, column: 13, command: 'THIRTEEN' },
				],
			};
			const buttons = normalizeButtongridButtons(widget);
			assert.strictEqual(buttons.length, 1);
			assert.strictEqual(buttons[0].command, 'ONE');
		});

		it('skips legacy inline buttons with columns less than 1', () => {
			const widget = {
				item: { name: 'RemoteParent' },
				mappings: [
					{ row: 1, column: 0, command: 'ZERO' },
					{ row: 1, column: 1, command: 'ONE' },
				],
			};
			const buttons = normalizeButtongridButtons(widget);
			assert.strictEqual(buttons.length, 1);
			assert.strictEqual(buttons[0].command, 'ONE');
		});

		it('preserves explicit child source in pre-normalized buttons payload', () => {
			const widget = {
				type: 'Buttongrid',
				item: { name: 'RemoteParent' },
				buttons: [
					{ row: 1, column: 1, command: 'PLAY', itemName: 'PlayerItem', source: 'child' },
				],
			};
			const buttons = normalizeButtongridButtons(widget);
			assert.strictEqual(buttons.length, 1);
			assert.strictEqual(buttons[0].source, 'child');
			assert.strictEqual(buttons[0].itemName, 'PlayerItem');
		});

		it('handles mixed inline and child buttons', () => {
			const widget = {
				item: { name: 'RemoteParent' },
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
			assert.strictEqual(buttons[0].source, 'legacy');
			assert.strictEqual(buttons[1].source, 'child');
		});
	});

	describe('stateful child button activity', () => {
		it('child buttons are stateful by default', () => {
			const buttons = normalizeButtongridButtons({
				type: 'Buttongrid',
				widgets: [{ type: 'Button', row: 1, column: 1, command: 'ON', state: 'ON' }],
			});
			assert.strictEqual(buttons[0].source, 'child');
			assert.strictEqual(buttons[0].stateless, false);
			assert.strictEqual(shouldRenderActive(buttons[0]), true);
		});

		it('child buttons with stateless=true never render active', () => {
			const buttons = normalizeButtongridButtons({
				type: 'Buttongrid',
				widgets: [{ type: 'Button', row: 1, column: 1, command: 'ON', state: 'ON', stateless: true }],
			});
			assert.strictEqual(shouldRenderActive(buttons[0]), false);
		});

		it('child buttons render active only when state matches click command', () => {
			const buttons = normalizeButtongridButtons({
				type: 'Buttongrid',
				widgets: [{ type: 'Button', row: 1, column: 1, command: 'ON', state: 'OFF' }],
			});
			assert.strictEqual(shouldRenderActive(buttons[0]), false);
			buttons[0].state = 'ON';
			assert.strictEqual(shouldRenderActive(buttons[0]), true);
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
				{ row: 1, column: 1, command: 'POWER', releaseCommand: '', label: 'Power', icon: 'material:power', itemName: '', state: 'POWER', stateless: true, source: 'legacy' },
				{ row: 1, column: 2, command: 'UP', releaseCommand: '', label: 'Up', icon: '', itemName: '', state: '', stateless: false, source: 'child' },
			];
			const sig = buttonsSignature(buttons);
			assert.strictEqual(sig, '1:1:POWER::Power:material:power::POWER:true:legacy:::1|1:2:UP::Up::::false:child:::1');
		});

		it('changes when button properties change', () => {
			const buttons1 = [{ row: 1, column: 1, command: 'A', releaseCommand: '', label: 'A', icon: '', itemName: '', stateless: false }];
			const buttons2 = [{ row: 1, column: 1, command: 'B', releaseCommand: '', label: 'B', icon: '', itemName: '', stateless: false }];
			assert.notStrictEqual(buttonsSignature(buttons1), buttonsSignature(buttons2));
		});

		it('changes when button visibility or colors change', () => {
			const buttons1 = [{ row: 1, column: 1, command: 'A', releaseCommand: '', label: 'A', icon: '', itemName: '', stateless: false, labelcolor: 'red', iconcolor: 'blue', visibility: true }];
			const buttons2 = [{ row: 1, column: 1, command: 'A', releaseCommand: '', label: 'A', icon: '', itemName: '', stateless: false, labelcolor: 'green', iconcolor: 'blue', visibility: true }];
			const buttons3 = [{ row: 1, column: 1, command: 'A', releaseCommand: '', label: 'A', icon: '', itemName: '', stateless: false, labelcolor: 'red', iconcolor: 'blue', visibility: false }];
			assert.notStrictEqual(buttonsSignature(buttons1), buttonsSignature(buttons2));
			assert.notStrictEqual(buttonsSignature(buttons1), buttonsSignature(buttons3));
		});
	});
});
