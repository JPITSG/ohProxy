'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
	MAX_TILE_ZOOM,
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
} = require('../../lib/map-tile-cache');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');
const DEFAULTS_FILE = path.join(PROJECT_ROOT, 'config.defaults.js');
const GITIGNORE_FILE = path.join(PROJECT_ROOT, '.gitignore');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const LANG_FILE = path.join(PROJECT_ROOT, 'public', 'lang.js');
const SW_FILE = path.join(PROJECT_ROOT, 'public', 'sw.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('body')]);

// Minimal in-memory fs stand-in matching the calls createTileCache makes.
// mtimes is exposed so tests can age files directly.
function memoryFs(seed = {}) {
	const files = new Map(Object.entries(seed));
	const mtimes = new Map([...files.keys()].map((p) => [p, Date.now()]));
	const dirs = new Set();
	return {
		files,
		mtimes,
		dirs,
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
			mtimes.set(to, mtimes.get(from) ?? Date.now());
			files.delete(from);
			mtimes.delete(from);
		},
		unlinkSync: (p) => { files.delete(p); mtimes.delete(p); },
	};
}

describe('Map Tile Coordinate Validation', () => {
	it('accepts in-range integer coordinates', () => {
		assert.deepEqual(parseTileCoords('0', '0', '0'), { z: 0, x: 0, y: 0 });
		assert.deepEqual(parseTileCoords('14', '8192', '8191'), { z: 14, x: 8192, y: 8191 });
		assert.deepEqual(parseTileCoords(19, 524287, 524287), { z: 19, x: 524287, y: 524287 });
	});

	it('rejects zoom levels beyond what the tile service serves', () => {
		assert.equal(parseTileCoords(String(MAX_TILE_ZOOM + 1), '0', '0'), null);
		assert.equal(parseTileCoords('99', '0', '0'), null);
	});

	it('rejects coordinates outside the tile grid for the given zoom', () => {
		assert.equal(parseTileCoords('0', '1', '0'), null);
		assert.equal(parseTileCoords('0', '0', '1'), null);
		assert.equal(parseTileCoords('1', '2', '0'), null);
		assert.equal(parseTileCoords('14', '16384', '0'), null);
		assert.equal(parseTileCoords('19', '524288', '0'), null);
	});

	it('rejects non-integer, signed and malformed values', () => {
		for (const bad of ['', ' ', '1.5', '-1', '+1', '1e3', '0x10', 'abc', '1 ', null, undefined, {}]) {
			assert.equal(parseTileCoords(bad, '0', '0'), null, `zoom ${String(bad)} should be rejected`);
			assert.equal(parseTileCoords('14', bad, '0'), null, `x ${String(bad)} should be rejected`);
			assert.equal(parseTileCoords('14', '0', bad), null, `y ${String(bad)} should be rejected`);
		}
	});

	it('rejects path traversal attempts in coordinate positions', () => {
		assert.equal(parseTileCoords('..', '..', '..'), null);
		assert.equal(parseTileCoords('14', '../../etc/passwd', '0'), null);
		assert.equal(parseTileCoords('14', '0', '0/../../secret'), null);
	});

	it('rejects leading zeros so each tile has exactly one cache key', () => {
		assert.equal(parseTileCoords('01', '0', '0'), null);
		assert.equal(parseTileCoords('14', '08192', '8191'), null);
		assert.equal(parseTileCoords('14', '8192', '08191'), null);
	});
});

describe('Map Tile Paths and URLs', () => {
	it('nests cache files by zoom and column to keep directories small', () => {
		assert.equal(
			tileCachePath('/cache/tiles', { z: 14, x: 8192, y: 8191 }),
			path.join('/cache/tiles', '14', '8192', '8191.png')
		);
	});

	it('keeps every cache path inside the base directory', () => {
		for (const coords of [{ z: 0, x: 0, y: 0 }, { z: 19, x: 524287, y: 524287 }]) {
			const resolved = path.resolve(tileCachePath('/cache/tiles', coords));
			assert.ok(resolved.startsWith(path.resolve('/cache/tiles') + path.sep));
		}
	});

	it('builds upstream URLs from validated integers only', () => {
		assert.equal(upstreamTileUrl({ z: 14, x: 8192, y: 8191 }), 'https://tile.openstreetmap.org/14/8192/8191.png');
	});

	it('formats a stable tile key', () => {
		assert.equal(tileKey({ z: 14, x: 8192, y: 8191 }), '14/8192/8191');
	});

	it('recognises PNG bodies and rejects anything else', () => {
		assert.equal(isPngBuffer(PNG), true);
		assert.equal(isPngBuffer(Buffer.from('<html>rate limited</html>')), false);
		assert.equal(isPngBuffer(Buffer.alloc(0)), false);
		assert.equal(isPngBuffer(null), false);
		assert.equal(isPngBuffer('not a buffer'), false);
	});
});

