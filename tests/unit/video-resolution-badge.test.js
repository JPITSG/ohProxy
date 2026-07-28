'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');

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

function extractConstArray(source, name) {
	const start = source.indexOf(`const ${name} = [`);
	assert.ok(start >= 0, `${name} must exist`);
	const end = source.indexOf('];', start);
	assert.ok(end > start);
	return Function(`${source.slice(start, end + 2)} return ${name};`)();
}

const VIDEO_RESOLUTION_RUNGS = extractConstArray(app, 'VIDEO_RESOLUTION_RUNGS');
const videoResolutionLabel = Function(
	'VIDEO_RESOLUTION_RUNGS',
	`return (${extractFunction(app, 'videoResolutionLabel')});`
)(VIDEO_RESOLUTION_RUNGS);

describe('Video resolution label', () => {
	it('covers the standard ladder from 144p to 8K', () => {
		assert.deepStrictEqual(VIDEO_RESOLUTION_RUNGS.map(([, label]) => label),
			['144p', '240p', '360p', '480p', '720p', '1080p', '1440p', '4K', '5K', '8K']);
		assert.deepStrictEqual(VIDEO_RESOLUTION_RUNGS.map(([lines]) => lines),
			[144, 240, 360, 480, 720, 1080, 1440, 2160, 2880, 4320]);
	});

	it('labels exact standard resolutions', () => {
		assert.strictEqual(videoResolutionLabel(426, 240), '240p');
		assert.strictEqual(videoResolutionLabel(640, 360), '360p');
		assert.strictEqual(videoResolutionLabel(854, 480), '480p');
		assert.strictEqual(videoResolutionLabel(640, 480), '480p');
		assert.strictEqual(videoResolutionLabel(1280, 720), '720p');
		assert.strictEqual(videoResolutionLabel(1920, 1080), '1080p');
		assert.strictEqual(videoResolutionLabel(2560, 1440), '1440p');
		assert.strictEqual(videoResolutionLabel(3840, 2160), '4K');
		assert.strictEqual(videoResolutionLabel(5120, 2880), '5K');
		assert.strictEqual(videoResolutionLabel(7680, 4320), '8K');
	});

	it('snaps off-ladder resolutions to the nearest rung, up or down', () => {
		// 4:3 security-camera formats
		assert.strictEqual(videoResolutionLabel(704, 480), '480p');   // D1
		assert.strictEqual(videoResolutionLabel(1280, 960), '1080p'); // 1.3MP, 960 sits nearer 1080 than 720
		assert.strictEqual(videoResolutionLabel(2304, 1296), '1440p'); // 3MP
		assert.strictEqual(videoResolutionLabel(2688, 1520), '1440p'); // 4MP
		assert.strictEqual(videoResolutionLabel(2592, 1944), '4K');   // 5MP, 1944 lines sit nearer 2160
		// nearest is decided on the log scale (relative distance, not absolute)
		assert.strictEqual(videoResolutionLabel(1568, 880), '720p');
		assert.strictEqual(videoResolutionLabel(1600, 900), '1080p');
		// ends of the ladder clamp
		assert.strictEqual(videoResolutionLabel(160, 120), '144p');
		assert.strictEqual(videoResolutionLabel(15360, 8640), '8K');
	});

	it('uses the smaller dimension so orientation does not change the label', () => {
		assert.strictEqual(videoResolutionLabel(1080, 1920), '1080p'); // portrait
		assert.strictEqual(videoResolutionLabel(3440, 1440), '1440p'); // ultrawide
		assert.strictEqual(videoResolutionLabel(2160, 3840), '4K');
	});

	it('returns no label until dimensions are known', () => {
		assert.strictEqual(videoResolutionLabel(0, 0), '');
		assert.strictEqual(videoResolutionLabel(undefined, undefined), '');
		assert.strictEqual(videoResolutionLabel(1920, 0), '');
	});
});

describe('Video resolution badge wiring', () => {
	it('renders the chip inside the badge row, to the left of the clock', () => {
		// DOM order within the flex row decides the visual order: resolution
		// chip first, clock last (hugging the corner)
		const row = app.indexOf("streamBadges.className = 'video-stream-badges';");
		const chip = app.indexOf("resolutionBadge.className = 'video-resolution hidden';");
		const clock = app.indexOf("streamClock.className = 'video-clock hidden';");
		assert.ok(row > -1 && chip > row && clock > chip);
		assert.match(app, /resolutionBadge = document\.createElement\('div'\);\s*resolutionBadge\.className = 'video-resolution hidden';\s*streamBadges\.appendChild\(resolutionBadge\);/);
		assert.match(app, /streamClock = document\.createElement\('div'\);\s*streamClock\.className = 'video-clock hidden';\s*streamBadges\.appendChild\(streamClock\);/);
	});

	it('shares the clock chip box style and hides alongside it', () => {
		assert.match(styles, /\.video-clock,\n\.video-resolution \{/);
		assert.match(styles, /\.video-clock\.hidden,\n\.video-resolution\.hidden \{\s*display: none;\s*\}/);
		// stall/DVR alert backgrounds stay clock-only: the resolution chip is
		// not a liveness indicator
		assert.doesNotMatch(styles, /\.video-resolution\.stalled/);
		assert.doesNotMatch(styles, /\.video-resolution\.dvr-shifted/);
	});
});
