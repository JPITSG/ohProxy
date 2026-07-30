'use strict';

const zlib = require('node:zlib');
const { bytesToHeader, zxyToTileId, findTile, readVarint } = require('pmtiles');

// Bulk tile fetcher for the primer. Per-tile getZxy() costs one HTTP range
// request per tile, and range reads against the huge planet archive carry
// multi-second time-to-first-byte - priming tens of thousands of tiles that
// way takes weeks. PMTiles clusters tiles in Hilbert order, so tiles wanted
// together sit near each other in the file: resolving directory entries first
// and coalescing adjacent tile ranges into large reads amortizes the latency
// across hundreds of tiles per request.

const HEADER_PROBE_BYTES = 16384;
const DEFAULT_MAX_RANGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_GAP_BYTES = 512 * 1024;

// PMTiles v3 directory: entry count, then tileId deltas, run lengths, byte
// lengths, and offsets (0 = contiguous with the previous entry).
function deserializeDirectory(buffer) {
	const p = { buf: new Uint8Array(buffer), pos: 0 };
	const numEntries = readVarint(p);
	const entries = [];
	let lastId = 0;
	for (let i = 0; i < numEntries; i++) {
		lastId += readVarint(p);
		entries.push({ tileId: lastId, offset: 0, length: 0, runLength: 1 });
	}
	for (let i = 0; i < numEntries; i++) entries[i].runLength = readVarint(p);
	for (let i = 0; i < numEntries; i++) entries[i].length = readVarint(p);
	for (let i = 0; i < numEntries; i++) {
		const value = readVarint(p);
		entries[i].offset = value === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : value - 1;
	}
	return entries;
}

// Groups sorted unique tile entries into read ranges, merging entries whose
// gap is small enough and capping the total range size.
function coalesceEntries(entries, maxGapBytes = DEFAULT_MAX_GAP_BYTES, maxRangeBytes = DEFAULT_MAX_RANGE_BYTES) {
	const sorted = [...entries].sort((a, b) => a.offset - b.offset);
	const ranges = [];
	let current = null;
	for (const entry of sorted) {
		const end = entry.offset + entry.length;
		if (current
			&& entry.offset - current.end <= maxGapBytes
			&& end - current.start <= maxRangeBytes) {
			current.end = Math.max(current.end, end);
			current.entries.push(entry);
		} else {
			current = { start: entry.offset, end, entries: [entry] };
			ranges.push(current);
		}
	}
	return ranges;
}

function createBulkTileFetcher(options) {
	const opts = options || {};
	const sourceUrl = opts.sourceUrl;
	const log = typeof opts.log === 'function' ? opts.log : () => {};
	const maxGapBytes = Number(opts.maxGapBytes) || DEFAULT_MAX_GAP_BYTES;
	const maxRangeBytes = Number(opts.maxRangeBytes) || DEFAULT_MAX_RANGE_BYTES;

	const fetchRange = opts.fetchRange || (async (offset, length) => {
		let lastError = null;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const response = await fetch(sourceUrl, {
					headers: { Range: `bytes=${offset}-${offset + length - 1}` },
				});
				if (response.status !== 206 && response.status !== 200) {
					throw new Error(`HTTP ${response.status}`);
				}
				return Buffer.from(await response.arrayBuffer());
			} catch (err) {
				lastError = err;
			}
		}
		throw lastError;
	});
	if (!sourceUrl && !opts.fetchRange) throw new Error('createBulkTileFetcher requires sourceUrl or fetchRange');

	let header = null;
	let rootEntries = null;
	const leafCache = new Map();

	function decompressDirectory(buffer) {
		return header.internalCompression === 2 ? zlib.gunzipSync(buffer) : buffer;
	}

	function decompressTile(buffer) {
		return header.tileCompression === 2 ? zlib.gunzipSync(buffer) : Buffer.from(buffer);
	}

	async function init() {
		if (header) return;
		const probe = await fetchRange(0, HEADER_PROBE_BYTES);
		// bytesToHeader constructs a DataView, so it needs a plain ArrayBuffer.
		const headerBytes = probe.subarray(0, 127);
		header = bytesToHeader(headerBytes.buffer.slice(headerBytes.byteOffset, headerBytes.byteOffset + headerBytes.byteLength));
		const rootEnd = header.rootDirectoryOffset + header.rootDirectoryLength;
		const rootBytes = rootEnd <= probe.length
			? probe.subarray(header.rootDirectoryOffset, rootEnd)
			: await fetchRange(header.rootDirectoryOffset, header.rootDirectoryLength);
		rootEntries = deserializeDirectory(decompressDirectory(rootBytes));
	}

	async function leafEntriesAt(offset, length) {
		if (!leafCache.has(offset)) {
			leafCache.set(offset, (async () => {
				const bytes = await fetchRange(header.leafDirectoryOffset + offset, length);
				return deserializeDirectory(decompressDirectory(bytes));
			})());
		}
		return leafCache.get(offset);
	}

	async function entryFor(tileId) {
		const rootHit = findTile(rootEntries, tileId);
		if (!rootHit) return null;
		if (rootHit.runLength > 0) return rootHit;
		const leaves = await leafEntriesAt(rootHit.offset, rootHit.length);
		const leafHit = findTile(leaves, tileId);
		return leafHit && leafHit.runLength > 0 ? leafHit : null;
	}

	// tiles: [{z,x,y}] -> Map('z/x/y' -> Buffer | null). null = no data in the
	// archive for that tile.
	async function fetchBatch(tiles) {
		await init();
		const results = new Map();
		const byOffset = new Map();
		for (const tile of tiles) {
			const key = `${tile.z}/${tile.x}/${tile.y}`;
			const entry = await entryFor(zxyToTileId(tile.z, tile.x, tile.y));
			if (!entry) {
				results.set(key, null);
				continue;
			}
			if (!byOffset.has(entry.offset)) byOffset.set(entry.offset, { entry, keys: [] });
			byOffset.get(entry.offset).keys.push(key);
		}

		const wanted = [...byOffset.values()].map((item) => ({ ...item.entry, keys: item.keys }));
		const ranges = coalesceEntries(wanted, maxGapBytes, maxRangeBytes);
		for (const range of ranges) {
			let block;
			try {
				block = await fetchRange(header.tileDataOffset + range.start, range.end - range.start);
			} catch (err) {
				log(`[MvtBulk] Range read ${range.start}-${range.end} failed: ${err.message || err}`);
				continue;
			}
			for (const entry of range.entries) {
				try {
					const raw = block.subarray(entry.offset - range.start, entry.offset - range.start + entry.length);
					const body = decompressTile(raw);
					for (const key of entry.keys) results.set(key, body);
				} catch (err) {
					log(`[MvtBulk] Tile decode at offset ${entry.offset} failed: ${err.message || err}`);
				}
			}
		}
		return results;
	}

	function stats() {
		return { rangesCached: leafCache.size, headerLoaded: !!header };
	}

	return { init, fetchBatch, stats };
}

module.exports = {
	deserializeDirectory,
	coalesceEntries,
	createBulkTileFetcher,
};
