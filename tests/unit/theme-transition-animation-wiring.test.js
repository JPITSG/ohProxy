'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');
const STYLES_FILE = path.join(PROJECT_ROOT, 'public', 'styles.css');

describe('Theme Transition Animation Wiring', () => {
	it('adds theme transition lifecycle helpers and accessibility guards', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const THEME_TRANSITION_CLASS = 'theme-transitioning';/);
		assert.match(app, /const THEME_TRANSITION_ACTIVE_CLASS = 'theme-transition-active';/);
		assert.match(app, /const THEME_TRANSITION_OVERLAY_COLOR_VAR = '--theme-transition-overlay-color';/);
		assert.match(app, /const THEME_TRANSITION_DURATION_MS = 220;/);
		assert.match(app, /function shouldAnimateThemeTransition\(themeChanged\) \{[\s\S]*?if \(!themeChanged \|\| !themeTransitionsEnabled\) return false;[\s\S]*?if \(document\.documentElement\.classList\.contains\('slim'\)\) return false;[\s\S]*?window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches[\s\S]*?return true;\s*\}/);
		assert.match(app, /function beginThemeTransition\(\) \{[\s\S]*?const previousBg = getComputedStyle\(body\)\.backgroundColor \|\| 'transparent';[\s\S]*?body\.style\.setProperty\(THEME_TRANSITION_OVERLAY_COLOR_VAR, previousBg\);[\s\S]*?themeTransitionCleanupTimer = setTimeout\(\(\) => \{[\s\S]*?finishThemeTransition\(\);[\s\S]*?\}, THEME_TRANSITION_DURATION_MS \+ THEME_TRANSITION_CLEANUP_BUFFER_MS\);/);
		assert.match(app, /function finishThemeTransition\(\) \{[\s\S]*?body\.classList\.remove\(THEME_TRANSITION_ACTIVE_CLASS\);[\s\S]*?body\.classList\.remove\(THEME_TRANSITION_CLASS\);[\s\S]*?body\.style\.removeProperty\(THEME_TRANSITION_OVERLAY_COLOR_VAR\);/);
	});

	it('animates only after bootstrap and keeps mode normalization intact', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function setTheme\(mode, syncToServer = true\) \{[\s\S]*?const resolvedMode = isLight \? 'light' : 'dark';[\s\S]*?const themeChanged = isLight !== wasLight;[\s\S]*?if \(shouldAnimateThemeTransition\(themeChanged\)\) \{\s*beginThemeTransition\(\);\s*\} else if \(themeChanged\) \{\s*finishThemeTransition\(\);\s*\}/);
		assert.match(app, /try \{ localStorage\.setItem\('ohTheme', resolvedMode\); \}/);
		assert.match(app, /reloadChartIframes\(resolvedMode\);\s*reloadWebviewIframes\(resolvedMode\);/);
		assert.match(app, /function initTheme\(forcedMode\) \{[\s\S]*?setTheme\(mode, false\);[\s\S]*?serverSettingsLoaded = true;[\s\S]*?themeTransitionsEnabled = true;/);
	});

	it('styles a global fade overlay with reduced-motion fallback', () => {
		const css = fs.readFileSync(STYLES_FILE, 'utf8');
		assert.match(css, /body\.theme-transitioning::before \{[\s\S]*?position: fixed;[\s\S]*?inset: 0;[\s\S]*?background: var\(--theme-transition-overlay-color, transparent\);[\s\S]*?opacity: 1;[\s\S]*?pointer-events: none;/);
		assert.match(css, /body\.theme-transitioning\.theme-transition-active::before \{[\s\S]*?opacity: 0;[\s\S]*?transition: opacity 220ms ease;/);
		assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?body\.theme-transitioning\.theme-transition-active::before \{[\s\S]*?transition-duration: 1ms;/);
	});
});
