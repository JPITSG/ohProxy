'use strict';

(function() {
	const form = document.getElementById('login-form');
	const formMessage = document.getElementById('form-message');
	const submitBtn = form.querySelector('.submit-btn');
	const loginCard = document.querySelector('.login-card');
	let lockoutTimer = null;

	function getCookie(name) {
		const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
		return match ? match[2] : null;
	}

	function showError(message, isLockout) {
		formMessage.textContent = message;
		formMessage.className = 'form-message ' + (isLockout ? 'lockout' : 'error');
	}

	function showHint() {
		formMessage.textContent = 'All fields are required';
		formMessage.className = 'form-message hint';
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
		showError('Too many attempts. Try again in ' + formatTime(remaining), true);
		submitBtn.disabled = true;

		lockoutTimer = setInterval(function() {
			remaining--;
			if (remaining <= 0) {
				clearInterval(lockoutTimer);
				lockoutTimer = null;
				showHint();
				submitBtn.disabled = false;
			} else {
				showError('Too many attempts. Try again in ' + formatTime(remaining), true);
			}
		}, 1000);
	}

	form.addEventListener('submit', async function(e) {
		e.preventDefault();

		const username = form.username.value.trim();
		const password = form.password.value;

		if (!username || !password) {
			showError('Please enter username and password');
			shake();
			return;
		}

		const csrfToken = getCookie('ohCSRF');
		if (!csrfToken) {
			showError('Session expired. Please refresh the page.');
			return;
		}

		submitBtn.disabled = true;
		submitBtn.textContent = 'Logging in...';

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
				// Success - reload page to get the app
				window.location.reload();
				return;
			}

			// Handle errors
			if (response.status === 429 && data.lockedOut) {
				shake();
				startLockoutCountdown(data.remainingSeconds || 900);
			} else if (response.status === 401) {
				shake();
				showError('Invalid username or password');
			} else if (response.status === 403) {
				showError('Session expired. Please refresh the page.');
			} else {
				showError(data.error || 'Login failed');
			}
		} catch (err) {
			showError('Connection error. Please try again.');
		} finally {
			submitBtn.disabled = false;
			submitBtn.textContent = 'Login';
		}
	});

	// Remove shake class after animation
	loginCard.addEventListener('animationend', function() {
		loginCard.classList.remove('shake');
	});
})();
