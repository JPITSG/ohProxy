'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
	MAX_DATA_ZOOM,
	COVERAGE_CELL_ZOOM,
	lonLatToTile,
	tileWidthMeters,
	buildCoverageCells,
	enumerateNeededTiles,
	countNeededTiles,
	renderSourceTile,
} = require('../../lib/mvt-coverage');

describe('MVT Coverage Math', () => {
	it('converts lon/lat to slippy tile coordinates', () => {
		// Central London z13, cross-checked against a live tile fetch.
		assert.deepEqual(lonLatToTile(-0.1276, 51.5072, 13), { x: 4093, y: 2724 });
		assert.deepEqual(lonLatToTile(0, 0, 0), { x: 0, y: 0 });
		// The equator line itself falls into the southern row.
		assert.deepEqual(lonLatToTile(-180, 0, 1), { x: 0, y: 1 });
		assert.deepEqual(lonLatToTile(179.999, 0, 1), { x: 1, y: 1 });
	});

	it('clamps out-of-range coordinates instead of producing invalid tiles', () => {
		const northPole = lonLatToTile(0, 89.9, 4);
		assert.ok(northPole.y >= 0);
		const wrapped = lonLatToTile(180, 0, 4);
		assert.ok(wrapped.x <= 15);
	});

	it('computes tile width in metres shrinking with latitude and zoom', () => {
		const equator = tileWidthMeters(0, 13);
		const mid = tileWidthMeters(52, 13);
		assert.ok(equator > 4800 && equator < 4950);
		assert.ok(mid < equator * 0.65 && mid > equator * 0.55);
		assert.ok(tileWidthMeters(0, 14) < equator);
	});

	it('builds a single cell for one point with zero radius', () => {
		const cells = buildCoverageCells([{ lat: 51.5072, lon: -0.1276 }], 0);
		assert.equal(cells.size, 1);
		assert.ok(cells.has('4093/2724'));
	});

	it('dilates coverage by the radius in every direction', () => {
		const cells = buildCoverageCells([{ lat: 51.5072, lon: -0.1276 }], 10);
		// z13 tiles are ~3km wide at this latitude, so a 10km radius needs at least a
		// 4-tile disc: strictly more than a 3x3 block, bounded by the 9x9 square.
		assert.ok(cells.size > 9, `expected disc larger than 3x3, got ${cells.size}`);
		assert.ok(cells.size <= 81, `expected disc bounded by 9x9, got ${cells.size}`);
	});

	it('deduplicates dense point clusters before dilating', () => {
		const cluster = [];
		for (let i = 0; i < 500; i++) {
			cluster.push({ lat: 51.5072 + i * 0.00001, lon: -0.1276 + i * 0.00001 });
		}
		const one = buildCoverageCells([{ lat: 51.5072, lon: -0.1276 }], 5);
		const many = buildCoverageCells(cluster, 5);
		// 500 near-identical points may straddle a cell corner (up to 4 base
		// cells), but the dilated discs overlap almost entirely - the cost must
		// stay in the order of one point, nowhere near 500 discs.
		assert.ok(many.size <= one.size * 2, `expected heavy overlap, got ${many.size} vs ${one.size}`);
		assert.ok(many.size >= one.size);
	});

	it('ignores invalid coordinates', () => {
		const cells = buildCoverageCells([
			{ lat: NaN, lon: 21 }, { lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: null, lon: undefined },
		], 10);
		assert.equal(cells.size, 0);
	});

	it('enumerates ancestors above the cell zoom and descendants below it', () => {
		const cells = buildCoverageCells([{ lat: 51.5072, lon: -0.1276 }], 0);
		const byZoom = enumerateNeededTiles(cells);
		// One z13 cell: one tile per zoom 0..13, then 4 at z14 and 16 at z15.
		for (let z = 0; z <= 13; z++) {
			assert.equal(byZoom.get(z).length, 1, `zoom ${z}`);
		}
		assert.equal(byZoom.get(14).length, 4);
		assert.equal(byZoom.get(15).length, 16);
		assert.equal(countNeededTiles(byZoom), 14 + 4 + 16);
	});

	it('deduplicates shared ancestors across neighbouring cells', () => {
		const cells = new Set(['4092/2724', '4093/2724']);
		const byZoom = enumerateNeededTiles(cells);
		assert.equal(byZoom.get(12).length, 1, 'both cells share the z12 parent');
		assert.equal(byZoom.get(13).length, 2);
		assert.equal(byZoom.get(15).length, 32);
	});

	it('maps display tiles to their render source at the data ceiling', () => {
		assert.deepEqual(renderSourceTile(15, 100, 200), { z: 15, x: 100, y: 200 });
		assert.deepEqual(renderSourceTile(12, 5, 9), { z: 12, x: 5, y: 9 });
		assert.deepEqual(renderSourceTile(19, 524287, 524286), { z: 15, x: 32767, y: 32767 });
		assert.deepEqual(renderSourceTile(16, 32744, 21793), { z: 15, x: 16372, y: 10896 });
	});

	it('exposes the data ceiling and coverage cell zoom as constants', () => {
		assert.equal(MAX_DATA_ZOOM, 15);
		assert.equal(COVERAGE_CELL_ZOOM, 13);
	});
});
