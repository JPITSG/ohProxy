'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');

describe('Weather Smooth Slide Wiring', () => {
	it('renders forecast cards inside a sliding forecast track', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /<div class="forecast-container">\s*<div class="forecast-track">\s*\$\{forecastCards\}\s*<\/div>\s*<\/div>/);
	});

	it('styles the forecast track for transform-based animation with reduced-motion fallback', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /\.forecast-track \{[\s\S]*?display: flex;[\s\S]*?gap: 12px;[\s\S]*?transform: translate3d\(0, 0, 0\);[\s\S]*?transition: transform 0\.26s ease;[\s\S]*?will-change: transform;/);
		assert.match(server, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.forecast-track \{[\s\S]*?transition: none;/);
	});

	it('drives paging via translate3d instead of visible-class toggles', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /var track = container\.querySelector\('\.forecast-track'\);/);
		assert.match(server, /maxFit = Math\.max\(1, Math\.min\(cards\.length, Math\.floor\(\(contentWidth \+ 12\) \/ 104\)\)\);/);
		assert.match(server, /track\.style\.transform = 'translate3d\(' \+ \(-offsetX\) \+ 'px,0,0\)'/);
		assert.match(server, /if \(dots\[i\] === dot\) \{ startIndex = i; fitCards\(true\); break; \}/);
		assert.match(server, /if \(delta < 0\) startIndex = Math\.min\(startIndex \+ 1, maxStart\);/);
		assert.match(server, /else startIndex = Math\.max\(startIndex - 1, 0\);/);
		assert.doesNotMatch(server, /if \(i >= startIndex && i < startIndex \+ maxFit\) cards\[i\]\.classList\.add\('visible'\);/);
		assert.doesNotMatch(server, /else cards\[i\]\.classList\.remove\('visible'\);/);
	});

	it('renders a client-side updated-age footer that avoids overlapping pager dots', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /function renderWeatherWidget\(weatherData, mode, slim, updatedAtMs\) \{/);
		assert.match(server, /const updatedAtAttr = Number\.isFinite\(updatedAtMs\) && updatedAtMs > 0\s*\? String\(Math\.floor\(updatedAtMs\)\)\s*: '';/);
		assert.match(server, /<div class="forecast-footer">\s*<div class="forecast-dots"><\/div>\s*<div class="weather-updated" data-updated-at="\$\{updatedAtAttr\}" aria-live="off"><\/div>\s*<\/div>/);
		assert.match(server, /\.weather-updated \{[\s\S]*?right: 0;[\s\S]*?top: 50%;[\s\S]*?opacity: 0\.3;[\s\S]*?white-space: nowrap;/);
		assert.match(server, /function formatUpdatedAgo\(updatedAt\) \{[\s\S]*?return amount \+ ' ' \+ unit \+ \(amount === 1 \? '' : 's'\) \+ ' ago';[\s\S]*?\}/);
		assert.match(server, /var rightSpace = Math\.floor\(\(footerWidth - dotsWidth\) \/ 2\) - 8;\s*fits = updatedWidth <= rightSpace;/);
		assert.match(server, /updatedEl\.textContent = 'Updated ' \+ formatUpdatedAgo\(updatedAt\);/);
		assert.match(server, /updatedEl\.hidden = !fits;/);
	});

	it('renders a hero band with current conditions and inline SVG scene', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /<div class="hero-scene"\$\{heroDesc \? [^\n]*\}>\$\{sceneSvg\}<\/div>/);
		assert.match(server, /<span class="hero-temp-val">\$\{currentTempStr\}<\/span>/);
		assert.match(server, /<div class="hero-chips">\$\{chipsHtml\}<\/div>/);
		// Hero text values are escaped at the interpolation site
		assert.match(server, /<div class="hero-desc" data-oh-tooltip="\$\{escapeHtml\(heroDesc\)\}" data-oh-tooltip-overflow="self">\$\{escapeHtml\(heroDesc\)\}<\/div>/);
		assert.match(server, /<div class="hero-sub" data-oh-tooltip="\$\{escapeHtml\(heroSub\)\}" data-oh-tooltip-overflow="self">\$\{escapeHtml\(heroSub\)\}<\/div>/);
	});

	it('renders per-day temperature range bars scaled to the forecast span', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /<div class="day-range"><span class="day-range-fill" style="\$\{rangeStyle\}"><\/span><\/div>/);
		assert.match(server, /const weekMin = Math\.min\(\.\.\.lows\);/);
		assert.match(server, /const weekMax = Math\.max\(\.\.\.highs\);/);
		assert.match(server, /background-position-x:\$\{bgPos\}%/);
	});

	it('uses inline SVG icons instead of remote icon images', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /function weatherIconSvg\(group, opts = \{\}\) \{/);
		assert.match(server, /<div class="day-icon"[^>]*>\$\{dayIconSvg\}<\/div>/);
		assert.doesNotMatch(server, /<img class="weather-icon"/);
	});

	it('draws the night moon in its own coordinates with the lunation phase', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		const start = server.indexOf('function weatherIconSvg(group, opts = {}) {');
		const end = server.indexOf('\n}\n', start) + 3;
		assert.ok(start >= 0 && end > start);
		const weatherIconSvg = new Function(`${server.slice(start, end)}; return weatherIconSvg;`)();
		const moonPath = (opts) => {
			const svg = weatherIconSvg('clear', { night: true, ...opts });
			const match = svg.match(/<path d="(M0 -11\.5A11\.5 11\.5 0 0 [01] 0 11\.5A[^"]+)" fill="url\(#wxMoon\)"([^>]*)\/>/);
			assert.ok(match, svg);
			return { d: match[1], attrs: match[2] };
		};

		assert.doesNotMatch(server, /wxCrescent|mask="url\(#wx/);
		// Waxing: lit limb on the right (sweep 1); crescent terminator bulges right, gibbous left
		assert.equal(moonPath({ moonLunation: 0.12 }).d, 'M0 -11.5A11.5 11.5 0 0 1 0 11.5A8.38 11.5 0 0 0 0 -11.5Z');
		assert.equal(moonPath({ moonLunation: 0.25 }).d, 'M0 -11.5A11.5 11.5 0 0 1 0 11.5A0 11.5 0 0 1 0 -11.5Z');
		assert.equal(moonPath({ moonLunation: 0.37 }).d, 'M0 -11.5A11.5 11.5 0 0 1 0 11.5A7.87 11.5 0 0 1 0 -11.5Z');
		// Full moon: both halves lit
		assert.equal(moonPath({ moonLunation: 0.5 }).d, 'M0 -11.5A11.5 11.5 0 0 0 0 11.5A11.5 11.5 0 0 0 0 -11.5Z');
		// Waning: lit limb on the left (sweep 0)
		assert.equal(moonPath({ moonLunation: 0.62 }).d, 'M0 -11.5A11.5 11.5 0 0 0 0 11.5A8.38 11.5 0 0 0 0 -11.5Z');
		assert.equal(moonPath({ moonLunation: 0.88 }).d, 'M0 -11.5A11.5 11.5 0 0 0 0 11.5A8.38 11.5 0 0 1 0 -11.5Z');
		// Southern hemisphere mirrors the lit side; northern does not
		assert.equal(moonPath({ moonLunation: 0.12 }).attrs, '');
		assert.equal(moonPath({ moonLunation: 0.12, southern: true }).attrs, ' transform="scale(-1 1)"');
		assert.match(server, /southern: Number\(forecastData\?\.lat\) < 0,/);
	});

	it('disables animation and transitions in slim mode', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /\$\{slim \? `[\s\S]*?\.forecast-track \{\s*transition: none !important;\s*will-change: auto !important;\s*\}[\s\S]*?animation: none !important;[\s\S]*?` : ''\}/);
	});
});
