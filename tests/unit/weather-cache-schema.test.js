'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Weather Cache Schema', () => {
	it('rejects legacy forecast-only cache payloads in /weather', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.doesNotMatch(server, /weatherData\.forecast \|\| weatherData/);
		assert.match(
			server,
			/if \(!forecast \|\| typeof forecast !== 'object' \|\| Array\.isArray\(forecast\)\) \{\s*sendStyledError\(res, req, 503, 'Weather data not available'\);\s*return;\s*\}/s
		);
	});

	it('writes structured forecast cache payloads', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /const combined = \{ forecast, current, currentDescription \};/);
	});
});
