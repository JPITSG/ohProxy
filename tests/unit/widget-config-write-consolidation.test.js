'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SESSIONS_FILE = path.join(PROJECT_ROOT, 'sessions.js');

describe('Widget Config Write Consolidation', () => {
	it('defines a shared helper with strict allowlisted targets', () => {
		const source = fs.readFileSync(SESSIONS_FILE, 'utf8');
		assert.match(source, /const WIDGET_CONFIG_TARGETS = Object\.freeze\(\{/);
		assert.match(source, /widget_glow_rules: 'rules'/);
		assert.match(source, /widget_visibility: 'visibility'/);
		assert.match(source, /widget_video_config: 'default_muted'/);
		assert.match(source, /widget_iframe_config: 'height'/);
		assert.match(source, /widget_proxy_cache: 'cache_seconds'/);
		assert.match(source, /widget_card_width: 'width'/);
		assert.match(source, /function upsertOrDeleteWidgetConfig\(\{ table, column, widgetId, value, shouldDelete \}\) \{/);
		assert.match(source, /if \(WIDGET_CONFIG_TARGETS\[table\] !== column\) \{/);
		assert.match(source, /throw new Error\(`Invalid widget config target: \$\{table\}\.\$\{column\}`\);/);
	});

	it('routes all widget setters through the shared helper', () => {
		const source = fs.readFileSync(SESSIONS_FILE, 'utf8');
		assert.match(source, /function setGlowRules\(widgetId, rules\) \{/);
		assert.match(source, /table: 'widget_glow_rules',\s*column: 'rules'/);
		assert.match(source, /function setVisibility\(widgetId, visibility\) \{/);
		assert.match(source, /table: 'widget_visibility',\s*column: 'visibility'/);
		assert.match(source, /function setVideoConfig\(widgetId, defaultMuted\) \{/);
		assert.match(source, /table: 'widget_video_config',\s*column: 'default_muted'/);
		assert.match(source, /function setIframeConfig\(widgetId, height\) \{/);
		assert.match(source, /table: 'widget_iframe_config',\s*column: 'height'/);
		assert.match(source, /function setProxyCacheConfig\(widgetId, cacheSeconds\) \{/);
		assert.match(source, /table: 'widget_proxy_cache',\s*column: 'cache_seconds'/);
		assert.match(source, /function setCardWidth\(widgetId, width\) \{/);
		assert.match(source, /table: 'widget_card_width',\s*column: 'width'/);
	});

	it('keeps insert-on-conflict SQL centralized in one helper', () => {
		const source = fs.readFileSync(SESSIONS_FILE, 'utf8');
		assert.match(source, /INSERT INTO \$\{table\} \(widget_id, \$\{column\}, updated_at\) VALUES \(\?, \?, \?\)/);
		assert.doesNotMatch(source, /INSERT INTO widget_glow_rules \(widget_id, rules, updated_at\)/);
		assert.doesNotMatch(source, /INSERT INTO widget_visibility \(widget_id, visibility, updated_at\)/);
		assert.doesNotMatch(source, /INSERT INTO widget_video_config \(widget_id, default_muted, updated_at\)/);
		assert.doesNotMatch(source, /INSERT INTO widget_iframe_config \(widget_id, height, updated_at\)/);
		assert.doesNotMatch(source, /INSERT INTO widget_proxy_cache \(widget_id, cache_seconds, updated_at\)/);
		assert.doesNotMatch(source, /INSERT INTO widget_card_width \(widget_id, width, updated_at\)/);
	});
});
