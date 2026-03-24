'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('video theme switch stability', () => {
	it('keeps video proxy URLs theme-stable and avoids tearing down active video cards on rerender', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');

		assert.match(
			app,
			/const videoUrl = rawVideoUrl \? `\/proxy\?url=\$\{encodeURIComponent\(rawVideoUrl\)\}\$\{encodingParam\}` : '';/,
		);
		assert.doesNotMatch(app, /&mode=\$\{themeMode\}\$\{encodingParam\}/);
		assert.match(
			app,
			/const existingVideo = card\.querySelector\('video\.video-stream'\);\s*if \(!isVideo && existingVideo && existingVideo\.src\) \{/s,
		);
	});
});
