'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const appJs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const swJs = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');

describe('logout login navigation', () => {
	it('routes HTML-auth logout to /login instead of the cached app-shell root', () => {
		assert.match(appJs, /window\.location\.href = '\/login\?logout=1';/);
		assert.doesNotMatch(appJs, /window\.location\.href = '\/';/);
	});

	it('serves /login before the auth middleware can redirect non-root HTML requests', () => {
		const loginRoute = serverJs.indexOf("app.get('/login'");
		const authMiddleware = serverJs.indexOf('app.use((req, res, next) => {', serverJs.indexOf("app.post('/api/auth/login'"));
		assert.ok(loginRoute !== -1, 'missing direct /login route');
		assert.ok(authMiddleware !== -1, 'missing auth middleware');
		assert.ok(loginRoute < authMiddleware, '/login route should be registered before auth middleware');
		const routeBody = serverJs.slice(loginRoute, authMiddleware);
		assert.match(routeBody, /setCsrfCookie\(res, csrfToken\);/);
		assert.match(routeBody, /res\.setHeader\('Cache-Control', 'no-store'\);/);
		assert.match(routeBody, /res\.send\(renderLoginHtml\(\)\);/);
	});

	it('keeps normal app-shell navigations local-first in the service worker', () => {
		assert.match(swJs, /if \(cachedShell\) \{\s*appShellRefresh = fetchAndCacheAppShell\(request\)\.catch\(\(\) => \{\}\);/);
		assert.match(swJs, /return cachedShell;/);
	});
});