describe('Map Tile Cache Decider', () => {
	const coords = { z: 14, x: 8192, y: 8191 };

	it('serves a local copy without any upstream request', async () => {
		let fetches = 0;
		const cache = createTileCache({
			baseDir: '/cache/tiles',
			fs: memoryFs({ [tileCachePath('/cache/tiles', coords)]: PNG }),
			fetchTile: async () => { fetches++; return { ok: true, status: 200, body: PNG }; },
		});

		const result = await cache.get(coords);
		assert.equal(result.route, ROUTE_HIT);
		assert.equal(result.status, 200);
		assert.equal(result.contentType, 'image/png');
		assert.deepEqual(result.body, PNG);
		assert.equal(fetches, 0, 'a cache hit must not contact the tile service');
	});

	it('fetches, caches and serves on a miss, then serves the second request locally', async () => {
		let fetches = 0;
		const store = memoryFs();
		const cache = createTileCache({
			baseDir: '/cache/tiles',
			fs: store,
			fetchTile: async () => { fetches++; return { ok: true, status: 200, body: PNG }; },
		});

		const first = await cache.get(coords);
		assert.equal(first.route, ROUTE_MISS);
		assert.deepEqual(first.body, PNG);
		assert.equal(fetches, 1);
		assert.deepEqual(store.files.get(tileCachePath('/cache/tiles', coords)), PNG);

		const second = await cache.get(coords);
		assert.equal(second.route, ROUTE_HIT);
		assert.equal(fetches, 1, 'the tile must only be fetched upstream once');
	});

	it('writes via a temp file and rename so partial tiles are never visible', async () => {
		const store = memoryFs();
		const seen = [];
		const tracking = { ...store, writeFileSync: (p, body) => { seen.push(p); store.writeFileSync(p, body); } };
		const cache = createTileCache({
			baseDir: '/cache/tiles',
			fs: tracking,
			fetchTile: async () => ({ ok: true, status: 200, body: PNG }),
		});

		await cache.get(coords);
		assert.equal(seen.length, 1);
		assert.match(seen[0], /\.tmp$/, 'tile body must be written to a temp name first');
		assert.ok(!store.files.has(seen[0]), 'temp file must not survive the rename');
		assert.ok(store.files.has(tileCachePath('/cache/tiles', coords)));
	});

	it('coalesces concurrent misses for the same tile into one upstream fetch', async () => {
		let fetches = 0;
		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		const cache = createTileCache({
			baseDir: '/cache/tiles',
			fs: memoryFs(),
			fetchTile: async () => { fetches++; await gate; return { ok: true, status: 200, body: PNG }; },
		});

		const pending = [cache.get(coords), cache.get(coords), cache.get(coords)];
		assert.equal(cache.inFlightCount(), 1);
		release();
		const results = await Promise.all(pending);

		assert.equal(fetches, 1, 'three simultaneous requests must share one upstream fetch');
		assert.equal(results.filter((r) => r.route === ROUTE_MISS).length, 1);
		assert.equal(results.filter((r) => r.route === ROUTE_COALESCED).length, 2);
		for (const result of results) assert.deepEqual(result.body, PNG);
		assert.equal(cache.inFlightCount(), 0, 'in-flight entries must be released');
	});

	it('does not cache non-2xx responses', async () => {
		const store = memoryFs();
		const logs = [];
		const cache = createTileCache({
			baseDir: '/cache/tiles',
			fs: store,
			log: (m) => logs.push(m),
			fetchTile: async () => ({ ok: false, status: 429, body: Buffer.from('slow down') }),
		});

		const result = await cache.get(coords);
		assert.equal(result.route, ROUTE_ERROR);
		assert.equal(result.status, 429);
		assert.equal(result.body, null);
		assert.equal(store.files.size, 0, 'error responses must never be cached');
		assert.ok(logs.some((m) => m.includes('status 429')));
	});

	it('does not cache a 200 response whose body is not a PNG', async () => {
		const store = memoryFs();
		const cache = createTileCache({
			baseDir: '/cache/tiles',
			fs: store,
			fetchTile: async () => ({ ok: true, status: 200, body: Buffer.from('<html>error page</html>') }),
		});

		const result = await cache.get(coords);
		assert.equal(result.route, ROUTE_ERROR);
		assert.equal(store.files.size, 0, 'a non-PNG body must never be cached and served as a tile');
	});

	it('reports an error instead of throwing when the fetch rejects', async () => {
		const cache = createTileCache({
			baseDir: '/cache/tiles',
			fs: memoryFs(),
			fetchTile: async () => { throw new Error('ETIMEDOUT'); },
		});

		const result = await cache.get(coords);
		assert.equal(result.route, ROUTE_ERROR);
		assert.equal(result.status, 502);
		assert.equal(cache.inFlightCount(), 0);
	});

	it('refetches when a cached file is unreadable or empty', async () => {
		let fetches = 0;
		const target = tileCachePath('/cache/tiles', coords);
		const cache = createTileCache({
			baseDir: '/cache/tiles',
			fs: memoryFs({ [target]: Buffer.alloc(0) }),
			fetchTile: async () => { fetches++; return { ok: true, status: 200, body: PNG }; },
		});

		const result = await cache.get(coords);
		assert.equal(result.route, ROUTE_MISS);
		assert.equal(fetches, 1);
	});

	it('requires its injected dependencies', () => {
		assert.throws(() => createTileCache({ fs: memoryFs(), fetchTile: async () => ({}) }), /baseDir/);
		assert.throws(() => createTileCache({ baseDir: '/c', fetchTile: async () => ({}) }), /fs/);
		assert.throws(() => createTileCache({ baseDir: '/c', fs: memoryFs() }), /fetchTile/);
	});
});

