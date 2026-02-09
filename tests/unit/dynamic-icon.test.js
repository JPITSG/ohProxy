'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Replicate iconCandidates() from app.js for testing
const ICON_VERSION = 'v3';

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function getHomeInlineIcon() {
	return ''; // inline icons not relevant for these tests
}

function iconCandidates(icon, itemState) {
	const cands = [];
	if (icon) {
		const inline = getHomeInlineIcon(icon);
		if (inline) cands.push(inline);
		const params = ['format=png'];
		if (itemState !== undefined && itemState !== '') {
			params.push(`state=${encodeURIComponent(itemState)}`);
		}
		cands.push(`icon/${ICON_VERSION}/${encodeURIComponent(icon)}?${params.join('&')}`);
	}
	return cands;
}

describe('iconCandidates', () => {
	it('returns unified endpoint URL with state when state provided', () => {
		const cands = iconCandidates('heating', 'ON');
		assert.strictEqual(cands.length, 1);
		assert.ok(cands[0].startsWith(`icon/${ICON_VERSION}/`));
		assert.ok(cands[0].includes('state=ON'));
		assert.ok(cands[0].includes('format=png'));
	});

	it('returns unified endpoint URL without state when no state', () => {
		const cands = iconCandidates('heating');
		assert.strictEqual(cands.length, 1);
		assert.ok(cands[0].startsWith(`icon/${ICON_VERSION}/`));
		assert.ok(!cands[0].includes('state='));
		assert.ok(cands[0].includes('format=png'));
	});

	it('returns unified endpoint URL without state for empty state', () => {
		const cands = iconCandidates('heating', '');
		assert.strictEqual(cands.length, 1);
		assert.ok(!cands[0].includes('state='));
	});

	it('URI-encodes icon name and state', () => {
		const cands = iconCandidates('my icon', 'ON OFF');
		assert.ok(cands[0].includes('my%20icon'));
		assert.ok(cands[0].includes('ON%20OFF'));
	});

	it('returns empty array when no icon', () => {
		const cands = iconCandidates('');
		assert.deepStrictEqual(cands, []);
	});

	it('returns empty array when icon is undefined', () => {
		const cands = iconCandidates(undefined);
		assert.deepStrictEqual(cands, []);
	});

	it('includes ICON_VERSION in the URL path', () => {
		const cands = iconCandidates('temperature', '22');
		assert.ok(cands[0].includes(`/${ICON_VERSION}/`));
	});

	it('only returns one candidate URL (no fallback cascade)', () => {
		const cands = iconCandidates('light', 'ON');
		assert.strictEqual(cands.length, 1);
	});
});
