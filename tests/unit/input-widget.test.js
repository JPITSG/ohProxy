'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Replicated from public/app.js.
function resolveInputHint(rawHint) {
	const hint = (rawHint || '').toLowerCase().trim();
	return ['text', 'number', 'date', 'time', 'datetime'].includes(hint) ? hint : 'text';
}

// Replicated from public/app.js.
function buildInputCommand(inputHint, rawValue) {
	if (inputHint === 'date') {
		if (!rawValue) return '';
		return rawValue + 'T00:00:00';
	}
	if (inputHint === 'time') {
		if (!rawValue) return '';
		return rawValue.length === 5 ? rawValue + ':00' : rawValue;
	}
	if (inputHint === 'datetime') {
		if (!rawValue) return '';
		return rawValue.length === 16 ? rawValue + ':00' : rawValue;
	}
	return rawValue;
}

// Replicated from public/app.js.
function parseInputState(inputHint, state) {
	if (!state || state === 'NULL' || state === 'UNDEF') return '';
	if (inputHint === 'number') {
		const num = parseFloat(state);
		return Number.isFinite(num) ? String(num) : '';
	}
	if (inputHint === 'date') {
		const m = state.match(/^(\d{4}-\d{2}-\d{2})/);
		return m ? m[1] : '';
	}
	if (inputHint === 'time') {
		const m = state.match(/(\d{2}:\d{2})/);
		return m ? m[1] : '';
	}
	if (inputHint === 'datetime') {
		const m = state.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
		return m ? m[1] + 'T' + m[2] : '';
	}
	return state;
}

describe('resolveInputHint', () => {
	it('returns "text" for text hint', () => {
		assert.strictEqual(resolveInputHint('text'), 'text');
	});
	it('returns "number" for number hint', () => {
		assert.strictEqual(resolveInputHint('number'), 'number');
	});
	it('returns "date" for date hint', () => {
		assert.strictEqual(resolveInputHint('date'), 'date');
	});
	it('returns "time" for time hint', () => {
		assert.strictEqual(resolveInputHint('time'), 'time');
	});
	it('returns "datetime" for datetime hint', () => {
		assert.strictEqual(resolveInputHint('datetime'), 'datetime');
	});
	it('defaults to "text" for missing or unknown hint', () => {
		assert.strictEqual(resolveInputHint(''), 'text');
		assert.strictEqual(resolveInputHint(null), 'text');
		assert.strictEqual(resolveInputHint(undefined), 'text');
		assert.strictEqual(resolveInputHint('unknown'), 'text');
		assert.strictEqual(resolveInputHint('NUMBER'), 'number');
	});
});

describe('buildInputCommand', () => {
	it('appends T00:00:00 for date values', () => {
		assert.strictEqual(buildInputCommand('date', '2024-01-15'), '2024-01-15T00:00:00');
	});
	it('returns empty for empty date', () => {
		assert.strictEqual(buildInputCommand('date', ''), '');
	});
	it('appends :00 for time values without seconds', () => {
		assert.strictEqual(buildInputCommand('time', '10:30'), '10:30:00');
	});
	it('preserves time values with seconds', () => {
		assert.strictEqual(buildInputCommand('time', '10:30:45'), '10:30:45');
	});
	it('returns empty for empty time', () => {
		assert.strictEqual(buildInputCommand('time', ''), '');
	});
	it('appends :00 for datetime values without seconds', () => {
		assert.strictEqual(buildInputCommand('datetime', '2024-01-15T10:30'), '2024-01-15T10:30:00');
	});
	it('passes through text values as-is', () => {
		assert.strictEqual(buildInputCommand('text', 'hello world'), 'hello world');
	});
	it('passes through number values as-is', () => {
		assert.strictEqual(buildInputCommand('number', '42'), '42');
	});
});

describe('parseInputState', () => {
	it('returns empty for NULL state', () => {
		assert.strictEqual(parseInputState('text', 'NULL'), '');
	});
	it('returns empty for UNDEF state', () => {
		assert.strictEqual(parseInputState('number', 'UNDEF'), '');
	});
	it('extracts date from ISO string', () => {
		assert.strictEqual(parseInputState('date', '2024-01-15T10:30:00.000+0100'), '2024-01-15');
	});
	it('extracts time from ISO string', () => {
		assert.strictEqual(parseInputState('time', '2024-01-15T10:30:00.000+0100'), '10:30');
	});
	it('extracts time from plain time string', () => {
		assert.strictEqual(parseInputState('time', '10:30:00'), '10:30');
	});
	it('extracts datetime from ISO string', () => {
		assert.strictEqual(parseInputState('datetime', '2024-01-15T10:30:00.000+0100'), '2024-01-15T10:30');
	});
	it('extracts number from state with unit', () => {
		assert.strictEqual(parseInputState('number', '23 %'), '23');
	});
	it('extracts plain number', () => {
		assert.strictEqual(parseInputState('number', '42.5'), '42.5');
	});
	it('returns empty for non-numeric number state', () => {
		assert.strictEqual(parseInputState('number', 'abc'), '');
	});
	it('passes through text state as-is', () => {
		assert.strictEqual(parseInputState('text', 'hello world'), 'hello world');
	});
});