describe('Map Tile Cache Aging', () => {
	const coords = { z: 14, x: 8192, y: 8191 };
	const target = tileCachePath('/cache/tiles', coords);
	const OLD_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('old')]);
	const DAY_MS = 86400000;

	function agedFs(ageMs) {
		const store = memoryFs({ [target]: OLD_PNG });
		store.mtimes.set(target, Date.now() - ageMs);
		return store;
	}

	it('serves fresh tiles without contacting upstream', async () => {
		let fetches = 0;
		const cache = createTileCache({
			baseDir: '/cache/tiles',
			fs: agedFs(5 * DAY_MS),
			maxAgeMs: 30 * DAY_MS,
			fetchTile: async () => { fetches++; return { ok: true, status: 200, body: PNG }; },
		});
		const result = await cache.get(coords);
		assert.equal(result.route, ROUTE_HIT);
		assert.equal(fetches, 0);
	});

	it('refreshes tiles older than the max age and stores the new copy', async () => {
		const store = agedFs(40 * DAY_MS);
		const cache = createTileCache({
			baseDir: '/cache/tiles',
			fs: store,
			maxAgeMs: 30 * DAY_MS,
			fetchTile: async () => ({ ok: true, status: 200, body: PNG }),
		});
		const result = await cache.get(coords);
		assert.equal(result.route, 'refreshed');
		assert.deepEqual(result.body, PNG, 'the new tile is served');
		assert.deepEqual(store.files.get(target), PNG, 'the new tile replaced the old one');

		const again = await cache.get(coords);
		assert.equal(again.route, ROUTE_HIT, 'the refreshed tile is fresh again');
	});

	it('serves the old copy when a refresh fails, leaving it in place', async () => {
		const store = agedFs(40 * DAY_MS);
		const logs = [];
		const cache = createTileCache({
			baseDir: '/cache/tiles',
			fs: store,
			log: (m) => logs.push(m),
			maxAgeMs: 30 * DAY_MS,
			fetchTile: async () => { throw new Error('ETIMEDOUT'); },
		});
		const result = await cache.get(coords);
		assert.equal(result.route, 'stale');
		assert.equal(result.status, 200);
		assert.deepEqual(result.body, OLD_PNG, 'the stale copy is served');
		assert.deepEqual(store.files.get(target), OLD_PNG, 'the stale copy stays on disk');
		assert.ok(logs.some((m) => m.includes('upstream fetch failed')));
	});

	it('serves the old copy when the refresh returns an error status or junk', async () => {
		for (const bad of [
			async () => ({ ok: false, status: 503, body: Buffer.from('down') }),
			async () => ({ ok: true, status: 200, body: Buffer.from('<html>not a png</html>') }),
		]) {
			const store = agedFs(40 * DAY_MS);
			const cache = createTileCache({
				baseDir: '/cache/tiles', fs: store, maxAgeMs: 30 * DAY_MS, fetchTile: bad,
			});
			const result = await cache.get(coords);
			assert.equal(result.route, 'stale');
			assert.deepEqual(result.body, OLD_PNG);
			assert.deepEqual(store.files.get(target), OLD_PNG);
		}
	});

	it('re-evaluates a live max age function on every request', async () => {
		let maxAge = 100 * DAY_MS;
		let fetches = 0;
		const cache = createTileCache({
			baseDir: '/cache/tiles',
			fs: agedFs(40 * DAY_MS),
			maxAgeMs: () => maxAge,
			fetchTile: async () => { fetches++; return { ok: true, status: 200, body: PNG }; },
		});
		assert.equal((await cache.get(coords)).route, ROUTE_HIT, 'fresh under the wide limit');
		maxAge = 30 * DAY_MS;
		assert.equal((await cache.get(coords)).route, 'refreshed', 'stale after the limit tightens');
		assert.equal(fetches, 1);
	});

	it('treats an age-fresh tile as stale when staleIf reports newer source data', async () => {
		const store = agedFs(1 * DAY_MS);
		let staleIfCalls = 0;
		const cache = createTileCache({
			baseDir: '/cache/tiles',
			fs: store,
			maxAgeMs: 30 * DAY_MS,
			staleIf: (c, mtimeMs) => { staleIfCalls++; return typeof mtimeMs === 'number'; },
			fetchTile: async () => ({ ok: true, status: 200, body: PNG }),
		});
		const result = await cache.get(coords);
		assert.equal(result.route, 'refreshed', 'newer source data forces a refresh');
		assert.deepEqual(store.files.get(target), PNG);
		assert.ok(staleIfCalls >= 1);
	});

	it('keeps serving the hit when staleIf reports the source is not newer', async () => {
		let fetches = 0;
		const cache = createTileCache({
			baseDir: '/cache/tiles',
			fs: agedFs(1 * DAY_MS),
			maxAgeMs: 30 * DAY_MS,
			staleIf: () => false,
			fetchTile: async () => { fetches++; return { ok: true, status: 200, body: PNG }; },
		});
		assert.equal((await cache.get(coords)).route, ROUTE_HIT);
		assert.equal(fetches, 0);
	});

	it('serves the old copy when a staleIf-triggered refresh fails', async () => {
		const store = agedFs(1 * DAY_MS);
		const cache = createTileCache({
			baseDir: '/cache/tiles',
			fs: store,
			maxAgeMs: 30 * DAY_MS,
			staleIf: () => true,
			fetchTile: async () => { throw new Error('render failed'); },
		});
		const result = await cache.get(coords);
		assert.equal(result.route, 'stale');
		assert.deepEqual(result.body, OLD_PNG);
	});

	it('never expires when no max age is configured', async () => {
		let fetches = 0;
		const cache = createTileCache({
			baseDir: '/cache/tiles',
			fs: agedFs(4000 * DAY_MS),
			fetchTile: async () => { fetches++; return { ok: true, status: 200, body: PNG }; },
		});
		assert.equal((await cache.get(coords)).route, ROUTE_HIT);
		assert.equal(fetches, 0);
	});
});

