'use strict';

(function() {
	var haptic = ohUtils.haptic;

	const form = document.getElementById('login-form');
	const submitBtn = form.querySelector('.submit-btn');
	const loginCard = document.querySelector('.login-card');
	let lockoutTimer = null;

	function getCookie(name) {
		const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
		return match ? match[2] : null;
	}

	function shake() {
		ohUtils.shakeElement(loginCard);
	}

	function formatTime(seconds) {
		if (seconds >= 60) {
			const mins = Math.floor(seconds / 60);
			const secs = seconds % 60;
			return mins + ':' + (secs < 10 ? '0' : '') + secs;
		}
		return seconds + 's';
	}

	function toPositiveInt(value) {
		const n = Number(value);
		if (!Number.isFinite(n)) return 0;
		const int = Math.floor(n);
		return int > 0 ? int : 0;
	}

	function resolveLockoutSeconds(response, data) {
		const bodySeconds = toPositiveInt(data && data.remainingSeconds);
		if (bodySeconds > 0) return bodySeconds;

		const retryAfter = response && response.headers && typeof response.headers.get === 'function'
			? response.headers.get('Retry-After')
			: '';
		const headerSeconds = toPositiveInt(retryAfter);
		if (headerSeconds > 0) return headerSeconds;

		return 900;
	}

	function startLockoutCountdown(seconds) {
		if (lockoutTimer) {
			clearInterval(lockoutTimer);
		}
		let remaining = seconds;
		submitBtn.disabled = true;
		submitBtn.textContent = 'Wait ' + formatTime(remaining);

		lockoutTimer = setInterval(function() {
			remaining--;
			if (remaining <= 0) {
				clearInterval(lockoutTimer);
				lockoutTimer = null;
				submitBtn.disabled = false;
				submitBtn.textContent = 'Login';
			} else {
				submitBtn.textContent = 'Wait ' + formatTime(remaining);
			}
		}, 1000);
	}

	form.addEventListener('submit', async function(e) {
		e.preventDefault();
		haptic();

		if (submitBtn.disabled) return;

		const username = form.username.value.trim();
		const password = form.password.value;

		if (!username || !password) {
			shake();
			return;
		}

		const csrfToken = getCookie('ohCSRF');
		if (!csrfToken) {
			window.location.reload();
			return;
		}

		submitBtn.disabled = true;
		submitBtn.textContent = 'Logging in...';
		let lockedOut = false;

		try {
			const response = await fetch('/api/auth/login', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-CSRF-Token': csrfToken,
				},
				body: JSON.stringify({ username, password }),
			});

			const data = await response.json();

			if (response.ok && data.success) {
				window.location.href = '/';
				return;
			}

			// Handle errors
			if (response.status === 403) {
				window.location.reload();
				return;
			} else if (response.status === 429 && data.lockedOut) {
				lockedOut = true;
				shake();
				startLockoutCountdown(resolveLockoutSeconds(response, data));
			} else {
				shake();
			}
		} catch (err) {
			shake();
		} finally {
			// Don't re-enable if locked out - countdown will handle it
			if (!lockedOut) {
				submitBtn.disabled = false;
				submitBtn.textContent = 'Login';
			}
		}
	});

})();
