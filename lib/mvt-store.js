'use strict';

const path = require('node:path');
const { renderSourceTile, MAX_DATA_ZOOM } = require('./mvt-coverage');

// Local vector-tile store: raw (decompressed) MVT blobs under
// cache/mvt/{z}/{x}/{y}.mvt, written by the primer and read by the renderer.
// Dependency-injected like map-tile-cache so tests run against an in-memory fs.

function createMvtStore(options) {
	const opts = options || {};
	const baseDir = opts.baseDir;
	const fsImpl = opts.fs;
	const log = typeof opts.log === 'function' ? opts.log : () => {};
	if (!baseDir) throw new Error('createMvtStore requires baseDir');
	if (!fsImpl) throw new Error('createMvtStore requires fs');

	let tmpCounter = 0;

	function tilePath(z, x, y) {
		return path.join(baseDir, String(z), String(x), `${y}.mvt`);
	}

	// has(): a usable (non-empty) tile exists. hasEntry(): any file exists,
	// including the zero-length "no data upstream" markers the primer writes -
	// the primer skips on hasEntry so markers are not refetched every run,
	// while the renderer only trusts has().
	function has(z, x, y) {
		try {
			const stat = fsImpl.statSync(tilePath(z, x, y));
			return stat.size > 0;
		} catch {
			return false;
		}
	}

	function hasEntry(z, x, y) {
		return fsImpl.existsSync(tilePath(z, x, y));
	}

	// Age of the stored entry (data or marker) in milliseconds, or null.
	function ageMs(z, x, y) {
		const mtime = mtimeMs(z, x, y);
		return mtime === null ? null : Date.now() - mtime;
	}

	// Modification time of the stored entry, or null. Used to detect rendered
	// tiles that are older than the vector data they were drawn from.
	function mtimeMs(z, x, y) {
		try {
			return fsImpl.statSync(tilePath(z, x, y)).mtimeMs;
		} catch {
			return null;
		}
	}

	// Marks an entry as freshly checked without changing its content - used
	// when a refresh confirms the upstream has nothing newer to offer.
	function touch(z, x, y) {
		try {
			const now = new Date();
			fsImpl.utimesSync(tilePath(z, x, y), now, now);
			return true;
		} catch (err) {
			log(`[MvtStore] ${z}/${x}/${y} touch failed: ${err.message || err}`);
			return false;
		}
	}

	function read(z, x, y) {
		const target = tilePath(z, x, y);
		if (!fsImpl.existsSync(target)) return null;
		try {
			const body = fsImpl.readFileSync(target);
			return body && body.length ? body : null;
		} catch (err) {
			log(`[MvtStore] ${z}/${x}/${y} read failed: ${err.message || err}`);
			return null;
		}
	}

	function write(z, x, y, body) {
		const target = tilePath(z, x, y);
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
			log(`[MvtStore] ${z}/${x}/${y} write failed: ${err.message || err}`);
			return false;
		}
	}

	// The decider's tier-1 question: does the store hold data that can render
	// this display tile? Returns the source tile coordinates or null. Disk is
	// the single source of truth - no separate coverage bookkeeping to drift.
	function renderSourceFor(z, x, y) {
		const src = renderSourceTile(z, x, y, MAX_DATA_ZOOM);
		return has(src.z, src.x, src.y) ? src : null;
	}

	return { tilePath, has, hasEntry, ageMs, mtimeMs, touch, read, write, renderSourceFor };
}

