'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// URL and label helpers replicated from server.js

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function stripIconVersion(pathname) {
	let out = pathname;
	out = out.replace(/\/v\d+\//i, '/');
	out = out.replace(/\.v\d+(?=\.)/i, '');
	return out;
}

function ensureJsonParam(url) {
	if (!url) return url;
	if (url.includes('type=json')) return url;
	return url + (url.includes('?') ? '&' : '?') + 'type=json';
}

function getRequestPath(req) {
	const direct = safeText(req?.path || '').trim();
	if (direct) return direct;
	const raw = safeText(req?.originalUrl || '').trim();
	if (!raw) return '';
	const q = raw.indexOf('?');
	return q === -1 ? raw : raw.slice(0, q);
}

let liveConfig = { ohTarget: 'http://example.com' };

function normalizeOpenhabPath(link) {
	const text = safeText(link);
	if (!text) return '';
	try {
		const base = new URL(liveConfig.ohTarget);
		const u = new URL(text, base);
		let out = u.pathname || '/';
		const basePath = base.pathname && base.pathname !== '/' ? base.pathname.replace(/\/$/, '') : '';
		if (basePath && out.startsWith(basePath)) out = out.slice(basePath.length) || '/';
		return `${out}${u.search || ''}`;
	} catch {
		let out = text.startsWith('/') ? text : `/${text}`;
		try {
			const base = new URL(liveConfig.ohTarget);
			const basePath = base.pathname && base.pathname !== '/' ? base.pathname.replace(/\/$/, '') : '';
			if (basePath && out.startsWith(basePath)) out = out.slice(basePath.length) || '/';
		} catch {}
		return out;
	}
}

function splitLabelState(label) {
	const raw = safeText(label);
	const match = raw.match(/^(.*)\s*\[(.+)\]\s*$/);
	if (!match) return { title: raw, state: '' };
	return { title: match[1].trim(), state: match[2].trim() };
}

function labelPathSegments(label) {
	const parts = splitLabelState(label);
	const segs = [];
	if (parts.title) segs.push(parts.title);
	if (parts.state) segs.push(parts.state);
	return segs;
}

describe('URL and Label Helpers', () => {
	describe('stripIconVersion', () => {
		it('removes /vNN/ segment', () => {
			assert.strictEqual(stripIconVersion('/openhab.app/images/v12/icon.png'), '/openhab.app/images/icon.png');
		});

		it('removes /vNN/ at root', () => {
			assert.strictEqual(stripIconVersion('/v2/icon.png'), '/icon.png');
		});

		it('removes .vNN before extension', () => {
			assert.strictEqual(stripIconVersion('/images/icon.v12.png'), '/images/icon.png');
		});

		it('removes .v0 before extension', () => {
			assert.strictEqual(stripIconVersion('/images/icon.v0.svg'), '/images/icon.svg');
		});

		it('only removes first /vNN/ occurrence', () => {
			assert.strictEqual(stripIconVersion('/v1/icons/v2/icon.png'), '/icons/v2/icon.png');
		});

		it('matches uppercase V in path', () => {
			assert.strictEqual(stripIconVersion('/V12/icon.png'), '/icon.png');
		});

		it('matches uppercase V in filename', () => {
			assert.strictEqual(stripIconVersion('/images/icon.V9.png'), '/images/icon.png');
		});

		it('leaves path unchanged when no version', () => {
			assert.strictEqual(stripIconVersion('/images/icon.png'), '/images/icon.png');
		});

		it('does not match vNN without trailing slash', () => {
			assert.strictEqual(stripIconVersion('/v12icon/icon.png'), '/v12icon/icon.png');
		});

		it('does not remove .vNN without trailing dot', () => {
			assert.strictEqual(stripIconVersion('/images/icon.v12'), '/images/icon.v12');
		});

		it('handles nested paths with versions', () => {
			assert.strictEqual(stripIconVersion('/a/v3/b/c.v4.png'), '/a/b/c.png');
		});
	});

	describe('ensureJsonParam', () => {
		it('returns null as-is', () => {
			assert.strictEqual(ensureJsonParam(null), null);
		});

		it('returns empty string as-is', () => {
			assert.strictEqual(ensureJsonParam(''), '');
		});

		it('adds type=json without query', () => {
			assert.strictEqual(ensureJsonParam('/rest/items'), '/rest/items?type=json');
		});

		it('adds type=json with existing query', () => {
			assert.strictEqual(ensureJsonParam('/rest/items?foo=1'), '/rest/items?foo=1&type=json');
		});

		it('keeps url unchanged when type=json present', () => {
			assert.strictEqual(ensureJsonParam('/rest/items?type=json'), '/rest/items?type=json');
		});

		it('keeps url unchanged when type=json appears later', () => {
			assert.strictEqual(ensureJsonParam('/rest/items?foo=1&type=json&bar=2'), '/rest/items?foo=1&type=json&bar=2');
		});

		it('does not treat type=Json as already present', () => {
			assert.strictEqual(ensureJsonParam('/rest/items?type=Json'), '/rest/items?type=Json&type=json');
		});

		it('does not append when type=json is in path string', () => {
			assert.strictEqual(ensureJsonParam('/type=json/path'), '/type=json/path');
		});

	});

	describe('getRequestPath', () => {
		it('uses req.path when present', () => {
			const req = { path: '/direct', originalUrl: '/ignored?x=1' };
			assert.strictEqual(getRequestPath(req), '/direct');
		});

		it('trims whitespace from req.path', () => {
			const req = { path: '  /trim  ', originalUrl: '/fallback' };
			assert.strictEqual(getRequestPath(req), '/trim');
		});

		it('falls back to originalUrl', () => {
			const req = { path: '', originalUrl: '/fallback' };
			assert.strictEqual(getRequestPath(req), '/fallback');
		});

		it('strips query from originalUrl', () => {
			const req = { path: '', originalUrl: '/fallback?x=1&y=2' };
			assert.strictEqual(getRequestPath(req), '/fallback');
		});

		it('returns empty string when no data', () => {
			assert.strictEqual(getRequestPath({}), '');
		});

		it('returns empty string for null request', () => {
			assert.strictEqual(getRequestPath(null), '');
		});
	});

	describe('normalizeOpenhabPath', () => {
		it('returns empty for empty input', () => {
			liveConfig = { ohTarget: 'http://example.com' };
			assert.strictEqual(normalizeOpenhabPath(''), '');
		});

		it('removes base path for absolute URL', () => {
			liveConfig = { ohTarget: 'http://example.com/openhab' };
			const link = 'http://example.com/openhab/rest/sitemaps/home';
			assert.strictEqual(normalizeOpenhabPath(link), '/rest/sitemaps/home');
		});

		it('removes base path for relative URL with prefix', () => {
			liveConfig = { ohTarget: 'http://example.com/openhab' };
			assert.strictEqual(normalizeOpenhabPath('/openhab/rest/items'), '/rest/items');
		});

		it('keeps path without base prefix', () => {
			liveConfig = { ohTarget: 'http://example.com/openhab' };
			assert.strictEqual(normalizeOpenhabPath('/rest/items'), '/rest/items');
		});

		it('handles relative path without leading slash', () => {
			liveConfig = { ohTarget: 'http://example.com/openhab' };
			assert.strictEqual(normalizeOpenhabPath('rest/items'), '/rest/items');
		});

		it('preserves query string', () => {
			liveConfig = { ohTarget: 'http://example.com/openhab' };
			assert.strictEqual(normalizeOpenhabPath('/openhab/rest/items?type=json'), '/rest/items?type=json');
		});

		it('handles base path root', () => {
			liveConfig = { ohTarget: 'http://example.com' };
			assert.strictEqual(normalizeOpenhabPath('/rest/items'), '/rest/items');
		});

		it('returns / when link equals base path', () => {
			liveConfig = { ohTarget: 'http://example.com/openhab' };
			assert.strictEqual(normalizeOpenhabPath('/openhab'), '/');
		});

		it('handles base path with trailing slash', () => {
			liveConfig = { ohTarget: 'http://example.com/openhab/' };
			assert.strictEqual(normalizeOpenhabPath('/openhab/rest/items'), '/rest/items');
		});

		it('falls back on invalid URL by prefixing slash', () => {
			liveConfig = { ohTarget: 'http://example.com/openhab' };
			assert.strictEqual(normalizeOpenhabPath('::bad::path'), '/::bad::path');
		});

		it('fallback removes base path when possible', () => {
			liveConfig = { ohTarget: 'http://example.com/openhab' };
			assert.strictEqual(normalizeOpenhabPath('openhab/rest/items'), '/rest/items');
		});
	});

	describe('splitLabelState', () => {
		it('splits title and state', () => {
			assert.deepStrictEqual(splitLabelState('Temp [23]'), { title: 'Temp', state: '23' });
		});

		it('splits without spaces', () => {
			assert.deepStrictEqual(splitLabelState('Temp[23]'), { title: 'Temp', state: '23' });
		});

		it('keeps spaces inside state', () => {
			assert.deepStrictEqual(splitLabelState('Temp [23 C]'), { title: 'Temp', state: '23 C' });
		});

		it('returns full label when no brackets', () => {
			assert.deepStrictEqual(splitLabelState('NoState'), { title: 'NoState', state: '' });
		});

		it('handles empty title', () => {
			assert.deepStrictEqual(splitLabelState('  [state]  '), { title: '', state: 'state' });
		});

		it('does not split when trailing text exists', () => {
			assert.deepStrictEqual(splitLabelState('Title [state] extra'), { title: 'Title [state] extra', state: '' });
		});

		it('handles empty string', () => {
			assert.deepStrictEqual(splitLabelState(''), { title: '', state: '' });
		});

		it('handles null input', () => {
			assert.deepStrictEqual(splitLabelState(null), { title: '', state: '' });
		});

		it('trims whitespace around title and state', () => {
			assert.deepStrictEqual(splitLabelState('  Title  [  state  ]  '), { title: 'Title', state: 'state' });
		});
	});

	describe('labelPathSegments', () => {
		it('returns title and state segments', () => {
			assert.deepStrictEqual(labelPathSegments('Temp [23]'), ['Temp', '23']);
		});

		it('returns only title when no state', () => {
			assert.deepStrictEqual(labelPathSegments('Temp'), ['Temp']);
		});

		it('returns only state when title empty', () => {
			assert.deepStrictEqual(labelPathSegments(' [23]'), ['23']);
		});

		it('returns empty array for empty input', () => {
			assert.deepStrictEqual(labelPathSegments(''), []);
		});

		it('trims whitespace in segments', () => {
			assert.deepStrictEqual(labelPathSegments('  Title  [  State  ] '), ['Title', 'State']);
		});
	});
});
