'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function read(relPath) {
	return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

describe('Flex gap fallback wiring for old Chromium', () => {
	it('detects flex-gap support and toggles no-flex-gap class', () => {
		const app = read('public/app.js');
		assert.match(app, /const supportsFlexGap = \(function\(\) \{[\s\S]*flex\.style\.rowGap = '1px';[\s\S]*flex\.scrollHeight === 1;/, 'missing runtime flex-gap detection');
		assert.match(app, /if \(!supportsFlexGap\) document\.documentElement\.classList\.add\('no-flex-gap'\);/, 'missing no-flex-gap root class toggle');
	});

	it('uses gap by default and scopes margin fallbacks to no-flex-gap', () => {
		const styles = read('public/styles.css');
		assert.match(styles, /\.oh-modal-footer \{[\s\S]*gap: 8px;/, 'oh modal footer should use gap by default');
		assert.match(styles, /\.card-config-footer \{[\s\S]*gap: 8px;/, 'card config footer should use gap by default');
		assert.match(styles, /\.admin-config-footer \{[\s\S]*gap: 8px;/, 'admin config footer should use gap by default');
		assert.match(styles, /html\.no-flex-gap \.oh-modal-footer button \+ button \{\s*margin-left: 8px;/, 'oh modal footer fallback should be scoped to no-flex-gap');
		assert.match(styles, /html\.no-flex-gap \.card-config-footer button \+ button,\s*html\.no-flex-gap \.admin-config-footer button \+ button \{\s*margin-left: 8px;/, 'config footer fallback should be scoped to no-flex-gap');
		assert.doesNotMatch(styles, /^\s*\.oh-modal-footer button \+ button \{/m, 'unscoped oh modal footer margin fallback should not exist');
		assert.doesNotMatch(styles, /^\s*\.card-config-footer button \+ button,\s*$/m, 'unscoped config footer margin fallback should not exist');
	});

	it('adds no-flex-gap vertical spacing fallbacks for modal setting stacks', () => {
		const styles = read('public/styles.css');
		assert.match(styles, /html\.no-flex-gap \.oh-modal-body > \* \+ \* \{\s*margin-top: 12px;/, 'missing oh modal body vertical fallback');
		assert.match(styles, /html\.no-flex-gap \.card-config-body > \* \+ \* \{\s*margin-top: 12px;/, 'missing card config body vertical fallback');
		assert.match(styles, /html\.no-flex-gap \.admin-config-section-body > \* \+ \* \{\s*margin-top: 12px;/, 'missing admin section body vertical fallback');
		assert.match(styles, /html\.no-flex-gap \.admin-config-field\.stacked > \* \+ \* \{\s*margin-top: 4px;/, 'missing stacked admin field vertical fallback');
		assert.match(styles, /html\.no-flex-gap \.admin-list-wrap > \* \+ \* \{\s*margin-top: 6px;/, 'missing admin list vertical fallback');
	});

	it('adds no-flex-gap horizontal spacing fallbacks for admin field/header rows', () => {
		const styles = read('public/styles.css');
		assert.match(styles, /html\.no-flex-gap \.admin-config-field:not\(\.stacked\) > \* \+ \* \{\s*margin-left: 12px;/, 'missing non-stacked admin field horizontal fallback');
		assert.match(styles, /html\.no-flex-gap \.admin-config-section-header > \* \+ \* \{\s*margin-left: 8px;/, 'missing admin section header horizontal fallback');
	});

	it('adds no-flex-gap fallbacks for card-config row and section gaps', () => {
		const styles = read('public/styles.css');
		assert.match(styles, /html\.no-flex-gap \.glow-rules-section > \* \+ \*,/, 'missing glow rules section vertical fallback selector');
		assert.match(styles, /html\.no-flex-gap \.iframe-height-section > \* \+ \*,/, 'missing iframe height section vertical fallback selector');
		assert.match(styles, /html\.no-flex-gap \.proxy-cache-section > \* \+ \* \{\s*margin-top: 8px;/, 'missing proxy cache section vertical fallback');
		assert.match(styles, /html\.no-flex-gap \.history-nav > \* \+ \* \s*\{\s*margin-left: 6px;/, 'missing history nav horizontal fallback');
		assert.match(styles, /html\.no-flex-gap \.glow-rule-row > \* \+ \*,\s*html\.no-flex-gap \.admin-list-row > \* \+ \* \{\s*margin-left: 6px;/, 'missing glow/admin list row horizontal fallback');
		assert.match(styles, /html\.no-flex-gap \.item-config-visibility > \* \+ \* \{\s*margin-left: 8px;/, 'missing item visibility horizontal fallback');
	});
});
