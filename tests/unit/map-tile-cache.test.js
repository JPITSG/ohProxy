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
function memoryFs(seed = {}) {
	const files = new Map(Object.entries(seed));
	const dirs = new Set();
	return {
		files,
		dirs,
		existsSync: (p) => files.has(p) || dirs.has(p),
		readFileSync: (p) => {
			if (!files.has(p)) throw new Error(`ENOENT ${p}`);
			return files.get(p);
		},
		writeFileSync: (p, body) => { files.set(p, body); },
		mkdirSync: (p) => { dirs.add(p); },
		renameSync: (from, to) => {
			files.set(to, files.get(from));
			files.delete(from);
		},
		unlinkSync: (p) => { files.delete(p); },
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

	it('serves tiles through the cache and marks the route in a response header', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const result = await mapTileCache\.get\(coords\);/);
		assert.match(server, /res\.setHeader\('X-Tile-Cache', result\.route === ROUTE_HIT \? 'hit' : 'miss'\);/);
	});

	it('logs request and route only while debug logging is enabled', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /if \(liveConfig\.mapTilesDebugLogging\) \{\s*logMessage\(`\[MapTiles\] \$\{tileKey\(coords\)\} user=\$\{req\.ohProxyUser\} -> \$\{result\.route\} \(\$\{result\.detail\}\)`\);/);
	});

	it('points the presence map at the local route only when enabled', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const proxyTiles = liveConfig\.mapTilesEnabled === true;/);
		assert.match(server, /\? '\["\/tiles\/\$\{z\}\/\$\{x\}\/\$\{y\}\.png"\]'/);
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
