'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('video active stream heartbeat logging', () => {
	it('includes stream URL, client, IP, and age in the periodic summary log', () => {
		const projectRoot = path.join(__dirname, '..', '..');
		const serverFile = path.join(projectRoot, 'server.js');
		const source = fs.readFileSync(serverFile, 'utf8');
		assert.match(source, /function formatActiveVideoStreamLog\(now = Date\.now\(\)\) \{/);
		assert.match(source, /details\.push\(`#\$\{id\} \$\{encoding\} url=\$\{url\} client=\$\{client\} ip=\$\{ip\} age=\$\{elapsedSec\}s`\);/);
		assert.match(source, /const activeStreamLog = formatActiveVideoStreamLog\(\);/);
		assert.match(source, /if \(activeStreamLog\) logMessage\(activeStreamLog\);/);
	});
});