describe('Map Tile Proxy Wiring', () => {
	it('gates the tile route on auth, trackgps and the enabled toggle', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /app\.get\(\/\^\\\/tiles\\\/\(\\d\{1,2\}\)\\\/\(\\d\{1,7\}\)\\\/\(\\d\{1,7\}\)\\\.png\$\/, async \(req, res\) => \{/);
		assert.match(server, /if \(!req\.ohProxyUser\) \{\s*return res\.status\(401\)\.send\('Unauthorized'\);/);
		assert.match(server, /if \(!req\.ohProxyUserData\?\.trackgps\) \{\s*return res\.status\(403\)\.send\('GPS tracking not enabled'\);/);
		assert.match(server, /if \(!liveConfig\.mapTilesEnabled\) \{\s*return res\.status\(404\)\.send\('Not found'\);/);
	});

	it('registers the tile route after the auth middleware that populates the user', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		const authIndex = server.indexOf('req.ohProxyUserData = user;');
		const routeIndex = server.indexOf('app.get(/^\\/tiles\\/');
		assert.ok(authIndex > 0, 'auth middleware assignment must exist');
		assert.ok(routeIndex > 0, 'tile route must exist');
		assert.ok(routeIndex > authIndex, 'tile route must be registered after the auth middleware');
	});

	it('is not reachable through the auth-exempt path allowlist', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		const exempt = server.match(/function isAuthExemptPath\(req\) \{[\s\S]*?\n\}/);
		assert.ok(exempt, 'isAuthExemptPath must exist');
		assert.ok(!/tiles/.test(exempt[0]), 'the tile route must never be auth-exempt');
	});

	it('rejects unauthenticated callers before touching the cache or network', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		const route = server.slice(server.indexOf('app.get(/^\\/tiles\\/'));
		const body = route.slice(0, route.indexOf('\n});'));
		const authIndex = body.indexOf("res.status(401).send('Unauthorized')");
		const trackgpsIndex = body.indexOf("res.status(403).send('GPS tracking not enabled')");
		const getIndex = body.indexOf('await mapTileCache.get(coords)');
		assert.ok(authIndex > 0 && trackgpsIndex > 0 && getIndex > 0);
		assert.ok(authIndex < getIndex, '401 check must precede any cache or upstream work');
		assert.ok(trackgpsIndex < getIndex, '403 check must precede any cache or upstream work');
	});

	it('adds no endpoint other than the tile route', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		const tileRoutes = server.match(/app\.(?:get|post|put|delete|patch|all|use)\(\s*\/\^\\\/tiles/g) || [];
		assert.equal(tileRoutes.length, 1, 'exactly one /tiles route may be registered');
		const lib = fs.readFileSync(path.join(PROJECT_ROOT, 'lib', 'map-tile-cache.js'), 'utf8');
		assert.ok(!/app\.(?:get|post|put|delete|patch|all|use)\(/.test(lib), 'the tile cache module must not register routes');
	});

	it('validates coordinates before building any upstream request', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const coords = match \? parseTileCoords\(match\[1\], match\[2\], match\[3\]\) : null;/);
		assert.match(server, /if \(!coords\) \{/);
		assert.match(server, /return res\.status\(400\)\.send\('Invalid tile coordinates'\);/);
	});

	it('serves tiles through the cache and marks the tier in a response header', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /result = await mapTileCache\.get\(coords\);/);
		assert.match(server, /res\.setHeader\('X-Tile-Cache', tier\);/);
	});

	it('runs the decider tiers in order: rendered, cached raster, upstream', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		const route = server.slice(server.indexOf('app.get(/^\\/tiles\\/'));
		const body = route.slice(0, route.indexOf('\n});'));
		const renderCheck = body.indexOf('mvtStore.renderSourceFor(coords.z, coords.x, coords.y)');
		const renderGet = body.indexOf('await renderedTileCache.get(coords)');
		const rasterGet = body.indexOf('await mapTileCache.get(coords)');
		assert.ok(renderCheck > 0 && renderGet > 0 && rasterGet > 0);
		assert.ok(renderCheck < renderGet, 'coverage check must precede the render');
		assert.ok(renderGet < rasterGet, 'tier 1 (render) must precede tiers 2/3 (raster)');
		assert.match(body, /liveConfig\.mapTilesRenderEnabled && mvtStore\.renderSourceFor/);
		assert.match(body, /tier = rendered\.route === ROUTE_HIT \? 'render-hit'/);
		assert.match(body, /: rendered\.route === ROUTE_REFRESHED \? 're-rendered'/);
		assert.match(body, /: rendered\.route === ROUTE_STALE \? 'render-stale'/);
		assert.match(body, /tier = result\.route === ROUTE_HIT \? 'raster-hit' : result\.route;/);
	});

	it('applies the shared max age to both caches, the primer and browser caching', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const mapTilesMaxAgeMs = \(\) => liveConfig\.mapTilesMaxAgeDays \* 86400000;/);
		const maxAgeWirings = server.match(/maxAgeMs: mapTilesMaxAgeMs,/g) || [];
		assert.equal(maxAgeWirings.length, 2, 'both tile caches must age out');
		assert.match(server, /maxAgeMs: liveConfig\.mapTilesMaxAgeDays \* 86400000,/, 'the primer must refresh stale vector data');
		assert.match(server, /Math\.min\(604800, Math\.floor\(liveConfig\.mapTilesMaxAgeDays \* 86400\)\)/, 'browser cache must not outlive the max age');
		assert.match(server, /staleIf: \(coords, renderMtimeMs\) => \{\s*const src = mvtStore\.renderSourceFor\(coords\.z, coords\.x, coords\.y\);/,
			'renders must expire when their source vector tile is newer');
		assert.match(server, /return sourceMtimeMs !== null && sourceMtimeMs > renderMtimeMs;/);
		assert.match(server, /errors\.push\('server\.mapTiles\.maxAgeDays must be a number between 1 and 3650'\);/);
		assert.match(server, /liveConfig\.mapTilesMaxAgeDays = configNumber\(newMapTiles\.maxAgeDays\) \|\| 30;/);

		const defaults = fs.readFileSync(DEFAULTS_FILE, 'utf8');
		assert.match(defaults, /maxAgeDays: 30,/);
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.ok(app.includes("'server.mapTiles.maxAgeDays'"), 'admin modal must expose maxAgeDays');
		const lang = fs.readFileSync(LANG_FILE, 'utf8');
		assert.match(lang, /'server\.mapTiles\.maxAgeDays': 'Map Data Max Age \(days\)',/);
	});

	it('renders tier-1 misses from the local vector store, never the network', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		const cacheDef = server.slice(server.indexOf('const renderedTileCache = createTileCache({'));
		const body = cacheDef.slice(0, cacheDef.indexOf('\n});'));
		assert.match(body, /baseDir: RENDER_CACHE_DIR,/);
		assert.match(body, /const src = mvtStore\.renderSourceFor\(coords\.z, coords\.x, coords\.y\);/);
		assert.match(body, /const mvt = mvtStore\.read\(src\.z, src\.x, src\.y\);/);
		assert.match(body, /getTileRenderer\(\)\.renderTile\(\{/);
		assert.ok(!/fetchBinaryFromUrl/.test(body), 'the render path must not fetch from the network');
	});

	it('registers the primer as a background task gated on both toggles', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /registerBackgroundTask\('mvt-prime',\s*liveConfig\.mapTilesEnabled && liveConfig\.mapTilesPrimeEnabled \? liveConfig\.mapTilesPrimeIntervalMs : 0,\s*mvtPrimeTask\)/);
		assert.match(server, /if \(!liveConfig\.mapTilesEnabled \|\| \(!liveConfig\.mapTilesPrimeEnabled && !forced\)\) return;/);
		assert.match(server, /updateBackgroundTaskInterval\('mvt-prime',/);
		assert.match(server, /shouldStop: \(\) => !liveConfig\.mapTilesEnabled \|\| \(!liveConfig\.mapTilesPrimeEnabled && !forced\),/);
	});

	it('documents and validates the prime and render settings', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /errors\.push\('server\.mapTiles\.prime\.enabled must be a boolean'\);/);
		assert.match(server, /errors\.push\('server\.mapTiles\.prime\.radiusKm must be a number between 1 and 100'\);/);
		assert.match(server, /errors\.push\('server\.mapTiles\.prime\.intervalMs must be at least 3600000 \(1 hour\)'\);/);
		assert.match(server, /errors\.push\('server\.mapTiles\.prime\.sourceUrl must be "auto" or an http\(s\) URL'\);/);
		assert.match(server, /errors\.push\('server\.mapTiles\.render\.enabled must be a boolean'\);/);

		const defaults = fs.readFileSync(DEFAULTS_FILE, 'utf8');
		assert.match(defaults, /prime: \{/);
		assert.match(defaults, /radiusKm: 10,/);
		assert.match(defaults, /intervalMs: 86400000,/);
		assert.match(defaults, /sourceUrl: 'auto',/);
		assert.match(defaults, /render: \{/);
		assert.match(defaults, /fontFile: '\/usr\/share\/fonts\/truetype\/dejavu\/DejaVuSans\.ttf',/);

		const app = fs.readFileSync(APP_FILE, 'utf8');
		for (const key of ['prime.enabled', 'prime.radiusKm', 'prime.intervalMs', 'prime.sourceUrl', 'render.enabled', 'render.fontFile']) {
			assert.ok(app.includes(`'server.mapTiles.${key}'`), `admin modal must expose server.mapTiles.${key}`);
		}
		const lang = fs.readFileSync(LANG_FILE, 'utf8');
		assert.match(lang, /'server\.mapTiles\.prime\.enabled': 'Prime Vector Tiles',/);
		assert.match(lang, /'server\.mapTiles\.render\.fontFile': 'Map Label Font',/);
	});

	it('keeps the vector and render caches out of version control', () => {
		const gitignore = fs.readFileSync(GITIGNORE_FILE, 'utf8').split(/\r?\n/);
		assert.ok(gitignore.includes('cache/mvt/'), '.gitignore must list cache/mvt/');
		assert.ok(gitignore.includes('cache/render/'), '.gitignore must list cache/render/');
	});

	it('shows the data-age chip while proxying and the attribution otherwise', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		// Proxy mode: chip replaces the attribution (which stays for direct-OSM mode).
		assert.match(server, /\$\{proxyTiles\s*\?\s*`\.olControlAttribution\{display:none!important\}/);
		assert.match(server, /#map-data-age\{position:fixed;bottom:6px;right:8px/);
		assert.match(server, /#map-data-age\.fresh\{background:rgba\(78,183,128,0\.22\);color:#1c6b40\}/);
		assert.match(server, /#map-data-age\.stale\{background:rgba\(198,40,40,0\.16\);color:#c62828/);
		assert.match(server, /: `\.olControlAttribution\{position:fixed/, 'attribution stays visible in direct-OSM mode');
		assert.match(server, /\$\{proxyTiles \? '<div id="map-data-age"><button id="map-data-refresh" type="button"/);
		assert.match(server, /<span id="map-data-age-text">map data …<\/span><\/div>' : ''\}/);
	});

	it('wires the data-age chip to viewport changes and stale detection', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /return 'z='\+z\+'&x0='\+tx\(ex\.left\)\+'&x1='\+tx\(ex\.right\)\+'&y0='\+ty\(ex\.top\)\+'&y1='\+ty\(ex\.bottom\);/);
		assert.match(server, /fetch\('\/api\/tiles\/age\?'\+qs\)/);
		assert.match(server, /dataAgeEl\.classList\.toggle\('stale',dataStale\);\s*dataAgeEl\.classList\.toggle\('fresh',!dataStale\);/);
		assert.match(server, /map\.events\.register\('moveend',null,queueDataAge\);/);
		assert.match(server, /map\.events\.register\('zoomend',null,queueDataAge\);/);
		assert.match(server, /map\.layers\[0\]\.events\.register\('loadend',null,queueDataAge\);/);
	});

	it('gates the tile-age endpoint like the tile route and validates the rectangle', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		const routeIndex = server.indexOf("app.get('/api/tiles/age'");
		const authIndex = server.indexOf('req.ohProxyUserData = user;');
		assert.ok(routeIndex > authIndex, 'age endpoint must register after the auth middleware');
		const body = server.slice(routeIndex, server.indexOf('\n});', routeIndex));
		assert.match(body, /res\.status\(401\)\.json\(\{ ok: false, error: 'Unauthorized' \}\)/);
		assert.match(body, /res\.status\(403\)\.json\(\{ ok: false, error: 'GPS tracking not enabled' \}\)/);
		assert.match(body, /if \(!liveConfig\.mapTilesEnabled\)/);
		assert.match(body, /const rect = parseTileRectQuery\(req\.query\);/);
		assert.match(body, /res\.status\(400\)\.json\(\{ ok: false, error: 'Invalid tile range' \}\)/);
		assert.match(server, /function parseTileRectQuery\(query\) \{[\s\S]*?\(x1 - x0 \+ 1\) \* \(y1 - y0 \+ 1\) <= 1024[\s\S]*?\}/);
		// Age comes from the authoritative data: vector source first, raster fallback.
		assert.match(body, /const src = mvtStore\.renderSourceFor\(z, x, y\);/);
		assert.match(body, /ageMs = mvtStore\.ageMs\(src\.z, src\.x, src\.y\);/);
		assert.match(body, /tileCachePath\(TILE_CACHE_DIR, \{ z, x, y \}\)/);
		assert.match(body, /maxAgeMs: liveConfig\.mapTilesMaxAgeDays \* 86400000/);
	});

	it('logs request and route only while debug logging is enabled', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /if \(liveConfig\.mapTilesDebugLogging\) \{\s*logMessage\(`\[MapTiles\] \$\{tileKey\(coords\)\} user=\$\{req\.ohProxyUser\} -> \$\{tier\} \(\$\{result\.detail\}\)`\);/);
	});

	it('points the presence map at the local route only when enabled', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const proxyTiles = liveConfig\.mapTilesEnabled === true;/);
		assert.match(server, /\? '\["\/tiles\/\$\{z\}\/\$\{x\}\/\$\{y\}\.png\?e=' \+ tilesEpoch \+ '"\]'/);
		assert.match(server, /: '\["\/\/a\.tile\.openstreetmap\.org\/\$\{z\}\/\$\{x\}\/\$\{y\}\.png"/);
		assert.match(server, /map\.addLayer\(new OpenLayers\.Layer\.OSM\("OSM",\$\{tileUrlsJson\}\)\);/);
	});

	it('only relaxes the referrer policy on the direct-tile path', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /if \(!proxyTiles\) \{\s*res\.setHeader\('Referrer-Policy', PRESENCE_TILE_REFERRER_POLICY\);\s*\}/);
	});

	it('validates the host shape before reusing it as an outbound referer', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /if \(!host \|\| !\/\^\[a-z0-9\.-\]\{1,253\}\(\?::\\d\{1,5\}\)\?\$\/i\.test\(host\)\) return;/);
	});

	it('keeps the tile cache directory out of version control', () => {
		const gitignore = fs.readFileSync(GITIGNORE_FILE, 'utf8');
		assert.ok(gitignore.split(/\r?\n/).includes('cache/tiles/'), '.gitignore must list cache/tiles/');
	});

	it('keeps tiles out of the service worker shell cache', () => {
		const sw = fs.readFileSync(SW_FILE, 'utf8');
		assert.match(sw, /if \(path\.startsWith\('\/tiles\/'\)\) return false;/);
	});

	it('documents both settings in the config defaults', () => {
		const defaults = fs.readFileSync(DEFAULTS_FILE, 'utf8');
		assert.match(defaults, /mapTiles: \{/);
		assert.match(defaults, /enabled: false,/);
		assert.match(defaults, /debugLogging: false,/);
		assert.match(defaults, /Serve map tiles through ohProxy/);
		assert.match(defaults, /Log every proxied tile request and the route taken/);
	});

	it('exposes both settings in the admin config modal with labels', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /id: 'map-tiles', group: 'server',/);
		assert.match(app, /\{ key: 'server\.mapTiles\.enabled', type: 'toggle' \}/);
		assert.match(app, /\{ key: 'server\.mapTiles\.debugLogging', type: 'toggle' \}/);

		const lang = fs.readFileSync(LANG_FILE, 'utf8');
		assert.match(lang, /'map-tiles': 'MAP TILES',/);
		assert.match(lang, /'server\.mapTiles\.enabled': 'Proxy Map Tiles',/);
		assert.match(lang, /'server\.mapTiles\.debugLogging': 'Tile Debug Logging',/);
		assert.match(lang, /'server\.mapTiles\.enabled': 'Serve the presence map background tiles/);
		assert.match(lang, /'server\.mapTiles\.debugLogging': 'Log every proxied tile request/);
	});

	it('validates and hot-reloads both settings as booleans', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /errors\.push\('server\.mapTiles\.enabled must be a boolean'\);/);
		assert.match(server, /errors\.push\('server\.mapTiles\.debugLogging must be a boolean'\);/);
		assert.match(server, /liveConfig\.mapTilesEnabled = newMapTiles\.enabled === true;/);
		assert.match(server, /liveConfig\.mapTilesDebugLogging = newMapTiles\.debugLogging === true;/);
	});
});
