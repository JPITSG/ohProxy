'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const APP_FILE = path.join(PROJECT_ROOT, 'public', 'app.js');

describe('Search OR operator wiring', () => {
	it('parses || branches with optional surrounding whitespace', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /function parseSearchQuery\(rawQuery\) \{\s*const text = safeText\(rawQuery\)\.trim\(\)\.toLowerCase\(\);\s*if \(!text\) return \{ text: '', branches: null, glowColor: '' \};\s*if \(!text\.includes\('\|\|'\)\) return \{ text, branches: null, glowColor: normalizeMainSearchGlowColor\(text\) \};\s*const branches = text\.split\('\|\|'\)\.map\(\(part\) => part\.trim\(\)\)\.filter\(Boolean\);\s*if \(!branches\.length\) return \{ text, branches: null, glowColor: normalizeMainSearchGlowColor\(text\) \};\s*return \{ text, branches, glowColor: '' \};\s*\}/);
	});

	it('matches any OR branch while preserving literal substring semantics per branch and supporting glow color branches', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const MAIN_SEARCH_GLOW_COLORS = new Set\(\['red', 'green', 'orange'\]\);/);
		assert.match(app, /function matchesMainSearchGlowColor\(widget, color\) \{[\s\S]*getWidgetGlowOverride\(widgetKey\(widget\), widgetGlowStateValue\(widget\)\)[\s\S]*return currentGlowColor === glowColor;[\s\S]*\}/);
		assert.match(app, /function searchQueryUsesMainSearchGlow\(query\) \{[\s\S]*query\.branches\.some\(\(branch\) => normalizeMainSearchGlowColor\(branch\)\);[\s\S]*\}/);
		assert.match(app, /function matchesSearchQuery\(haystack, query, widget = null\) \{\s*const hay = safeText\(haystack\)\.toLowerCase\(\);\s*if \(!query\?\.text\) return true;\s*if \(!Array\.isArray\(query\.branches\) \|\| !query\.branches\.length\) \{\s*if \(query\.glowColor\) return matchesMainSearchGlowColor\(widget, query\.glowColor\);\s*return hay\.includes\(query\.text\);\s*\}\s*return query\.branches\.some\(\(branch\) => \{\s*const glowColor = normalizeMainSearchGlowColor\(branch\);\s*if \(glowColor\) return matchesMainSearchGlowColor\(widget, glowColor\);\s*return hay\.includes\(branch\);\s*\}\);\s*\}/);
	});

	it('uses the shared OR matcher for widgets and frame labels during render', () => {
		const app = fs.readFileSync(APP_FILE, 'utf8');
		assert.match(app, /const searchQuery = parseSearchQuery\(state\.filter\);\s*const q = searchQuery\.text;\s*const rawSource = q \? \(state\.searchWidgets \|\| state\.rawWidgets\) : state\.rawWidgets;/);
		assert.match(app, /const hay = `\$\{widgetLabel\(w\)\} \$\{widgetState\(w\)\} \$\{widgetType\(w\)\} \$\{w\?\.item\?\.name \|\| ''\}`\.toLowerCase\(\);\s*return matchesSearchQuery\(hay, searchQuery, w\);/);
		assert.match(app, /if \(!matchesSearchQuery\(frameLabel, searchQuery\)\) continue;\s*frameKeys\.add\(frameKeyFor\(f\.path, frameLabel\)\);/);
		assert.match(app, /if \(!matchesSearchQuery\(frameLabel, searchQuery\)\) continue;\s*const groupLabel = searchGroupLabel\(\{ __path: f\.path, __frame: frameLabel \}\);/);
		assert.match(app, /const usesGlowSearch = searchQueryUsesMainSearchGlow\(searchQuery\);\s*const refreshTargets = usesGlowSearch \? source\.filter\(widgetHasMainSearchGlowRules\) : widgets;\s*refreshSearchStates\(refreshTargets, \{ force: shouldForceMainSearchGlowStateRefresh\(searchQuery\) \}\)/);
	});
});
