'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SESSIONS_FILE = path.join(PROJECT_ROOT, 'sessions.js');

describe('Keyed Config Write Consolidation', () => {
	it('defines a shared keyed helper with strict allowlisted targets', () => {
		const source = fs.readFileSync(SESSIONS_FILE, 'utf8');
		assert.match(source, /const KEYED_CONFIG_TARGETS = Object\.freeze\(\{/);
		assert.match(source, /widget_glow_rules:\s*\{\s*keyColumn:\s*'widget_id',\s*valueColumn:\s*'rules'\s*\}/s);
		assert.match(source, /widget_visibility:\s*\{\s*keyColumn:\s*'widget_id',\s*valueColumn:\s*'visibility'\s*\}/s);
		assert.match(source, /widget_video_config:\s*\{\s*keyColumn:\s*'widget_id',\s*valueColumn:\s*'default_muted'\s*\}/s);
		assert.match(source, /widget_iframe_config:\s*\{\s*keyColumn:\s*'widget_id',\s*valueColumn:\s*'height'\s*\}/s);
		assert.match(source, /widget_proxy_cache:\s*\{\s*keyColumn:\s*'widget_id',\s*valueColumn:\s*'cache_seconds'\s*\}/s);
		assert.match(source, /widget_card_width:\s*\{\s*keyColumn:\s*'widget_id',\s*valueColumn:\s*'width'\s*\}/s);
		assert.match(source, /sitemap_visibility:\s*\{\s*keyColumn:\s*'sitemap_name',\s*valueColumn:\s*'visibility'\s*\}/s);
		assert.match(source, /function upsertOrDeleteKeyedConfig\(\{ table, keyColumn, valueColumn, keyValue, value, shouldDelete \}\) \{/);
		assert.match(source, /const target = KEYED_CONFIG_TARGETS\[table\];/);
		assert.match(source, /if \(!target \|\| target\.keyColumn !== keyColumn \|\| target\.valueColumn !== valueColumn\) \{/);
		assert.match(source, /throw new Error\(`Invalid keyed config target: \$\{table\}\.\$\{keyColumn\}\.\$\{valueColumn\}`\);/);
	});

	it('keeps widget-scoped helper as a wrapper around the keyed helper', () => {
		const source = fs.readFileSync(SESSIONS_FILE, 'utf8');
		assert.match(source, /function upsertOrDeleteWidgetConfig\(\{ table, column, widgetId, value, shouldDelete \}\) \{/);
		assert.match(source, /upsertOrDeleteKeyedConfig\(\{/);
		assert.match(source, /keyColumn: 'widget_id',\s*valueColumn: column,\s*keyValue: widgetId,/s);
	});

	it('routes all widget setters through the shared helper', () => {
		const source = fs.readFileSync(SESSIONS_FILE, 'utf8');
		assert.match(source, /function setGlowRules\(widgetId, rules\) \{/);
		assert.match(source, /table: 'widget_glow_rules',\s*column: 'rules'/);
		assert.match(source, /function setVisibility\(widgetId, visibility, visibilityUsers = \[\]\) \{/);
		assert.match(source, /function upsertVisibilityConfig\(\{\s*table, keyColumn, keyValue, visibility, visibilityUsers, shouldDelete\s*\}\) \{/s);
		assert.match(source, /table: 'widget_visibility',\s*keyColumn: 'widget_id'/s);
		assert.match(source, /function setVideoConfig\(widgetId, defaultMuted\) \{/);
		assert.match(source, /table: 'widget_video_config',\s*column: 'default_muted'/);
		assert.match(source, /function setIframeConfig\(widgetId, height\) \{/);
		assert.match(source, /table: 'widget_iframe_config',\s*column: 'height'/);
		assert.match(source, /function setProxyCacheConfig\(widgetId, cacheSeconds\) \{/);
		assert.match(source, /table: 'widget_proxy_cache',\s*column: 'cache_seconds'/);
		assert.match(source, /function setCardWidth\(widgetId, width\) \{/);
		assert.match(source, /table: 'widget_card_width',\s*column: 'width'/);
		assert.match(source, /function setSitemapVisibility\(sitemapName, visibility, visibilityUsers = \[\]\) \{/);
		assert.match(source, /table: 'sitemap_visibility',\s*keyColumn: 'sitemap_name'/s);
	});

	it('keeps insert-on-conflict SQL centralized in one helper', () => {
		const source = fs.readFileSync(SESSIONS_FILE, 'utf8');
		assert.match(source, /INSERT INTO \$\{table\} \(\$\{keyColumn\}, \$\{valueColumn\}, updated_at\) VALUES \(\?, \?, \?\)/);
		assert.doesNotMatch(source, /INSERT INTO widget_glow_rules \(widget_id, rules, updated_at\)/);
		assert.doesNotMatch(source, /INSERT INTO widget_visibility \(widget_id, visibility, updated_at\)/);
		assert.doesNotMatch(source, /INSERT INTO widget_video_config \(widget_id, default_muted, updated_at\)/);
		assert.doesNotMatch(source, /INSERT INTO widget_iframe_config \(widget_id, height, updated_at\)/);
		assert.doesNotMatch(source, /INSERT INTO widget_proxy_cache \(widget_id, cache_seconds, updated_at\)/);
		assert.doesNotMatch(source, /INSERT INTO widget_card_width \(widget_id, width, updated_at\)/);
		assert.doesNotMatch(source, /INSERT INTO sitemap_visibility \(sitemap_name, visibility, updated_at\)/);
	});
});
