(function() {
	var haptic = ohUtils.haptic;

	// Set theme from URL param, localStorage, or system preference
	var params = new URLSearchParams(window.location.search);
	var mode = params.get('mode');
	if (mode === 'dark' || mode === 'light') {
		document.documentElement.setAttribute('data-theme', mode);
	} else {
		var saved;
		try { saved = localStorage.getItem('ohTheme'); } catch (e) { /* storage blocked */ }
		var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
		document.documentElement.setAttribute('data-theme', saved || (prefersDark ? 'dark' : 'light'));
	}
	// Enable animations only when parent iframe has not opted out
	var noAnim = window.name === 'noanim' || (window.frameElement && window.frameElement.name === 'noanim');
	if (!noAnim) {
		document.documentElement.classList.add('chart-animated');
	}

	var CHART_DATE_FMT = window._chartDateFormat || 'MMM Do, YYYY';
	var CHART_TIME_FMT = window._chartTimeFormat || 'H:mm:ss';
	var CHART_PERIOD = window._chartPeriod || 'D';
	var CHART_Y_PATTERN = window._chartYAxisPattern || null;
	var CHART_INTERP = window._chartInterpolation || 'linear';
	var CHART_SERIES = Array.isArray(window._chartSeries) ? window._chartSeries : [];
	var CHART_IS_MULTI_SERIES = window._chartIsMultiSeries === true || CHART_SERIES.length > 1;
	if (!CHART_SERIES.length && Array.isArray(window._chartData)) {
		CHART_SERIES = [{ item: '', label: '', colorIndex: 0, points: window._chartData }];
	}
	var SERIES_PALETTE_LIGHT = ['#b91c1c', '#1d4ed8', '#0f766e', '#7c3aed', '#c2410c', '#be185d', '#15803d', '#0369a1', '#a16207', '#4f46e5', '#9d174d', '#166534'];
	var SERIES_PALETTE_DARK = ['#f87171', '#60a5fa', '#34d399', '#c084fc', '#fb923c', '#f472b6', '#4ade80', '#22d3ee', '#facc15', '#a5b4fc', '#f9a8d4', '#2dd4bf'];
	function getSeriesColor(index) {
		var palette = document.documentElement.getAttribute('data-theme') === 'light' ? SERIES_PALETTE_LIGHT : SERIES_PALETTE_DARK;
		var i = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
		return palette[i % palette.length];
	}

		function parseBasePeriodSeconds(p) {
			// Simple / multiplied
			var sm = p.match(/^(\d*)([hDWMY])$/);
			if (sm) {
				var mul = sm[1] ? parseInt(sm[1], 10) : 1;
				var uSec = { h: 3600, D: 86400, W: 604800, M: 2592000, Y: 31536000 };
				return mul * uSec[sm[2]];
			}
			// ISO 8601
			var im = p.match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
			if (im) {
				var sec = (parseInt(im[1] || 0) * 31536000) + (parseInt(im[2] || 0) * 2592000)
					+ (parseInt(im[3] || 0) * 604800) + (parseInt(im[4] || 0) * 86400)
					+ (parseInt(im[5] || 0) * 3600) + (parseInt(im[6] || 0) * 60) + parseInt(im[7] || 0);
				return sec > 0 ? sec : 0;
			}
			return 0;
		}

		function parsePeriodSeconds(p) {
			if (typeof p !== 'string') return 0;
			var raw = p.trim();
			if (!raw) return 0;
			var dashCount = (raw.match(/-/g) || []).length;
			if (dashCount > 1) return 0;
			if (dashCount === 1) {
				var parts = raw.split('-');
				var past = parts[0];
				var future = parts[1];
				var pastSec = past ? parseBasePeriodSeconds(past) : 0;
				var futureSec = future ? parseBasePeriodSeconds(future) : 0;
				if (past && !pastSec) return 0;
				if (future && !futureSec) return 0;
				if (!pastSec && !futureSec) return 0;
				return pastSec + futureSec;
			}
			return parseBasePeriodSeconds(raw);
		}

		// Classify any period string into a display tier for x-axis formatting
		function periodDurationTier(p) {
			var sec = parsePeriodSeconds(p);
			if (!sec) return 'hD';
			if (sec <= 86400) return 'hD';
			if (sec <= 604800) return 'W';
			if (sec <= 7776000) return 'M';
			return 'Y';
		}
	var PERIOD_TIER = periodDurationTier(CHART_PERIOD);

	// Java DecimalFormat-compatible formatter
	function javaDecimalFormat(pattern, number) {
		if (typeof number !== 'number' || !Number.isFinite(number)) {
			return String(number);
		}
		// Handle positive/negative subpatterns
		var subpatterns = [];
		var inQuote = false;
		var splitIdx = -1;
		for (var i = 0; i < pattern.length; i++) {
			if (pattern[i] === "'") { inQuote = !inQuote; continue; }
			if (!inQuote && pattern[i] === ';') { splitIdx = i; break; }
		}
		if (splitIdx >= 0) {
			subpatterns = [pattern.substring(0, splitIdx), pattern.substring(splitIdx + 1)];
		} else {
			subpatterns = [pattern];
		}

		var isNeg = number < 0 || (1 / number === -Infinity);
		var pat = isNeg && subpatterns.length > 1 ? subpatterns[1] : subpatterns[0];
		var absNum = Math.abs(number);

		// Parse prefix, body, suffix by scanning for first/last format char
		var firstFmt = -1, lastFmt = -1;
		inQuote = false;
		for (var i = 0; i < pat.length; i++) {
			if (pat[i] === "'") { inQuote = !inQuote; continue; }
			if (!inQuote && /[0#.,E]/.test(pat[i])) {
				if (firstFmt < 0) firstFmt = i;
				lastFmt = i;
			}
		}
		if (firstFmt < 0) return pat; // no format chars

		var prefixRaw = pat.substring(0, firstFmt);
		var body = pat.substring(firstFmt, lastFmt + 1);
		var suffixRaw = pat.substring(lastFmt + 1);

		// Unquote helper
		function unquote(s) {
			var r = '', q = false;
			for (var i = 0; i < s.length; i++) {
				if (s[i] === "'") { q = !q; continue; }
				r += s[i];
			}
			return r;
		}
		var prefix = unquote(prefixRaw);
		var suffix = unquote(suffixRaw);

		function hasUnquotedPercent(rawText) {
			var quoted = false;
			for (var idx = 0; idx < rawText.length; idx++) {
				if (rawText[idx] === "'") { quoted = !quoted; continue; }
				if (!quoted && rawText[idx] === '%') return true;
			}
			return false;
		}
		if (hasUnquotedPercent(prefixRaw) || hasUnquotedPercent(suffixRaw)) {
			absNum *= 100;
		}

		// Scientific notation
		var eIdx = body.indexOf('E');
		if (eIdx >= 0) {
			var mantissaPat = body.substring(0, eIdx);
			// Count decimals in mantissa pattern
			var dotIdx = mantissaPat.indexOf('.');
			var mantDec = 0;
			if (dotIdx >= 0) {
				mantDec = mantissaPat.length - dotIdx - 1;
			}
			if (absNum === 0) {
				var result = (0).toFixed(mantDec) + 'E0';
			} else {
				var expParts = absNum.toExponential().split('e');
				var mantissa = parseFloat(expParts[0]);
				var exp = parseInt(expParts[1], 10);
				if (!Number.isFinite(mantissa) || !Number.isFinite(exp)) {
					var fallbackExp = Math.floor(Math.log10(absNum));
					var fallbackScale = Math.pow(10, fallbackExp);
					if (!Number.isFinite(fallbackScale) || fallbackScale === 0) {
						var fallbackParts = absNum.toExponential(15).split('e');
						mantissa = parseFloat(fallbackParts[0]);
						exp = parseInt(fallbackParts[1], 10);
					} else {
						mantissa = absNum / fallbackScale;
						exp = fallbackExp;
					}
				}
				var mantissaText = Number.isFinite(mantissa) ? mantissa.toFixed(mantDec) : (0).toFixed(mantDec);
				var mantissaNum = parseFloat(mantissaText);
				if (Number.isFinite(mantissaNum) && mantissaNum >= 10) {
					exp += 1;
					mantissaText = (mantissaNum / 10).toFixed(mantDec);
				}
				var result = mantissaText + 'E' + exp;
				// Normalize negative zero
				if (parseFloat(result.split('E')[0]) === 0 && result.charAt(0) === '-') {
					result = result.substring(1);
				}
			}
			var negPrefix = isNeg && subpatterns.length === 1 ? '-' : '';
			var formatted = negPrefix + prefix + result + suffix;
			// Normalize negative zero
			if (isNeg && parseFloat(formatted.replace(/[^0-9.eE+-]/g, '')) === 0) {
				return prefix + result + suffix;
			}
			return formatted;
		}

		// Determine decimal digits from pattern
		var dotPos = body.indexOf('.');
		var intPart = dotPos >= 0 ? body.substring(0, dotPos) : body;
		var decPart = dotPos >= 0 ? body.substring(dotPos + 1) : '';

		// Count forced (0) and optional (#) decimal digits
		var minDec = 0, maxDec = 0;
		for (var i = 0; i < decPart.length; i++) {
			if (decPart[i] === '0') { minDec++; maxDec++; }
			else if (decPart[i] === '#') { maxDec++; }
		}

		// Grouping: find last comma position in integer pattern
		var groupSize = 0;
		var lastComma = intPart.lastIndexOf(',');
		if (lastComma >= 0) {
			groupSize = intPart.length - lastComma - 1;
			// Remove commas for counting
			intPart = intPart.replace(/,/g, '');
		}

		// Min integer digits (count of 0s in integer part)
		var minInt = 0;
		for (var i = 0; i < intPart.length; i++) {
			if (intPart[i] === '0') minInt++;
		}
		if (minInt === 0) minInt = 1; // always at least one digit

		// Round to maxDec
		var rounded = maxDec >= 0 ? parseFloat(absNum.toFixed(maxDec)) : absNum;
		var parts = rounded.toFixed(maxDec).split('.');
		var intStr = parts[0];
		var decStr = parts.length > 1 ? parts[1] : '';

		// Pad integer to min digits
		while (intStr.length < minInt) intStr = '0' + intStr;

		// Trim trailing zeros in decimal beyond minDec
		if (decStr.length > minDec) {
			var trimmed = decStr.substring(0, minDec) + decStr.substring(minDec).replace(/0+$/, '');
			decStr = trimmed;
		}

		// Apply grouping
		if (groupSize > 0 && intStr.length > groupSize) {
			var grouped = '';
			var count = 0;
			for (var i = intStr.length - 1; i >= 0; i--) {
				if (count > 0 && count % groupSize === 0) grouped = ',' + grouped;
				grouped = intStr[i] + grouped;
				count++;
			}
			intStr = grouped;
		}

		var result = decStr ? intStr + '.' + decStr : intStr;

		// Negative prefix for single-pattern mode
		var negPrefix = isNeg && subpatterns.length === 1 ? '-' : '';
		var formatted = negPrefix + prefix + result + suffix;

		// Normalize negative zero
		if (isNeg && parseFloat(result) === 0) {
			return prefix + result + suffix;
		}
		return formatted;
	}
	var MONTHS_S = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	var DAYS_S = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	function ordSuffix(n) {
		if (n >= 11 && n <= 13) return n + 'th';
		switch (n % 10) { case 1: return n + 'st'; case 2: return n + 'nd'; case 3: return n + 'rd'; default: return n + 'th'; }
	}
	function fmtDT(d, fmt) {
		var pad = function(n) { return String(n).padStart(2, '0'); };
		var h24 = d.getHours(), h12 = h24 % 12 || 12;
		var tokens = { YYYY: d.getFullYear(), MMM: MONTHS_S[d.getMonth()], Do: ordSuffix(d.getDate()), DD: pad(d.getDate()), HH: pad(h24), H: h24, hh: pad(h12), h: h12, mm: pad(d.getMinutes()), ss: pad(d.getSeconds()), A: h24 < 12 ? 'AM' : 'PM' };
		return fmt.replace(/YYYY|MMM|Do|DD|HH|H|hh|h|mm|ss|A/g, function(m) { return tokens[m]; });
	}

	function fmtXLabel(ts) {
		var d = new Date(ts);
		switch (PERIOD_TIER) {
			case 'hD': return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
			case 'W': return DAYS_S[d.getDay()];
			case 'M': return MONTHS_S[d.getMonth()] + ' ' + d.getDate();
			case 'Y': return MONTHS_S[d.getMonth()];
			default: return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
		}
	}

	window.ChartRenderer = class {
		constructor(containerId, svgId) {
			this.container = document.getElementById(containerId);
			this.svg = document.getElementById(svgId);
			this.tooltip = document.getElementById('tooltip');
				this.tooltipValue = document.getElementById('tooltipValue');
				this.tooltipLabel = document.getElementById('tooltipLabel');
				this.points = [];
				this.seriesSets = [];
				this.isMultiSeries = CHART_IS_MULTI_SERIES;
				this.layout = {};
				this.tapCircle = null;
			this.hideTimer = null;
			this.isTouching = false;
			this.touchMoved = false;
			this.wasDragging = false;
			this.tooltipCache = { w: 0, h: 0, contentLen: 0 };
			this.hasRenderedOnce = false;
			this.init();
		}

		init() {
			this.render();
			this.container.addEventListener('click', e => this.onClick(e));
			this.container.addEventListener('touchstart', e => this.onTouchStart(e), { passive: true });
			this.container.addEventListener('touchmove', e => this.onTouchMove(e), { passive: true });
			this.container.addEventListener('touchend', e => this.onTouchEnd(e));
			this.container.addEventListener('touchcancel', e => this.onTouchEnd(e));
			this.container.addEventListener('mousemove', e => this.onMouseMove(e));
			this.container.addEventListener('mouseleave', e => this.onMouseLeave(e));

			// Min/Max stat hover listeners
			var statMin = document.getElementById('statMin');
			var statMax = document.getElementById('statMax');
			if (statMin) {
				statMin.addEventListener('mouseenter', () => this.showStatTooltip(this.minPoint));
				statMin.addEventListener('mouseleave', () => this.hideTooltip());
			}
			if (statMax) {
				statMax.addEventListener('mouseenter', () => this.showStatTooltip(this.maxPoint));
				statMax.addEventListener('mouseleave', () => this.hideTooltip());
			}
			var statCur = document.getElementById('statCur');
			if (statCur) {
				statCur.addEventListener('mouseenter', () => this.showStatTooltip(this.curPoint));
				statCur.addEventListener('mouseleave', () => this.hideTooltip());
			}
			// Reformat legend stat values using yAxisDecimalPattern if set
			if (CHART_Y_PATTERN) {
				var statsEl = document.getElementById('chartStats');
				if (statsEl) {
					var unit = window._chartUnit ? ' ' + window._chartUnit : '';
					statsEl.querySelectorAll('.stat-value[data-raw]').forEach(function(el) {
						var raw = parseFloat(el.getAttribute('data-raw'));
						if (Number.isFinite(raw)) {
							el.textContent = javaDecimalFormat(CHART_Y_PATTERN, raw) + unit;
						}
					});
				}
			}
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
			var w = this.container.clientWidth || rect.width;
			var h = this.container.clientHeight || rect.height;
			if (!w || !h) {
				w = rect.width;
				h = rect.height;
			}
			var sm = w < 500;
			var animated = document.documentElement.classList.contains('chart-animated') && !this.hasRenderedOnce;
			this.svg.classList.toggle('chart-animated-once', animated);

			// Compute y-axis info once for this render
			var rawYValues = this.getYAxisValues(sm);
			var yAxisInfo = this.getYAxisRelevancy(rawYValues);
			var unitSuffix = this.getUnitSuffix();
			var yDecimals = this.getMajorityDecimals(yAxisInfo.values);
			var yAxisWidth = this.measureYAxisWidthWith(yAxisInfo.values, unitSuffix, yDecimals, sm);
			// Y-axis labels are at x=-margin with text-anchor:end
			// Left spacing (viewport to label) = margin
			// Gap (label to chart) = margin
			// So: leftPad = margin + yAxisWidth + margin = 2*margin + yAxisWidth
			var margin = Math.round(w * 0.02 * (sm ? 1.5 : 1)); // 2% of width, 50% larger on small viewports
			var leftPad = yAxisWidth + 2 * margin;
			var rightPad = margin;
			var xAxisSpace = sm ? 18 : 25; // matches x-axis label offset
			var topPad = sm ? margin + 5 : margin; // a little more on phone
			var bottomPad = sm ? xAxisSpace + margin : xAxisSpace + Math.round(margin * 0.6);
			var pad = { top: topPad, right: rightPad, bottom: bottomPad, left: leftPad };
			var cw = w - pad.left - pad.right;
			var ch = h - pad.top - pad.bottom;
			var iL = 0;
			var iR = 0;
			var dw = cw - iL - iR;

				this.layout = { sm: sm, pad: pad, cw: cw, ch: ch, iL: iL, dw: dw, margin: margin, containerRect: rect, yDecimals: yDecimals };
				this.tooltipCache = { w: 0, h: 0, contentLen: 0 }; // Reset cache on render
				this.svg.innerHTML = '';
				var rawSeriesData = Array.isArray(CHART_SERIES) ? CHART_SERIES : [];
				this.isMultiSeries = window._chartIsMultiSeries === true || rawSeriesData.length > 1;

				var $ = (t, a) => this.svg$(t, a);

				// Defs: gradient, masks, clip path
				var defs = $('defs', {});
				if (!this.isMultiSeries) {
					var grad = $('linearGradient', { id: 'areaGradient', x1: '0%', y1: '0%', x2: '0%', y2: '100%' });
					grad.appendChild($('stop', { offset: '0%', style: 'stop-color:var(--chart-gradient-start)' }));
					grad.appendChild($('stop', { offset: '50%', style: 'stop-color:var(--chart-gradient-start);stop-opacity:0.6' }));
					grad.appendChild($('stop', { offset: '100%', style: 'stop-color:var(--chart-gradient-end)' }));
					defs.appendChild(grad);
				}

				var clipPath = $('clipPath', { id: 'chartClip' });
				clipPath.appendChild($('rect', { x: '0', y: '0', width: cw, height: ch }));
				defs.appendChild(clipPath);

			this.svg.appendChild(defs);

			// Main group
			var g = $('g', { transform: 'translate(' + pad.left + ',' + pad.top + ')' });
			var hGridGroup = $('g', {});
			var vGridGroup = $('g', {});

			var rawRange = window._chartYMax - window._chartYMin;
			var isFlat = !Number.isFinite(rawRange) || Math.abs(rawRange) < 1e-10;
			var yRange = isFlat ? 1 : rawRange; // Avoid division by zero, but use isFlat for positioning

			// Y-axis grid and labels - calculate positions from pre-computed values
			var yValues = [];
			var yPositions = [];
			var yRelevantMap = [];

			for (var i = 0; i < rawYValues.length; i++) {
				var y = rawYValues[i];
				var yPos;
				if (isFlat) {
					yPos = ch / 2;
				} else if (sm) {
					yPos = rawYValues.length > 1
						? ch - (i / (rawYValues.length - 1)) * ch
						: ch / 2;
				} else {
					yPos = ch - ((y - window._chartYMin) / yRange) * ch;
				}
				// Filter by position bounds (only relevant for desktop with niceStep)
				if (yPos >= -5 && yPos <= ch + 5) {
					yValues.push(y);
					yPositions.push(yPos);
					yRelevantMap.push(yAxisInfo.flags[i]);
				}
			}
			for (var i = 0; i < yValues.length; i++) {
				hGridGroup.appendChild($('line', { class: 'grid-line', x1: 0, y1: yPositions[i], x2: cw, y2: yPositions[i] }));
				var label = $('text', { class: 'axis-label', x: -margin, y: yPositions[i] + 4, 'text-anchor': 'end' });
				label.textContent = yRelevantMap[i] ? this.fmt(yValues[i], yDecimals) + unitSuffix : '';
				g.appendChild(label);
			}
			g.appendChild(hGridGroup);

			// X-axis grid and labels
			var maxXLabels = Math.min(window._chartXLabels.length, Math.floor(dw / 70));
			var xStep = Math.max(1, Math.ceil(window._chartXLabels.length / maxXLabels));
			window._chartXLabels.forEach((labelData, i) => {
				if (i % xStep !== 0 && i !== window._chartXLabels.length - 1) return;
				var labelText = typeof labelData === 'object' ? (labelData.ts ? fmtXLabel(labelData.ts) : labelData.text) : labelData;
				var labelPos = typeof labelData === 'object' ? labelData.pos : null;
				var isLast = i === window._chartXLabels.length - 1;
				var xPos = labelPos !== null
					? iL + (labelPos / 100) * dw
					: iL + (window._chartXLabels.length > 1 ? (i / (window._chartXLabels.length - 1)) * dw : dw / 2);
				vGridGroup.appendChild($('line', { class: 'grid-line', x1: xPos, y1: 0, x2: xPos, y2: ch }));
				// On small viewports, right-align the last label to the chart edge
				var anchor = (sm && isLast) ? 'end' : 'middle';
				var labelX = (sm && isLast) ? cw : xPos;
				var xLabelY = sm ? ch + 18 : ch + 25;
				var text = $('text', { class: 'axis-label', x: labelX, y: xLabelY, 'text-anchor': anchor });
				text.textContent = labelText;
				g.appendChild(text);
				});
				g.appendChild(vGridGroup);

				// Build per-series points array
				this.points = [];
				this.seriesSets = [];
				this.circleData = [];
				for (var s = 0; s < rawSeriesData.length; s++) {
					var seriesRaw = rawSeriesData[s];
					var seriesData = Array.isArray(seriesRaw && seriesRaw.points) ? seriesRaw.points : [];
					if (seriesData.length === 0) continue;
					var labelText = (typeof seriesRaw.label === 'string' && seriesRaw.label.trim())
						? seriesRaw.label.trim()
						: (typeof seriesRaw.item === 'string' && seriesRaw.item.trim() ? seriesRaw.item.trim() : ('Series ' + (s + 1)));
					var color = getSeriesColor(Number(seriesRaw.colorIndex));
					var seriesPoints = [];
					var seriesMin = null;
					var seriesMax = null;
					for (var i = 0; i < seriesData.length; i++) {
						var d = seriesData[i];
						var pt = {
							x: iL + (d.x / 100) * dw,
							y: isFlat ? ch / 2 : ch - ((d.y - window._chartYMin) / yRange) * ch,
							value: d.y,
							t: d.t,
							index: i,
							seriesIndex: s,
							seriesLabel: labelText,
							seriesColor: color
						};
						seriesPoints.push(pt);
						if (!seriesMin || pt.value < seriesMin.value) seriesMin = pt;
						if (!seriesMax || pt.value > seriesMax.value) seriesMax = pt;
					}
					if (seriesPoints.length) {
						this.seriesSets.push({
							index: s,
							label: labelText,
							color: color,
							points: seriesPoints,
							minPoint: seriesMin,
							maxPoint: seriesMax,
							curPoint: seriesPoints[seriesPoints.length - 1]
						});
					}
				}
				if (this.seriesSets.length) {
					this.points = this.seriesSets[0].points;
					this.minPoint = this.seriesSets[0].minPoint;
					this.maxPoint = this.seriesSets[0].maxPoint;
					this.curPoint = this.seriesSets[0].curPoint;
				} else {
					this.minPoint = null;
					this.maxPoint = null;
					this.curPoint = null;
				}

				// Draw chart if we have points
				if (this.seriesSets.length > 0) {
					var chartGroup = $('g', { 'clip-path': 'url(#chartClip)' });
					for (var s = 0; s < this.seriesSets.length; s++) {
						var series = this.seriesSets[s];
						var linePath = this.createPath(series.points);
						if (!linePath) continue;
						var glowPath = null;
						if (!this.isMultiSeries) {
							var areaPath = linePath + ' L ' + series.points[series.points.length - 1].x + ' ' + ch + ' L ' + series.points[0].x + ' ' + ch + ' Z';
							chartGroup.appendChild($('path', { class: 'chart-area', d: areaPath }));
							glowPath = $('path', { class: 'chart-line-glow', d: linePath });
							chartGroup.appendChild(glowPath);
						}
						var lineClass = this.isMultiSeries ? 'chart-line chart-line-series' : 'chart-line';
						var mainPath = $('path', { class: lineClass, d: linePath });
						if (this.isMultiSeries) {
							mainPath.style.stroke = series.color;
							mainPath.style.filter = 'none';
						}
						chartGroup.appendChild(mainPath);
						if (animated) {
							var pathLen = mainPath.getTotalLength();
							if (glowPath) {
								glowPath.style.strokeDasharray = pathLen;
								glowPath.style.strokeDashoffset = pathLen;
							}
							mainPath.style.strokeDasharray = pathLen;
							mainPath.style.strokeDashoffset = pathLen;
						}
					}
					g.appendChild(chartGroup);

					// Data points (desktop only, single-series mode)
					if (!sm && !this.isMultiSeries && this.points.length > 0) {
						var pointsGroup = $('g', { class: 'data-points' });

						// Collect grid X positions for interpolated points
						var gridXPositions = [];
						for (var i = 0; i < window._chartXLabels.length; i++) {
							var ld = window._chartXLabels[i];
							var lp = typeof ld === 'object' ? ld.pos : null;
							if (lp !== null) {
								gridXPositions.push({ x: iL + (lp / 100) * dw, delay: 0.6 + i * 0.025 });
							}
						}

						// Add min/max points
						var delays = ['0.5s', '0.55s'];
						[this.minPoint, this.maxPoint].forEach((pt, idx) => {
							var circle = $('circle', { class: 'data-point', cx: pt.x, cy: pt.y, r: 5 });
							circle.style.animationDelay = delays[idx];
							circle.dataset.idx = this.circleData.length;
							this.circleData.push(pt);
							pointsGroup.appendChild(circle);
						});

						// Add interpolated points at grid lines (two-pointer, O(n+m))
						var gridIdx = 0;
						for (var i = 1; i < this.points.length; i++) {
							var prev = this.points[i - 1];
							var curr = this.points[i];
							// Process grid positions within this segment
							while (gridIdx < gridXPositions.length && gridXPositions[gridIdx].x <= curr.x) {
								var gd = gridXPositions[gridIdx];
								if (gd.x >= prev.x) {
									var segXSpan = curr.x - prev.x;
									var t = Math.abs(segXSpan) > 1e-9 ? (gd.x - prev.x) / segXSpan : 1;
									if (!Number.isFinite(t)) t = 1;
									if (t < 0) t = 0;
									if (t > 1) t = 1;
									var interpY;
									var interpValue;
									if (CHART_INTERP === 'step') {
										var atBoundary = Math.abs(gd.x - curr.x) < 1e-4;
										interpY = atBoundary ? curr.y : prev.y;
										interpValue = atBoundary ? curr.value : prev.value;
									} else {
										interpY = prev.y + t * (curr.y - prev.y);
										interpValue = prev.value + t * (curr.value - prev.value);
									}
									var interpTime = prev.t + t * (curr.t - prev.t);
									var circle = $('circle', { class: 'data-point', cx: gd.x, cy: interpY, r: 5 });
									circle.style.animationDelay = gd.delay + 's';
									circle.dataset.idx = this.circleData.length;
									this.circleData.push({ x: gd.x, y: interpY, value: interpValue, t: interpTime });
									pointsGroup.appendChild(circle);
								}
								gridIdx++;
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
			if (w > 0 && h > 0) {
				this.hasRenderedOnce = true;
			}
		}

		createPath(pts) {
			if (!pts || pts.length === 0) return '';
			if (pts.length === 1) return 'M ' + pts[0].x + ' ' + pts[0].y;
			var path = ['M ' + pts[0].x + ' ' + pts[0].y];
			for (var i = 1; i < pts.length; i++) {
				if (CHART_INTERP === 'step') {
					path.push('L ' + pts[i].x + ' ' + pts[i - 1].y);
					path.push('L ' + pts[i].x + ' ' + pts[i].y);
				} else {
					path.push('L ' + pts[i].x + ' ' + pts[i].y);
				}
			}
			return path.join(' ');
		}

		niceStep(range, targetSteps) {
			// Guard against zero/tiny range to prevent infinite loops
			if (!range || !Number.isFinite(range) || range < 1e-10) return 1;
			var rough = range / targetSteps;
			var magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
			var residual = rough / magnitude;
			var nice = residual <= 1.5 ? 1 : residual <= 3 ? 2 : residual <= 7 ? 5 : 10;
			return nice * magnitude;
		}

		fmt(n, decimals) {
			if (!Number.isFinite(n)) return String(n);
			if (CHART_Y_PATTERN) return javaDecimalFormat(CHART_Y_PATTERN, n);
			var result;
			if (typeof decimals === 'number') {
				result = n.toFixed(decimals);
			} else if (n === 0) {
				return '0.0';
			} else if (Number.isInteger(n) || Math.abs(n - Math.round(n)) < 0.0001) {
				var r = Math.round(n);
				result = Math.abs(r) >= 100 ? r.toFixed(0) : r.toFixed(1);
			} else if (Math.abs(n) >= 100) {
				result = n.toFixed(0);
			} else if (Math.abs(n) >= 1) {
				result = n.toFixed(1);
			} else {
				result = n.toFixed(2);
			}
			// Normalize negative zero to positive zero
			if (result.charAt(0) === '-' && parseFloat(result) === 0) {
				return result.substring(1);
			}
			return result;
		}

		getDecimals(n) {
			if (!Number.isFinite(n)) return 0;
			if (n === 0) return 1;
			if (Number.isInteger(n) || Math.abs(n - Math.round(n)) < 0.0001) {
				return Math.abs(Math.round(n)) >= 100 ? 0 : 1;
			}
			if (Math.abs(n) >= 100) return 0;
			if (Math.abs(n) >= 1) return 1;
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
			// Ensure decimals are sufficient to distinguish values
			if (values.length > 1) {
				var maxDecimals = 4;
				while (majority < maxDecimals) {
					var formatted = new Set();
					for (var i = 0; i < values.length; i++) {
						formatted.add(values[i].toFixed(majority));
					}
					if (formatted.size >= Math.min(values.length, 2)) break;
					majority++;
				}
			}
			return majority;
		}

		getYAxisValues(sm) {
			var yRange = window._chartYMax - window._chartYMin;
			var numYLines = sm ? 5 : 6;
			var yValues = [];

			// Handle flat data (constant values) - threshold aligned with isFlat in render()
			if (!Number.isFinite(yRange) || Math.abs(yRange) < 1e-10) {
				yValues.push(window._chartYMin);
				return yValues;
			}

			if (sm) {
				for (var i = 0; i < 5; i++) {
					yValues.push(window._chartYMin + (yRange * i / 4));
				}
			} else {
				var yStep = this.niceStep(Math.abs(yRange), numYLines);
				var startY = Math.floor(window._chartYMin / yStep) * yStep;
				for (var y = startY; y <= window._chartYMax + yStep * 0.1; y += yStep) {
					if (y < window._chartYMin - yStep * 0.1) continue;
					yValues.push(y);
				}
			}

			return yValues;
		}

		getUnitSuffix() {
			return window._chartUnit ? ' ' + window._chartUnit : '';
		}

		getYAxisRelevancy(yValues) {
			var dMin = typeof window._chartDataMin === 'number' ? window._chartDataMin : window._chartYMin;
			var dMax = typeof window._chartDataMax === 'number' ? window._chartDataMax : window._chartYMax;
			var flags = yValues.map(function(v) {
				if (dMin === dMax) return true;
				if (dMin > 0 && v < 0) return false;
				if (dMax < 0 && v > 0) return false;
				return true;
			});
			var values = yValues.filter(function(v, i) { return flags[i]; });
			return { flags: flags, values: values.length > 0 ? values : yValues };
		}

		measureYAxisWidthWith(relevantValues, unitSuffix, yDecimals, sm) {
			if (relevantValues.length === 0) return sm ? 30 : 40;

			// Create temp text element to measure
			var tempText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
			tempText.setAttribute('class', 'axis-label');
			tempText.style.visibility = 'hidden';
			this.svg.appendChild(tempText);

			var maxWidth = 0;
			for (var i = 0; i < relevantValues.length; i++) {
				tempText.textContent = this.fmt(relevantValues[i], yDecimals) + unitSuffix;
				var bbox = tempText.getBBox();
				if (bbox.width > maxWidth) maxWidth = bbox.width;
			}

			this.svg.removeChild(tempText);
			return Math.ceil(maxWidth);
		}

			fmtTimestamp(ts) {
				var d = new Date(ts);
				return fmtDT(d, CHART_DATE_FMT + ' ' + CHART_TIME_FMT);
			}

			findClosestPointInArray(points, plotX) {
				if (!Array.isArray(points) || points.length === 0) return null;
				var closest = null;
				var minDist = Infinity;
				for (var i = 0; i < points.length; i++) {
					var dist = Math.abs(points[i].x - plotX);
					if (dist < minDist) {
						minDist = dist;
						closest = points[i];
					}
				}
				return closest;
			}

			findClosestPoint(clientX) {
				var rect = this.layout.containerRect;
				var x = clientX - rect.left - this.layout.pad.left;

				if (x < 0 || x > this.layout.cw || this.seriesSets.length === 0) {
					return null;
				}

				if (!this.isMultiSeries) {
					return this.findClosestPointInArray(this.points, x);
				}
				var best = null;
				var bestDist = Infinity;
				for (var s = 0; s < this.seriesSets.length; s++) {
					var seriesClosest = this.findClosestPointInArray(this.seriesSets[s].points, x);
					if (!seriesClosest) continue;
					var dist = Math.abs(seriesClosest.x - x);
					if (dist < bestDist) {
						bestDist = dist;
						best = seriesClosest;
					}
				}
				return best;
			}

			getLineYAtX(plotX, cursorY) {
				if (this.points.length === 0) return null;
			if (this.points.length === 1) return this.points[0].y;
			if (plotX <= this.points[0].x) return this.points[0].y;

			for (var i = 1; i < this.points.length; i++) {
				var prev = this.points[i - 1];
				var curr = this.points[i];
				if (plotX > curr.x && i < this.points.length - 1) continue;

				var xSpan = curr.x - prev.x;
				if (CHART_INTERP === 'step') {
					if (Math.abs(xSpan) <= 1e-9 || Math.abs(plotX - curr.x) < 1e-4) {
						if (typeof cursorY === 'number' && Number.isFinite(cursorY)) {
							var lo = Math.min(prev.y, curr.y);
							var hi = Math.max(prev.y, curr.y);
							return Math.max(lo, Math.min(hi, cursorY));
						}
						return curr.y;
					}
					return prev.y;
				}

				var t = Math.abs(xSpan) > 1e-9 ? (plotX - prev.x) / xSpan : 1;
				if (!Number.isFinite(t)) t = 1;
				if (t < 0) t = 0;
				if (t > 1) t = 1;
				return prev.y + t * (curr.y - prev.y);
				}
				return this.points[this.points.length - 1].y;
			}

			getLineYAtXForPoints(points, plotX, cursorY) {
				var originalPoints = this.points;
				this.points = Array.isArray(points) ? points : [];
				var y = this.getLineYAtX(plotX, cursorY);
				this.points = originalPoints;
				return y;
			}

			getClosestSeriesLinePoint(cursorX, cursorY) {
				if (!this.seriesSets.length) return null;
				var best = null;
				for (var s = 0; s < this.seriesSets.length; s++) {
					var series = this.seriesSets[s];
					if (!series || !series.points || series.points.length === 0) continue;
					var closest = this.findClosestPointInArray(series.points, cursorX);
					if (!closest) continue;
					var lineY = this.getLineYAtXForPoints(series.points, cursorX, cursorY);
					if (!Number.isFinite(lineY)) lineY = closest.y;
					var dist = Math.abs(cursorY - lineY);
					if (!best || dist < best.dist) {
						best = { point: closest, dist: dist };
					}
				}
				return best;
			}

		onClick(e) {
			if (!this.layout.sm) return;
			// Ignore clicks if we just finished a touch drag
			if (this.wasDragging) {
				this.wasDragging = false;
				return;
			}

			// Refresh containerRect in case iframe scrolled/repositioned
			this.layout.containerRect = this.container.getBoundingClientRect();

			var touch = e.changedTouches ? e.changedTouches[0] : e;
			var closest = this.findClosestPoint(touch.clientX);

			if (closest) {
				haptic();
				this.showTapCircle(closest);
				this.showMobileTooltip(closest);
				if (this.hideTimer) clearTimeout(this.hideTimer);
				this.hideTimer = setTimeout(() => this.hideTooltip(), 3000);
			} else {
				this.hideTooltip();
			}
		}

			onTouchStart(e) {
				if (!this.layout.sm || this.seriesSets.length === 0) return;

			// Refresh containerRect in case iframe scrolled/repositioned
			this.layout.containerRect = this.container.getBoundingClientRect();

			var touch = e.touches[0];
			var closest = this.findClosestPoint(touch.clientX);

			if (closest) {
				this.isTouching = true;
				this.touchMoved = false;
				this.showTapCircle(closest);
				this.showMobileTooltip(closest);
				if (this.hideTimer) clearTimeout(this.hideTimer);
			}
		}

		onTouchMove(e) {
			if (!this.isTouching) return;

			this.touchMoved = true;

			var touch = e.touches[0];
			var closest = this.findClosestPoint(touch.clientX);

			if (closest) {
				this.showTapCircle(closest);
				this.showMobileTooltip(closest);
			}
		}

		onTouchEnd(e) {
			if (!this.isTouching) return;

			this.isTouching = false;
			if (this.touchMoved) {
				this.wasDragging = true;
				// Keep tooltip visible for a bit after drag ends
				if (this.hideTimer) clearTimeout(this.hideTimer);
				this.hideTimer = setTimeout(() => this.hideTooltip(), 2000);
			}
		}

			onMouseMove(e) {
				// Skip on mobile or during touch interaction
				if (this.layout.sm || this.isTouching || this.seriesSets.length === 0) return;

				// Refresh containerRect in case iframe scrolled/repositioned
				this.layout.containerRect = this.container.getBoundingClientRect();

				var rect = this.layout.containerRect;
				var cursorX = e.clientX - rect.left - this.layout.pad.left;
				var cursorY = e.clientY - rect.top - this.layout.pad.top;
				if (this.isMultiSeries) {
					var lineHit = this.getClosestSeriesLinePoint(cursorX, cursorY);
					if (lineHit && lineHit.dist <= 20) {
						if (this.hideTimer) clearTimeout(this.hideTimer);
						this.showTapCircle(lineHit.point);
						this.showMobileTooltip(lineHit.point);
					} else {
						this.hideTooltip();
					}
					return;
				}

				var closest = this.findClosestPoint(e.clientX);
				if (closest) {
					// Check if cursor is within 20px of the visible line shape.
					var lineY = this.getLineYAtX(cursorX, cursorY);
					if (!Number.isFinite(lineY)) lineY = closest.y;
					var dist = Math.abs(cursorY - lineY);

					if (dist <= 20) {
						if (this.hideTimer) clearTimeout(this.hideTimer);
						this.showTapCircle(closest);
						this.showMobileTooltip(closest);
					} else {
						this.hideTooltip();
					}
				} else {
					this.hideTooltip();
				}
			}

			onMouseLeave(e) {
				if (this.layout.sm || this.isTouching) return;
				this.hideTooltip();
			}

			formatTooltipValue(pt, decimals) {
				var unit = window._chartUnit ? ' ' + window._chartUnit : '';
				var valueText = this.fmt(pt.value, decimals) + unit;
				if (this.isMultiSeries && pt.seriesLabel) {
					return pt.seriesLabel + ': ' + valueText;
				}
				return valueText;
			}

			showTapCircle(pt) {
				if (this.tapCircle) this.tapCircle.remove();
				var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
				circle.setAttribute('cx', pt.x + this.layout.pad.left);
				circle.setAttribute('cy', pt.y + this.layout.pad.top);
				circle.setAttribute('r', '5');
				circle.setAttribute('class', 'data-point');
				circle.style.opacity = '1';
				if (pt.seriesColor) {
					circle.style.stroke = pt.seriesColor;
					circle.style.filter = 'none';
				}
				this.svg.appendChild(circle);
				this.tapCircle = circle;
			}

		showTooltip(e, pt) {
			// Refresh rect in case iframe scrolled/repositioned
			var rect = this.layout.containerRect = this.container.getBoundingClientRect();
				var x = e.clientX - rect.left;
				var y = e.clientY - rect.top;

				var decimals = this.layout.yDecimals;
				this.tooltipValue.textContent = this.formatTooltipValue(pt, decimals);
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
				var decimals = this.layout.yDecimals;
				var valueText = this.formatTooltipValue(pt, decimals);
				var labelText = pt.t ? this.fmtTimestamp(pt.t) : '';
				this.tooltipValue.textContent = valueText;
				this.tooltipLabel.textContent = labelText;

			// Use cached dimensions if content length is similar (within 3 chars)
			var contentLen = valueText.length + labelText.length;
			var cache = this.tooltipCache;
			var tw, th;

			if (cache.w === 0 || Math.abs(contentLen - cache.contentLen) > 3) {
				// Measure tooltip dimensions while hidden
				this.tooltip.classList.remove('visible');
				this.tooltip.style.visibility = 'hidden';
				this.tooltip.style.display = 'block';

				var tooltipRect = this.tooltip.getBoundingClientRect();
				tw = tooltipRect.width;
				th = tooltipRect.height;

				this.tooltip.style.display = '';
				this.tooltip.style.visibility = '';

				cache.w = tw;
				cache.h = th;
				cache.contentLen = contentLen;
			} else {
				tw = cache.w;
				th = cache.h;
			}

			var rect = this.layout.containerRect || this.container.getBoundingClientRect();
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

			showStatTooltip(pt) {
				if (!pt) return;
				var rect = this.layout.containerRect || this.container.getBoundingClientRect();
				var decimals = this.layout.yDecimals;

				this.tooltipValue.textContent = this.formatTooltipValue(pt, decimals);
				this.tooltipLabel.textContent = pt.t ? this.fmtTimestamp(pt.t) : '';

			// Position tooltip near the point on the chart
			var tx = this.layout.pad.left + pt.x + 15;
			var ty = this.layout.pad.top + pt.y - 15;

			// Bounds checking
			if (tx + 120 > rect.width) tx = this.layout.pad.left + pt.x - 120;
			if (ty < 10) ty = this.layout.pad.top + pt.y + 15;

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

	// Check if title is truncated and hide stats if so
	function checkTitleOverflow() {
		var title = document.getElementById('chartTitle');
		var stats = document.getElementById('chartStats');
		if (!title || !stats) return;

		// Check if title is truncated (scrollWidth > clientWidth)
		var isOverflowing = title.scrollWidth > title.clientWidth;
		stats.querySelectorAll('.stat-item').forEach(function(el) {
			el.classList.toggle('hidden', isOverflowing);
		});
	}

	// Script is at end of body, DOM is ready - instantiate immediately
	var chartRenderer = new window.ChartRenderer('chartContainer', 'chartSvg');
	checkTitleOverflow();
	function reflowChartLayout() {
		if (chartRenderer && typeof chartRenderer.render === 'function') {
			chartRenderer.render();
		}
		checkTitleOverflow();
	}
	var chartReflowDebounceTimer = null;
	var chartReflowRafId = 0;
	var CHART_REFLOW_DEBOUNCE_MS = 64;
	function scheduleChartReflow() {
		if (chartReflowDebounceTimer) {
			clearTimeout(chartReflowDebounceTimer);
		}
		chartReflowDebounceTimer = window.setTimeout(function() {
			chartReflowDebounceTimer = null;
			if (chartReflowRafId && window.cancelAnimationFrame) {
				window.cancelAnimationFrame(chartReflowRafId);
				chartReflowRafId = 0;
			}
			if (window.requestAnimationFrame) {
				chartReflowRafId = window.requestAnimationFrame(function() {
					chartReflowRafId = 0;
					reflowChartLayout();
				});
				return;
			}
			reflowChartLayout();
		}, CHART_REFLOW_DEBOUNCE_MS);
	}
	window.addEventListener('orientationchange', scheduleChartReflow);
	window.addEventListener('resize', scheduleChartReflow);
	if (window.visualViewport) {
		window.visualViewport.addEventListener('resize', scheduleChartReflow);
	}

	// Fullscreen toggle (only when embedded in an iframe)
	(function() {
		if (window === window.top) return;

		var fsBtn = document.getElementById('chartFullscreen');
		var rotateBtn = document.getElementById('chartRotate');
		var fsDivider = document.getElementById('fsDivider');
		if (!fsBtn) return;
		fsBtn.style.display = 'flex';
		if (fsDivider) fsDivider.style.display = 'block';
		var isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

		var fsActive = false;
		var isRotated = false;
		var expandSvg = '<svg viewBox="0 0 24 24"><path d="M3 3h6v2H5v4H3V3zm12 0h6v6h-2V5h-4V3zM3 15h2v4h4v2H3v-6zm16 0h2v6h-6v-2h4v-4z"/></svg>';
		var minimizeSvg = '<svg viewBox="0 0 24 24"><path d="M9 3v6H3V7h4V3h2zm6 0h2v4h4v2h-6V3zM3 15h6v6H7v-4H3v-2zm12 0h6v2h-4v4h-2v-6z"/></svg>';
		function applyRotation() {
			if (isRotated) {
				document.body.classList.add('chart-fs-rotated');
			} else {
				document.body.classList.remove('chart-fs-rotated');
			}
			scheduleChartReflow();
		}
		function syncRotateButton() {
			if (!rotateBtn) return;
			rotateBtn.style.display = (isTouchDevice && fsActive) ? 'flex' : 'none';
		}
		if (rotateBtn) {
			rotateBtn.addEventListener('click', function() {
				if (!isTouchDevice || !fsActive) return;
				isRotated = !isRotated;
				applyRotation();
			});
		}

		fsBtn.addEventListener('click', function() {
			if (!fsActive) {
				window.parent.postMessage({ type: 'ohproxy-fullscreen-request' }, '*');
			} else {
				window.parent.postMessage({ type: 'ohproxy-fullscreen-exit' }, '*');
			}
		});

		window.addEventListener('message', function(e) {
			if (!e.data || e.data.type !== 'ohproxy-fullscreen-state') return;
			fsActive = !!e.data.active;
			fsBtn.innerHTML = fsActive ? minimizeSvg : expandSvg;
			if (!fsActive) {
				isRotated = false;
				applyRotation();
			} else {
				scheduleChartReflow();
			}
			syncRotateButton();
		});
		syncRotateButton();
	})();
})();
