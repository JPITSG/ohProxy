'use strict';

// Coverage math for the vector-tile primer: turns GPS history into the set of
// z/x/y tiles worth holding locally. All functions are pure so the worker and
// the tests share the exact same arithmetic.

// The Protomaps basemap build carries data down to z15; deeper display zooms
// render from the z15 ancestor (vector overzoom).
const MAX_DATA_ZOOM = 15;
// Coverage is tracked as a set of z13 cells (~3 km across at mid latitudes):
// coarse enough to stay small, fine enough that a +10 km dilation is accurate.
const COVERAGE_CELL_ZOOM = 13;
const EARTH_CIRCUMFERENCE_M = 40075016.686;

function lonLatToTile(lon, lat, z) {
	const n = 2 ** z;
	const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
	const clampedLon = Math.max(-180, Math.min(180, lon));
	const x = Math.min(n - 1, Math.max(0, Math.floor(((clampedLon + 180) / 360) * n)));
	const latRad = (clampedLat * Math.PI) / 180;
	const y = Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)));
	return { x, y };
}

function tileCenterLat(y, z) {
	const n = 2 ** z;
	const yNorm = (y + 0.5) / n;
	return (Math.atan(Math.sinh(Math.PI * (1 - 2 * yNorm))) * 180) / Math.PI;
}

function tileWidthMeters(lat, z) {
	return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

function cellKey(x, y) {
	return `${x}/${y}`;
}

// points: iterable of { lat, lon }. Returns a Set of z13 "x/y" cell keys
// covering every point dilated by radiusKm.
function buildCoverageCells(points, radiusKm) {
	const radiusM = Math.max(0, Number(radiusKm) || 0) * 1000;
	const n = 2 ** COVERAGE_CELL_ZOOM;

	// Dedupe points into their base cells first so dilation runs per cell, not
	// per GPS fix (hundreds of thousands of fixes collapse into ~1k cells).
	const baseCells = new Map();
	for (const point of points) {
		const lat = Number(point.lat);
		const lon = Number(point.lon);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
		if (lat < -85 || lat > 85 || lon < -180 || lon > 180) continue;
		const { x, y } = lonLatToTile(lon, lat, COVERAGE_CELL_ZOOM);
		baseCells.set(cellKey(x, y), y);
	}

	const covered = new Set();
	for (const [key, y] of baseCells) {
		const [cx] = key.split('/').map(Number);
		const lat = tileCenterLat(y, COVERAGE_CELL_ZOOM);
		const cellM = tileWidthMeters(lat, COVERAGE_CELL_ZOOM);
		const r = cellM > 0 ? Math.ceil(radiusM / cellM) : 0;
		for (let dx = -r; dx <= r; dx++) {
			for (let dy = -r; dy <= r; dy++) {
				if (dx * dx + dy * dy > r * r && r > 1) continue;
				const nx = cx + dx;
				const ny = y + dy;
				if (ny < 0 || ny >= n || nx < 0 || nx >= n) continue;
				covered.add(cellKey(nx, ny));
			}
		}
	}
	return covered;
}

// Expands the z13 cell set into the concrete tile list per zoom (0..15):
// ancestors above the cell zoom, descendants below it. Arrays are sorted so
// priming order is deterministic and broad zooms land first.
function enumerateNeededTiles(cells, maxZoom = MAX_DATA_ZOOM) {
	const byZoom = new Map();
	const cellList = [...cells].map((key) => key.split('/').map(Number));

	for (let z = 0; z <= Math.min(COVERAGE_CELL_ZOOM, maxZoom); z++) {
		const shift = COVERAGE_CELL_ZOOM - z;
		const seen = new Set();
		const tiles = [];
		for (const [x, y] of cellList) {
			const key = cellKey(x >> shift, y >> shift);
			if (!seen.has(key)) {
				seen.add(key);
				tiles.push({ z, x: x >> shift, y: y >> shift });
			}
		}
		byZoom.set(z, tiles);
	}

	for (let z = COVERAGE_CELL_ZOOM + 1; z <= maxZoom; z++) {
		const factor = 2 ** (z - COVERAGE_CELL_ZOOM);
		const tiles = [];
		for (const [x, y] of cellList) {
			for (let dx = 0; dx < factor; dx++) {
				for (let dy = 0; dy < factor; dy++) {
					tiles.push({ z, x: x * factor + dx, y: y * factor + dy });
				}
			}
		}
		byZoom.set(z, tiles);
	}

	for (const tiles of byZoom.values()) {
		tiles.sort((a, b) => (a.x - b.x) || (a.y - b.y));
	}
	return byZoom;
}

function countNeededTiles(byZoom) {
	let total = 0;
	for (const tiles of byZoom.values()) total += tiles.length;
	return total;
}

// Maps a display tile to the tile that holds its vector data: itself at or
// below the data ceiling, otherwise its ancestor at the ceiling.
function renderSourceTile(z, x, y, maxDataZoom = MAX_DATA_ZOOM) {
	if (z <= maxDataZoom) return { z, x, y };
	const shift = z - maxDataZoom;
	return { z: maxDataZoom, x: x >> shift, y: y >> shift };
}

module.exports = {
	MAX_DATA_ZOOM,
	COVERAGE_CELL_ZOOM,
	lonLatToTile,
	tileCenterLat,
	tileWidthMeters,
	buildCoverageCells,
	enumerateNeededTiles,
	countNeededTiles,
	renderSourceTile,
};
