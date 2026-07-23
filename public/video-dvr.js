'use strict';

/*
 * OhVideoDvr - in-browser timeshift (DVR) buffer for live video widgets.
 *
 * The server pipes an endless fragmented-MP4 stream (H.264 + optional AAC).
 * Assigning that URL straight to <video>.src plays live-only: the element
 * treats it as an unbounded resource and keeps no seekable history. Instead,
 * this module fetches the same stream and appends it into a MediaSource
 * SourceBuffer, which retains a rolling window of the last N seconds in
 * memory. video.buffered then spans that window, plain currentTime seeks
 * scrub inside it, and a slim overlay bar exposes pause / scrub / LIVE.
 *
 * Everything lives in tab memory (SourceBuffer quota) - nothing is persisted.
 * On any incompatibility (no MSE, non-fMP4 payload, unsupported codecs) the
 * caller-provided onFallback restores the legacy direct <video>.src path.
 */
(function () {

	/* DVR_PURE_HELPERS_START */
	// Tunables shared by the pure helpers and the engine.
	const DVR_MIN_WINDOW_S = 30;         // hard floor for the rolling window
	const DVR_EVICT_SLACK_S = 20;        // window overshoot tolerated before trimming
	const DVR_EVICT_MIN_CHUNK_S = 10;    // never trim slivers (append/remove churn)
	const DVR_KEEP_BEHIND_PLAYHEAD_S = 5; // trimming never crosses the playhead

	function readMp4BoxHeader(bytes, offset) {
		if (!bytes || offset + 8 > bytes.length) return null;
		let size = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
		const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
		let headerSize = 8;
		if (size === 1) {
			// 64-bit largesize; the high dword must be 0 for anything we handle
			if (offset + 16 > bytes.length) return null;
			const hi = ((bytes[offset + 8] << 24) | (bytes[offset + 9] << 16) | (bytes[offset + 10] << 8) | bytes[offset + 11]) >>> 0;
			if (hi !== 0) return null;
			size = ((bytes[offset + 12] << 24) | (bytes[offset + 13] << 16) | (bytes[offset + 14] << 8) | bytes[offset + 15]) >>> 0;
			headerSize = 16;
		} else if (size === 0) {
			size = bytes.length - offset;
		}
		if (size < headerSize) return null;
		return { size, type, headerSize };
	}

	// Length in bytes of the complete init segment (through the end of moov).
	// 0 = need more data, -1 = payload is not a fragmented MP4 stream.
	function findInitSegmentLength(bytes) {
		const initTypes = { ftyp: 1, styp: 1, free: 1, skip: 1, sidx: 1, moov: 1 };
		let offset = 0;
		let first = true;
		while (offset < (bytes ? bytes.length : 0)) {
			const box = readMp4BoxHeader(bytes, offset);
			if (!box) return first ? (bytes.length >= 8 ? -1 : 0) : 0;
			if (!initTypes[box.type]) return first ? -1 : 0;
			first = false;
			if (offset + box.size > bytes.length) return 0;
			offset += box.size;
			if (box.type === 'moov') return offset;
		}
		return 0;
	}

	function findMp4ChildBox(bytes, start, end, type) {
		let offset = start;
		while (offset + 8 <= end) {
			const box = readMp4BoxHeader(bytes, offset);
			if (!box || offset + box.size > end) return null;
			if (box.type === type) {
				return { body: offset + box.headerSize, end: offset + box.size };
			}
			offset += box.size;
		}
		return null;
	}

	function mp4HexByte(value) {
		const hex = value.toString(16);
		return hex.length < 2 ? '0' + hex : hex;
	}

	// Derives the mp4a.40.x suffix from an esds box (defaults to AAC-LC).
	function esdsAudioCodec(bytes, esds) {
		if (!esds) return 'mp4a.40.2';
		let offset = esds.body + 4; // skip FullBox version+flags
		const readDescriptor = () => {
			if (offset + 2 > esds.end) return null;
			const tag = bytes[offset]; offset += 1;
			let size = 0;
			for (let i = 0; i < 4 && offset < esds.end; i += 1) {
				const b = bytes[offset]; offset += 1;
				size = (size << 7) | (b & 0x7f);
				if (!(b & 0x80)) break;
			}
			return { tag, size, body: offset };
		};
		const es = readDescriptor();
		if (!es || es.tag !== 0x03) return 'mp4a.40.2';
		offset = es.body + 2; // ES_ID
		const flags = bytes[offset]; offset += 1;
		if (flags & 0x80) offset += 2;
		if (flags & 0x40) offset += 1 + bytes[offset];
		if (flags & 0x20) offset += 2;
		const dec = readDescriptor();
		if (!dec || dec.tag !== 0x04) return 'mp4a.40.2';
		const oti = bytes[dec.body];
		if (oti !== 0x40) return 'mp4a.40.2';
		offset = dec.body + 13; // objectTypeIndication + streamType/bufferSize + bitrates
		const dsi = readDescriptor();
		if (!dsi || dsi.tag !== 0x05 || dsi.body >= esds.end) return 'mp4a.40.2';
		const aot = bytes[dsi.body] >> 3;
		return (aot > 0 && aot < 31) ? ('mp4a.40.' + aot) : 'mp4a.40.2';
	}

	// Walks a complete init segment and returns RFC 6381 codec strings for
	// every recognised track (e.g. ['avc1.64001f', 'mp4a.40.2']).
	function extractFmp4Codecs(bytes) {
		const codecs = [];
		const containers = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1 };
		const walk = (start, end) => {
			let offset = start;
			while (offset + 8 <= end) {
				const box = readMp4BoxHeader(bytes, offset);
				if (!box || box.size < box.headerSize || offset + box.size > end) return;
				const body = offset + box.headerSize;
				if (containers[box.type]) {
					walk(body, offset + box.size);
				} else if (box.type === 'stsd') {
					walk(body + 8, offset + box.size); // FullBox header + entry_count
				} else if (box.type === 'avc1' || box.type === 'avc3') {
					// VisualSampleEntry carries 78 bytes of fields before children
					const avcc = findMp4ChildBox(bytes, body + 78, offset + box.size, 'avcC');
					if (avcc && avcc.body + 4 <= avcc.end) {
						codecs.push('avc1.' + mp4HexByte(bytes[avcc.body + 1]) + mp4HexByte(bytes[avcc.body + 2]) + mp4HexByte(bytes[avcc.body + 3]));
					} else {
						codecs.push('avc1.42E01E');
					}
				} else if (box.type === 'mp4a') {
					// AudioSampleEntry carries 28 bytes of fields before children
					codecs.push(esdsAudioCodec(bytes, findMp4ChildBox(bytes, body + 28, offset + box.size, 'esds')));
				}
				offset += box.size;
			}
		};
		walk(0, bytes ? bytes.length : 0);
		return codecs;
	}

	// Where to trim the rolling window to, or null when no trim is due.
	function computeDvrEvictionCutoff(bufStart, bufEnd, currentTime, windowSeconds) {
		if (!isFinite(bufStart) || !isFinite(bufEnd) || bufEnd <= bufStart) return null;
		const windowS = Math.max(DVR_MIN_WINDOW_S, windowSeconds || 0);
		if (bufEnd - bufStart <= windowS + DVR_EVICT_SLACK_S) return null;
		const playhead = isFinite(currentTime) ? currentTime : bufEnd;
		const cutoff = Math.min(bufEnd - windowS, playhead - DVR_KEEP_BEHIND_PLAYHEAD_S);
		if (cutoff - bufStart < DVR_EVICT_MIN_CHUNK_S) return null;
		return cutoff;
	}

	// Maps a media-timeline position to wall-clock time. Each (re)connection
	// appends an epoch {media, wall}; the latest epoch at/before mediaTime wins.
	function wallTimeFromEpochs(epochs, mediaTime) {
		if (!Array.isArray(epochs) || !epochs.length || !isFinite(mediaTime)) return null;
		let best = null;
		for (const epoch of epochs) {
			if (!epoch || !isFinite(epoch.media) || !isFinite(epoch.wall)) continue;
			if (epoch.media <= mediaTime + 0.25 && (!best || epoch.media >= best.media)) best = epoch;
		}
		if (!best) best = epochs[0];
		if (!best || !isFinite(best.media) || !isFinite(best.wall)) return null;
		return new Date(best.wall + Math.max(0, mediaTime - best.media) * 1000);
	}
	/* DVR_PURE_HELPERS_END */

	const DEFAULT_WINDOW_S = 300;
	const LIVE_EDGE_OFFSET_S = 1.2;      // where "go to live" lands behind the newest data
	const LIVE_LATENCY_SHIFT_S = 4;      // closer than this to the edge counts as "live"
	const FOLLOW_LIVE_MAX_DRIFT_S = 8;   // auto-resync threshold while following live
	const PREROLL_MAX_BYTES = 1024 * 1024;
	const PREROLL_TIMEOUT_MS = 10000;
	const SOURCEOPEN_TIMEOUT_MS = 8000;
	const RETRY_BASE_MS = 1000;
	const RETRY_MAX_MS = 8000;
	const DRAG_SEEK_THROTTLE_MS = 150;   // min gap between live seeks while dragging
	const DVR_UNLOCK_WINDOW_S = 5;       // bar shows immediately but stays inert until this much history exists
	const MAX_QUEUE_BYTES = 24 * 1024 * 1024;
	const MAX_FAILURES_PER_URL = 2;      // then stick to the legacy path this session
	const MAX_RESTARTS_BEFORE_PLAY = 3;

	const PLAY_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.4v11.2c0 .5.55.8.97.53l8.4-5.6a.64.64 0 0 0 0-1.06l-8.4-5.6a.64.64 0 0 0-.97.53z"/></svg>';
	const PAUSE_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.4" y="2.2" width="3.4" height="11.6" rx="1"/><rect x="9.2" y="2.2" width="3.4" height="11.6" rx="1"/></svg>';

	const dvrFailureCounts = new Map();

	function mseConstructor() {
		return window.MediaSource || window.ManagedMediaSource || null;
	}

	function isSupported() {
		const Ctor = mseConstructor();
		return !!(Ctor && typeof Ctor.isTypeSupported === 'function'
			&& window.fetch && window.ReadableStream && window.AbortController
			&& window.URL && typeof URL.createObjectURL === 'function');
	}

	function concatBytes(a, b) {
		const bb = b instanceof Uint8Array ? b : new Uint8Array(b);
		if (!a || !a.length) return bb;
		const out = new Uint8Array(a.length + bb.length);
		out.set(a, 0);
		out.set(bb, a.length);
		return out;
	}

	function formatOffset(seconds) {
		const total = Math.max(0, Math.round(seconds));
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const s = total % 60;
		const pad = (v) => (v < 10 ? '0' : '') + v;
		return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
	}

	function defaultClockFormat(date) {
		const pad = (v) => (v < 10 ? '0' : '') + v;
		return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	}

	function haptic() {
		if (typeof window.haptic === 'function') {
			try { window.haptic(); } catch (_) {}
		}
	}

	function createDvrSession(videoEl, videoContainer, url, opts) {
		const options = opts && typeof opts === 'object' ? opts : {};
		const formatClock = typeof options.formatClock === 'function' ? options.formatClock : defaultClockFormat;
		const onFallback = typeof options.onFallback === 'function' ? options.onFallback : null;

		const session = {
			active: false,
			destroyed: false,
			suspended: false,
			userPaused: false,
			followLive: true,
		};

		let windowSeconds = Math.max(DVR_MIN_WINDOW_S, Number(options.windowSeconds) || DEFAULT_WINDOW_S);
		let mediaSource = null;
		let sourceBuffer = null;
		let usingMms = false;
		let objectUrl = '';
		let abortCtrl = null;
		let retryTimer = null;
		let retryDelayMs = RETRY_BASE_MS;
		let queue = [];
		let queuedBytes = 0;
		let epochs = [];
		let hadFirstInit = false;
		let durationFixed = false;
		let everPlayed = false;
		let restartCount = 0;
		let resumeOnStreaming = false;
		let uiRaf = 0;
		let dragging = false;
		let barLocked = true;
		let lastSeekableUpdate = 0;
		const videoListeners = [];
		const msListeners = [];

		// ── DOM: slim control bar (play/pause · offset · scrub track · LIVE) ──
		const bar = document.createElement('div');
		bar.className = 'video-dvr';
		const playBtn = document.createElement('button');
		playBtn.type = 'button';
		playBtn.className = 'video-dvr-play';
		playBtn.title = 'Pause';
		playBtn.setAttribute('aria-label', 'Pause');
		playBtn.innerHTML = PAUSE_SVG;
		const offsetLabel = document.createElement('span');
		offsetLabel.className = 'video-dvr-offset';
		offsetLabel.textContent = '';
		const track = document.createElement('div');
		track.className = 'video-dvr-track';
		const rail = document.createElement('div');
		rail.className = 'video-dvr-rail';
		const avail = document.createElement('div');
		avail.className = 'video-dvr-avail';
		const fill = document.createElement('div');
		fill.className = 'video-dvr-fill';
		const thumb = document.createElement('div');
		thumb.className = 'video-dvr-thumb';
		const bubble = document.createElement('div');
		bubble.className = 'video-dvr-bubble';
		rail.appendChild(avail);
		rail.appendChild(fill);
		track.appendChild(rail);
		track.appendChild(thumb);
		track.appendChild(bubble);
		const liveBtn = document.createElement('button');
		liveBtn.type = 'button';
		liveBtn.className = 'video-dvr-live';
		liveBtn.title = 'Go to live';
		liveBtn.setAttribute('aria-label', 'Go to live');
		liveBtn.innerHTML = '<span class="video-dvr-live-dot"></span><span class="video-dvr-live-text">LIVE</span>';
		bar.appendChild(playBtn);
		bar.appendChild(offsetLabel);
		bar.appendChild(track);
		bar.appendChild(liveBtn);
		videoContainer.appendChild(bar);
		videoContainer.classList.add('dvr-active');

		function bufferedRange() {
			try {
				const b = sourceBuffer && mediaSource && mediaSource.readyState !== 'closed'
					? sourceBuffer.buffered
					: videoEl.buffered;
				if (!b || !b.length) return null;
				return { start: b.start(0), end: b.end(b.length - 1) };
			} catch (_) {
				return null;
			}
		}

		function liveEdge() {
			const range = bufferedRange();
			return range ? range.end : 0;
		}

		// The track represents exactly the buffered span: 0% is the oldest
		// buffered footage, 100% is the live edge, so the fill always covers
		// the full rail. The span stretches with every appended fragment,
		// which moves a time-shifted playhead's percentage - the thumb/fill
		// GLIDE there via a CSS transition (disabled while dragging) instead
		// of stepping once per append.
		function timelineWindow() {
			const range = bufferedRange();
			if (!range) return null;
			const spanS = Math.max(0.1, range.end - range.start);
			return { start: range.start, end: range.end, windowS: spanS, origin: range.start };
		}

		function timelinePct(time, tw) {
			return Math.min(100, Math.max(0, ((time - tw.origin) / tw.windowS) * 100));
		}

		function timelineTime(fraction, tw) {
			const target = tw.origin + tw.windowS * fraction;
			return Math.min(tw.end, Math.max(tw.start, target));
		}

		function behindLiveSeconds() {
			const range = bufferedRange();
			if (!range) return null;
			return Math.max(0, range.end - (videoEl.currentTime || 0));
		}

		function isAtLiveEdge() {
			const behind = behindLiveSeconds();
			return behind !== null && behind <= LIVE_LATENCY_SHIFT_S && !videoEl.paused;
		}

		// ── networking: fetch → preroll (init segment) → append pump ──

		function connect() {
			if (session.destroyed || session.suspended) return;
			if (abortCtrl) { try { abortCtrl.abort(); } catch (_) {} }
			const ctrl = new AbortController();
			abortCtrl = ctrl;
			// window.fetch may be rerouted through a worker RPC that buffers
			// whole bodies - that never completes for an endless live stream
			// (it would stall until the RPC timeout on every first attempt).
			// Streaming must always use the browser's native fetch.
			const doFetch = window.__OH_NATIVE_FETCH__ || window.fetch;
			doFetch(url, { credentials: 'same-origin', cache: 'no-store', signal: ctrl.signal })
				.then((resp) => {
					if (!resp.ok || !resp.body) throw new Error('http-' + (resp ? resp.status : 0));
					retryDelayMs = RETRY_BASE_MS;
					return consume(resp.body.getReader(), ctrl);
				})
				.catch(() => {
					if (session.destroyed || session.suspended || ctrl !== abortCtrl) return;
					scheduleReconnect();
				});
		}

		async function consume(reader, ctrl) {
			let pending = null;
			let sawInit = false;
			const prerollTimer = setTimeout(() => {
				if (!sawInit && ctrl === abortCtrl) {
					try { ctrl.abort(); } catch (_) {}
					scheduleReconnect();
				}
			}, PREROLL_TIMEOUT_MS);
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (session.destroyed || session.suspended || ctrl !== abortCtrl) return;
					if (done) throw new Error('stream-ended');
					if (!value || !value.length) continue;
					if (!sawInit) {
						pending = concatBytes(pending, value);
						const initLen = findInitSegmentLength(pending);
						if (initLen === -1) { fallbackToDirect('not-fmp4'); return; }
						if (initLen === 0) {
							if (pending.length > PREROLL_MAX_BYTES) { fallbackToDirect('no-moov'); return; }
							continue;
						}
						sawInit = true;
						const initBytes = pending.slice(0, initLen);
						const rest = pending.slice(initLen);
						pending = null;
						const ready = await ensureMediaSource(initBytes);
						if (!ready || session.destroyed || ctrl !== abortCtrl) return;
						enqueue({ init: true, first: !hadFirstInit, bytes: initBytes });
						hadFirstInit = true;
						if (rest.length) enqueue({ bytes: rest });
					} else {
						enqueue({ bytes: value });
					}
				}
			} finally {
				clearTimeout(prerollTimer);
			}
		}

		function scheduleReconnect() {
			if (session.destroyed || session.suspended) return;
			clearTimeout(retryTimer);
			const delay = retryDelayMs;
			retryDelayMs = Math.min(RETRY_MAX_MS, retryDelayMs * 2);
			retryTimer = setTimeout(() => {
				if (!session.destroyed && !session.suspended) connect();
			}, delay);
		}

		function ensureMediaSource(initBytes) {
			if (sourceBuffer) return Promise.resolve(true);
			const Ctor = mseConstructor();
			if (!Ctor) { fallbackToDirect('no-mse'); return Promise.resolve(false); }
			usingMms = !window.MediaSource && !!window.ManagedMediaSource;

			const parsed = extractFmp4Codecs(initBytes);
			const candidates = [];
			if (parsed.length) candidates.push('video/mp4; codecs="' + parsed.join(', ') + '"');
			candidates.push('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
			candidates.push('video/mp4; codecs="avc1.42E01E"');
			let mime = '';
			for (const candidate of candidates) {
				try {
					if (Ctor.isTypeSupported(candidate)) { mime = candidate; break; }
				} catch (_) {}
			}
			if (!mime) { fallbackToDirect('codec-unsupported'); return Promise.resolve(false); }

			mediaSource = new Ctor();
			objectUrl = URL.createObjectURL(mediaSource);
			if (usingMms) {
				try { videoEl.disableRemotePlayback = true; } catch (_) {}
			}

			return new Promise((resolve) => {
				let settled = false;
				const openTimer = setTimeout(() => {
					if (settled) return;
					settled = true;
					fallbackToDirect('sourceopen-timeout');
					resolve(false);
				}, SOURCEOPEN_TIMEOUT_MS);
				const onOpen = () => {
					if (settled || session.destroyed) return;
					settled = true;
					clearTimeout(openTimer);
					try {
						sourceBuffer = mediaSource.addSourceBuffer(mime);
					} catch (_) {
						fallbackToDirect('addsourcebuffer');
						resolve(false);
						return;
					}
					sourceBuffer.addEventListener('updateend', afterUpdate);
					sourceBuffer.addEventListener('error', onSourceBufferError);
					session.active = true;
					videoEl.play().catch(() => {});
					pump();
					resolve(true);
				};
				addMsListener('sourceopen', onOpen);
				if (usingMms) {
					addMsListener('startstreaming', () => {
						if (resumeOnStreaming) {
							resumeOnStreaming = false;
							connect();
						}
						pump();
					});
				}
				videoEl.src = objectUrl;
			});
		}

		function addMsListener(event, handler) {
			mediaSource.addEventListener(event, handler);
			msListeners.push([mediaSource, event, handler]);
		}

		function enqueue(item) {
			queue.push(item);
			queuedBytes += item.bytes.length;
			if (queuedBytes > MAX_QUEUE_BYTES) {
				// Consumer cannot keep up (hidden MMS tab, wedged decoder):
				// drop the connection and re-stitch later instead of hoarding RAM.
				queue = queue.filter((q) => q.init);
				queuedBytes = queue.reduce((n, q) => n + q.bytes.length, 0);
				if (usingMms && mediaSource && mediaSource.streaming === false) {
					resumeOnStreaming = true;
					if (abortCtrl) { try { abortCtrl.abort(); } catch (_) {} }
				} else {
					scheduleReconnect();
					if (abortCtrl) { try { abortCtrl.abort(); } catch (_) {} }
				}
				return;
			}
			pump();
		}

		function pump() {
			if (session.destroyed || !sourceBuffer) return;
			if (!mediaSource || mediaSource.readyState !== 'open') return;
			if (sourceBuffer.updating) return;
			if (usingMms && mediaSource.streaming === false) return;

			const range = bufferedRange();
			if (range) {
				const cutoff = computeDvrEvictionCutoff(range.start, range.end, videoEl.currentTime, windowSeconds);
				if (cutoff !== null) {
					try {
						sourceBuffer.remove(range.start, cutoff);
						return; // updateend re-enters pump
					} catch (_) {}
				}
			}

			const item = queue[0];
			if (!item) return;
			try {
				if (item.init) {
					try { sourceBuffer.abort(); } catch (_) {}
					const offset = item.first ? 0 : liveEdge() + 0.1;
					sourceBuffer.timestampOffset = offset;
					epochs.push({ media: offset, wall: Date.now() });
					if (epochs.length > 50) epochs.splice(0, epochs.length - 50);
				}
				sourceBuffer.appendBuffer(item.bytes);
				queue.shift();
				queuedBytes -= item.bytes.length;
			} catch (err) {
				if (err && err.name === 'QuotaExceededError') shrinkForQuota();
				else failPlayback('append-error');
			}
		}

		function afterUpdate() {
			if (session.destroyed) return;
			if (!durationFixed && mediaSource && mediaSource.readyState === 'open' && !sourceBuffer.updating) {
				durationFixed = true;
				if (mediaSource.duration !== Infinity) {
					try { mediaSource.duration = Infinity; } catch (_) {}
				}
			}
			const range = bufferedRange();
			if (range) {
				// Keep the playhead inside the window after quota trims
				if (videoEl.currentTime < range.start && range.end > range.start) {
					try { videoEl.currentTime = Math.min(range.start + 0.1, range.end); } catch (_) {}
				}
				// Follow the live edge unless the user scrubbed away or paused
				if (session.followLive && !session.userPaused && !videoEl.paused) {
					const drift = range.end - videoEl.currentTime;
					if (drift > FOLLOW_LIVE_MAX_DRIFT_S) {
						try { videoEl.currentTime = Math.max(range.start, range.end - LIVE_EDGE_OFFSET_S); } catch (_) {}
					}
				}
				const now = Date.now();
				if (now - lastSeekableUpdate > 1000 && mediaSource && mediaSource.readyState === 'open'
					&& typeof mediaSource.setLiveSeekableRange === 'function') {
					lastSeekableUpdate = now;
					try { mediaSource.setLiveSeekableRange(range.start, range.end); } catch (_) {}
				}
			}
			scheduleUiUpdate();
			pump();
		}

		function shrinkForQuota() {
			windowSeconds = Math.max(DVR_MIN_WINDOW_S, Math.floor(windowSeconds * 0.75));
			const range = bufferedRange();
			if (!range || !sourceBuffer || sourceBuffer.updating) {
				if (!range) failPlayback('quota-empty');
				return;
			}
			const span = range.end - range.start;
			let cutoff = range.start + Math.max(DVR_EVICT_MIN_CHUNK_S, span * 0.25);
			cutoff = Math.min(cutoff, Math.max(range.start + 1, range.end - 1));
			try { sourceBuffer.remove(range.start, cutoff); } catch (_) { failPlayback('quota-remove'); }
		}

		function onSourceBufferError() {
			failPlayback('sourcebuffer-error');
		}

		function failPlayback(reason) {
			if (session.destroyed) return;
			restartCount += 1;
			if (!everPlayed && restartCount >= MAX_RESTARTS_BEFORE_PLAY) {
				fallbackToDirect(reason);
				return;
			}
			restart();
		}

		// ── overlay bar behaviour ──

		function scheduleUiUpdate() {
			if (uiRaf) return;
			uiRaf = requestAnimationFrame(() => {
				uiRaf = 0;
				updateUi();
			});
		}

		function updateUi() {
			if (session.destroyed) return;
			const range = bufferedRange();
			if (!range) return;
			const span = range.end - range.start;
			if (!bar.classList.contains('ready') && session.active && everPlayed) {
				bar.classList.add('ready');
			}
			// Visible from the first frame, usable once there is enough
			// history to make scrubbing meaningful (re-locks after restarts).
			barLocked = span < DVR_UNLOCK_WINDOW_S;
			bar.classList.toggle('locked', barLocked);
			// While scrubbing, the transient pause must not flip the play
			// button or repaint positions - the drag owns the bar.
			if (dragging) return;
			// Only rewrite the icon when the state actually flips: replacing
			// the svg under the cursor between mousedown and mouseup makes
			// the browser swallow the click (the "press twice" bug).
			const wantIcon = videoEl.paused ? 'play' : 'pause';
			if (playBtn.dataset.icon !== wantIcon) {
				playBtn.dataset.icon = wantIcon;
				playBtn.innerHTML = videoEl.paused ? PLAY_SVG : PAUSE_SVG;
				const playLabel = videoEl.paused ? 'Play' : 'Pause';
				playBtn.title = playLabel;
				playBtn.setAttribute('aria-label', playLabel);
			}
			const clamped = Math.min(Math.max(videoEl.currentTime, range.start), range.end);
			const behind = Math.max(0, range.end - clamped);
			const live = behind <= LIVE_LATENCY_SHIFT_S && !videoEl.paused;
			const tw = timelineWindow();
			// Pin the playhead to the end while following live: the edge jumps
			// forward with every appended fragment while playback advances
			// smoothly, so tracking the real position bounces the thumb
			// inside the last few percent of the track.
			const posPct = live ? 100 : timelinePct(clamped, tw);
			fill.style.width = posPct + '%';
			thumb.style.left = posPct + '%';
			offsetLabel.textContent = live ? '' : '-' + formatOffset(behind);
			offsetLabel.classList.toggle('empty', live);
			bar.classList.toggle('at-live', live);
		}

		function trackFraction(event) {
			const rect = track.getBoundingClientRect();
			// With the fs-rotated video the bar is CSS-rotated 90deg, so the
			// track runs vertically in viewport coordinates.
			const rotated = videoContainer.classList.contains('dvr-rotated');
			const fraction = rotated
				? (event.clientY - rect.top) / (rect.height || 1)
				: (event.clientX - rect.left) / (rect.width || 1);
			return Math.min(1, Math.max(0, fraction));
		}

		function previewScrub(fraction) {
			const tw = timelineWindow();
			if (!tw) return;
			const target = timelineTime(fraction, tw);
			const pct = timelinePct(target, tw);
			fill.style.width = pct + '%';
			thumb.style.left = pct + '%';
			bubble.style.left = pct + '%';
			const wall = wallTimeFromEpochs(epochs, target);
			const behind = Math.max(0, tw.end - target);
			bubble.textContent = (wall ? formatClock(wall) : '') + (behind > LIVE_LATENCY_SHIFT_S ? '  -' + formatOffset(behind) : '  LIVE');
			offsetLabel.textContent = behind > LIVE_LATENCY_SHIFT_S ? '-' + formatOffset(behind) : '';
		}

		function applyScrub(fraction) {
			const tw = timelineWindow();
			if (!tw) return;
			let target = timelineTime(fraction, tw);
			const behind = tw.end - target;
			session.followLive = behind <= LIVE_LATENCY_SHIFT_S;
			if (session.followLive) target = Math.max(tw.start, tw.end - LIVE_EDGE_OFFSET_S);
			try { videoEl.currentTime = target; } catch (_) {}
			if (!session.userPaused) videoEl.play().catch(() => {});
			scheduleUiUpdate();
		}

		function goLive() {
			haptic();
			session.userPaused = false;
			session.followLive = true;
			const range = bufferedRange();
			if (range) {
				try { videoEl.currentTime = Math.max(range.start, range.end - LIVE_EDGE_OFFSET_S); } catch (_) {}
			}
			videoEl.play().catch(() => {});
			scheduleUiUpdate();
		}

		function togglePlay() {
			haptic();
			if (videoEl.paused) {
				session.userPaused = false;
				videoEl.play().catch(() => {});
			} else {
				session.userPaused = true;
				session.followLive = false;
				videoEl.pause();
			}
			scheduleUiUpdate();
		}

		playBtn.addEventListener('click', (e) => { e.stopPropagation(); if (barLocked) return; togglePlay(); });
		liveBtn.addEventListener('click', (e) => { e.stopPropagation(); if (barLocked) return; goLive(); });
		bar.addEventListener('contextmenu', (e) => { e.preventDefault(); });
		for (const evt of ['pointerdown', 'touchstart', 'mousedown', 'click']) {
			bar.addEventListener(evt, (e) => { e.stopPropagation(); });
		}

		// Live scrubbing: the video follows the pointer from the moment it
		// lands on the track, throttled so a fast drag does not flood the
		// decoder with seeks. The release still runs applyScrub for the
		// authoritative position and the follow-live decision.
		let lastDragSeekAt = 0;
		function scrubSeek(fraction) {
			const tw = timelineWindow();
			if (!tw) return;
			try { videoEl.currentTime = timelineTime(fraction, tw); } catch (_) {}
		}

		track.addEventListener('pointerdown', (e) => {
			if (!bar.classList.contains('ready') || barLocked) return;
			e.stopPropagation();
			e.preventDefault();
			dragging = true;
			bar.classList.add('dragging');
			try { track.setPointerCapture(e.pointerId); } catch (_) {}
			// followLive stays off for the whole drag so the live-edge
			// resync cannot yank the playhead from under the pointer.
			session.followLive = false;
			// Scrub preview: hold the frame still while the pointer is down;
			// applyScrub resumes playback on release (unless user-paused).
			try { videoEl.pause(); } catch (_) {}
			previewScrub(trackFraction(e));
			scrubSeek(trackFraction(e));
			lastDragSeekAt = Date.now();
		});
		track.addEventListener('pointermove', (e) => {
			if (!dragging) return;
			e.stopPropagation();
			const fraction = trackFraction(e);
			previewScrub(fraction);
			const now = Date.now();
			if (now - lastDragSeekAt >= DRAG_SEEK_THROTTLE_MS) {
				lastDragSeekAt = now;
				scrubSeek(fraction);
			}
		});
		const endDrag = (e) => {
			if (!dragging) return;
			e.stopPropagation();
			dragging = false;
			bar.classList.remove('dragging');
			haptic();
			applyScrub(trackFraction(e));
		};
		track.addEventListener('pointerup', endDrag);
		track.addEventListener('pointercancel', () => {
			if (!dragging) return;
			dragging = false;
			bar.classList.remove('dragging');
			const range = bufferedRange();
			if (range) session.followLive = (range.end - videoEl.currentTime) <= LIVE_LATENCY_SHIFT_S;
			if (!session.userPaused) videoEl.play().catch(() => {});
			scheduleUiUpdate();
		});

		// ── video element hooks ──

		function addVideoListener(event, handler) {
			videoEl.addEventListener(event, handler);
			videoListeners.push([event, handler]);
		}

		addVideoListener('playing', () => {
			everPlayed = true;
			restartCount = 0;
			scheduleUiUpdate();
		});
		addVideoListener('pause', scheduleUiUpdate);
		addVideoListener('play', scheduleUiUpdate);
		addVideoListener('timeupdate', scheduleUiUpdate);
		addVideoListener('seeked', scheduleUiUpdate);
		addVideoListener('seeking', () => {
			// Covers native scrubbing too (e.g. the iOS fullscreen player).
			// Drag seeks manage followLive themselves - without this guard a
			// drag passing near the edge would re-arm the live resync mid-drag.
			if (dragging) return;
			const range = bufferedRange();
			if (range) session.followLive = (range.end - videoEl.currentTime) <= LIVE_LATENCY_SHIFT_S;
			scheduleUiUpdate();
		});
		addVideoListener('waiting', () => {
			// Jump small unbuffered gaps (reconnect seams, post-trim holes)
			const buffered = videoEl.buffered;
			if (!buffered || !buffered.length) return;
			const now = videoEl.currentTime;
			for (let i = 0; i < buffered.length; i += 1) {
				const start = buffered.start(i);
				if (start > now && start - now < 30) {
					try { videoEl.currentTime = start + 0.1; } catch (_) {}
					return;
				}
			}
		});

		const watchdog = setInterval(() => {
			if (!document.contains(videoEl)) destroy();
		}, 5000);

		// ── lifecycle ──

		function teardownStream() {
			clearTimeout(retryTimer);
			retryTimer = null;
			if (abortCtrl) {
				const ctrl = abortCtrl;
				abortCtrl = null;
				try { ctrl.abort(); } catch (_) {}
			}
		}

		function detachMediaSource() {
			for (const [target, event, handler] of msListeners.splice(0)) {
				try { target.removeEventListener(event, handler); } catch (_) {}
			}
			if (sourceBuffer) {
				try { sourceBuffer.removeEventListener('updateend', afterUpdate); } catch (_) {}
				try { sourceBuffer.removeEventListener('error', onSourceBufferError); } catch (_) {}
			}
			sourceBuffer = null;
			mediaSource = null;
			if (objectUrl) {
				try { URL.revokeObjectURL(objectUrl); } catch (_) {}
				objectUrl = '';
			}
		}

		function restart() {
			if (session.destroyed) return;
			teardownStream();
			detachMediaSource();
			queue = [];
			queuedBytes = 0;
			epochs = [];
			hadFirstInit = false;
			durationFixed = false;
			resumeOnStreaming = false;
			session.active = false;
			session.followLive = true;
			session.userPaused = false;
			retryDelayMs = RETRY_BASE_MS;
			bar.classList.remove('at-live');
			connect();
		}

		function suspend() {
			if (session.destroyed || session.suspended) return;
			session.suspended = true;
			teardownStream();
			try { videoEl.pause(); } catch (_) {}
		}

		function resumeFromSuspend() {
			if (session.destroyed || !session.suspended) return;
			session.suspended = false;
			retryDelayMs = RETRY_BASE_MS;
			// The stitched timeline resumes at the old edge; the follow-live
			// drift check snaps to the fresh edge once new data lands.
			if (!session.userPaused) videoEl.play().catch(() => {});
			connect();
		}

		function destroy() {
			if (session.destroyed) return;
			session.destroyed = true;
			session.active = false;
			teardownStream();
			clearInterval(watchdog);
			if (uiRaf) { cancelAnimationFrame(uiRaf); uiRaf = 0; }
			for (const [event, handler] of videoListeners.splice(0)) {
				try { videoEl.removeEventListener(event, handler); } catch (_) {}
			}
			const wasOurSrc = objectUrl && videoEl.src === objectUrl;
			detachMediaSource();
			if (wasOurSrc) {
				try { videoEl.removeAttribute('src'); videoEl.load(); } catch (_) {}
			}
			queue = [];
			queuedBytes = 0;
			epochs = [];
			if (bar.parentNode) bar.parentNode.removeChild(bar);
			videoContainer.classList.remove('dvr-active');
			if (videoEl.__dvr === session) delete videoEl.__dvr;
		}

		function fallbackToDirect(reason) {
			if (session.destroyed) return;
			dvrFailureCounts.set(url, (dvrFailureCounts.get(url) || 0) + 1);
			try { console.info('[DVR] Falling back to direct playback:', reason); } catch (_) {}
			destroy();
			if (onFallback) onFallback(reason);
		}

		// ── public surface (consumed by app.js) ──

		session.destroy = destroy;
		session.restart = restart;
		session.suspend = suspend;
		session.resumeFromSuspend = resumeFromSuspend;
		session.isUserPaused = () => session.userPaused;
		session.isSuspended = () => session.suspended;
		// Scrub-preview pause: the element is paused while the pointer is
		// held on the track; babysitters must not resume it mid-drag.
		session.isScrubbing = () => dragging;
		session.isTimeShifted = () => {
			const behind = behindLiveSeconds();
			return behind !== null && (behind > LIVE_LATENCY_SHIFT_S || videoEl.paused);
		};
		session.wallTimeAt = (mediaTime) => wallTimeFromEpochs(epochs, mediaTime);
		// The stream clock swaps to this while the user is behind live.
		session.shiftedClockDate = () => {
			if (session.destroyed || !session.active) return null;
			const behind = behindLiveSeconds();
			if (behind === null) return null;
			if (behind <= LIVE_LATENCY_SHIFT_S && !videoEl.paused) return null;
			return wallTimeFromEpochs(epochs, videoEl.currentTime) || new Date(Date.now() - behind * 1000);
		};

		videoEl.__dvr = session;
		connect();
		return session;
	}

	window.OhVideoDvr = {
		isSupported,
		attach(videoEl, videoContainer, url, opts) {
			if (!videoEl || !videoContainer || !url || !isSupported()) return null;
			if ((dvrFailureCounts.get(url) || 0) >= MAX_FAILURES_PER_URL) return null;
			if (videoEl.__dvr) videoEl.__dvr.destroy();
			try {
				return createDvrSession(videoEl, videoContainer, url, opts);
			} catch (_) {
				return null;
			}
		},
		_internals: { readMp4BoxHeader, findInitSegmentLength, extractFmp4Codecs, computeDvrEvictionCutoff, wallTimeFromEpochs },
	};
})();
