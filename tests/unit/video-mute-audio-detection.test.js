'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');

describe('video mute audio detection', () => {
	it('defines mute button state helpers and disabled styling for pending audio detection', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		const styles = fs.readFileSync(STYLES_FILE, 'utf8');

		assert.match(app, /function getVideoControlContainer\(videoEl\) \{/);
		assert.match(app, /function getVideoMuteButton\(videoEl\) \{/);
		assert.match(app, /function setVideoMuteButtonState\(videoEl, state\) \{/);
		assert.match(app, /function getVideoFullscreenButton\(videoEl\) \{/);
		assert.match(app, /function setVideoFullscreenButtonState\(videoEl, state\) \{/);
		assert.match(app, /muteBtn\.dataset\.audioState = state;/);
		assert.match(app, /if \(state === 'enabled'\) \{\s*muteBtn\.disabled = false;\s*muteBtn\.style\.opacity = '1';\s*muteBtn\.style\.pointerEvents = 'auto';\s*return;\s*\}\s*muteBtn\.disabled = true;\s*muteBtn\.style\.opacity = '';\s*muteBtn\.style\.pointerEvents = '';/s);
		assert.match(app, /if \(state === 'enabled'\) \{\s*fsBtn\.disabled = false;\s*fsBtn\.style\.opacity = '1';\s*fsBtn\.style\.pointerEvents = 'auto';\s*return;\s*\}\s*fsBtn\.disabled = true;\s*fsBtn\.style\.opacity = '';\s*fsBtn\.style\.pointerEvents = '';/s);
		assert.match(app, /function resetVideoAudioTrackProbe\(videoEl\) \{\s*if \(!videoEl\) return;\s*videoEl\.__audioTrackResolved = false;\s*videoEl\.__hasAudioTrack = null;\s*setVideoMuteButtonState\(videoEl, 'pending'\);\s*\}/s);
		assert.match(app, /function resetVideoControlButtonStates\(videoEl\) \{\s*resetVideoAudioTrackProbe\(videoEl\);\s*setVideoFullscreenButtonState\(videoEl, 'pending'\);\s*\}/s);
		assert.match(styles, /\.video-mute-btn:disabled \{\s*opacity: \.4;\s*cursor: default;\s*pointer-events: none;\s*\}/s);
		assert.match(styles, /\.video-mute-btn\[data-audio-state="hidden"\] \{\s*opacity: 0;\s*\}/s);
		assert.match(styles, /\.video-fullscreen-btn:disabled \{\s*opacity: \.4;\s*cursor: default;\s*pointer-events: none;\s*\}/s);
	});

	it('shows the current mute state in the icon while keeping the action label on the button', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');

		assert.match(app, /muteBtn\.innerHTML = '<img src="icons\/video-mute\.svg" alt="" aria-hidden="true" \/>';/);
		assert.match(app, /const actionLabel = isMuted \? 'Unmute' : 'Mute';/);
		assert.match(app, /muteBtn\.innerHTML = isMuted\s*\?\s*'<img src="icons\/video-mute\.svg" alt="" aria-hidden="true" \/>'\s*:\s*'<img src="icons\/video-unmute\.svg" alt="" aria-hidden="true" \/>';/s);
		assert.match(app, /muteBtn\.title = actionLabel;/);
		assert.match(app, /muteBtn\.setAttribute\('aria-label', actionLabel\);/);
	});

	it('probes audio tracks and only resolves mute visibility when audio presence is definitive', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');

		assert.match(app, /function detectVideoHasAudio\(videoEl, \{ allowCaptureStream = false \} = \{\}\) \{/);
		assert.match(app, /const audioTracks = videoEl\.audioTracks;/);
		assert.match(app, /if \(audioTracks && typeof audioTracks\.length === 'number'\) \{\s*return audioTracks\.length > 0;\s*\}/s);
		assert.match(app, /if \(typeof videoEl\.mozHasAudio === 'boolean'\) \{\s*return videoEl\.mozHasAudio;\s*\}/s);
		assert.match(app, /const captureStream = videoEl\.captureStream \|\| videoEl\.mozCaptureStream;/);
		assert.match(app, /const audioTrackCount = capturedStream\.getAudioTracks\(\)\.length;/);
		assert.match(app, /if \(audioTrackCount > 0\) return true;/);
		assert.match(app, /if \(totalTrackCount > 0\) return false;/);
		assert.match(app, /for \(const track of capturedStream\.getTracks\(\)\) \{\s*try \{ track\.stop\(\); \} catch \{\}\s*\}/s);
		assert.match(app, /if \(typeof videoEl\.webkitAudioDecodedByteCount === 'number' && videoEl\.webkitAudioDecodedByteCount > 0\) \{\s*return true;\s*\}/s);
		assert.match(app, /function syncVideoMuteButtonForAudioTrack\(videoEl, options\) \{\s*if \(!videoEl \|\| videoEl\.__audioTrackResolved\) return videoEl\?\.__hasAudioTrack \?\? null;\s*const hasAudioTrack = detectVideoHasAudio\(videoEl, options\);\s*if \(hasAudioTrack === null\) \{\s*setVideoMuteButtonState\(videoEl, 'pending'\);\s*return null;\s*\}\s*videoEl\.__audioTrackResolved = true;\s*videoEl\.__hasAudioTrack = hasAudioTrack;\s*setVideoMuteButtonState\(videoEl, hasAudioTrack \? 'enabled' : 'hidden'\);\s*return hasAudioTrack;\s*\}/s);
	});

	it('resets to pending on reload paths and resolves on metadata and playback events', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');

		assert.match(app, /videoEl\.__videoContainer = videoContainer;/);
		assert.match(app, /updateMuteBtn\(\);\s*resetVideoControlButtonStates\(videoEl\);/s);
		assert.match(app, /videoContainer\.appendChild\(fsBtn\);\s*setVideoFullscreenButtonState\(videoEl, 'pending'\);/s);
		assert.match(app, /videoEl\.addEventListener\('loadedmetadata', \(\) => \{\s*updateMuteBtn\(\);\s*syncVideoMuteButtonForAudioTrack\(videoEl\);\s*\}\);/s);
		assert.match(app, /videoEl\.addEventListener\('playing', \(\) => \{\s*setVideoZoomReady\(videoEl, true\);\s*updateMuteBtn\(\);\s*syncVideoMuteButtonForAudioTrack\(videoEl, \{ allowCaptureStream: true \}\);\s*\}\);/s);
		assert.match(app, /videoEl\.addEventListener\('playing', \(\) => \{\s*setVideoZoomReady\(videoEl, true\);\s*setVideoFullscreenButtonState\(videoEl, 'enabled'\);\s*\}\);/s);
		assert.match(app, /function restartVideoStream\(videoEl\) \{\s*resetVideoControlButtonStates\(videoEl\);/s);
		assert.match(app, /function pauseVideoStreamsForVisibility\(\) \{[\s\S]*resetVideoControlButtonStates\(video\);/s);
		assert.match(app, /function resumeVideoStreamsFromVisibility\(\) \{[\s\S]*resetVideoControlButtonStates\(video\);/s);
		assert.match(app, /if \(videoEl\.dataset\.baseUrl !== videoUrl\) \{\s*videoEl\.dataset\.baseUrl = videoUrl;\s*resetVideoControlButtonStates\(videoEl\);/s);
	});
});
