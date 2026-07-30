'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
	RENDER_STYLE_VERSION,
	rampWidth,
	roadClassOf,
	polylineLength,
	polylinePointAt,
	rotatedLabelBounds,
	createTileRenderer,
} = require('../../lib/tile-renderer');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const FIXTURE_Z15 = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'london-z15.mvt');
const FIXTURE_Z13 = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'london-z13.mvt');
const FONT_FILE = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('Tile Renderer Style Tables', () => {
	it('interpolates widths between ramp anchors and clamps at the ends', () => {
		assert.equal(rampWidth('motorway', 4), 0.7, 'clamped below');
		assert.equal(rampWidth('motorway', 19), 26, 'clamped above');
		const mid = rampWidth('motorway', 13);
		assert.ok(mid > 3.5 && mid < 6, `z13 motorway should sit between z12 and z14 anchors, got ${mid}`);
		assert.equal(rampWidth('unknown-class', 12), 1, 'unknown ramps default to 1');
	});

	it('widths grow monotonically with zoom', () => {
		for (const cls of ['motorway', 'primary', 'minor', 'rail', 'river']) {
			let prev = 0;
			for (let z = 4; z <= 19; z++) {
				const w = rampWidth(cls, z);
				assert.ok(w >= prev, `${cls} width must not shrink at z${z}`);
				prev = w;
			}
		}
	});

	it('classifies roads by kind_detail first, then by kind', () => {
		assert.equal(roadClassOf({ kind: 'major_road', kind_detail: 'motorway' }), 'motorway');
		assert.equal(roadClassOf({ kind: 'major_road', kind_detail: 'trunk_link' }), 'trunk');
		assert.equal(roadClassOf({ kind: 'major_road', kind_detail: 'secondary' }), 'secondary');
		assert.equal(roadClassOf({ kind: 'minor_road', kind_detail: 'service' }), 'service');
		assert.equal(roadClassOf({ kind: 'path', kind_detail: 'footway' }), 'path');
		assert.equal(roadClassOf({ kind: 'rail', kind_detail: 'subway' }), 'rail');
		// Fallbacks when kind_detail is missing or unknown.
		assert.equal(roadClassOf({ kind: 'major_road' }), 'primary');
		assert.equal(roadClassOf({ kind: 'ferry' }), 'ferry');
		assert.equal(roadClassOf({ kind: 'minor_road', kind_detail: 'mystery' }), 'minor');
	});

	it('exposes a style version for render cache keying', () => {
		assert.match(RENDER_STYLE_VERSION, /^v\d+$/);
	});

	it('measures polyline length and finds midpoints with direction', () => {
		const line = [{ x: 0, y: 0 }, { x: 30, y: 40 }, { x: 30, y: 100 }];
		assert.equal(polylineLength(line), 110);
		const mid = polylinePointAt(line, 55);
		assert.equal(mid.x, 30);
		assert.equal(mid.y, 45);
		assert.equal(mid.angleDeg, 90, 'vertical segment reported as 90 degrees');
		const early = polylinePointAt(line, 25);
		assert.ok(Math.abs(early.angleDeg - 53.13) < 0.1, 'diagonal 3-4-5 segment angle');
		assert.equal(polylinePointAt(line, 500), null, 'beyond the end returns null');
	});

	it('never returns an upside-down street label angle', () => {
		// Right-to-left line: raw atan2 would be ~180 degrees.
		const mid = polylinePointAt([{ x: 100, y: 0 }, { x: 0, y: 0 }], 50);
		assert.equal(mid.angleDeg, 0);
		const steep = polylinePointAt([{ x: 0, y: 100 }, { x: 0, y: 0 }], 50);
		assert.equal(steep.angleDeg, 90);
	});

	it('bounds rotated labels correctly at the extremes', () => {
		const flat = rotatedLabelBounds(100, 100, 80, 12, 0);
		assert.deepEqual(flat, { x0: 60, y0: 94, x1: 140, y1: 106 });
		const vertical = rotatedLabelBounds(100, 100, 80, 12, 90);
		assert.deepEqual(vertical, { x0: 94, y0: 60, x1: 106, y1: 140 });
		const diagonal = rotatedLabelBounds(0, 0, 80, 12, 45);
		assert.ok(diagonal.x1 > 30 && diagonal.x1 < 40, 'diagonal AABB spans cos+sin blend');
	});
});

describe('Tile Renderer Output', () => {
	// Rendering runs real Skia-in-WASM; one shared renderer keeps init cost to
	// a single load across these tests.
	const renderer = createTileRenderer({ fontFile: FONT_FILE, log: () => {} });

	it('renders a native-zoom fixture tile to a substantial PNG', async () => {
		const mvt = fs.readFileSync(FIXTURE_Z15);
		const png = await renderer.renderTile({ mvt, z: 15, x: 16372, y: 10896, srcZ: 15, srcX: 16372, srcY: 10896 });
		assert.ok(Buffer.isBuffer(png));
		assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), 'output must be a PNG');
		assert.ok(png.length > 20000, `a dense urban tile should exceed 20KB, got ${png.length}`);
	});

	it('renders deterministically for identical input', async () => {
		const mvt = fs.readFileSync(FIXTURE_Z13);
		const job = { mvt, z: 13, x: 4093, y: 2724, srcZ: 13, srcX: 4093, srcY: 2724 };
		const first = await renderer.renderTile(job);
		const second = await renderer.renderTile(job);
		assert.ok(first.equals(second), 'same input must produce identical bytes');
	});

	it('overzooms: renders a z18 display tile from z15 data', async () => {
		const mvt = fs.readFileSync(FIXTURE_Z15);
		const png = await renderer.renderTile({ mvt, z: 18, x: 130978, y: 87169, srcZ: 15, srcX: 16372, srcY: 10896 });
		assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE));
		assert.ok(png.length > 3000, 'overzoomed tile should still contain geometry');
		// Different quadrants of the same source must render differently.
		const other = await renderer.renderTile({ mvt, z: 18, x: 130979, y: 87169, srcZ: 15, srcX: 16372, srcY: 10896 });
		assert.ok(!png.equals(other), 'adjacent overzoom quadrants must differ');
	});

	it('renders without labels when the font file is missing', async () => {
		const noFont = createTileRenderer({ fontFile: '/nonexistent/font.ttf', log: () => {} });
		const mvt = fs.readFileSync(FIXTURE_Z15);
		const png = await noFont.renderTile({ mvt, z: 15, x: 16372, y: 10896, srcZ: 15, srcX: 16372, srcY: 10896 });
		assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), 'must degrade gracefully, not throw');
	});

	it('runs concurrent renders through the internal queue without corruption', async () => {
		const mvt = fs.readFileSync(FIXTURE_Z13);
		const jobs = Array.from({ length: 8 }, () =>
			renderer.renderTile({ mvt, z: 13, x: 4093, y: 2724, srcZ: 13, srcX: 4093, srcY: 2724 }));
		const results = await Promise.all(jobs);
		for (const png of results) {
			assert.ok(png.equals(results[0]), 'concurrent renders of the same tile must match');
		}
	});
});
