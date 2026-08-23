'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');
const source = fs.readFileSync(SERVER_FILE, 'utf8');

function extractFunction(src, name) {
	let start = src.indexOf(`async function ${name}(`);
	if (start < 0) start = src.indexOf(`function ${name}(`);
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

function extractConst(name) {
	const m = source.match(new RegExp(`const ${name} = [^;]+;`));
	assert.ok(m, `${name} constant must exist`);
	return m[0];
}

const helpers = new Function(`
${extractConst('NEARBY_DAYS_PAGE_SIZE')}
${extractConst('NEARBY_DAYS_SPARSE_ROW_CAP')}
${extractConst('NEARBY_DAYS_DEEP_OFFSET_CAP')}
${extractConst('NEARBY_DAYS_WALK_START_MS')}
${extractFunction(source, 'nearbyDayKeyFromValue')}
${extractFunction(source, 'nearbyDayBounds')}
${extractFunction(source, 'computeNearbyDaysAggregate')}
${extractFunction(source, 'computeNearbyDaysDenseWalk')}
${extractFunction(source, 'computeNearbyDays')}
return { NEARBY_DAYS_SPARSE_ROW_CAP, computeNearbyDays, nearbyDayKeyFromValue, nearbyDayBounds };
`)();

const { computeNearbyDays, NEARBY_DAYS_SPARSE_ROW_CAP } = helpers;

const SQL = {
	probe: /^SELECT COUNT\(\*\) AS c FROM \(SELECT 1 FROM log_gps/,
	aggregate: /GROUP BY day_date ORDER BY day_date DESC$/,
	point: /^SELECT lat, lon FROM log_gps WHERE username = \? AND timestamp = \?/,
	oldest: /ORDER BY timestamp ASC LIMIT 1$/,
	step: /AND timestamp < \? AND[\s\S]*ORDER BY timestamp DESC LIMIT 1$/,
	dayCount: /^SELECT COUNT\(\*\) AS cnt FROM log_gps WHERE username = \? AND timestamp >= \? AND timestamp < \?/,
};

// Fake DB: `rows` is the qualifying dataset, newest-first, each { ts, lat, lon }.
// Replies to every SQL shape computeNearbyDays issues; records calls per shape.
function fakeDb(rows, bboxCount) {
	const calls = { probe: 0, aggregate: 0, point: 0, oldest: 0, step: 0, dayCount: 0, boundaries: [], countRanges: [] };
	function dayKey(d) {
		return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
	}
	async function run(sql, params) {
		if (SQL.probe.test(sql)) {
			calls.probe += 1;
			return [{ c: bboxCount }];
		}
		if (SQL.aggregate.test(sql)) {
			calls.aggregate += 1;
			const groups = new Map();
			for (const r of rows) {
				const key = dayKey(r.ts);
				if (!groups.has(key)) groups.set(key, { day_date: new Date(r.ts.getFullYear(), r.ts.getMonth(), r.ts.getDate()), cnt: 0, newest_ts: r.ts });
				const g = groups.get(key);
				g.cnt += 1;
				if (r.ts > g.newest_ts) g.newest_ts = r.ts;
			}
			return [...groups.values()].sort((a, b) => b.day_date - a.day_date);
		}
		if (SQL.point.test(sql)) {
			calls.point += 1;
			const row = rows.find((r) => r.ts.getTime() === params[1].getTime());
			return row ? [{ lat: row.lat, lon: row.lon }] : [];
		}
		if (SQL.oldest.test(sql)) {
			calls.oldest += 1;
			return rows.length ? [{ ts: rows[rows.length - 1].ts }] : [];
		}
		if (SQL.step.test(sql)) {
			calls.step += 1;
			calls.boundaries.push(params[1]);
			const row = rows.find((r) => r.ts < params[1]);
			return row ? [{ ts: row.ts, lat: row.lat, lon: row.lon }] : [];
		}
		if (SQL.dayCount.test(sql)) {
			calls.dayCount += 1;
			calls.countRanges.push([params[1], params[2]]);
			return [{ cnt: rows.filter((r) => r.ts >= params[1] && r.ts < params[2]).length }];
		}
		throw new Error('Unexpected SQL: ' + sql);
	}
	return { run, calls };
}

const PARAMS = { username: 'u', lat: 10.5, lon: 21.25, radius: 100, offset: 0 };
function d(...args) { return new Date(...args); }

describe('Nearby Days adaptive computation', () => {
	it('sparse bbox uses one exact aggregation and pages with hasMore', async () => {
		const rows = [];
		for (let day = 20; day > 13; day -= 1) {
			rows.push({ ts: d(2026, 7, day, 18, 30, 0), lat: '52.1000001', lon: '20.9600001' });
			rows.push({ ts: d(2026, 7, day, 9, 0, 0), lat: '52.1000002', lon: '20.9600002' });
		}
		const db = fakeDb(rows, 14);
		const result = await computeNearbyDays(db.run, PARAMS);
		assert.strictEqual(db.calls.aggregate, 1);
		assert.strictEqual(db.calls.oldest, 0, 'sparse path must not walk');
		assert.strictEqual(db.calls.step, 0);
		assert.strictEqual(result.days.length, 5);
		assert.strictEqual(result.hasMore, true, '7 days > one page');
		assert.strictEqual(result.days[0].key, '2026-08-20');
		assert.strictEqual(result.days[4].key, '2026-08-16');
		assert.strictEqual(result.days[0].count, 2);
		assert.strictEqual(result.days[0].lat, '52.1000001', 'newest row of the day supplies the marker point');
		assert.strictEqual(db.calls.point, 5, 'one point lookup per paged day');
		assert.strictEqual(result.days[0].timestamp.getTime(), d(2026, 7, 20, 18, 30, 0).getTime());
	});

	it('sparse offset paging returns the tail without hasMore', async () => {
		const rows = [];
		for (let day = 20; day > 13; day -= 1) rows.push({ ts: d(2026, 7, day, 12, 0, 0), lat: '1', lon: '2' });
		const db = fakeDb(rows, 7);
		const result = await computeNearbyDays(db.run, { ...PARAMS, offset: 5 });
		assert.deepStrictEqual(result.days.map((x) => x.key), ['2026-08-15', '2026-08-14']);
		assert.strictEqual(result.hasMore, false);
	});

	it('dense bbox walks the timestamp index instead of aggregating', async () => {
		const rows = [
			{ ts: d(2026, 7, 23, 14, 0, 0), lat: '52.10', lon: '20.96' },
			{ ts: d(2026, 7, 23, 8, 0, 0), lat: '52.11', lon: '20.95' },
			{ ts: d(2026, 7, 22, 23, 59, 0), lat: '52.12', lon: '20.94' },
			// no rows on Aug 21 - the walk must skip it without a count query
			{ ts: d(2026, 7, 20, 18, 0, 0), lat: '52.13', lon: '20.93' },
			{ ts: d(2026, 7, 20, 5, 0, 0), lat: '52.14', lon: '20.92' },
		];
		const db = fakeDb(rows, NEARBY_DAYS_SPARSE_ROW_CAP + 1);
		const result = await computeNearbyDays(db.run, PARAMS);
		assert.strictEqual(db.calls.aggregate, 0, 'dense path must not aggregate the bbox');
		assert.strictEqual(db.calls.oldest, 1);
		assert.deepStrictEqual(result.days.map((x) => x.key), ['2026-08-23', '2026-08-22', '2026-08-20']);
		assert.deepStrictEqual(result.days.map((x) => x.count), [2, 1, 2]);
		assert.strictEqual(result.days[0].lat, '52.10', 'newest row of the day supplies the marker point');
		assert.strictEqual(result.hasMore, false);
		assert.strictEqual(db.calls.step, 3, 'oldest-row bound must spare the terminal empty step');
		assert.strictEqual(db.calls.dayCount, 3, 'one count per returned day only');
		assert.deepStrictEqual(db.calls.countRanges[0], [d(2026, 7, 23), d(2026, 7, 24)], 'count is bounded to the day');
	});

	it('dense walk reports hasMore when older qualifying rows remain', async () => {
		const rows = [];
		for (let day = 23; day > 15; day -= 1) rows.push({ ts: d(2026, 7, day, 12, 0, 0), lat: '1', lon: '2' });
		const db = fakeDb(rows, NEARBY_DAYS_SPARSE_ROW_CAP + 1);
		const result = await computeNearbyDays(db.run, PARAMS);
		assert.strictEqual(result.days.length, 5);
		assert.strictEqual(result.hasMore, true);
		assert.strictEqual(db.calls.step, 5, 'walk stops at one page of days');
	});

	it('dense walk honours offset paging', async () => {
		const rows = [];
		for (let day = 23; day > 15; day -= 1) rows.push({ ts: d(2026, 7, day, 12, 0, 0), lat: '1', lon: '2' });
		const db = fakeDb(rows, NEARBY_DAYS_SPARSE_ROW_CAP + 1);
		const result = await computeNearbyDays(db.run, { ...PARAMS, offset: 5 });
		assert.deepStrictEqual(result.days.map((x) => x.key), ['2026-08-18', '2026-08-17', '2026-08-16']);
		assert.strictEqual(result.hasMore, false);
		assert.strictEqual(db.calls.dayCount, 3, 'skipped offset days are not counted');
	});

	it('dense bbox with an empty circle returns immediately after the oldest probe', async () => {
		const db = fakeDb([], NEARBY_DAYS_SPARSE_ROW_CAP + 1);
		const result = await computeNearbyDays(db.run, PARAMS);
		assert.deepStrictEqual(result, { days: [], hasMore: false });
		assert.strictEqual(db.calls.oldest, 1);
		assert.strictEqual(db.calls.step, 0);
	});

	it('deep offsets fall back to the flat-cost aggregate even over a dense bbox', async () => {
		const rows = [{ ts: d(2026, 7, 23, 12, 0, 0), lat: '1', lon: '2' }];
		const db = fakeDb(rows, NEARBY_DAYS_SPARSE_ROW_CAP + 1);
		await computeNearbyDays(db.run, { ...PARAMS, offset: 251 });
		assert.strictEqual(db.calls.aggregate, 1);
		assert.strictEqual(db.calls.step, 0);
	});

	it('probe always runs first with a capped index-only scan', async () => {
		const db = fakeDb([], 0);
		await computeNearbyDays(db.run, PARAMS);
		assert.strictEqual(db.calls.probe, 1);
	});
});

describe('Nearby Days endpoint source', () => {
	it('no longer ships the truncating newest-5000 row dump', () => {
		assert.ok(!/ORDER BY timestamp DESC LIMIT 5000/.test(source));
	});

	it('route delegates to computeNearbyDays with the shared query runner', () => {
		assert.match(source, /result = await computeNearbyDays\(\(sql, sqlParams\) => queryWithTimeout\(conn, sql, sqlParams\), \{ username, lat, lon, radius, offset \}\)/);
	});

	it('circle filtering happens in SQL with X=longitude point order', () => {
		assert.match(source, /ST_Distance_Sphere\(POINT\(lon, lat\), POINT\(\?, \?\)\) <= \?/);
	});

	it('dense walk pins the timestamp index so the optimizer cannot pick the bbox index', () => {
		assert.match(source, /FORCE INDEX \(idx_username_timestamp\) WHERE username = \? AND timestamp < \?/);
	});
});