// Fetches every missing tile from tilesByZoom, politely: batches with a pause
// between them and a stop check so a config change can abort a long prime.
// Two fetch strategies:
//   fetchTileBatch(tiles[]) -> Map('z/x/y' -> Buffer|null) - preferred; lets
//     the caller coalesce byte ranges so latency amortizes across a batch.
//   fetchTile(z, x, y) -> Buffer|null - per-tile fallback.
// null / absent results mean the archive has no data for that tile; a
// zero-length marker file is stored so future runs skip it (readers treat
// empty files as absent).
//
// With maxAgeMs set, entries older than it are refreshed too: new data
// replaces the old copy; a "no data" answer for a tile that has data keeps the
// old copy and just marks it checked; a failed fetch leaves the old entry
// completely untouched so it retries on the next run.
async function primeMissingTiles(options) {
	const opts = options || {};
	const store = opts.store;
	const tilesByZoom = opts.tilesByZoom;
	const fetchTile = opts.fetchTile;
	const fetchTileBatch = opts.fetchTileBatch;
	const maxAgeMs = Number.isFinite(Number(opts.maxAgeMs)) && Number(opts.maxAgeMs) > 0 ? Number(opts.maxAgeMs) : Infinity;
	const concurrency = Math.max(1, Math.floor(Number(opts.concurrency) || 4));
	const batchSize = Math.max(1, Math.floor(Number(opts.batchSize) || 512));
	const delayMs = Math.max(0, Math.floor(Number(opts.delayMs) || 0));
	const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : () => false;
	const log = typeof opts.log === 'function' ? opts.log : () => {};
	const sleep = typeof opts.sleep === 'function' ? opts.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	if (!store) throw new Error('primeMissingTiles requires store');
	if (!tilesByZoom) throw new Error('primeMissingTiles requires tilesByZoom');
	if (typeof fetchTile !== 'function' && typeof fetchTileBatch !== 'function') {
		throw new Error('primeMissingTiles requires fetchTile or fetchTileBatch');
	}

	const stats = { fetched: 0, refreshed: 0, kept: 0, empty: 0, skipped: 0, failed: 0, stopped: false };
	const zooms = [...tilesByZoom.keys()].sort((a, b) => a - b);

	const hasEntry = (t) => (store.hasEntry ? store.hasEntry(t.z, t.x, t.y) : store.has(t.z, t.x, t.y));
	const isStale = (t) => {
		if (maxAgeMs === Infinity || typeof store.ageMs !== 'function') return false;
		const age = store.ageMs(t.z, t.x, t.y);
		return age !== null && age > maxAgeMs;
	};

	const storeResult = (t, body) => {
		const hadData = store.has(t.z, t.x, t.y);
		if (body && body.length) {
			if (store.write(t.z, t.x, t.y, body)) {
				if (hadData) stats.refreshed++;
				else stats.fetched++;
			} else stats.failed++;
		} else if (hadData) {
			// Upstream says "no data" for a tile we hold data for. Keep the old
			// copy; only mark it checked so it is not retried daily.
			store.touch(t.z, t.x, t.y);
			stats.kept++;
		} else {
			store.write(t.z, t.x, t.y, Buffer.alloc(0));
			stats.empty++;
		}
	};

	for (const z of zooms) {
		const tiles = tilesByZoom.get(z) || [];
		const missing = tiles.filter((t) => !hasEntry(t) || isStale(t));
		stats.skipped += tiles.length - missing.length;

		if (typeof fetchTileBatch === 'function') {
			for (let i = 0; i < missing.length; i += batchSize) {
				if (shouldStop()) {
					stats.stopped = true;
					return stats;
				}
				const batch = missing.slice(i, i + batchSize);
				try {
					const results = await fetchTileBatch(batch);
					for (const t of batch) storeResult(t, results.get(`${t.z}/${t.x}/${t.y}`) || null);
				} catch (err) {
					stats.failed += batch.length;
					log(`[MvtPrime] Batch of ${batch.length} at z${z} failed: ${err.message || err}`);
				}
				if (delayMs > 0 && i + batchSize < missing.length) await sleep(delayMs);
			}
			continue;
		}

		for (let i = 0; i < missing.length; i += concurrency) {
			if (shouldStop()) {
				stats.stopped = true;
				return stats;
			}
			const batch = missing.slice(i, i + concurrency);
			await Promise.all(batch.map(async (t) => {
				try {
					storeResult(t, await fetchTile(t.z, t.x, t.y));
				} catch (err) {
					stats.failed++;
					log(`[MvtPrime] ${t.z}/${t.x}/${t.y} fetch failed: ${err.message || err}`);
				}
			}));
			if (delayMs > 0 && i + concurrency < missing.length) await sleep(delayMs);
		}
	}
	return stats;
}

// Resolves the source archive URL. 'auto' discovers the newest daily planet
// build from the Protomaps metadata endpoint; anything else is used verbatim
// (e.g. a self-built planetiler archive served from local storage).
const PROTOMAPS_BUILDS_METADATA_URL = 'https://build-metadata.protomaps.dev/builds.json';
const PROTOMAPS_BUILDS_BASE_URL = 'https://build.protomaps.com/';

async function resolveSourceUrl(configured, fetchJson) {
	const value = String(configured || '').trim();
	if (value && value.toLowerCase() !== 'auto') return value;
	const builds = await fetchJson(PROTOMAPS_BUILDS_METADATA_URL);
	if (!Array.isArray(builds) || !builds.length) throw new Error('Build metadata empty');
	const latest = builds[builds.length - 1];
	if (!latest || typeof latest.key !== 'string' || !/^[A-Za-z0-9._-]+\.pmtiles$/.test(latest.key)) {
		throw new Error('Build metadata malformed');
	}
	return PROTOMAPS_BUILDS_BASE_URL + latest.key;
}

module.exports = {
	createMvtStore,
	primeMissingTiles,
	resolveSourceUrl,
	PROTOMAPS_BUILDS_METADATA_URL,
	PROTOMAPS_BUILDS_BASE_URL,
};
