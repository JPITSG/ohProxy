'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function read(relPath) {
	return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

describe('Admin password settings wiring', () => {
	it('adds PASSWORD section above PREFERENCES in the user group', () => {
		const app = read('public/app.js');
		const passwordSectionIndex = app.indexOf("id: 'user-password'");
		const preferencesSectionIndex = app.indexOf("id: 'user-preferences'");

		assert.ok(passwordSectionIndex !== -1, 'missing user-password section');
		assert.ok(preferencesSectionIndex !== -1, 'missing user-preferences section');
		assert.ok(passwordSectionIndex < preferencesSectionIndex, 'user-password section should be above user-preferences');
		assert.match(app, /id:\s*'user-password',\s*group:\s*'user',\s*reloadRequired:\s*true/, 'missing reloadRequired bubble flag for user-password section');
		assert.match(app, /id:\s*'user-password'[\s\S]*\{\s*key:\s*'user\.password',\s*type:\s*'password'\s*\}/, 'missing user.password field');
		assert.match(app, /id:\s*'user-password'[\s\S]*\{\s*key:\s*'user\.confirm',\s*type:\s*'password'\s*\}/, 'missing user.confirm field');
		assert.match(app, /id:\s*'user-preferences'[\s\S]*\{\s*key:\s*'user\.mapviewRendering',\s*type:\s*'select'/, 'missing user.mapviewRendering field');
	});

	it('adds language strings for password fields and logout alert', () => {
		const lang = read('public/lang.js');
		assert.match(lang, /'user-password': 'PASSWORD'/, 'missing PASSWORD section title');
		assert.match(lang, /'user\.password': 'Password'/, 'missing user.password label');
		assert.match(lang, /'user\.confirm': 'Confirm'/, 'missing user.confirm label');
		assert.match(lang, /'user\.mapviewRendering': 'Mapview Rendering'/, 'missing user.mapviewRendering label');
		assert.match(lang, /passwordChangedHeader:\s*'Password Changed'/, 'missing password changed alert header');
		assert.match(lang, /passwordChangedBody:\s*'[^']*<br\/><br\/>[^']*'/, 'missing line break in password changed alert body');
		assert.match(lang, /passwordChangedContinueBtn:\s*'Continue'/, 'missing Continue button label');
	});

	it('handles passwordChanged save responses with logout alert flow', () => {
		const app = read('public/app.js');
		assert.match(app, /if\s*\(result\.passwordChanged\)/, 'missing passwordChanged response handling');
		assert.match(app, /ohLang\.adminConfig\.passwordChangedBody/, 'missing password changed alert body usage');
		assert.match(app, /showClose:\s*false/, 'password changed alert should hide close button');
		assert.match(app, /dismissOnBackdrop:\s*false/, 'password changed alert should disable backdrop dismissal');
		assert.match(app, /dismissOnEscape:\s*false/, 'password changed alert should disable escape dismissal');
		assert.match(app, /logoutAndRedirectToLogin\(\)/, 'missing password changed logout redirect handler');
		assert.match(app, /window\.location\.href = '\/api\/logout';/, 'missing basic-auth logout redirect');
		assert.match(app, /window\.location\.href = '\/';/, 'missing HTML-auth login redirect');
	});
});
