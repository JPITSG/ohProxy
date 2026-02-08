'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

// Replicated from public/app.js.
function normalizeMapping(mapping) {
	if (!mapping) return [];
	if (Array.isArray(mapping)) {
		return mapping
			.map((m) => {
				if (!m || typeof m !== 'object') return null;
				const command = safeText(m.command ?? '');
				const releaseCommand = safeText(m.releaseCommand ?? '');
				const label = safeText(m.label ?? m.command ?? '');
				const icon = safeText(m.icon ?? '');
				if (!command) return null;
				return { command, releaseCommand, label: label || command, icon };
			})
			.filter(Boolean);
	}
	if (typeof mapping === 'object') {
		if ('command' in mapping || 'label' in mapping || 'releaseCommand' in mapping || 'icon' in mapping) {
			const command = safeText(mapping.command ?? '');
			const releaseCommand = safeText(mapping.releaseCommand ?? '');
			const label = safeText(mapping.label ?? mapping.command ?? '');
			const icon = safeText(mapping.icon ?? '');
			if (!command) return [];
			return [{ command, releaseCommand, label: label || command, icon }];
		}
		return Object.entries(mapping)
			.filter(([command]) => safeText(command))
			.map(([command, mappingValue]) => {
				const isEntryObject = mappingValue && typeof mappingValue === 'object';
				const label = isEntryObject
					? safeText(mappingValue.label ?? command)
					: safeText(mappingValue);
				const icon = isEntryObject ? safeText(mappingValue.icon ?? '') : '';
				return {
					command: safeText(command),
					releaseCommand: '',
					label: label || safeText(command),
					icon,
				};
			});
	}
	return [];
}

const MATERIAL_ICON_STYLE_ALIASES = {
	filled: 'filled',
	fill: 'filled',
	outlined: 'outlined',
	outline: 'outlined',
	round: 'round',
	rounded: 'round',
	sharp: 'sharp',
	'two-tone': 'two-tone',
	two_tone: 'two-tone',
	twotone: 'two-tone',
};

function resolveMaterialMappingIcon(icon) {
	const raw = safeText(icon).trim();
	if (!raw || !/^material:/i.test(raw)) return '';
	const parts = raw.split(':').map((part) => safeText(part).trim()).filter(Boolean);
	if (parts.length < 2) return '';
	let style = 'filled';
	let iconName = '';
	if (parts.length >= 3) {
		const mappedStyle = MATERIAL_ICON_STYLE_ALIASES[parts[1].toLowerCase()];
		if (mappedStyle) {
			style = mappedStyle;
			iconName = parts.slice(2).join('_');
		} else {
			iconName = parts.slice(1).join('_');
		}
	} else {
		iconName = parts[1];
	}
	const normalizedName = iconName.toLowerCase().replace(/\s+/g, '_');
	if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(normalizedName)) return '';
	return style === 'filled'
		? `/icons/material/${normalizedName}.svg`
		: `/icons/material/${style}/${normalizedName}.svg`;
}

function iconCandidates(icon) {
	return [`images/v3/${icon}.png`];
}

function mappingIconCandidates(icon) {
	const raw = safeText(icon).trim();
	if (!raw) return [];
	const materialPath = resolveMaterialMappingIcon(raw);
	if (materialPath) return [materialPath];
	return iconCandidates(raw);
}

// Replicated from server.js.
function normalizeMappings(mapping) {
	if (!mapping) return [];
	if (Array.isArray(mapping)) {
		return mapping
			.map((m) => {
				if (!m || typeof m !== 'object') return null;
				const command = safeText(m.command ?? '');
				const releaseCommand = safeText(m.releaseCommand ?? '');
				const label = safeText(m.label ?? m.command ?? '');
				const icon = safeText(m.icon ?? '');
				if (!command && !label && !icon) return null;
				return { command, releaseCommand, label: label || command, icon };
			})
			.filter(Boolean);
	}
	if (typeof mapping === 'object') {
		if ('command' in mapping || 'label' in mapping || 'releaseCommand' in mapping || 'icon' in mapping) {
			const command = safeText(mapping.command ?? '');
			const releaseCommand = safeText(mapping.releaseCommand ?? '');
			const label = safeText(mapping.label ?? mapping.command ?? '');
			const icon = safeText(mapping.icon ?? '');
			if (!command && !label && !icon) return [];
			return [{ command, releaseCommand, label: label || command, icon }];
		}
		return Object.entries(mapping).map(([command, mappingValue]) => {
			const isEntryObject = mappingValue && typeof mappingValue === 'object';
			const label = isEntryObject
				? safeText(mappingValue.label ?? command)
				: safeText(mappingValue);
			const icon = isEntryObject ? safeText(mappingValue.icon ?? '') : '';
			return {
				command: safeText(command),
				releaseCommand: '',
				label: label || safeText(command),
				icon,
			};
		});
	}
	return [];
}

function mappingsSignature(mapping) {
	const normalized = normalizeMappings(mapping);
	return normalized.map((m) => `${m.command}:${m.releaseCommand || ''}:${m.label}:${m.icon || ''}`).join('|');
}

describe('Mapping Icon Support', () => {
	it('client normalizeMapping preserves icon field from array entries', () => {
		const normalized = normalizeMapping([{ command: '4', label: 'Stop', icon: 'material:stop' }]);
		assert.deepStrictEqual(normalized, [{ command: '4', releaseCommand: '', label: 'Stop', icon: 'material:stop' }]);
	});

	it('client normalizeMapping supports compact object entries with icon', () => {
		const normalized = normalizeMapping({
			'4': { label: 'Stop', icon: 'material:stop' },
			'1': 'B',
		});
		assert.deepStrictEqual(normalized, [
			{ command: '1', releaseCommand: '', label: 'B', icon: '' },
			{ command: '4', releaseCommand: '', label: 'Stop', icon: 'material:stop' },
		]);
	});

	it('resolves material icons to local hosted paths', () => {
		assert.deepStrictEqual(mappingIconCandidates('material:stop'), ['/icons/material/stop.svg']);
		assert.deepStrictEqual(mappingIconCandidates('material:outlined:mic_off'), ['/icons/material/outlined/mic_off.svg']);
		assert.deepStrictEqual(mappingIconCandidates('material:twotone:mic_off'), ['/icons/material/two-tone/mic_off.svg']);
	});

	it('falls back to openHAB icon candidates for non-material mappings', () => {
		assert.deepStrictEqual(mappingIconCandidates('siren'), ['images/v3/siren.png']);
	});

	it('server mapping signature changes when icon changes', () => {
		const a = mappingsSignature([{ command: '4', label: 'Stop', icon: 'material:stop' }]);
		const b = mappingsSignature([{ command: '4', label: 'Stop', icon: 'material:play_arrow' }]);
		assert.notStrictEqual(a, b);
	});

	it('server normalizeMappings preserves icon values', () => {
		const normalized = normalizeMappings([{ command: '4', label: 'Stop', icon: 'material:stop' }]);
		assert.deepStrictEqual(normalized, [{ command: '4', releaseCommand: '', label: 'Stop', icon: 'material:stop' }]);
	});

	it('app render paths call setMappingControlContent for switch and selection', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /setMappingControlContent\(optBtn, m\);/);
		assert.match(app, /setMappingControlContent\(btn, m\);/);
		assert.match(app, /setMappingControlContent\(b, m\);/);
	});
});
