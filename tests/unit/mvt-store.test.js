'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
	createMvtStore,
	primeMissingTiles,
	resolveSourceUrl,
	PROTOMAPS_BUILDS_BASE_URL,
} = require('../../lib/mvt-store');

function memoryFs(seed = {}) {
	const files = new Map(Object.entries(seed));
	const mtimes = new Map([...files.keys()].map((p) => [p, Date.now()]));
	const dirs = new Set();
	return {
		files,
		mtimes,
		existsSync: (p) => files.has(p) || dirs.has(p),
		statSync: (p) => {
			if (!files.has(p)) throw new Error(`ENOENT ${p}`);
			return { size: files.get(p).length, mtimeMs: mtimes.get(p) ?? Date.now() };
		},
		readFileSync: (p) => {
			if (!files.has(p)) throw new Error(`ENOENT ${p}`);
			return files.get(p);
		},
		writeFileSync: (p, body) => { files.set(p, body); mtimes.set(p, Date.now()); },
		mkdirSync: (p) => { dirs.add(p); },
		renameSync: (from, to) => {
			files.set(to, files.get(from));
			mtimes.set(to, Date.now());
			files.delete(from);
			mtimes.delete(from);
		},
		unlinkSync: (p) => { files.delete(p); mtimes.delete(p); },
		utimesSync: (p, atime, mtime) => {
			if (!files.has(p)) throw new Error(`ENOENT ${p}`);
			mtimes.set(p, mtime instanceof Date ? mtime.getTime() : Number(mtime));
		},
	};
}

const DATA = Buffer.from('vector-tile-bytes');

describe('MVT Store', () => {
	it('writes and reads tiles under z/x/y paths', () => {
		const store = createMvtStore({ baseDir: '/cache/mvt', fs: memoryFs() });
		assert.equal(store.write(15, 100, 200, DATA), true);
		assert.deepEqual(store.read(15, 100, 200), DATA);
		assert.equal(store.tilePath(15, 100, 200), path.join('/cache/mvt', '15', '100', '200.mvt'));
	});

	it('distinguishes usable tiles from empty no-data markers', () => {
		const store = createMvtStore({ baseDir: '/cache/mvt', fs: memoryFs() });
		store.write(15, 1, 1, Buffer.alloc(0));
		assert.equal(store.hasEntry(15, 1, 1), true, 'marker exists as an entry');
		assert.equal(store.has(15, 1, 1), false, 'marker is not a usable tile');
		assert.equal(store.read(15, 1, 1), null);
		assert.equal(store.renderSourceFor(15, 1, 1), null, 'markers must not become render sources');
	});

	it('reports entry modification times for source-vs-render comparisons', () => {
		const backing = memoryFs();
		const store = createMvtStore({ baseDir: '/cache/mvt', fs: backing });
		assert.equal(store.mtimeMs(15, 9, 9), null, 'missing entries have no mtime');
		store.write(15, 9, 9, DATA);
		const reported = store.mtimeMs(15, 9, 9);
		assert.equal(reported, backing.mtimes.get(store.tilePath(15, 9, 9)));
		backing.mtimes.set(store.tilePath(15, 9, 9), 12345);
		assert.equal(store.mtimeMs(15, 9, 9), 12345);
	});

	it('resolves overzoomed display tiles to their z15 ancestor', () => {
		const store = createMvtStore({ baseDir: '/cache/mvt', fs: memoryFs() });
		store.write(15, 16372, 10896, DATA);
		assert.deepEqual(store.renderSourceFor(18, 130978, 87169), { z: 15, x: 16372, y: 10896 });
		assert.deepEqual(store.renderSourceFor(15, 16372, 10896), { z: 15, x: 16372, y: 10896 });
		assert.equal(store.renderSourceFor(15, 0, 0), null);
		assert.equal(store.renderSourceFor(14, 8186, 5448), null, 'lower zooms need their own tile');
	});
});

