'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const server = fs.readFileSync(path.join(PROJECT_ROOT, 'server.js'), 'utf8');

function extractFunction(source, name) {
	const start = source.indexOf(`function ${name}(`);
	assert.ok(start >= 0, `${name} must exist`);
	const bodyStart = source.indexOf('{', start);
	let depth = 0;
	for (let i = bodyStart; i < source.length; i += 1) {
		if (source[i] === '{') depth += 1;
		else if (source[i] === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error(`Could not extract ${name}`);
}

// Deterministic stand-ins for the config-driven formatter: DATE-<utc date>,
// TIME-<utc time>, so assertions read literally.
const liveConfig = { clientConfig: { dateFormat: 'DATE', timeFormat: 'TIME' } };
function formatDT(d, format) {
	if (format === 'DATE') return `D${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
	return `T${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
const roundPresenceCoord = (value) => Math.round(Number(value) * 10000000) / 10000000;

const presenceDurationLabel = Function(
	`return (${extractFunction(server, 'presenceDurationLabel')});`
)();

const presenceMarkerTooltip = Function(
	'formatDT', 'liveConfig', 'presenceDurationLabel',
	`return (${extractFunction(server, 'presenceMarkerTooltip')});`
)(formatDT, liveConfig, presenceDurationLabel);

const buildPresenceMarkersFromRows = Function(
	'roundPresenceCoord', 'presenceMarkerTooltip',
	`return (${extractFunction(server, 'buildPresenceMarkersFromRows')});`
)(roundPresenceCoord, presenceMarkerTooltip);

describe('Presence Stacked Pin Range Tooltips', () => {
	it('keeps the classic Date/Time tooltip for a single fix', () => {
		assert.equal(
			presenceMarkerTooltip('2026-07-30T10:00:00Z'),
			'<div class="tt-date">D2026-7-30</div><div class="tt-time">T10:00</div>'
		);
		assert.equal(presenceMarkerTooltip(''), '');
	});

	it('renders a same-day stack as one date with From, To and Length rows', () => {
		assert.equal(
			presenceMarkerTooltip('2026-07-30T08:00:00Z', '2026-07-30T10:15:00Z'),
			'<div class="tt-date">D2026-7-30</div>'
			+ '<div class="tt-time"><span class="tt-fromto">From</span>T8:00</div>'
			+ '<div class="tt-time"><span class="tt-fromto">To</span>T10:15</div>'
			+ '<div class="tt-time"><span class="tt-fromto">Length</span>2.3 hours</div>'
		);
	});

	it('carries a date on each side when the stack spans midnight', () => {
		assert.equal(
			presenceMarkerTooltip('2026-07-29T23:58:00Z', '2026-07-30T00:12:00Z'),
			'<div class="tt-time"><span class="tt-fromto">From</span>D2026-7-29 T23:58</div>'
			+ '<div class="tt-time"><span class="tt-fromto">To</span>D2026-7-30 T0:12</div>'
			+ '<div class="tt-time"><span class="tt-fromto">Length</span>14.0 mins</div>'
		);
	});

	it('describes stack lengths with one decimal in minutes, hours and days', () => {
		const MIN = 60000;
		assert.equal(presenceDurationLabel(30 * 1000), '0.5 mins');
		assert.equal(presenceDurationLabel(1 * MIN), '1.0 min');
		assert.equal(presenceDurationLabel(32 * MIN), '32.0 mins');
		assert.equal(presenceDurationLabel(89 * MIN), '89.0 mins');
		assert.equal(presenceDurationLabel(95 * MIN), '1.6 hours');
		assert.equal(presenceDurationLabel(2 * 60 * MIN), '2.0 hours');
		assert.equal(presenceDurationLabel(2.4 * 60 * MIN), '2.4 hours');
		assert.equal(presenceDurationLabel(47 * 60 * MIN), '47.0 hours');
		assert.equal(presenceDurationLabel(48 * 60 * MIN), '2.0 days');
		assert.equal(presenceDurationLabel(60 * 60 * MIN), '2.5 days');
		assert.equal(presenceDurationLabel(50 * 24 * 60 * MIN), '50.0 days');
		assert.equal(presenceDurationLabel(0), '');
		assert.equal(presenceDurationLabel(-5), '');
	});

	it('falls back to the single form when from and to are identical', () => {
		assert.equal(
			presenceMarkerTooltip('2026-07-30T10:00:00Z', '2026-07-30T10:00:00Z'),
			'<div class="tt-date">D2026-7-30</div><div class="tt-time">T10:00</div>'
		);
	});

	it('collapses only consecutive same-spot fixes into one pin', () => {
		// Newest first, like ORDER BY id DESC: back at home since 09:30, a fix
		// on the move at 09:00, and an older separate home visit at 08:00.
		const rows = [
			{ lat: 50.0000001, lon: 8.0000001, timestamp: '2026-07-30T10:00:00Z' },
			{ lat: 50.0000001, lon: 8.0000001, timestamp: '2026-07-30T09:30:00Z' },
			{ lat: 50.1, lon: 8.1, timestamp: '2026-07-30T09:00:00Z' },
			{ lat: 50.0000001, lon: 8.0000001, timestamp: '2026-07-30T08:00:00Z' },
		];
		const markers = buildPresenceMarkersFromRows(rows);
		assert.equal(markers.length, 2, 'four fixes collapse into two pins');

		// After the reverse the track runs oldest to newest: single fix first,
		// then the stacked pin, which is also the red (latest) one.
		const [single, stacked] = markers;
		assert.equal(single[2], 'blue');
		assert.equal(single[3], '<div class="tt-date">D2026-7-30</div><div class="tt-time">T9:00</div>');

		// The range covers the CURRENT stay only - the 08:00 fix belongs to an
		// earlier visit interrupted by the 09:00 trip and must not stretch it.
		assert.equal(stacked[2], 'red');
		assert.equal(
			stacked[3],
			'<div class="tt-date">D2026-7-30</div>'
			+ '<div class="tt-time"><span class="tt-fromto">From</span>T9:30</div>'
			+ '<div class="tt-time"><span class="tt-fromto">To</span>T10:00</div>'
			+ '<div class="tt-time"><span class="tt-fromto">Length</span>30.0 mins</div>'
		);
	});

	it('shows only the latest stay after leaving and returning (10h away 3h back 3h)', () => {
		// 10 hours at home (00:00-10:00), 3 hours out (5 fixes), back home for
		// 3 hours (13:00-16:00). Newest first.
		const home = { lat: 50.0000001, lon: 8.0000001 };
		const rows = [
			{ ...home, timestamp: '2026-07-30T16:00:00Z' },
			{ ...home, timestamp: '2026-07-30T14:30:00Z' },
			{ ...home, timestamp: '2026-07-30T13:00:00Z' },
			{ lat: 50.2, lon: 8.2, timestamp: '2026-07-30T12:00:00Z' },
			{ lat: 50.3, lon: 8.3, timestamp: '2026-07-30T11:00:00Z' },
			{ ...home, timestamp: '2026-07-30T10:00:00Z' },
			{ ...home, timestamp: '2026-07-30T05:00:00Z' },
			{ ...home, timestamp: '2026-07-30T00:00:00Z' },
		];
		const markers = buildPresenceMarkersFromRows(rows);
		assert.equal(markers.length, 3, 'home collapses to one pin plus two trip pins');
		const homePin = markers[markers.length - 1];
		assert.equal(homePin[2], 'red');
		assert.equal(
			homePin[3],
			'<div class="tt-date">D2026-7-30</div>'
			+ '<div class="tt-time"><span class="tt-fromto">From</span>T13:00</div>'
			+ '<div class="tt-time"><span class="tt-fromto">To</span>T16:00</div>'
			+ '<div class="tt-time"><span class="tt-fromto">Length</span>3.0 hours</div>',
			'the range is the 3-hour return stay, not 16 hours spanning the trip'
		);
	});

	it('never lets an older interrupted stay reopen a closed stack', () => {
		// A A B A A newest-first: after B closes the home stack, the two older
		// home fixes are consecutive with each other but belong to the earlier
		// stay and must not extend the pin.
		const home = { lat: 50.0000001, lon: 8.0000001 };
		const rows = [
			{ ...home, timestamp: '2026-07-30T12:00:00Z' },
			{ ...home, timestamp: '2026-07-30T11:30:00Z' },
			{ lat: 50.1, lon: 8.1, timestamp: '2026-07-30T11:00:00Z' },
			{ ...home, timestamp: '2026-07-30T10:00:00Z' },
			{ ...home, timestamp: '2026-07-30T09:00:00Z' },
		];
		const markers = buildPresenceMarkersFromRows(rows);
		const homePin = markers[markers.length - 1];
		assert.ok(homePin[3].includes('From</span>T11:30'), 'range starts at the latest stay');
		assert.ok(homePin[3].includes('Length</span>30.0 mins'));
	});

	it('keeps single-fix pins on the plain tooltip and preserves coordinates', () => {
		const rows = [
			{ lat: 51.5, lon: -0.12, timestamp: '2026-07-30T10:00:00Z' },
			{ lat: 51.6, lon: -0.13, timestamp: '2026-07-30T09:00:00Z' },
		];
		const markers = buildPresenceMarkersFromRows(rows);
		assert.equal(markers.length, 2);
		for (const marker of markers) {
			assert.ok(!marker[3].includes('tt-fromto'), 'no range without a stack');
		}
		assert.deepEqual([markers[1][0], markers[1][1], markers[1][2]], [51.5, -0.12, 'red']);
	});

	it('treats fixes just outside the rounding cell as separate pins', () => {
		const rows = [
			{ lat: 50.0000001, lon: 8.0000001, timestamp: '2026-07-30T10:00:00Z' },
			{ lat: 50.0000002, lon: 8.0000001, timestamp: '2026-07-30T09:00:00Z' },
		];
		assert.equal(buildPresenceMarkersFromRows(rows).length, 2, 'only identical rounded coords stack');
	});

	it('gives the label column a fixed width so all times align horizontally', () => {
		assert.match(server, /\.tooltip \.tt-fromto\{display:inline-block;width:4\.5em;margin-right:0\.375em;font-size:0\.5625rem;font-weight:400;letter-spacing:0\.08em;text-transform:uppercase;color:rgba\(19,21,54,0\.5\)\}/);
	});
});
