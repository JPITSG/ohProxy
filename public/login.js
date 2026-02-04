'use strict';

(function() {
	const form = document.getElementById('login-form');
	const submitBtn = form.querySelector('.submit-btn');
	const loginCard = document.querySelector('.login-card');
	let lockoutTimer = null;

	function getCookie(name) {
		const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
		return match ? match[2] : null;
	}

	function shake() {
		loginCard.classList.remove('shake');
		// Trigger reflow to restart animation
		void loginCard.offsetWidth;
		loginCard.classList.add('shake');
	}

	function formatTime(seconds) {
		if (seconds >= 60) {
			const mins = Math.floor(seconds / 60);
			const secs = seconds % 60;
			return mins + ':' + (secs < 10 ? '0' : '') + secs;
		}
		return seconds + 's';
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
				startLockoutCountdown(data.remainingSeconds || 900);
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

	// Remove shake class after animation
	loginCard.addEventListener('animationend', function() {
		loginCard.classList.remove('shake');
	});
})();
