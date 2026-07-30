'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { deserializeDirectory, coalesceEntries } = require('../../lib/mvt-bulk-fetch');

// Serialize a directory the way the PMTiles v3 spec describes, so the parser
// is tested against independently constructed bytes.
function writeVarint(bytes, value) {
	let v = value;
	while (v >= 0x80) {
		bytes.push((v & 0x7f) | 0x80);
		v = Math.floor(v / 128);
	}
	bytes.push(v);
}

function serializeDirectory(entries) {
	const bytes = [];
	writeVarint(bytes, entries.length);
	let lastId = 0;
	for (const e of entries) { writeVarint(bytes, e.tileId - lastId); lastId = e.tileId; }
	for (const e of entries) writeVarint(bytes, e.runLength);
	for (const e of entries) writeVarint(bytes, e.length);
	for (let i = 0; i < entries.length; i++) {
		const contiguous = i > 0 && entries[i].offset === entries[i - 1].offset + entries[i - 1].length;
		writeVarint(bytes, contiguous ? 0 : entries[i].offset + 1);
	}
	return Buffer.from(bytes);
}

describe('PMTiles Directory Parsing', () => {
	it('round-trips a directory with contiguous and jumped offsets', () => {
		const entries = [
			{ tileId: 10, offset: 0, length: 100, runLength: 1 },
			{ tileId: 11, offset: 100, length: 50, runLength: 1 },   // contiguous -> stored as 0
			{ tileId: 40, offset: 5000, length: 200, runLength: 4 }, // jump + run
			{ tileId: 90, offset: 5200, length: 25, runLength: 0 },  // leaf pointer, contiguous
		];
		const parsed = deserializeDirectory(serializeDirectory(entries));
		assert.deepEqual(parsed, entries);
	});

	it('parses multi-byte varint values', () => {
		const entries = [
			{ tileId: 123456789, offset: 987654321, length: 300000, runLength: 1 },
			{ tileId: 123456790, offset: 987954321, length: 5, runLength: 1 },
		];
		const parsed = deserializeDirectory(serializeDirectory(entries));
		assert.deepEqual(parsed, entries);
	});
});

describe('Range Coalescing', () => {
	it('merges entries separated by small gaps into one range', () => {
		const ranges = coalesceEntries([
			{ offset: 0, length: 100 },
			{ offset: 150, length: 100 },
			{ offset: 400, length: 100 },
		], 1000, 1 << 20);
		assert.equal(ranges.length, 1);
		assert.equal(ranges[0].start, 0);
		assert.equal(ranges[0].end, 500);
		assert.equal(ranges[0].entries.length, 3);
	});

	it('splits when the gap exceeds the limit', () => {
		const ranges = coalesceEntries([
			{ offset: 0, length: 100 },
			{ offset: 5000, length: 100 },
		], 1000, 1 << 20);
		assert.equal(ranges.length, 2);
	});

	it('splits when the total range would exceed the cap', () => {
		const ranges = coalesceEntries([
			{ offset: 0, length: 600 },
			{ offset: 600, length: 600 },
		], 1000, 1000);
		assert.equal(ranges.length, 2);
	});

	it('sorts unordered input before grouping', () => {
		const ranges = coalesceEntries([
			{ offset: 300, length: 50 },
			{ offset: 0, length: 100 },
			{ offset: 120, length: 50 },
		], 500, 1 << 20);
		assert.equal(ranges.length, 1);
		assert.equal(ranges[0].start, 0);
		assert.equal(ranges[0].end, 350);
	});
});
