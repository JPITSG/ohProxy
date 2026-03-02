'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SESSIONS_FILE = path.join(PROJECT_ROOT, 'sessions.js');

describe('Sitemap Visibility Persistence Wiring', () => {
	it('creates sitemap visibility table in database initialization', () => {
		const source = fs.readFileSync(SESSIONS_FILE, 'utf8');
		assert.match(source, /CREATE TABLE IF NOT EXISTS sitemap_visibility \(/);
		assert.match(source, /sitemap_name TEXT PRIMARY KEY/);
		assert.match(source, /visibility TEXT NOT NULL DEFAULT 'all'/);
		assert.match(source, /users_json TEXT NOT NULL DEFAULT '\[\]'/);
	});

	it('exposes sitemap visibility getters and setters with validation', () => {
		const source = fs.readFileSync(SESSIONS_FILE, 'utf8');
		assert.match(source, /const SITEMAP_NAME_REGEX = \/\^\[A-Za-z0-9_-\]\{1,64\}\$\/;/);
		assert.match(source, /function getAllSitemapVisibilityRules\(\) \{/);
		assert.match(source, /SELECT sitemap_name, visibility, users_json FROM sitemap_visibility/);
		assert.match(source, /function setSitemapVisibility\(sitemapName, visibility, visibilityUsers = \[\]\) \{/);
		assert.match(source, /if \(!SITEMAP_NAME_REGEX\.test\(name\)\) return false;/);
		assert.match(source, /if \(!VALID_VISIBILITIES\.includes\(visibility\)\) return false;/);
		assert.match(source, /table: 'sitemap_visibility'/);
		assert.match(source, /const effectiveVisibility = visibility === 'users' && users.length === 0 \? 'all' : visibility;/);
	});

	it('exports sitemap visibility functions', () => {
		const source = fs.readFileSync(SESSIONS_FILE, 'utf8');
		assert.match(source, /getAllSitemapVisibilityRules,/);
		assert.match(source, /setSitemapVisibility,/);
	});
});
