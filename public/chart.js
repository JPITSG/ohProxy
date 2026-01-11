(function() {
	// Set theme from URL param, localStorage, or system preference
	var params = new URLSearchParams(window.location.search);
	var mode = params.get('mode');
	if (mode === 'dark' || mode === 'light') {
		document.documentElement.setAttribute('data-theme', mode);
	} else {
		var saved = localStorage.getItem('theme');
		var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
		document.documentElement.setAttribute('data-theme', saved || (prefersDark ? 'dark' : 'light'));
	}

	window.ChartRenderer = class {
		constructor(containerId, svgId) {
			this.container = document.getElementById(containerId);
			this.svg = document.getElementById(svgId);
			this.tooltip = document.getElementById('tooltip');
			this.tooltipValue = document.getElementById('tooltipValue');
			this.tooltipLabel = document.getElementById('tooltipLabel');
			this.padding = { top: 25, right: 45, bottom: 60, left: 35 };
			this.points = [];
			this.layout = {};
			this.tapCircle = null;
			this.hideTimer = null;
			this.init();
			window.addEventListener('resize', () => this.render());
		}

		init() {
			this.render();
			this.container.addEventListener('click', e => this.onClick(e));
			this.container.addEventListener('touchend', e => this.onClick(e));
		}

		svg$(tag, attrs) {
			var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
			for (var key in attrs) {
				el.setAttribute(key, attrs[key]);
			}
			return el;
		}

		render() {
			var rect = this.container.getBoundingClientRect();
			var w = rect.width;
			var h = rect.height;
			var sm = w < 500;
			var pad = sm ? { top: 15, right: 45, bottom: 40, left: 22 } : this.padding;
			var cw = w - pad.left - pad.right;
			var ch = h - pad.top - pad.bottom;
			var iL = sm ? 10 : 25;
			var iR = sm ? 10 : 25;
			var dw = cw - iL - iR;

			this.layout = { sm: sm, pad: pad, cw: cw, ch: ch, iL: iL, dw: dw };
			this.svg.innerHTML = '';

			var $ = (t, a) => this.svg$(t, a);

			// Defs: gradient, masks, clip path
			var defs = $('defs', {});

			var grad = $('linearGradient', { id: 'areaGradient', x1: '0%', y1: '0%', x2: '0%', y2: '100%' });
			grad.appendChild($('stop', { offset: '0%', style: 'stop-color:var(--chart-gradient-start)' }));
			grad.appendChild($('stop', { offset: '50%', style: 'stop-color:var(--chart-gradient-start);stop-opacity:0.6' }));
			grad.appendChild($('stop', { offset: '100%', style: 'stop-color:var(--chart-gradient-end)' }));
			defs.appendChild(grad);

			var hMask = $('mask', { id: 'hGridMask', maskUnits: 'objectBoundingBox', maskContentUnits: 'objectBoundingBox' });
			var hGrad = $('linearGradient', { id: 'hGridGrad', x1: '0%', y1: '0%', x2: '100%', y2: '0%' });
			hGrad.innerHTML = '<stop offset="0%" stop-color="white" stop-opacity="0"/><stop offset="3%" stop-color="white" stop-opacity="1"/><stop offset="97%" stop-color="white" stop-opacity="1"/><stop offset="100%" stop-color="white" stop-opacity="0"/>';
			defs.appendChild(hGrad);
			hMask.appendChild($('rect', { x: '0', y: '0', width: '1', height: '1', fill: 'url(#hGridGrad)' }));
			defs.appendChild(hMask);

			var vMask = $('mask', { id: 'vGridMask', maskUnits: 'objectBoundingBox', maskContentUnits: 'objectBoundingBox' });
			var vGrad = $('linearGradient', { id: 'vGridGrad', x1: '0%', y1: '0%', x2: '0%', y2: '100%' });
			vGrad.innerHTML = '<stop offset="0%" stop-color="white" stop-opacity="0"/><stop offset="3%" stop-color="white" stop-opacity="1"/><stop offset="97%" stop-color="white" stop-opacity="1"/><stop offset="100%" stop-color="white" stop-opacity="0"/>';
			defs.appendChild(vGrad);
			vMask.appendChild($('rect', { x: '0', y: '0', width: '1', height: '1', fill: 'url(#vGridGrad)' }));
			defs.appendChild(vMask);

			var clipPath = $('clipPath', { id: 'chartClip' });
			clipPath.appendChild($('rect', { x: '0', y: '0', width: cw, height: ch }));
			defs.appendChild(clipPath);

			this.svg.appendChild(defs);

			// Main group
			var g = $('g', { transform: 'translate(' + pad.left + ',' + pad.top + ')' });
			var hGridGroup = $('g', { mask: 'url(#hGridMask)' });
			var vGridGroup = $('g', { mask: 'url(#vGridMask)' });

			var yRange = window._chartYMax - window._chartYMin;
			var numYLines = sm ? 5 : 6;
			var unitSuffix = window._chartUnit && window._chartUnit !== '?' ? ' ' + window._chartUnit : '';

			// Y-axis grid and labels - collect values first for consistent formatting
			var yValues = [];
			var yPositions = [];
			if (sm) {
				for (var i = 0; i < 5; i++) {
					yValues.push(window._chartYMin + (yRange * i / 4));
					yPositions.push(ch - (i / 4) * ch);
				}
			} else {
				var yStep = this.niceStep(Math.abs(yRange), numYLines);
				var startY = Math.floor(window._chartYMin / yStep) * yStep;
				for (var y = startY; y <= window._chartYMax + yStep * 0.1; y += yStep) {
					if (y < window._chartYMin - yStep * 0.1) continue;
					var yPos = ch - ((y - window._chartYMin) / yRange) * ch;
					if (yPos >= -5 && yPos <= ch + 5) {
						yValues.push(y);
						yPositions.push(yPos);
					}
				}
			}
			// Filter values for majority calculation - exclude clearly irrelevant labels
			var dMin = typeof window._chartDataMin === 'number' ? window._chartDataMin : window._chartYMin;
			var dMax = typeof window._chartDataMax === 'number' ? window._chartDataMax : window._chartYMax;
			var isRelevant = function(v) {
				// Hide negative labels when all data is positive (>= 0)
				if (dMin >= 0 && v < 0) return false;
				// Hide positive labels when all data is negative (<= 0)
				if (dMax <= 0 && v > 0) return false;
				return true;
			};
			var yValuesInRange = yValues.filter(isRelevant);
			var yDecimals = this.getMajorityDecimals(yValuesInRange.length > 0 ? yValuesInRange : yValues);
			for (var i = 0; i < yValues.length; i++) {
				hGridGroup.appendChild($('line', { class: 'grid-line', x1: 0, y1: yPositions[i], x2: cw, y2: yPositions[i] }));
				var label = $('text', { class: 'axis-label', x: -8, y: yPositions[i] + 4, 'text-anchor': 'end' });
				// Only show label if relevant to data range
				label.textContent = isRelevant(yValues[i]) ? this.fmt(yValues[i], yDecimals) + unitSuffix : '';
				g.appendChild(label);
			}
			g.appendChild(hGridGroup);

			// X-axis grid and labels
			var maxXLabels = Math.min(window._chartXLabels.length, Math.floor(dw / 70));
			var xStep = Math.max(1, Math.ceil(window._chartXLabels.length / maxXLabels));
			window._chartXLabels.forEach((labelData, i) => {
				if (i % xStep !== 0 && i !== window._chartXLabels.length - 1) return;
				var labelText = typeof labelData === 'object' ? labelData.text : labelData;
				var labelPos = typeof labelData === 'object' ? labelData.pos : null;
				var xPos = labelPos !== null
					? iL + (labelPos / 100) * dw
					: iL + (window._chartXLabels.length > 1 ? (i / (window._chartXLabels.length - 1)) * dw : dw / 2);
				vGridGroup.appendChild($('line', { class: 'grid-line', x1: xPos, y1: 0, x2: xPos, y2: ch }));
				var text = $('text', { class: 'axis-label', x: xPos, y: ch + 25, 'text-anchor': 'middle' });
				text.textContent = labelText;
				g.appendChild(text);
			});
			g.appendChild(vGridGroup);

			// Build points array
			this.points = [];
			var minPoint = null;
			var maxPoint = null;
			for (var i = 0; i < window._chartData.length; i++) {
				var d = window._chartData[i];
				var pt = {
					x: iL + (d.x / 100) * dw,
					y: ch - ((d.y - window._chartYMin) / yRange) * ch,
					value: d.y,
					t: d.t,
					index: i
				};
				this.points.push(pt);
				if (!minPoint || pt.value < minPoint.value) minPoint = pt;
				if (!maxPoint || pt.value > maxPoint.value) maxPoint = pt;
			}

			// Draw chart if we have points
			if (this.points.length > 0) {
				var linePath = this.createPath(this.points);
				var chartGroup = $('g', { 'clip-path': 'url(#chartClip)' });

				// Area path
				var areaPath = linePath + ' L ' + this.points[this.points.length - 1].x + ' ' + ch + ' L ' + this.points[0].x + ' ' + ch + ' Z';
				chartGroup.appendChild($('path', { class: 'chart-area', d: areaPath }));
				chartGroup.appendChild($('path', { class: 'chart-line-glow', d: linePath }));
				chartGroup.appendChild($('path', { class: 'chart-line', d: linePath }));
				g.appendChild(chartGroup);

				// Data points (desktop only)
				if (!sm) {
					this.circleData = [];
					var pointsGroup = $('g', { class: 'data-points' });

					// Collect grid X positions for interpolated points
					var gridXPositions = [];
					for (var i = 0; i < window._chartXLabels.length; i++) {
						var ld = window._chartXLabels[i];
						var lp = typeof ld === 'object' ? ld.pos : null;
						if (lp !== null) {
							gridXPositions.push({ x: iL + (lp / 100) * dw, delay: 1.2 + i * 0.05 });
						}
					}

					// Add min/max points
					var delays = ['1.0s', '1.1s'];
					[minPoint, maxPoint].forEach((pt, idx) => {
						var circle = $('circle', { class: 'data-point', cx: pt.x, cy: pt.y, r: 5 });
						circle.style.animationDelay = delays[idx];
						circle.dataset.idx = this.circleData.length;
						this.circleData.push(pt);
						pointsGroup.appendChild(circle);
					});

					// Add interpolated points at grid lines
					for (var i = 1; i < this.points.length; i++) {
						var prev = this.points[i - 1];
						var curr = this.points[i];
						var minX = Math.min(prev.x, curr.x);
						var maxX = Math.max(prev.x, curr.x);
						for (var j = gridXPositions.length - 1; j >= 0; j--) {
							var gd = gridXPositions[j];
							if (gd.x >= minX && gd.x <= maxX) {
								var t = (gd.x - prev.x) / (curr.x - prev.x);
								var interpY = prev.y + t * (curr.y - prev.y);
								var interpValue = prev.value + t * (curr.value - prev.value);
								var interpTime = prev.t + t * (curr.t - prev.t);
								var circle = $('circle', { class: 'data-point', cx: gd.x, cy: interpY, r: 5 });
								circle.style.animationDelay = gd.delay + 's';
								circle.dataset.idx = this.circleData.length;
								this.circleData.push({ x: gd.x, y: interpY, value: interpValue, t: interpTime });
								pointsGroup.appendChild(circle);
								gridXPositions.splice(j, 1);
							}
						}
					}

					// Event listeners for desktop tooltips
					pointsGroup.addEventListener('mouseenter', e => {
						if (e.target.classList.contains('data-point')) {
							this.showTooltip(e, this.circleData[e.target.dataset.idx]);
						}
					}, true);
					pointsGroup.addEventListener('mouseleave', e => {
						if (e.target.classList.contains('data-point')) {
							this.hideTooltip();
						}
					}, true);

					g.appendChild(pointsGroup);
				}
			}

			this.svg.appendChild(g);
		}

		createPath(pts) {
			if (pts.length < 2) return '';
			var path = ['M ' + pts[0].x + ' ' + pts[0].y];
			for (var i = 1; i < pts.length; i++) {
				path.push('L ' + pts[i].x + ' ' + pts[i].y);
			}
			return path.join(' ');
		}

		niceStep(range, targetSteps) {
			var rough = range / targetSteps;
			var magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
			var residual = rough / magnitude;
			var nice = residual <= 1.5 ? 1 : residual <= 3 ? 2 : residual <= 7 ? 5 : 10;
			return nice * magnitude;
		}

		fmt(n, decimals) {
			if (typeof decimals === 'number') {
				return n.toFixed(decimals);
			}
			if (n === 0) return '0.0';
			if (Number.isInteger(n) || Math.abs(n - Math.round(n)) < 0.0001) {
				var r = Math.round(n);
				if (Math.abs(r) >= 100) return r.toFixed(0);
				return r.toFixed(1);
			}
			if (Math.abs(n) >= 1000) return n.toFixed(0);
			if (Math.abs(n) >= 100) return n.toFixed(0);
			if (Math.abs(n) >= 10) return n.toFixed(1);
			if (Math.abs(n) >= 1) return n.toFixed(1);
			if (Math.abs(n) >= 0.1) return n.toFixed(2);
			return n.toFixed(2);
		}

		getDecimals(n) {
			if (n === 0) return 1;
			if (Number.isInteger(n) || Math.abs(n - Math.round(n)) < 0.0001) {
				var r = Math.round(n);
				if (Math.abs(r) >= 100) return 0;
				return 1;
			}
			if (Math.abs(n) >= 1000) return 0;
			if (Math.abs(n) >= 100) return 0;
			if (Math.abs(n) >= 10) return 1;
			if (Math.abs(n) >= 1) return 1;
			if (Math.abs(n) >= 0.1) return 2;
			return 2;
		}

		getMajorityDecimals(values) {
			var counts = {};
			for (var i = 0; i < values.length; i++) {
				var d = this.getDecimals(values[i]);
				counts[d] = (counts[d] || 0) + 1;
			}
			var maxCount = 0;
			var majority = 1;
			for (var d in counts) {
				if (counts[d] > maxCount) {
					maxCount = counts[d];
					majority = parseInt(d, 10);
				}
			}
			return majority;
		}

		fmtTimestamp(ts) {
			var d = new Date(ts);
			var h = d.getHours();
			var mi = d.getMinutes();
			var time = h + ':' + (mi < 10 ? '0' : '') + mi;
			var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
			return time + ', ' + months[d.getMonth()] + ' ' + d.getDate();
		}

		onClick(e) {
			if (!this.layout.sm) return;

			var touch = e.changedTouches ? e.changedTouches[0] : e;
			var rect = this.container.getBoundingClientRect();
			var x = touch.clientX - rect.left - this.layout.pad.left;

			if (x < 0 || x > this.layout.cw || this.points.length === 0) {
				this.hideTooltip();
				return;
			}

			// Find closest point by X position
			var closest = null;
			var minDist = Infinity;
			for (var i = 0; i < this.points.length; i++) {
				var dist = Math.abs(this.points[i].x - x);
				if (dist < minDist) {
					minDist = dist;
					closest = this.points[i];
				}
			}

			if (closest) {
				this.showTapCircle(closest);
				this.showMobileTooltip(closest);
				if (this.hideTimer) clearTimeout(this.hideTimer);
				this.hideTimer = setTimeout(() => this.hideTooltip(), 3000);
			}
		}

		showTapCircle(pt) {
			if (this.tapCircle) this.tapCircle.remove();
			var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
			circle.setAttribute('cx', pt.x + this.layout.pad.left);
			circle.setAttribute('cy', pt.y + this.layout.pad.top);
			circle.setAttribute('r', '5');
			circle.setAttribute('class', 'data-point');
			circle.style.opacity = '1';
			this.svg.appendChild(circle);
			this.tapCircle = circle;
		}

		showTooltip(e, pt) {
			var rect = this.container.getBoundingClientRect();
			var x = e.clientX - rect.left;
			var y = e.clientY - rect.top;

			this.tooltipValue.textContent = this.fmt(pt.value) + (window._chartUnit && window._chartUnit !== '?' ? ' ' + window._chartUnit : '');
			this.tooltipLabel.textContent = pt.t ? this.fmtTimestamp(pt.t) : '';

			var tx = x + 15;
			var ty = y - 15;
			if (tx + 120 > rect.width) tx = x - 120;
			if (ty < 10) ty = y + 15;

			this.tooltip.style.left = tx + 'px';
			this.tooltip.style.top = ty + 'px';
			this.tooltip.classList.add('visible');
		}

		showMobileTooltip(pt) {
			this.tooltipValue.textContent = this.fmt(pt.value) + (window._chartUnit && window._chartUnit !== '?' ? ' ' + window._chartUnit : '');
			this.tooltipLabel.textContent = pt.t ? this.fmtTimestamp(pt.t) : '';

			// Measure tooltip dimensions while hidden
			this.tooltip.classList.remove('visible');
			this.tooltip.style.visibility = 'hidden';
			this.tooltip.style.display = 'block';

			var rect = this.container.getBoundingClientRect();
			var tooltipRect = this.tooltip.getBoundingClientRect();
			var tw = tooltipRect.width;
			var th = tooltipRect.height;

			this.tooltip.style.display = '';
			this.tooltip.style.visibility = '';

			var cx = pt.x + this.layout.pad.left;
			var cy = pt.y + this.layout.pad.top;

			var circleR = 5;
			var gap = 10;
			var margin = 5;

			// Calculate candidate positions: above, below, right, left of circle
			var candidates = [
				{ x: cx - tw / 2, y: cy - circleR - gap - th, pos: 'above' },
				{ x: cx - tw / 2, y: cy + circleR + gap, pos: 'below' },
				{ x: cx + circleR + gap, y: cy - th / 2, pos: 'right' },
				{ x: cx - circleR - gap - tw, y: cy - th / 2, pos: 'left' }
			];

			// Score each candidate: prefer ones fully within bounds
			var best = null;
			var bestScore = -Infinity;

			for (var i = 0; i < candidates.length; i++) {
				var c = candidates[i];
				var score = 0;

				// Check bounds
				var inLeft = c.x >= margin;
				var inRight = c.x + tw <= rect.width - margin;
				var inTop = c.y >= margin;
				var inBottom = c.y + th <= rect.height - margin;

				if (inLeft && inRight && inTop && inBottom) {
					score = 100;
				} else {
					// Partial score based on how much is visible
					if (inLeft) score += 10;
					if (inRight) score += 10;
					if (inTop) score += 10;
					if (inBottom) score += 10;
				}

				// Prefer above/below over left/right
				if (c.pos === 'above' || c.pos === 'below') score += 5;

				if (score > bestScore) {
					bestScore = score;
					best = c;
				}
			}

			// Clamp to container bounds
			var tx = Math.max(margin, Math.min(best.x, rect.width - tw - margin));
			var ty = Math.max(margin, Math.min(best.y, rect.height - th - margin));

			this.tooltip.style.left = tx + 'px';
			this.tooltip.style.top = ty + 'px';
			this.tooltip.classList.add('visible');
		}

		hideTooltip() {
			this.tooltip.classList.remove('visible');
			if (this.tapCircle) {
				this.tapCircle.remove();
				this.tapCircle = null;
			}
		}
	};

	document.addEventListener('DOMContentLoaded', function() {
		new window.ChartRenderer('chartContainer', 'chartSvg');
	});
})();
