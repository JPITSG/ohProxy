'use strict';

const path = require('node:path');

// OSM serves raster tiles up to z19.
const MAX_TILE_ZOOM = 19;
const UPSTREAM_TILE_ORIGIN = 'https://tile.openstreetmap.org';
const TILE_CONTENT_TYPE = 'image/png';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Route labels returned by TileCache.get(). Kept as constants so the route
// taken can be asserted in tests and logged consistently.
const ROUTE_HIT = 'hit';
const ROUTE_MISS = 'miss';
const ROUTE_COALESCED = 'coalesced';
const ROUTE_ERROR = 'error';

// Strict decimal integers only: no signs, no whitespace, no leading zeros.
// Rejecting leading zeros keeps the cache key canonical, so /tiles/01/0/0.png
// cannot occupy a second cache entry for the same tile as /tiles/1/0/0.png.
const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/;

function parseTileCoords(rawZ, rawX, rawY) {
	const parts = [rawZ, rawX, rawY].map((value) => (value === null || value === undefined ? '' : String(value)));
	if (!parts.every((part) => INTEGER_PATTERN.test(part))) return null;

	const [z, x, y] = parts.map(Number);
	if (!Number.isSafeInteger(z) || z < 0 || z > MAX_TILE_ZOOM) return null;

	const limit = 2 ** z;
	if (!Number.isSafeInteger(x) || x < 0 || x >= limit) return null;
	if (!Number.isSafeInteger(y) || y < 0 || y >= limit) return null;

	return { z, x, y };
}

function tileKey(coords) {
	return `${coords.z}/${coords.x}/${coords.y}`;
}

// z/x/y.png keeps per-directory entry counts low, which matters once the cache
// holds tens of thousands of tiles.
function tileCachePath(baseDir, coords) {
	return path.join(baseDir, String(coords.z), String(coords.x), `${coords.y}.png`);
}

function upstreamTileUrl(coords) {
	return `${UPSTREAM_TILE_ORIGIN}/${coords.z}/${coords.x}/${coords.y}.png`;
}

function isPngBuffer(body) {
	return Buffer.isBuffer(body)
		&& body.length > PNG_SIGNATURE.length
		&& body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

// options.fs must expose existsSync/readFileSync/writeFileSync/mkdirSync/
// renameSync/unlinkSync. options.fetchTile is an async (url) => { ok, status,
// body, contentType }. options.log receives upstream/cache failures, which are
// always reported regardless of the debug toggle.
function createTileCache(options) {
	const opts = options || {};
	const baseDir = opts.baseDir;
	const fsImpl = opts.fs;
	const fetchTile = opts.fetchTile;
	const log = typeof opts.log === 'function' ? opts.log : () => {};

	if (!baseDir) throw new Error('createTileCache requires baseDir');
	if (!fsImpl) throw new Error('createTileCache requires fs');
	if (typeof fetchTile !== 'function') throw new Error('createTileCache requires fetchTile');

	const inFlight = new Map();
	let tmpCounter = 0;

	// Write to a temp name and rename into place so a concurrent reader can
	// never observe a partially written tile.
	function storeTile(coords, body) {
		const target = tileCachePath(baseDir, coords);
		const dir = path.dirname(target);
		tmpCounter = (tmpCounter + 1) % 1000000;
		const tmp = `${target}.${process.pid}.${tmpCounter}.tmp`;
		try {
			if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
			fsImpl.writeFileSync(tmp, body);
			fsImpl.renameSync(tmp, target);
			return true;
		} catch (err) {
			try { fsImpl.unlinkSync(tmp); } catch {}
			log(`[MapTiles] ${tileKey(coords)} cache write failed: ${err.message || err}`);
			return false;
		}
	}

	function readTile(coords) {
		const target = tileCachePath(baseDir, coords);
		if (!fsImpl.existsSync(target)) return null;
		try {
			const body = fsImpl.readFileSync(target);
			return body && body.length ? body : null;
		} catch (err) {
			log(`[MapTiles] ${tileKey(coords)} cache read failed: ${err.message || err}`);
			return null;
		}
	}

	async function fetchAndStore(coords) {
		const key = tileKey(coords);
		let result;
		try {
			result = await fetchTile(upstreamTileUrl(coords));
		} catch (err) {
			log(`[MapTiles] ${key} upstream fetch failed: ${err.message || err}`);
			return { route: ROUTE_ERROR, status: 502, body: null, contentType: '', detail: 'upstream fetch failed' };
		}

		const status = result && Number.isFinite(Number(result.status)) ? Number(result.status) : 502;

		// Only ever cache a real PNG from a 2xx response. Without the body check
		// an upstream error page or rate-limit notice would be stored and then
		// served as a tile indefinitely.
		if (!result || !result.ok) {
			log(`[MapTiles] ${key} upstream returned status ${status}, not cached`);
			return { route: ROUTE_ERROR, status: status >= 400 ? status : 502, body: null, contentType: '', detail: `upstream status ${status}` };
		}
		if (!isPngBuffer(result.body)) {
			log(`[MapTiles] ${key} upstream body was not a PNG, not cached`);
			return { route: ROUTE_ERROR, status: 502, body: null, contentType: '', detail: 'upstream body not a PNG' };
		}

		const stored = storeTile(coords, result.body);
		return {
			route: ROUTE_MISS,
			status: 200,
			body: result.body,
			contentType: TILE_CONTENT_TYPE,
			detail: stored ? 'fetched upstream and cached' : 'fetched upstream, cache write failed',
		};
	}

	async function get(coords) {
		const key = tileKey(coords);

		const cached = readTile(coords);
		if (cached) {
			return { route: ROUTE_HIT, status: 200, body: cached, contentType: TILE_CONTENT_TYPE, detail: 'served from local cache' };
		}

		// OpenLayers requests a full viewport at once, so the same missing tile
		// can be asked for several times before the first fetch resolves. Share
		// one upstream request rather than issuing duplicates.
		const pending = inFlight.get(key);
		if (pending) {
			const result = await pending;
			return {
				...result,
				route: result.route === ROUTE_MISS ? ROUTE_COALESCED : result.route,
				detail: result.route === ROUTE_MISS ? 'joined in-flight upstream fetch' : result.detail,
			};
		}

		const task = fetchAndStore(coords);
		inFlight.set(key, task);
		try {
			return await task;
		} finally {
			inFlight.delete(key);
		}
	}

	function inFlightCount() {
		return inFlight.size;
	}

	return { get, inFlightCount };
}

module.exports = {
	MAX_TILE_ZOOM,
	UPSTREAM_TILE_ORIGIN,
	TILE_CONTENT_TYPE,
	ROUTE_HIT,
	ROUTE_MISS,
	ROUTE_COALESCED,
	ROUTE_ERROR,
	parseTileCoords,
	tileKey,
	tileCachePath,
	upstreamTileUrl,
	isPngBuffer,
	createTileCache,
};
