'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
	applyOpenhabMap,
	createOpenhabMapTransformer,
	formatMapSource,
	parseInlineOpenhabMap,
	parseMapStatePattern,
	parseOpenhabMap,
} = require('../../lib/openhab-map-transform');

const tempDirs = [];

function makeTempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohproxy-map-transform-'));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('openHAB MAP history transformations', () => {
	it('parses generic map entries, escapes, continuations, and defaults', () => {
		const mappings = parseOpenhabMap([
			'# display labels',
			'READY=Available',
			'WAITING=Please\\ wait',
			'LONG=First\\',
			'  Second',
			'UNICODE=Active\\u0020now',
			'=_source_',
		].join('\n'));

		assert.strictEqual(applyOpenhabMap(mappings, 'READY'), 'Available');
		assert.strictEqual(applyOpenhabMap(mappings, 'WAITING'), 'Please wait');
		assert.strictEqual(applyOpenhabMap(mappings, 'LONG'), 'FirstSecond');
		assert.strictEqual(applyOpenhabMap(mappings, 'UNICODE'), 'Active now');
		assert.strictEqual(applyOpenhabMap(mappings, 'UNKNOWN'), 'UNKNOWN');
	});

	it('supports file-based maps without hard-coding state names', () => {
		const transformDir = makeTempDir();
		fs.writeFileSync(path.join(transformDir, 'status.map'), 'READY=Available\nWAITING=Standby\n=Unknown\n');
		const transformer = createOpenhabMapTransformer({ transformDir });

		assert.strictEqual(transformer.transform('MAP(status.map):%s', 'READY'), 'Available');
		assert.strictEqual(transformer.transform('map(status.map):%s', 'WAITING'), 'Standby');
		assert.strictEqual(transformer.transform('MAP(status.map):%s', 'OTHER'), 'Unknown');
	});

	it('supports inline maps and custom delimiters', () => {
		const regular = parseInlineOpenhabMap('|ready=Available;waiting=Standby');
		const custom = parseInlineOpenhabMap('|?delimiter=##ready=Available##waiting=Standby');

		assert.strictEqual(applyOpenhabMap(regular, 'waiting'), 'Standby');
		assert.strictEqual(applyOpenhabMap(custom, 'ready'), 'Available');
		const transformer = createOpenhabMapTransformer({ transformDir: makeTempDir() });
		assert.strictEqual(transformer.transform('MAP(|ready=Available;waiting=Standby):%s', 'ready'), 'Available');
	});

	it('formats the raw state before looking it up', () => {
		assert.strictEqual(formatMapSource('5.24', '%.1f'), '5.2');
		assert.deepStrictEqual(parseMapStatePattern('MAP(level.map):%.1f'), {
			config: 'level.map',
			sourceFormat: '%.1f',
		});
	});

	it('rejects traversal and symlink escapes outside the transform directory', () => {
		const parent = makeTempDir();
		const transformDir = path.join(parent, 'transform');
		fs.mkdirSync(transformDir);
		fs.writeFileSync(path.join(parent, 'outside.map'), 'READY=Leaked\n');
		fs.symlinkSync(path.join(parent, 'outside.map'), path.join(transformDir, 'linked.map'));
		const transformer = createOpenhabMapTransformer({ transformDir });

		assert.strictEqual(transformer.transform('MAP(../outside.map):%s', 'READY'), null);
		assert.strictEqual(transformer.transform('MAP(linked.map):%s', 'READY'), null);
		assert.strictEqual(transformer.transform('MAP(/tmp/outside.map):%s', 'READY'), null);
	});
});
