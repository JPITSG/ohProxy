'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');

describe('Voice Recording Cue Sounds', () => {
	it('synthesizes rising start and falling stop blips lazily via Web Audio', () => {
		assert.match(app, /function playVoiceCue\(kind\) \{/);
		assert.match(app, /if \(!voiceCueCtx\) voiceCueCtx = new AudioCtx\(\);/);
		assert.match(app, /kind === 'start' \? \[660, 880\] : \[880, 660\]/);
	});

	it('plays the start cue when either recording mode begins listening', () => {
		// Vosk: after getUserMedia resolves; browser: when recognition starts
		assert.equal((app.match(/els\.voice\.classList\.add\('listening'\);\s*playVoiceCue\('start'\);/g) || []).length, 2);
	});

	it('plays the stop cue exactly once per session on every end path', () => {
		// Vosk second click / silence auto-stop
		assert.match(app, /els\.voice\.classList\.remove\('listening'\);\s*playVoiceCue\('stop'\);/);
		// Browser transcript captured (guarded: vosk already stopped earlier)
		assert.match(app, /async function sendVoiceCommand\(transcript\) \{\s*\/\/[^\n]*\n\s*if \(isListening\) playVoiceCue\('stop'\);/);
		// Cancel / error reset
		assert.match(app, /function resetVoiceState\(\) \{\s*if \(isListening\) playVoiceCue\('stop'\);/);
		// Recognition ended without a result
		assert.match(app, /recognition\.onend = function\(\) \{\s*if \(!isProcessing\) \{\s*if \(isListening\) playVoiceCue\('stop'\);/);
	});
});
