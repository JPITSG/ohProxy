'use strict';

/**
 * Chart Period Parsing and Helper Tests
 *
 * Tests for parsePeriodToSeconds, chartCacheTtl, chartShowCurStat,
 * chartFallbackN, chartXLabelInterval, chartHashConfig, and
 * the client-side periodDurationTier function.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

// ── Replicate server-side helpers ───────────────────────────────────────

const MAX_PERIOD_SEC = 10 * 365.25 * 86400;

function parseBasePeriodToSeconds(period) {
	const simpleMatch = period.match(/^(\d*)([hDWMY])$/);
	if (simpleMatch) {
		const multiplier = simpleMatch[1] ? parseInt(simpleMatch[1], 10) : 1;
		const unitSec = { h: 3600, D: 86400, W: 604800, M: 2592000, Y: 31536000 };
		const sec = multiplier * unitSec[simpleMatch[2]];
		return Math.min(sec, MAX_PERIOD_SEC);
	}
	const isoMatch = period.match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
	if (isoMatch) {
		const [, y, mo, w, d, h, mi, s] = isoMatch;
		const sec = (parseInt(y || 0) * 31536000)
			+ (parseInt(mo || 0) * 2592000)
			+ (parseInt(w || 0) * 604800)
			+ (parseInt(d || 0) * 86400)
			+ (parseInt(h || 0) * 3600)
			+ (parseInt(mi || 0) * 60)
			+ (parseInt(s || 0));
			return sec > 0 ? Math.min(sec, MAX_PERIOD_SEC) : 0;
	}
	return 0;
}

function parsePeriodToSeconds(period) {
	if (typeof period !== 'string') return 0;
	const raw = period.trim();
	if (!raw) return 0;
	const dashCount = (raw.match(/-/g) || []).length;
	if (dashCount > 1) return 0;
	if (dashCount === 1) {
		const [past, future] = raw.split('-');
		const pastSec = past ? parseBasePeriodToSeconds(past) : 0;
		const futureSec = future ? parseBasePeriodToSeconds(future) : 0;
		if (past && !pastSec) return 0;
		if (future && !futureSec) return 0;
		if (!pastSec && !futureSec) return 0;
		return pastSec + futureSec;
	}
	return parseBasePeriodToSeconds(raw);
}

function chartCacheTtl(durationSec) {
	if (durationSec <= 3600) return 60 * 1000;
	if (durationSec <= 86400) return 10 * 60 * 1000;
	if (durationSec <= 30 * 86400) return 60 * 60 * 1000;
	return 24 * 60 * 60 * 1000;
}

function chartFallbackN(durationSec) {
	return Math.min(Math.max(Math.round(durationSec / 60), 60), 8760);
}

function chartXLabelInterval(dataDurationSec) {
	const niceIntervals = [
		300, 600, 900, 1800, 3600, 7200, 14400, 21600,
		43200, 86400, 172800, 432000, 604800, 1209600, 2592000,
	];
	const target = dataDurationSec / 7;
	for (const iv of niceIntervals) {
		if (iv >= target) return iv;
	}
	return niceIntervals[niceIntervals.length - 1];
}

function chartHashConfig(durationSec) {
	if (durationSec <= 3600)    return { sample: 1,  decimals: 2, tsRound: 60 };
	if (durationSec <= 86400)   return { sample: 4,  decimals: 1, tsRound: 3600 };
	if (durationSec <= 604800)  return { sample: 8,  decimals: 1, tsRound: 86400 };
	if (durationSec <= 2592000) return { sample: 16, decimals: 0, tsRound: 86400 };
	return { sample: 32, decimals: 0, tsRound: 604800 };
}

function chartShowCurStat(durationSec) {
	return durationSec <= 14400;
}

// ── Replicate client-side periodDurationTier ────────────────────────────

function periodDurationTier(p) {
	var sec = parsePeriodToSeconds(p);
	if (!sec) return 'hD';
	if (sec <= 86400) return 'hD';
	if (sec <= 604800) return 'W';
	if (sec <= 7776000) return 'M';
	return 'Y';
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('parsePeriodToSeconds', () => {
	describe('simple periods', () => {
		it('parses h as 3600', () => {
			assert.strictEqual(parsePeriodToSeconds('h'), 3600);
		});
		it('parses D as 86400', () => {
			assert.strictEqual(parsePeriodToSeconds('D'), 86400);
		});
		it('parses W as 604800', () => {
			assert.strictEqual(parsePeriodToSeconds('W'), 604800);
		});
		it('parses M as 2592000', () => {
			assert.strictEqual(parsePeriodToSeconds('M'), 2592000);
		});
		it('parses Y as 31536000', () => {
			assert.strictEqual(parsePeriodToSeconds('Y'), 31536000);
		});
	});

	describe('multiplied periods', () => {
		it('parses 4h as 14400', () => {
			assert.strictEqual(parsePeriodToSeconds('4h'), 14400);
		});
		it('parses 2D as 172800', () => {
			assert.strictEqual(parsePeriodToSeconds('2D'), 172800);
		});
		it('parses 3W as 1814400', () => {
			assert.strictEqual(parsePeriodToSeconds('3W'), 1814400);
		});
		it('parses 12M as 31104000', () => {
			assert.strictEqual(parsePeriodToSeconds('12M'), 31104000);
		});
		it('parses 2Y as 63072000', () => {
			assert.strictEqual(parsePeriodToSeconds('2Y'), 63072000);
		});
	});

	describe('ISO 8601 durations', () => {
		it('parses PT1H as 3600', () => {
			assert.strictEqual(parsePeriodToSeconds('PT1H'), 3600);
		});
		it('parses PT1H30M as 5400', () => {
			assert.strictEqual(parsePeriodToSeconds('PT1H30M'), 5400);
		});
		it('parses P2W as 1209600', () => {
			assert.strictEqual(parsePeriodToSeconds('P2W'), 1209600);
		});
		it('parses P1DT12H as 129600', () => {
			assert.strictEqual(parsePeriodToSeconds('P1DT12H'), 129600);
		});
		it('parses P1Y6M as 47088000', () => {
			assert.strictEqual(parsePeriodToSeconds('P1Y6M'), 47088000);
		});
		it('parses P1D as 86400', () => {
			assert.strictEqual(parsePeriodToSeconds('P1D'), 86400);
		});
		it('parses PT30S as 30', () => {
			assert.strictEqual(parsePeriodToSeconds('PT30S'), 30);
		});
	});

	describe('past-future periods', () => {
		it('parses 2h-1h as full window (past + future)', () => {
			assert.strictEqual(parsePeriodToSeconds('2h-1h'), 10800);
		});
		it('parses h-1h as full window (past + future)', () => {
			assert.strictEqual(parsePeriodToSeconds('h-1h'), 7200);
		});
		it('parses 4h-2h as full window (past + future)', () => {
			assert.strictEqual(parsePeriodToSeconds('4h-2h'), 21600);
		});
		it('parses D-1D as full window (past + future)', () => {
			assert.strictEqual(parsePeriodToSeconds('D-1D'), 172800);
		});
		it('parses 2W-1D as full window (past + future)', () => {
			assert.strictEqual(parsePeriodToSeconds('2W-1D'), 1296000);
		});
		it('parses D- with empty future portion', () => {
			assert.strictEqual(parsePeriodToSeconds('D-'), 86400);
		});
		it('parses -1h as future-only window', () => {
			assert.strictEqual(parsePeriodToSeconds('-1h'), 3600);
		});
		it('parses PT1H30M-PT30M as full ISO window', () => {
			assert.strictEqual(parsePeriodToSeconds('PT1H30M-PT30M'), 7200);
		});
		it('parses long ISO past-future period P10Y6M2DT3H4M5S-PT30M', () => {
			assert.strictEqual(parsePeriodToSeconds('P10Y6M2DT3H4M5S-PT30M'), MAX_PERIOD_SEC + 1800);
		});
	});

	describe('invalid inputs', () => {
		it('returns 0 for empty string', () => {
			assert.strictEqual(parsePeriodToSeconds(''), 0);
		});
		it('returns 0 for null', () => {
			assert.strictEqual(parsePeriodToSeconds(null), 0);
		});
		it('returns 0 for undefined', () => {
			assert.strictEqual(parsePeriodToSeconds(undefined), 0);
		});
		it('returns 0 for random text', () => {
			assert.strictEqual(parsePeriodToSeconds('invalid'), 0);
		});
		it('returns 0 for X', () => {
			assert.strictEqual(parsePeriodToSeconds('X'), 0);
		});
		it('returns 0 for bare P with no components', () => {
			assert.strictEqual(parsePeriodToSeconds('P'), 0);
		});
		it('returns 0 for number only', () => {
			assert.strictEqual(parsePeriodToSeconds('42'), 0);
		});
		it('returns 0 for malformed multi-dash past-future period', () => {
			assert.strictEqual(parsePeriodToSeconds('h-1h-1h'), 0);
		});
		it('returns 0 for empty-sided past-future period', () => {
			assert.strictEqual(parsePeriodToSeconds('-'), 0);
		});
	});

	describe('cap at 10 years', () => {
		it('caps 100Y at max', () => {
			assert.strictEqual(parsePeriodToSeconds('100Y'), MAX_PERIOD_SEC);
		});
	});
});

describe('chartCacheTtl', () => {
	it('returns 60s for h (3600)', () => {
		assert.strictEqual(chartCacheTtl(3600), 60000);
	});
	it('returns 10min for D (86400)', () => {
		assert.strictEqual(chartCacheTtl(86400), 600000);
	});
	it('returns 1h for W (604800)', () => {
		assert.strictEqual(chartCacheTtl(604800), 3600000);
	});
	it('returns 1h for M (2592000)', () => {
		assert.strictEqual(chartCacheTtl(2592000), 3600000);
	});
	it('returns 1d for Y (31536000)', () => {
		assert.strictEqual(chartCacheTtl(31536000), 86400000);
	});
	it('returns 10min for 4h (14400)', () => {
		assert.strictEqual(chartCacheTtl(14400), 600000);
	});
});

describe('chartShowCurStat', () => {
	it('true for h (3600)', () => {
		assert.strictEqual(chartShowCurStat(3600), true);
	});
	it('true for 4h (14400)', () => {
		assert.strictEqual(chartShowCurStat(14400), true);
	});
	it('false for D (86400)', () => {
		assert.strictEqual(chartShowCurStat(86400), false);
	});
	it('false for W (604800)', () => {
		assert.strictEqual(chartShowCurStat(604800), false);
	});
});

describe('chartFallbackN', () => {
	it('returns 60 for h (minimum clamp)', () => {
		assert.strictEqual(chartFallbackN(3600), 60);
	});
	it('returns 1440 for D', () => {
		assert.strictEqual(chartFallbackN(86400), 1440);
	});
	it('returns 8760 for Y (maximum clamp)', () => {
		assert.strictEqual(chartFallbackN(31536000), 8760);
	});
});

describe('chartXLabelInterval', () => {
	it('returns a reasonable interval for 1h data', () => {
		const iv = chartXLabelInterval(3600);
		assert.ok(iv >= 300 && iv <= 900, `Expected 300-900, got ${iv}`);
	});
	it('returns a reasonable interval for 1d data', () => {
		const iv = chartXLabelInterval(86400);
		assert.ok(iv >= 7200 && iv <= 21600, `Expected 7200-21600, got ${iv}`);
	});
});

describe('chartHashConfig', () => {
	it('returns sample:1 for h', () => {
		assert.deepStrictEqual(chartHashConfig(3600), { sample: 1, decimals: 2, tsRound: 60 });
	});
	it('returns sample:4 for D', () => {
		assert.deepStrictEqual(chartHashConfig(86400), { sample: 4, decimals: 1, tsRound: 3600 });
	});
	it('returns sample:8 for W', () => {
		assert.deepStrictEqual(chartHashConfig(604800), { sample: 8, decimals: 1, tsRound: 86400 });
	});
	it('returns sample:16 for M', () => {
		assert.deepStrictEqual(chartHashConfig(2592000), { sample: 16, decimals: 0, tsRound: 86400 });
	});
	it('returns sample:32 for Y', () => {
		assert.deepStrictEqual(chartHashConfig(31536000), { sample: 32, decimals: 0, tsRound: 604800 });
	});
});

describe('periodDurationTier (client-side)', () => {
	it('classifies h as hD', () => {
		assert.strictEqual(periodDurationTier('h'), 'hD');
	});
	it('classifies D as hD', () => {
		assert.strictEqual(periodDurationTier('D'), 'hD');
	});
	it('classifies 4h as hD', () => {
		assert.strictEqual(periodDurationTier('4h'), 'hD');
	});
	it('classifies W as W', () => {
		assert.strictEqual(periodDurationTier('W'), 'W');
	});
	it('classifies 2W as M (>7d)', () => {
		assert.strictEqual(periodDurationTier('2W'), 'M');
	});
	it('classifies M as M', () => {
		assert.strictEqual(periodDurationTier('M'), 'M');
	});
	it('classifies 3M as M (<=90d)', () => {
		assert.strictEqual(periodDurationTier('3M'), 'M');
	});
	it('classifies Y as Y', () => {
		assert.strictEqual(periodDurationTier('Y'), 'Y');
	});
	it('classifies PT1H30M as hD', () => {
		assert.strictEqual(periodDurationTier('PT1H30M'), 'hD');
	});
	it('classifies P2W as M (>7d)', () => {
		assert.strictEqual(periodDurationTier('P2W'), 'M');
	});
	it('classifies P1Y6M as Y', () => {
		assert.strictEqual(periodDurationTier('P1Y6M'), 'Y');
	});
	it('classifies 2h-1h past-future as hD', () => {
		assert.strictEqual(periodDurationTier('2h-1h'), 'hD');
	});
	it('classifies 2W-1D past-future as M (full window > 7d)', () => {
		assert.strictEqual(periodDurationTier('2W-1D'), 'M');
	});
	it('classifies D-1D past-future as hD', () => {
		assert.strictEqual(periodDurationTier('D-1D'), 'W');
	});
	it('classifies D- past-future as hD', () => {
		assert.strictEqual(periodDurationTier('D-'), 'hD');
	});
	it('classifies -1h future-only as hD', () => {
		assert.strictEqual(periodDurationTier('-1h'), 'hD');
	});
	it('classifies PT1H30M-PT30M past-future as hD', () => {
		assert.strictEqual(periodDurationTier('PT1H30M-PT30M'), 'hD');
	});
	it('returns hD for invalid input', () => {
		assert.strictEqual(periodDurationTier('invalid'), 'hD');
	});
});
