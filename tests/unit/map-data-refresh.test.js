'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');
const source = fs.readFileSync(SERVER_FILE, 'utf8');

function extractFunction(src, name) {
	const start = src.indexOf(`function ${name}(`);
	assert.ok(start >= 0, `${name} must exist`);
	const bodyStart = src.indexOf('{', start);
	let depth = 0;
	for (let i = bodyStart; i < src.length; i += 1) {
		if (src[i] === '{') depth += 1;
		else if (src[i] === '}') {
			depth -= 1;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	throw new Error(`Could not extract ${name}`);
}

const parseTileRectQuery = new Function(`${extractFunction(source, 'parseTileRectQuery')}; return parseTileRectQuery;`)();

describe('Tile rectangle query parsing', () => {
	it('accepts a valid viewport rectangle', () => {
		assert.deepStrictEqual(
			parseTileRectQuery({ z: '15', x0: '100', x1: '107', y0: '200', y1: '204' }),
			{ z: 15, x0: 100, x1: 107, y0: 200, y1: 204 }
		);
	});

	it('rejects rectangles larger than 1024 tiles', () => {
		assert.strictEqual(parseTileRectQuery({ z: '15', x0: '0', x1: '63', y0: '0', y1: '16' }), null);
		assert.notStrictEqual(parseTileRectQuery({ z: '15', x0: '0', x1: '63', y0: '0', y1: '15' }), null);
	});

	it('rejects out-of-range zoom, coordinates, and inverted rectangles', () => {
		assert.strictEqual(parseTileRectQuery({ z: '20', x0: '0', x1: '0', y0: '0', y1: '0' }), null);
		assert.strictEqual(parseTileRectQuery({ z: '2', x0: '0', x1: '4', y0: '0', y1: '0' }), null, 'x beyond 2^z');
		assert.strictEqual(parseTileRectQuery({ z: '15', x0: '5', x1: '4', y0: '0', y1: '0' }), null);
		assert.strictEqual(parseTileRectQuery({ z: '15', x0: '-1', x1: '1', y0: '0', y1: '0' }), null);
		assert.strictEqual(parseTileRectQuery({ z: 'abc', x0: '0', x1: '0', y0: '0', y1: '0' }), null);
	});
});

describe('Manual map-data refresh wiring', () => {
	const routeIndex = source.indexOf("app.post('/api/tiles/refresh'");
	const body = source.slice(routeIndex, source.indexOf('\n});', routeIndex));

	it('is gated exactly like the age endpoint', () => {
		assert.ok(routeIndex >= 0, 'refresh endpoint must exist');
		assert.match(body, /res\.status\(401\)\.json\(\{ ok: false, error: 'Unauthorized' \}\)/);
		assert.match(body, /res\.status\(403\)\.json\(\{ ok: false, error: 'GPS tracking not enabled' \}\)/);
		assert.match(body, /if \(!liveConfig\.mapTilesEnabled\)/);
		assert.match(body, /const rect = parseTileRectQuery\(req\.query\);/);
		assert.match(body, /res\.status\(400\)\.json\(\{ ok: false, error: 'Invalid tile range' \}\)/);
	});

	it('backdates the authoritative data past the configured max age', () => {
		assert.match(body, /const staleTime = new Date\(markedAt - \(liveConfig\.mapTilesMaxAgeDays \+ 1\) \* 86400000\);/);
		assert.match(body, /const srcPath = mvtStore\.tilePath\(src\.z, src\.x, src\.y\);\s*try \{\s*fs\.utimesSync\(srcPath, staleTime, staleTime\);/);
		assert.match(body, /const rasterPath = tileCachePath\(TILE_CACHE_DIR, \{ z: rect\.z, x, y \}\);\s*try \{\s*fs\.utimesSync\(rasterPath, staleTime, staleTime\);/);
		assert.match(body, /backdatedSources\.has\(key\)/, 'overzoomed source tiles are backdated once');
	});

	it('records each backdated path so the age endpoint can report it as refreshing', () => {
		assert.match(body, /manualTileRefreshes\.set\(srcPath, markedAt\);/);
		assert.match(body, /manualTileRefreshes\.set\(rasterPath, markedAt\);/);
		assert.match(body, /pruneManualTileRefreshes\(\);/);
	});

	it('bumps the persisted tile epoch and kicks a forced primer run', () => {
		assert.match(body, /const epoch = bumpTilesEpoch\(\);/);
		assert.match(body, /mvtPrimeForceNext = true;\s*primerStarted = triggerBackgroundTaskNow\('mvt-prime'\);/);
		assert.match(source, /let tilesEpoch = 0;\s*try \{\s*tilesEpoch = parseInt\(fs\.readFileSync\(TILES_EPOCH_FILE, 'utf8'\), 10\) \|\| 0;/);
		assert.match(source, /fs\.writeFileSync\(TILES_EPOCH_FILE, String\(tilesEpoch\)\);/);
	});

	it('a forced primer run bypasses the periodic-primer enable gate', () => {
		assert.match(source, /const forced = mvtPrimeForceNext;\s*mvtPrimeForceNext = false;\s*if \(!liveConfig\.mapTilesEnabled \|\| \(!liveConfig\.mapTilesPrimeEnabled && !forced\)\) return;/);
		assert.match(source, /shouldStop: \(\) => !liveConfig\.mapTilesEnabled \|\| \(!liveConfig\.mapTilesPrimeEnabled && !forced\),/);
	});

	it('presence tile URLs carry the epoch so refreshes bust browser caches on next load', () => {
		assert.match(source, /'\["\/tiles\/\$\{z\}\/\$\{x\}\/\$\{y\}\.png\?e=' \+ tilesEpoch \+ '"\]'/);
	});
});

describe('Pending manual-refresh tracking', () => {
	const pruneFactory = new Function(
		'manualTileRefreshes',
		'MANUAL_TILE_REFRESH_TTL_MS',
		`${extractFunction(source, 'pruneManualTileRefreshes')}; return pruneManualTileRefreshes;`
	);

	it('prunes entries older than the TTL and keeps recent ones', () => {
		const pending = new Map([['expired', Date.now() - 301000], ['recent', Date.now() - 1000]]);
		pruneFactory(pending, 300000)();
		assert.deepStrictEqual([...pending.keys()], ['recent']);
	});

	it('the age endpoint reports pending tiles as refreshing, not backdated-old', () => {
		const ageIndex = source.indexOf("app.get('/api/tiles/age'");
		const ageBody = source.slice(ageIndex, source.indexOf('\n});', ageIndex));
		assert.match(ageBody, /pruneManualTileRefreshes\(\);/);
		assert.match(ageBody, /const markedAt = manualTileRefreshes\.get\(authPath\);/);
		assert.match(ageBody, /if \(Date\.now\(\) - ageMs >= markedAt\) manualTileRefreshes\.delete\(authPath\);\s*else \{ refreshing\+\+; continue; \}/);
		assert.match(ageBody, /known, unknown, refreshing \}\);/);
	});
});

describe('Data-age chip client wiring', () => {
	it('text updates target the span so the refresh button survives', () => {
		assert.match(source, /var dataAgeText=document\.getElementById\('map-data-age-text'\);/);
		assert.match(source, /dataAgeText\.textContent='map data '\+fmtDataAge\(d\.oldestAgeMs\)\+' old';/);
		assert.ok(!/dataAgeEl\.textContent=/.test(source), 'the pill container must never be overwritten');
	});

	it('unknown age clears both state classes', () => {
		assert.match(source, /dataAgeEl\.classList\.remove\('stale'\);dataAgeEl\.classList\.remove\('fresh'\);/);
	});

	it('a pending refresh shows the neutral refreshing text instead of a red backdated age', () => {
		assert.match(source, /if\(d\.refreshing>0\)\{dataAgeText\.textContent='map data refreshing\\\\u2026';dataAgeEl\.classList\.remove\('stale'\);dataAgeEl\.classList\.remove\('fresh'\);clearTimeout\(dataAgeTimer\);dataAgeTimer=setTimeout\(refreshDataAge,5000\);return\}/);
	});

	it('the refresh button posts the current viewport rect, spins, and re-polls', () => {
		assert.match(source, /if\(dataAgeRefreshBtn\)dataAgeRefreshBtn\.addEventListener\('click',function\(\)\{\s*var qs=dataAgeTileRect\(\);\s*if\(!qs\|\|dataAgeRefreshBtn\.classList\.contains\('spinning'\)\)return;/);
		assert.match(source, /fetch\('\/api\/tiles\/refresh\?'\+qs,\{method:'POST'\}\)/);
		assert.match(source, /refreshDataAge\(\);\s*setTimeout\(refreshDataAge,5000\);\s*setTimeout\(refreshDataAge,20000\);/);
	});
});
