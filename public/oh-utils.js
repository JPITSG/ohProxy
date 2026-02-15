(function(root) {
	'use strict';

	/* ── haptic ────────────────────────────────────────────
	 *  Safe vibration wrapper.
	 *  - No-ops silently when Vibration API is unavailable
	 *  - Clamps duration to a sane range (1-500 ms)
	 */
	function haptic(ms) {
		if (typeof navigator.vibrate !== 'function') return;
		ms = Math.max(1, Math.min(+(ms || 30), 500));
		try { navigator.vibrate(ms); } catch (_) { /* sandboxed iframe / permissions */ }
	}

	/* ── shakeElement ──────────────────────────────────────
	 *  Restarts the CSS .shake animation on an element.
	 *  - Guards against null / non-Element arguments
	 *  - Cleans up previous in-flight shake before starting
	 *    a new one (avoids stacking animationend listeners)
	 *  - Fallback timeout ensures class is removed even if
	 *    animationend never fires (hidden tab, detached node)
	 */
	function shakeElement(el) {
		if (!(el instanceof Element)) return;

		// Tear down any in-flight shake first
		if (el._shakeCleanup) el._shakeCleanup();

		el.classList.remove('shake');
		void el.offsetWidth;           // reflow to restart animation
		el.classList.add('shake');

		var cleanup = function() {
			el.classList.remove('shake');
			el.removeEventListener('animationend', onEnd);
			clearTimeout(timer);
			el._shakeCleanup = null;
		};
		var onEnd = function(e) {
			if (e.animationName === 'shake') cleanup();
		};
		el.addEventListener('animationend', onEnd);
		var timer = setTimeout(cleanup, 800);  // safety net (animation is 500ms)

		el._shakeCleanup = cleanup;
	}

	root.ohUtils = { haptic: haptic, shakeElement: shakeElement };
})(this);
