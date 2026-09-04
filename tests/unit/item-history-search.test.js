'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
	decodeHistorySearchCursor,
	encodeHistorySearchCursor,
	isSaneMysqlHistoryConfig,
} = require('../../lib/item-history-search');
const {
	buildHistoryStateFormatter,
	consumeHistorySearchEntries,
	createHistorySearchScanState,
} = require('../../lib/widget-normalizer');
const { createOpenhabMapTransformer } = require('../../lib/openhab-map-transform');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

describe('Item history search', () => {
	it('only enables the capability for complete, sane MySQL settings', () => {
		assert.strictEqual(isSaneMysqlHistoryConfig({
			host: 'db-host',
			port: '3306',
			database: 'persistence',
			username: 'reader',
			password: '',
		}), true);
		assert.strictEqual(isSaneMysqlHistoryConfig({
			socket: '/run/mysqld/mysqld.sock',
			database: 'persistence',
			username: 'reader',
		}), true);
		assert.strictEqual(isSaneMysqlHistoryConfig({ host: 'db-host', username: 'reader' }), false);
		assert.strictEqual(isSaneMysqlHistoryConfig({ host: 'db-host', database: 'persistence' }), false);
		assert.strictEqual(isSaneMysqlHistoryConfig({ socket: 'relative.sock', database: 'persistence', username: 'reader' }), false);
		assert.strictEqual(isSaneMysqlHistoryConfig({ host: 'db internal', database: 'persistence', username: 'reader' }), false);
		assert.strictEqual(isSaneMysqlHistoryConfig({ host: 'db-host', port: '70000', database: 'persistence', username: 'reader' }), false);
	});

	it('round-trips opaque time/member cursors and rejects malformed input', () => {
		const encoded = encodeHistorySearchCursor('2026-09-04T10:11:12.345Z', 'Member_1');
		assert.match(encoded, /^[a-zA-Z0-9_-]+$/);
		assert.deepStrictEqual(decodeHistorySearchCursor(encoded), {
			time: '2026-09-04T10:11:12.345Z',
			member: 'Member_1',
		});
		assert.strictEqual(decodeHistorySearchCursor('not-a-cursor'), null);
		assert.strictEqual(encodeHistorySearchCursor('invalid', ''), null);
		assert.strictEqual(encodeHistorySearchCursor(new Date(), 'invalid-member'), null);
	});

	it('matches the final displayed state and deduplicates transformed runs', () => {
		const formatter = buildHistoryStateFormatter(
			{},
			[{ command: 'OVERRIDE', label: 'Manual choice' }],
			String
		);
		const scan = createHistorySearchScanState('friendly');
		consumeHistorySearchEntries(scan, [
			{ time: '2026-09-04T10:05:00.000Z', state: 'CODE_A', transformedState: 'Friendly state' },
			{ time: '2026-09-04T10:04:00.000Z', state: 'CODE_B', transformedState: 'Friendly state' },
			{ time: '2026-09-04T10:03:00.000Z', state: 'OFF', transformedState: 'Dormant' },
		], {
			formatEntry: entry => {
				const displayState = formatter(entry.state, entry.transformedState);
				return { displayState, renderedState: displayState };
			},
			done: true,
		});

		assert.strictEqual(scan.bufferedMatches.length, 1);
		assert.strictEqual(scan.bufferedMatches[0].displayState, 'Friendly state');
		assert.strictEqual(scan.bufferedMatches[0].state, 'CODE_B');
		assert.strictEqual(scan.bufferedMatches[0].time, '2026-09-04T10:04:00.000Z');

		const rawOnly = createHistorySearchScanState('code_a');
		consumeHistorySearchEntries(rawOnly, [
			{ time: '2026-09-04T10:05:00.000Z', state: 'CODE_A', transformedState: 'Friendly state' },
		], {
			formatEntry: entry => ({
				displayState: formatter(entry.state, entry.transformedState),
				renderedState: formatter(entry.state, entry.transformedState),
			}),
			done: true,
		});
		assert.deepStrictEqual(rawOnly.bufferedMatches, []);
		assert.strictEqual(formatter('OVERRIDE', 'Wrong transformed label'), 'Manual choice');
	});

	it('searches an openHAB MAP label instead of its persisted source value', () => {
		const transformer = createOpenhabMapTransformer();
		const pattern = 'MAP(|CLOSED=Inactive;OPEN=Active):%s';
		const transformedState = transformer.transform(pattern, 'CLOSED');
		const formatter = buildHistoryStateFormatter({ pattern }, [], String);
		const scan = createHistorySearchScanState('inactive');
		consumeHistorySearchEntries(scan, [
			{ time: '2026-09-04T10:00:00.000Z', state: 'CLOSED', transformedState },
		], {
			formatEntry: entry => ({
				displayState: formatter(entry.state, entry.transformedState),
				renderedState: formatter(entry.state, entry.transformedState),
			}),
			done: true,
		});

		assert.strictEqual(transformedState, 'Inactive');
		assert.strictEqual(scan.bufferedMatches.length, 1);
		assert.strictEqual(scan.bufferedMatches[0].displayState, 'Inactive');
	});

	it('tracks group-member transitions independently across database chunks', () => {
		const scan = createHistorySearchScanState('open');
		const options = {
			seriesKey: entry => entry.memberName,
			formatEntry: entry => ({
				displayState: entry.transformedState,
				renderedState: entry.member + ' \u00B7 ' + entry.transformedState,
			}),
		};
		consumeHistorySearchEntries(scan, [
			{ time: '2026-09-04T10:05:00.000Z', state: '1', transformedState: 'Open', memberName: 'A', member: 'Window' },
			{ time: '2026-09-04T10:04:00.000Z', state: '1', transformedState: 'Open', memberName: 'B', member: 'Door' },
		], options);
		consumeHistorySearchEntries(scan, [
			{ time: '2026-09-04T10:03:00.000Z', state: '0', transformedState: 'Closed', memberName: 'A', member: 'Window' },
			{ time: '2026-09-04T10:02:00.000Z', state: '0', transformedState: 'Closed', memberName: 'B', member: 'Door' },
		], { ...options, done: true });

		assert.deepStrictEqual(scan.bufferedMatches.map(entry => entry.renderedState), [
			'Window \u00B7 Open',
			'Door \u00B7 Open',
		]);
	});

	it('wires a gated, bounded and responsive search through the modal and server', () => {
		const server = fs.readFileSync(path.join(PROJECT_ROOT, 'server.js'), 'utf8');
		const app = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'app.js'), 'utf8');
		const styles = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'styles.css'), 'utf8');

		assert.match(server, /app\.get\('\/api\/card-config\/:itemName\/history-search', requireAdmin/);
		assert.match(server, /function isHistorySearchAvailable\(conn = getMysqlConnection\(\)\) \{\s*return !!conn && isSaneMysqlHistoryConfig\(MYSQL_CONFIG\);/);
		assert.match(server, /searchAvailable: isHistorySearchAvailable\(conn\)/);
		assert.doesNotMatch(server, /searchAvailable:[^\n]*(?:password|username|database|host|socket)/i);
		assert.match(app, /class="history-search-form"[\s\S]*?class="history-search-input"[\s\S]*?class="history-search-submit"/);
		assert.match(app, /const HISTORY_SEARCH_PAGE_SIZE = 3;/);
		assert.match(app, /const HISTORY_SEARCH_MAX_SAMPLES_PER_ACTION = 5000;/);
		assert.match(app, /consumeHistorySearchEntries\(historySearchScanState, data\.entries/);
		assert.match(app, /const status = entries\.length \? historySearchSummary\(entries\.length\) : '';/);
		assert.doesNotMatch(app, /historySearchThrough|historySearchSummary\(entries\.length, through\)/);
		assert.match(app, /event\.key !== 'Escape'[\s\S]*?event\.preventDefault\(\);\s*event\.stopPropagation\(\);[\s\S]*?clearHistorySearch\(\);/);
		assert.match(app, /const hasNav = navFrag\.childNodes\.length > 0;\s*nav\.innerHTML = '';\s*nav\.appendChild\(navFrag\);\s*nav\.style\.display = hasNav \? 'flex' : 'none';/);
		assert.match(styles, /@media \(max-width: 639px\), \(hover: none\), \(pointer: coarse\)[\s\S]*?\.history-search-input,[\s\S]*?height: 44px;/);
	});
});