describe('MVT Primer', () => {
	function makeTiles() {
		return new Map([
			[13, [{ z: 13, x: 1, y: 1 }, { z: 13, x: 1, y: 2 }]],
			[14, [{ z: 14, x: 2, y: 2 }]],
		]);
	}

	it('fetches only missing tiles and stores them', async () => {
		const store = createMvtStore({ baseDir: '/m', fs: memoryFs() });
		store.write(13, 1, 1, DATA);
		const fetched = [];
		const stats = await primeMissingTiles({
			store,
			tilesByZoom: makeTiles(),
			fetchTile: async (z, x, y) => { fetched.push(`${z}/${x}/${y}`); return DATA; },
			sleep: async () => {},
		});
		assert.deepEqual(fetched.sort(), ['13/1/2', '14/2/2']);
		assert.equal(stats.fetched, 2);
		assert.equal(stats.skipped, 1);
		assert.deepEqual(store.read(14, 2, 2), DATA);
	});

	it('records empty markers for tiles with no upstream data and skips them next run', async () => {
		const store = createMvtStore({ baseDir: '/m', fs: memoryFs() });
		const stats = await primeMissingTiles({
			store,
			tilesByZoom: new Map([[13, [{ z: 13, x: 5, y: 5 }]]]),
			fetchTile: async () => null,
			sleep: async () => {},
		});
		assert.equal(stats.empty, 1);
		assert.equal(store.hasEntry(13, 5, 5), true);

		let calls = 0;
		const second = await primeMissingTiles({
			store,
			tilesByZoom: new Map([[13, [{ z: 13, x: 5, y: 5 }]]]),
			fetchTile: async () => { calls++; return null; },
			sleep: async () => {},
		});
		assert.equal(calls, 0, 'marker must suppress refetching');
		assert.equal(second.skipped, 1);
	});

	it('counts failures without aborting the run', async () => {
		const store = createMvtStore({ baseDir: '/m', fs: memoryFs() });
		const logs = [];
		const stats = await primeMissingTiles({
			store,
			tilesByZoom: makeTiles(),
			fetchTile: async (z, x, y) => {
				if (x === 1 && y === 1) throw new Error('range read failed');
				return DATA;
			},
			log: (m) => logs.push(m),
			sleep: async () => {},
		});
		assert.equal(stats.failed, 1);
		assert.equal(stats.fetched, 2);
		assert.ok(logs.some((m) => m.includes('13/1/1')));
	});

	it('stops between batches when shouldStop reports true', async () => {
		const store = createMvtStore({ baseDir: '/m', fs: memoryFs() });
		let fetches = 0;
		const stats = await primeMissingTiles({
			store,
			tilesByZoom: new Map([[13, Array.from({ length: 10 }, (_, i) => ({ z: 13, x: i, y: 0 }))]]),
			concurrency: 2,
			fetchTile: async () => { fetches++; return DATA; },
			shouldStop: () => fetches >= 4,
			sleep: async () => {},
		});
		assert.equal(stats.stopped, true);
		assert.ok(fetches < 10, 'must not fetch the full list after a stop');
	});

	it('prefers fetchTileBatch and stores batch results including no-data markers', async () => {
		const store = createMvtStore({ baseDir: '/m', fs: memoryFs() });
		store.write(13, 1, 1, DATA);
		const batches = [];
		const stats = await primeMissingTiles({
			store,
			tilesByZoom: makeTiles(),
			fetchTileBatch: async (tiles) => {
				batches.push(tiles.map((t) => `${t.z}/${t.x}/${t.y}`));
				const out = new Map();
				out.set('13/1/2', DATA);
				out.set('14/2/2', null);
				return out;
			},
			fetchTile: async () => { throw new Error('per-tile path must not run when batch is available'); },
			sleep: async () => {},
		});
		assert.deepEqual(batches, [['13/1/2'], ['14/2/2']], 'only missing tiles, batched per zoom');
		assert.equal(stats.fetched, 1);
		assert.equal(stats.empty, 1);
		assert.equal(stats.skipped, 1);
		assert.equal(store.hasEntry(14, 2, 2), true);
		assert.equal(store.has(14, 2, 2), false);
	});

	it('counts a failed batch without aborting later batches', async () => {
		const store = createMvtStore({ baseDir: '/m', fs: memoryFs() });
		const logs = [];
		const stats = await primeMissingTiles({
			store,
			tilesByZoom: new Map([[13, Array.from({ length: 4 }, (_, i) => ({ z: 13, x: i, y: 0 }))]]),
			batchSize: 2,
			fetchTileBatch: async (tiles) => {
				if (tiles[0].x === 0) throw new Error('range read failed');
				return new Map(tiles.map((t) => [`${t.z}/${t.x}/${t.y}`, DATA]));
			},
			log: (m) => logs.push(m),
			sleep: async () => {},
		});
		assert.equal(stats.failed, 2);
		assert.equal(stats.fetched, 2);
		assert.ok(logs.some((m) => m.includes('Batch of 2')));
	});

	it('refreshes entries older than maxAgeMs and replaces them with new data', async () => {
		const backing = memoryFs();
		const store = createMvtStore({ baseDir: '/m', fs: backing });
		const DAY = 86400000;
		const NEW = Buffer.from('newer-tile');
		store.write(13, 1, 1, DATA);
		store.write(13, 1, 2, DATA);
		// Age only the first tile past the limit.
		backing.mtimes.set(store.tilePath(13, 1, 1), Date.now() - 40 * DAY);
		const fetched = [];
		const stats = await primeMissingTiles({
			store,
			tilesByZoom: new Map([[13, [{ z: 13, x: 1, y: 1 }, { z: 13, x: 1, y: 2 }]]]),
			maxAgeMs: 30 * DAY,
			fetchTileBatch: async (tiles) => {
				fetched.push(...tiles.map((t) => `${t.z}/${t.x}/${t.y}`));
				return new Map([['13/1/1', NEW]]);
			},
			sleep: async () => {},
		});
		assert.deepEqual(fetched, ['13/1/1'], 'only the stale tile is refetched');
		assert.equal(stats.refreshed, 1);
		assert.equal(stats.skipped, 1);
		assert.deepEqual(store.read(13, 1, 1), NEW);
	});

	it('keeps the old copy and marks it checked when a refresh reports no data', async () => {
		const backing = memoryFs();
		const store = createMvtStore({ baseDir: '/m', fs: backing });
		const DAY = 86400000;
		store.write(13, 2, 2, DATA);
		backing.mtimes.set(store.tilePath(13, 2, 2), Date.now() - 40 * DAY);
		const stats = await primeMissingTiles({
			store,
			tilesByZoom: new Map([[13, [{ z: 13, x: 2, y: 2 }]]]),
			maxAgeMs: 30 * DAY,
			fetchTileBatch: async () => new Map([['13/2/2', null]]),
			sleep: async () => {},
		});
		assert.equal(stats.kept, 1);
		assert.deepEqual(store.read(13, 2, 2), DATA, 'old data is kept');
		assert.ok(store.ageMs(13, 2, 2) < DAY, 'entry is marked freshly checked');
	});

	it('leaves stale entries untouched when the refresh batch fails', async () => {
		const backing = memoryFs();
		const store = createMvtStore({ baseDir: '/m', fs: backing });
		const DAY = 86400000;
		store.write(13, 3, 3, DATA);
		const oldMtime = Date.now() - 40 * DAY;
		backing.mtimes.set(store.tilePath(13, 3, 3), oldMtime);
		const stats = await primeMissingTiles({
			store,
			tilesByZoom: new Map([[13, [{ z: 13, x: 3, y: 3 }]]]),
			maxAgeMs: 30 * DAY,
			fetchTileBatch: async () => { throw new Error('network down'); },
			sleep: async () => {},
		});
		assert.equal(stats.failed, 1);
		assert.deepEqual(store.read(13, 3, 3), DATA, 'old data survives the failure');
		assert.equal(backing.mtimes.get(store.tilePath(13, 3, 3)), oldMtime, 'mtime untouched so the next run retries');
	});

	it('drips: pauses between batches via the injected sleep', async () => {
		const store = createMvtStore({ baseDir: '/m', fs: memoryFs() });
		let sleeps = 0;
		await primeMissingTiles({
			store,
			tilesByZoom: new Map([[13, Array.from({ length: 6 }, (_, i) => ({ z: 13, x: i, y: 0 }))]]),
			concurrency: 2,
			delayMs: 40,
			fetchTile: async () => DATA,
			sleep: async () => { sleeps++; },
		});
		assert.equal(sleeps, 2, 'two pauses between three batches');
	});
});

describe('MVT Source Resolution', () => {
	it('uses an explicit URL verbatim without hitting the metadata endpoint', async () => {
		let metadataCalls = 0;
		const url = await resolveSourceUrl('https://example.invalid/self-built.pmtiles', async () => { metadataCalls++; return []; });
		assert.equal(url, 'https://example.invalid/self-built.pmtiles');
		assert.equal(metadataCalls, 0);
	});

	it('discovers the newest daily build for auto', async () => {
		const url = await resolveSourceUrl('auto', async () => [
			{ key: '20260728.pmtiles' }, { key: '20260729.pmtiles' }, { key: '20260730.pmtiles' },
		]);
		assert.equal(url, PROTOMAPS_BUILDS_BASE_URL + '20260730.pmtiles');
	});

	it('rejects malformed metadata instead of building a bad URL', async () => {
		await assert.rejects(() => resolveSourceUrl('auto', async () => []), /empty/);
		await assert.rejects(() => resolveSourceUrl('auto', async () => [{ key: '../evil' }]), /malformed/);
		await assert.rejects(() => resolveSourceUrl('', async () => null), /empty/);
	});
});
