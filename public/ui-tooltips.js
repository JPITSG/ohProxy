'use strict';

(() => {
	const TOOLTIP_ATTRIBUTE = 'data-oh-tooltip';
	const OVERFLOW_ATTRIBUTE = 'data-oh-tooltip-overflow';
	const TOUCH_ATTRIBUTE = 'data-oh-tooltip-touch';
	const PLACEMENT_ATTRIBUTE = 'data-oh-tooltip-placement';
	const TOOLTIP_SELECTOR = `[${TOOLTIP_ATTRIBUTE}]`;
	const HOVER_DELAY_MS = 260;
	const TOUCH_VISIBLE_MS = 5000;
	const TOUCH_FOCUS_MS = 750;
	const VIEWPORT_GAP_PX = 4;
	const TARGET_GAP_PX = 8;

	let tooltip = null;
	let activeTarget = null;
	let pendingTarget = null;
	let pendingPoint = null;
	let activePoint = null;
	let activeMode = '';
	let showTimer = 0;
	let touchTimer = 0;
	let touchPointerId = null;
	let lastTouchAt = -Infinity;
	let touchStartX = 0;
	let touchStartY = 0;
	let touchMoved = false;
	let touchGestureBlocked = false;
	const activeTouchPointers = new Set();

	function elementTarget(value) {
		return value && value.nodeType === 1 ? value : value?.parentElement || null;
	}

	function closestTooltipTarget(value) {
		const el = elementTarget(value);
		return el && typeof el.closest === 'function' ? el.closest(TOOLTIP_SELECTOR) : null;
	}

	function tooltipText(target) {
		return target ? String(target.getAttribute(TOOLTIP_ATTRIBUTE) || '').trim() : '';
	}

	function overflowElement(target) {
		const selector = target?.getAttribute(OVERFLOW_ATTRIBUTE);
		if (!selector) return null;
		if (selector === 'self') return target;
		try {
			return target.querySelector(selector);
		} catch (_) {
			return null;
		}
	}

	function isOverflowing(target) {
		const el = overflowElement(target);
		if (!el) return true;
		return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
	}

	function canShow(target) {
		return !!(
			target
			&& target.isConnected
			&& tooltipText(target)
			&& isOverflowing(target)
		);
	}

	function ensureTooltip() {
		if (tooltip?.isConnected) return tooltip;
		if (!document.body) return null;
		tooltip = document.createElement('div');
		tooltip.id = 'ohTooltip';
		tooltip.className = 'oh-tooltip';
		tooltip.setAttribute('role', 'tooltip');
		tooltip.setAttribute('aria-hidden', 'true');
		document.body.appendChild(tooltip);
		return tooltip;
	}

	function clamp(value, min, max) {
		return Math.max(min, Math.min(value, max));
	}

	function applyPosition(left, top) {
		const layer = ensureTooltip();
		if (!layer) return;
		const maxLeft = Math.max(VIEWPORT_GAP_PX, window.innerWidth - layer.offsetWidth - VIEWPORT_GAP_PX);
		const maxTop = Math.max(VIEWPORT_GAP_PX, window.innerHeight - layer.offsetHeight - VIEWPORT_GAP_PX);
		layer.style.left = `${Math.round(clamp(left, VIEWPORT_GAP_PX, maxLeft))}px`;
		layer.style.top = `${Math.round(clamp(top, VIEWPORT_GAP_PX, maxTop))}px`;
	}

	function positionAtPoint(point) {
		const layer = ensureTooltip();
		if (!layer || !point) return;
		const width = layer.offsetWidth;
		const height = layer.offsetHeight;
		let left = point.x - width - 16;
		if (left < VIEWPORT_GAP_PX && point.x + 16 + width <= window.innerWidth - VIEWPORT_GAP_PX) {
			left = point.x + 16;
		}
		applyPosition(left, point.y - height / 2 + 8);
	}

	function positionAtTarget(target) {
		const layer = ensureTooltip();
		if (!layer || !target) return;
		const rect = target.getBoundingClientRect();
		const width = layer.offsetWidth;
		const height = layer.offsetHeight;
		const requested = String(target.getAttribute(PLACEMENT_ATTRIBUTE) || 'auto').toLowerCase();
		let placement = requested;
		if (!['top', 'bottom', 'left', 'right'].includes(placement)) {
			if (rect.top >= height + TARGET_GAP_PX + VIEWPORT_GAP_PX) placement = 'top';
			else if (window.innerHeight - rect.bottom >= height + TARGET_GAP_PX + VIEWPORT_GAP_PX) placement = 'bottom';
			else if (rect.left >= width + TARGET_GAP_PX + VIEWPORT_GAP_PX) placement = 'left';
			else placement = 'right';
		}

		let left = rect.left + rect.width / 2 - width / 2;
		let top = rect.top - height - TARGET_GAP_PX;
		if (placement === 'bottom') top = rect.bottom + TARGET_GAP_PX;
		if (placement === 'left') {
			left = rect.left - width - TARGET_GAP_PX;
			top = rect.top + rect.height / 2 - height / 2;
		}
		if (placement === 'right') {
			left = rect.right + TARGET_GAP_PX;
			top = rect.top + rect.height / 2 - height / 2;
		}
		applyPosition(left, top);
	}

	function positionActive() {
		if (!activeTarget) return;
		if (activeMode === 'pointer' && activePoint) positionAtPoint(activePoint);
		else positionAtTarget(activeTarget);
	}

	function clearTimers() {
		if (showTimer) {
			clearTimeout(showTimer);
			showTimer = 0;
		}
		if (touchTimer) {
			clearTimeout(touchTimer);
			touchTimer = 0;
		}
		pendingTarget = null;
		pendingPoint = null;
	}

	function hide() {
		clearTimers();
		activeTarget = null;
		activePoint = null;
		activeMode = '';
		if (!tooltip) return;
		tooltip.classList.remove('visible');
		tooltip.setAttribute('aria-hidden', 'true');
	}

	function showNow(target, point, mode = 'anchor') {
		clearTimers();
		if (!canShow(target)) {
			hide();
			return;
		}
		const layer = ensureTooltip();
		if (!layer) return;
		const wasVisible = layer.classList.contains('visible');
		activeTarget = target;
		activePoint = point || null;
		activeMode = mode;
		layer.textContent = tooltipText(target);
		layer.setAttribute('aria-hidden', 'false');
		positionActive();
		if (wasVisible) return;
		// positionActive measures the hidden layer, flushing its initial style so
		// adding the class here still animates and does not depend on a paintable
		// animation-frame callback (backgrounded/PWA pages may suspend rAF).
		if (activeTarget === target) layer.classList.add('visible');
	}

	function queuePointerTooltip(target, point) {
		clearTimers();
		if (!canShow(target)) return;
		pendingTarget = target;
		pendingPoint = point;
		showTimer = setTimeout(() => {
			showTimer = 0;
			const nextTarget = pendingTarget;
			const nextPoint = pendingPoint;
			pendingTarget = null;
			pendingPoint = null;
			showNow(nextTarget, nextPoint, 'pointer');
		}, HOVER_DELAY_MS);
	}

	function set(target, text, options = {}) {
		if (!target) return;
		const normalized = text === null || text === undefined ? '' : String(text).trim();
		target.removeAttribute('title');
		if (normalized) target.setAttribute(TOOLTIP_ATTRIBUTE, normalized);
		else target.removeAttribute(TOOLTIP_ATTRIBUTE);

		if (options.ariaLabel !== false) {
			const ariaLabel = typeof options.ariaLabel === 'string'
				? options.ariaLabel.trim()
				: normalized;
			if (ariaLabel) target.setAttribute('aria-label', ariaLabel);
			else target.removeAttribute('aria-label');
		}

		if (normalized && options.overflowSelector) target.setAttribute(OVERFLOW_ATTRIBUTE, options.overflowSelector);
		else target.removeAttribute(OVERFLOW_ATTRIBUTE);
		if (normalized && options.touch === true) target.setAttribute(TOUCH_ATTRIBUTE, 'true');
		else target.removeAttribute(TOUCH_ATTRIBUTE);
		if (normalized && options.placement) target.setAttribute(PLACEMENT_ATTRIBUTE, options.placement);
		else target.removeAttribute(PLACEMENT_ATTRIBUTE);

		if (activeTarget === target) {
			if (canShow(target)) {
				const layer = ensureTooltip();
				if (layer) layer.textContent = normalized;
				positionActive();
			} else {
				hide();
			}
		}
	}

	function clear(target, options = {}) {
		if (!target) return;
		target.removeAttribute('title');
		target.removeAttribute(TOOLTIP_ATTRIBUTE);
		target.removeAttribute(OVERFLOW_ATTRIBUTE);
		target.removeAttribute(TOUCH_ATTRIBUTE);
		target.removeAttribute(PLACEMENT_ATTRIBUTE);
		if (options.ariaLabel === true) target.removeAttribute('aria-label');
		if (activeTarget === target || pendingTarget === target) hide();
	}

	document.addEventListener('pointerover', (event) => {
		if (event.pointerType === 'touch') return;
		const target = closestTooltipTarget(event.target);
		if (!target || target.contains(elementTarget(event.relatedTarget))) return;
		queuePointerTooltip(target, { x: event.clientX, y: event.clientY });
	});

	document.addEventListener('pointermove', (event) => {
		if (event.pointerType === 'touch') {
			if (!touchGestureBlocked && event.pointerId === touchPointerId) {
				const dx = event.clientX - touchStartX;
				const dy = event.clientY - touchStartY;
				if (dx * dx + dy * dy > 100) touchMoved = true;
			}
			return;
		}
		const target = closestTooltipTarget(event.target);
		if (pendingTarget === target) {
			pendingPoint = { x: event.clientX, y: event.clientY };
		}
		if (activeTarget === target && activeMode === 'pointer') {
			activePoint = { x: event.clientX, y: event.clientY };
			positionAtPoint(activePoint);
		}
	});

	document.addEventListener('pointerout', (event) => {
		if (event.pointerType === 'touch') return;
		const target = closestTooltipTarget(event.target);
		if (!target || target.contains(elementTarget(event.relatedTarget))) return;
		if (target === activeTarget || target === pendingTarget) hide();
	});

	document.addEventListener('focusin', (event) => {
		const target = closestTooltipTarget(event.target);
		if (!target) return;
		showNow(target, null, 'anchor');
		// A tap focuses after pointerup, so this focusin re-show would otherwise
		// cancel the touch auto-hide (clearTimers) and pin the tooltip open.
		// Keyboard focus stays persistent: its touch clock is stale.
		if (performance.now() - lastTouchAt < TOUCH_FOCUS_MS && activeTarget === target) {
			touchTimer = setTimeout(hide, TOUCH_VISIBLE_MS);
		}
	});

	document.addEventListener('focusout', (event) => {
		const target = closestTooltipTarget(event.target);
		if (!target || target.contains(elementTarget(event.relatedTarget))) return;
		if (target === activeTarget || target === pendingTarget) hide();
	});

	document.addEventListener('pointerdown', (event) => {
		hide();
		if (event.pointerType !== 'touch') return;
		lastTouchAt = performance.now();
		activeTouchPointers.add(event.pointerId);
		if (activeTouchPointers.size > 1) {
			touchGestureBlocked = true;
			return;
		}
		touchPointerId = event.pointerId;
		touchStartX = event.clientX;
		touchStartY = event.clientY;
		touchMoved = false;
	}, true);

	document.addEventListener('pointerup', (event) => {
		if (event.pointerType !== 'touch') return;
		lastTouchAt = performance.now();
		const wasTracked = activeTouchPointers.delete(event.pointerId);
		const wasPrimary = event.pointerId === touchPointerId;
		const suppress = touchGestureBlocked || activeTouchPointers.size > 0 || (wasPrimary && touchMoved);
		if (activeTouchPointers.size === 0) {
			touchPointerId = null;
			touchMoved = false;
			touchGestureBlocked = false;
		}
		if (!wasTracked || !wasPrimary || suppress) return;
		const target = closestTooltipTarget(event.target);
		if (!target || target.getAttribute(TOUCH_ATTRIBUTE) !== 'true') return;
		showNow(target, null, 'anchor');
		if (activeTarget === target) touchTimer = setTimeout(hide, TOUCH_VISIBLE_MS);
	}, true);
	document.addEventListener('pointercancel', (event) => {
		if (event.pointerType !== 'touch' || !activeTouchPointers.delete(event.pointerId)) return;
		touchGestureBlocked = true;
		if (activeTouchPointers.size === 0) {
			touchPointerId = null;
			touchMoved = false;
			touchGestureBlocked = false;
		}
		hide();
	}, true);

	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') hide();
	});
	document.addEventListener('scroll', hide, true);
	window.addEventListener('resize', hide);
	window.addEventListener('orientationchange', hide);
	window.addEventListener('blur', hide);

	window.ohTooltips = Object.freeze({
		set,
		clear,
		hide,
		refresh(target) {
			if (target && target !== activeTarget) return;
			if (!activeTarget || !canShow(activeTarget)) {
				hide();
				return;
			}
			const layer = ensureTooltip();
			if (layer) layer.textContent = tooltipText(activeTarget);
			positionActive();
		},
	});
})();
