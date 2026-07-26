'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('Shared tooltip system', () => {
	it('ships versioned tooltip assets in the app shell and server-rendered pages', () => {
		const index = read('public/index.html');
		const sw = read('public/sw.js');
		const server = read('server.js');

		assert.match(index, /ui-tooltips\.__CSS_VERSION__\.css/);
		assert.match(index, /ui-tooltips\.__JS_VERSION__\.js/);
		assert.match(sw, /'\.\/ui-tooltips\.__CSS_VERSION__\.css'/);
		assert.match(sw, /'\.\/ui-tooltips\.__JS_VERSION__\.js'/);
		assert.match(server, /const UI_TOOLTIPS_JS_PATH = path\.join\(PUBLIC_DIR, 'ui-tooltips\.js'\);/);
		assert.match(server, /const UI_TOOLTIPS_CSS_PATH = path\.join\(PUBLIC_DIR, 'ui-tooltips\.css'\);/);
		assert.match(server, /app\.get\(\/\^\\\/ui-tooltips\\\.v\[\\w\.\-\]\+\\\.js\$\/i/);
		assert.match(server, /app\.get\(\/\^\\\/ui-tooltips\\\.v\[\\w\.\-\]\+\\\.css\$\/i/);
		assert.ok((server.match(/ui-tooltips\.\$\{assetVersion\}\.css/g) || []).length >= 3);
		assert.ok((server.match(/ui-tooltips\.\$\{assetVersion\}\.js/g) || []).length >= 3);
	});

	it('matches the chart tooltip surface and uses a fixed unclipped portal', () => {
		const css = read('public/ui-tooltips.css');
		const chartCss = read('public/chart.css');

		for (const declaration of [
			'border-radius: 10px;',
			'padding: 0.5rem 0.75rem;',
			'font-size: .7rem;',
			'font-weight: 500;',
			'transform: translateY(8px);',
			'transition:',
		]) {
			assert.ok(css.includes(declaration), `shared tooltip is missing ${declaration}`);
			assert.ok(chartCss.includes(declaration), `chart tooltip is missing ${declaration}`);
		}
		assert.match(css, /\.oh-tooltip \{[\s\S]*position: fixed;[\s\S]*pointer-events: none;/);
		assert.match(css, /\.oh-tooltip\.visible \{[\s\S]*opacity: 1;[\s\S]*visibility: visible;/);
		assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
		assert.match(read('public/ui-tooltips.js'), /tooltip\.setAttribute\('role', 'tooltip'\);/);
	});

	it('delegates hover and focus behavior and avoids accidental touch-swipe tooltips', () => {
		const js = read('public/ui-tooltips.js');

		assert.match(js, /document\.addEventListener\('pointerover'/);
		assert.match(js, /document\.addEventListener\('focusin'/);
		assert.match(js, /document\.addEventListener\('focusout'/);
		assert.match(js, /document\.addEventListener\('scroll', hide, true\);/);
		assert.match(js, /if \(dx \* dx \+ dy \* dy > 100\) touchMoved = true;/);
		assert.match(js, /const activeTouchPointers = new Set\(\);/);
		assert.match(js, /if \(activeTouchPointers\.size > 1\) \{\s*touchGestureBlocked = true;/);
		assert.match(js, /if \(!wasTracked \|\| !wasPrimary \|\| suppress\) return;/);
		assert.match(js, /target\.getAttribute\(TOUCH_ATTRIBUTE\) !== 'true'/);
		assert.match(js, /overflowSelector/);
		assert.match(js, /el\.scrollWidth > el\.clientWidth \+ 1/);
		assert.match(js, /positionActive\(\);\s*if \(wasVisible\) return;\s*[\s\S]*layer\.classList\.add\('visible'\);/);
		assert.doesNotMatch(js, /\brequestAnimationFrame\s*\(/, 'tooltip display must not stall in a backgrounded PWA page');
	});

	it('eliminates first-party native browser tooltips', () => {
		const index = read('public/index.html');
		const server = read('server.js');
		const scripts = [
			['public/app.js', read('public/app.js')],
			['public/chart.js', read('public/chart.js')],
			['public/video-dvr.js', read('public/video-dvr.js')],
		];

		assert.doesNotMatch(index, /\stitle="/);
		assert.doesNotMatch(server, /\stitle="/);
		for (const [name, source] of scripts) {
			const assignments = source
				.split('\n')
				.filter((line) => /\.title\s*=/.test(line) && !/document\.title\s*=/.test(line));
			assert.deepStrictEqual(assignments, [], `${name} still assigns a native title`);
			assert.doesNotMatch(source, /setAttribute\(['"]title['"]/);
		}
	});

	it('adds contextual tooltips to icon-only app, chart, media, and map controls', () => {
		const index = read('public/index.html');
		const app = read('public/app.js');
		const chart = read('public/chart.js');
		const server = read('server.js');

		for (const id of ['backBtn', 'homeBtn', 'voiceBtn', 'adminConfigBtn', 'logoutBtn', 'themeToggleBtn']) {
			assert.match(index, new RegExp(`<button id="${id}"[^>]*data-oh-tooltip=`));
			assert.match(index, new RegExp(`<button id="${id}"[^>]*aria-label=`));
		}
		assert.match(app, /setControlTooltip\(imageViewerClose, tooltipLabel\('closeImage'/);
		assert.match(app, /setControlTooltip\(imageViewerDownload, tooltipLabel\('downloadImage'/);
		assert.match(app, /setControlTooltip\(sendBtn, tooltipLabel\('sendValue'/);
		assert.match(app, /setControlTooltip\(eyeBtn, label\);/);
		assert.match(chart, /setChartControlLabel\(fsBtn, fsActive \? 'Exit fullscreen' : 'Enter fullscreen'\);/);
		assert.match(chart, /isRotated \? 'Reset chart orientation' : 'Rotate chart'/);
		for (const id of ['zoom-in', 'zoom-home', 'map-fullscreen', 'map-rotate', 'zoom-out', 'pb-back', 'pb-play', 'pb-pause', 'pb-stop', 'pb-forward']) {
			assert.match(server, new RegExp(`id="${id}"[^>]*data-oh-tooltip=`));
			assert.match(server, new RegExp(`id="${id}"[^>]*aria-label=`));
		}
	});

	it('keeps specialized tooltips, suppresses redundant labels, and exposes truncated text', () => {
		const app = read('public/app.js');
		const dvr = read('public/video-dvr.js');
		const server = read('server.js');

		assert.match(server, /id="chartNavTooltip"/);
		assert.match(server, /id="hover-tooltip" class="tooltip"/);
		assert.match(server, /data-tooltip-message="No earlier data"/);
		assert.match(app, /setControlTooltip\(el, text, \{ overflowSelector: '\.mapping-text' \}\);/);
		assert.match(app, /setControlTooltip\(el, text\);\s*\n\s*\};/);
		assert.match(app, /overflowSelector: '\.visibility-users-option-name'/);
		assert.match(app, /overflowSelector: '\.sitemap-select-option-title'/);
		assert.match(app, /setControlTooltip\(titleEl, labelParts\.title, \{\s*ariaLabel: false,\s*overflowSelector: 'self',\s*\}\);/);
		assert.match(app, /setControlTooltip\(pageSpan, headerTitle\.pageText, \{\s*ariaLabel: false,\s*overflowSelector: 'self',\s*\}\);/);
		assert.match(server, /id="chartTitle" data-oh-tooltip="\$\{safeTitle\}" data-oh-tooltip-overflow="self"/);
		assert.match(server, /class="hero-sub" data-oh-tooltip="\$\{escapeHtml\(heroSub\)\}" data-oh-tooltip-overflow="self"/);
		assert.doesNotMatch(dvr, /setDvrTooltip\(liveBtn/);
		assert.match(dvr, /liveBtn\.setAttribute\('aria-label', 'Jump to live'\);/);
	});

	it('makes weather semantics available to mouse, keyboard, touch, and assistive tech', () => {
		const server = read('server.js');

		assert.match(server, /class="chip" role="img" tabindex="0" data-oh-tooltip=/);
		assert.match(server, /class="forecast-day\$\{isToday \? ' today' : ''\}" role="group" tabindex="0" data-oh-tooltip=/);
		assert.match(server, /data-oh-tooltip-touch="true"/);
		assert.match(server, /Low \$\{lowTemp\} degrees, high \$\{highTemp\} degrees/);
		assert.match(server, /\$\{pop\}% chance of precipitation/);
	});
});
