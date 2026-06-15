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
		assert.match(server, /maxFit = Math\.max\(1, Math\.min\(cards\.length, Math\.floor\(\(contentWidth \+ 10\) \/ 80\)\)\);/);
		assert.match(server, /track\.style\.transform = 'translate3d\(' \+ \(-offsetX\) \+ 'px,0,0\)'/);
		assert.match(server, /if \(dots\[i\] === dot\) \{ startIndex = i; fitCards\(true\); break; \}/);
		assert.match(server, /if \(delta < 0\) startIndex = Math\.min\(startIndex \+ 1, maxStart\);/);
		assert.match(server, /else startIndex = Math\.max\(startIndex - 1, 0\);/);
		assert.doesNotMatch(server, /if \(i >= startIndex && i < startIndex \+ maxFit\) cards\[i\]\.classList\.add\('visible'\);/);
		assert.doesNotMatch(server, /else cards\[i\]\.classList\.remove\('visible'\);/);
	});

	it('renders a client-side updated-age footer that avoids overlapping pager dots', () => {
		const server = fs.readFileSync(SERVER_FILE, 'utf8');
		assert.match(server, /function renderWeatherWidget\(forecastData, mode, slim, updatedAtMs\) \{/);
		assert.match(server, /const updatedAtAttr = Number\.isFinite\(updatedAtMs\) && updatedAtMs > 0\s*\? String\(Math\.floor\(updatedAtMs\)\)\s*: '';/);
		assert.match(server, /<div class="forecast-footer">\s*<div class="forecast-dots"><\/div>\s*<div class="weather-updated" data-updated-at="\$\{updatedAtAttr\}" aria-live="off"><\/div>\s*<\/div>/);
		assert.match(server, /\.weather-updated \{[\s\S]*?right: 0;[\s\S]*?top: 50%;[\s\S]*?opacity: 0\.3;[\s\S]*?white-space: nowrap;/);
		assert.match(server, /function formatUpdatedAgo\(updatedAt\) \{[\s\S]*?return amount \+ ' ' \+ unit \+ \(amount === 1 \? '' : 's'\) \+ ' ago';[\s\S]*?\}/);
		assert.match(server, /var rightSpace = Math\.floor\(\(footerWidth - dotsWidth\) \/ 2\) - 8;\s*fits = updatedWidth <= rightSpace;/);
		assert.match(server, /updatedEl\.textContent = 'Updated ' \+ formatUpdatedAgo\(updatedAt\);/);
		assert.match(server, /updatedEl\.hidden = !fits;/);
	});
});
