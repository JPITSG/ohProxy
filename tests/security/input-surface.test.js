'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');
const SESSIONS_FILE = path.join(PROJECT_ROOT, 'sessions.js');

function readFile(filePath) {
	return fs.readFileSync(filePath, 'utf8');
}

function countMatches(content, regex) {
	const matches = content.match(regex);
	return matches ? matches.length : 0;
}

function findInputLines(content) {
	return content.split('\n').filter((line) => /req\.(query|body|params)\b/.test(line));
}

describe('Input Surface Coverage', () => {
	it('tracks all req.query/req.body/req.params usages in server.js', () => {
		const content = readFile(SERVER_FILE);
		const inputLines = findInputLines(content);
		const allowedPatterns = [
			/if\s*\(!isPlainObject\(req\.query\)\)/,
			/const\s+\{\s*username,\s*password\s*\}\s*=\s*req\.body\s*;/,
			/if\s*\(!isPlainObject\(req\.body\)\)/,
			/const\s+newSettings\s*=\s*req\.body\s*;/,
			/const\s+body\s*=\s*req\.body\s*;/,
			/const\s+rawWidgetId\s*=\s*req\.params\.widgetId\s*;/,
			/const\s+\{\s*widgetId,\s*rules,\s*visibility,\s*defaultMuted,\s*iframeHeight,\s*proxyCacheSeconds\s*\}\s*=\s*req\.body\s*;/,
			/const\s+\{\s*command\s*\}\s*=\s*req\.body\s*;/,
			/const\s+rawTheme\s*=\s*req\.query\?\.theme\s*;/,
			/const\s+rawRoot\s*=\s*typeof\s+req\.query\?\.root\s*===\s*'string'\s*\?\s*req\.query\.root\s*:\s*''\s*;/,
			/const\s+rawSitemap\s*=\s*typeof\s+req\.query\?\.sitemap\s*===\s*'string'\s*\?\s*req\.query\.sitemap\s*:\s*''\s*;/,
			/const\s+rawMode\s*=\s*typeof\s+req\.query\?\.mode\s*===\s*'string'\s*\?\s*req\.query\.mode\s*:\s*''\s*;/,
			/const\s+rawDelta\s*=\s*req\.query\?\.delta\s*;/,
			/const\s+rawUrl\s*=\s*req\.query\?\.url\s*;/,
			/const\s+rawItem\s*=\s*req\.query\?\.item\s*;/,
			/const\s+rawPeriod\s*=\s*req\.query\?\.period\s*;/,
			/const\s+rawMode\s*=\s*req\.query\?\.mode\s*;/,
			/const\s+rawTitle\s*=\s*req\.query\?\.title\s*;/,
			/const\s+raw\s*=\s*req\.query\?\.url\s*;/,
			/if\s*\(req\.query\?\.w\s*!==\s*undefined\s*&&\s*typeof\s+req\.query\.w\s*!==\s*'string'\s*\)/,
			/const\s+rawWidth\s*=\s*parseOptionalInt\(req\.query\?\.w,\s*\{\s*min:\s*0,\s*max:\s*10000\s*\}\)\s*;/,
			/if\s*\(req\.query\?\.w\s*!==\s*undefined\s*&&\s*!Number\.isFinite\(rawWidth\)\s*\)/,
			/if\s*\(req\.query\?\.cache\s*!==\s*undefined\s*&&\s*typeof\s+req\.query\.cache\s*!==\s*'string'\s*\)/,
			/const\s+cacheSeconds\s*=\s*parseOptionalInt\(req\.query\?\.cache,\s*\{\s*min:\s*0,\s*max:\s*86400\s*\}\)\s*;/,
			/if\s*\(req\.query\?\.cache\s*!==\s*undefined\s*&&\s*!Number\.isFinite\(cacheSeconds\)\s*\)/,
			/const\s+queryKeys\s*=\s*Object\.keys\(req\.query\)\s*;/,
			/const\s+rawState\s*=\s*req\.query\[itemName\]\s*;/,
			/const\s+month\s*=\s*parseInt\(req\.query\.month,\s*10\)\s*;/,
			/const\s+day\s*=\s*parseInt\(req\.query\.day,\s*10\)\s*;/,
			/const\s+year\s*=\s*parseInt\(req\.query\.year,\s*10\)\s*;/,
			/const\s+lat\s*=\s*parseFloat\(req\.query\.lat\)\s*;/,
			/const\s+lon\s*=\s*parseFloat\(req\.query\.lon\)\s*;/,
			/const\s+offset\s*=\s*parseInt\(req\.query\.offset,\s*10\)\s*\|\|\s*0\s*;/,
			/const\s+radius\s*=\s*Math\.min\(Math\.max\(parseInt\(req\.query\.radius,\s*10\)\s*\|\|\s*100,\s*1\),\s*50000\)\s*;/,
			/const\s+rawItemName\s*=\s*req\.params\.itemName\s*;/,
			/const\s+offset\s*=\s*Math\.max\(0,\s*parseInt\(req\.query\.offset,\s*10\)\s*\|\|\s*0\)\s*;/,
			/const\s+rawCommands\s*=\s*typeof\s+req\.query\.commands\s*===\s*'string'\s*\?\s*req\.query\.commands\s*:\s*''\s*;/,
			/const\s+rawBefore\s*=\s*typeof\s+req\.query\.before\s*===\s*'string'\s*\?\s*req\.query\.before\s*:\s*''\s*;/,
		];

		const unexpected = inputLines.filter((line) => !allowedPatterns.some((pattern) => pattern.test(line)));
		if (unexpected.length) {
			assert.fail(`Unexpected req.* usage lines:\n${unexpected.map((line) => line.trim()).join('\n')}`);
		}
	});
});

describe('Input Validation Coverage', () => {
	it('validates POST body keys and values', () => {
		const content = readFile(SERVER_FILE);

		assert.ok(content.includes("!username || typeof username !== 'string' || hasAnyControlChars(username) || !/^[a-zA-Z0-9_-]{1,20}$/.test(username)"));
		assert.ok(content.includes("!password || typeof password !== 'string' || hasAnyControlChars(password) || password.length > 200"));

		assert.ok(content.includes('const allowedKeys = ['));
		const requiredKeys = ['slimMode', 'theme', 'fontSize', 'compactView', 'showLabels', 'darkMode', 'paused'];
		for (const key of requiredKeys) {
			assert.ok(content.includes(`'${key}'`), `Missing settings whitelist key: ${key}`);
		}
		assert.ok(content.includes("const boolKeys = new Set(['slimMode', 'compactView', 'showLabels', 'darkMode', 'paused'])"));
		assert.ok(content.includes("const size = parseOptionalInt(val, { min: 8, max: 32 });"));
		assert.ok(content.includes("theme !== 'light' && theme !== 'dark'"));

		assert.ok(content.includes('widgetId.length > 200'));
		assert.ok(content.includes('Array.isArray(rules)'));
		assert.ok(content.includes('rules.length > 100'));
		assert.ok(content.includes("const validOperators = ['=', '!=', '>', '<', '>=', '<=', 'contains', '!contains', 'startsWith', 'endsWith', '*'];"));
		assert.ok(content.includes("const validColors = ['green', 'orange', 'red'];"));
		assert.ok(content.includes("const validVisibilities = ['all', 'normal', 'admin'];"));

		assert.ok(content.includes('command.length > 500'));
		assert.ok(content.includes('const trimmed = command.trim();'));
		assert.ok(content.includes('trimmed.length > 500'));
	});

	it('validates GET query keys and values', () => {
		const content = readFile(SERVER_FILE);

		assert.ok(content.includes("theme === 'light' || theme === 'dark'"));
		assert.ok(content.includes("normalized && normalized.includes('/rest/sitemaps/')"));
		assert.ok(content.includes('rootPath = ensureJsonParam(rootPath)'));

		assert.ok(content.includes("delta !== '1' && delta !== 'true'"));

		assert.ok(content.includes("if (!['http:', 'https:', 'rtsp:'].includes(target.protocol))"));
		assert.ok(content.includes('isProxyTargetAllowed(target, liveConfig.proxyAllowlist)'));

		assert.ok(content.includes("if (!['h', 'D', 'W', 'M', 'Y'].includes(period))"));
		assert.ok(content.includes("if (!['light', 'dark'].includes(mode))"));

		assert.ok(content.includes('parseOptionalInt(req.query?.w, { min: 0, max: 10000 })'));

		assert.ok(content.includes("target.protocol !== 'rtsp:'"));

		assert.ok(content.includes("/^[a-zA-Z0-9_]{1,50}$/"), 'Missing itemName regex validation');
		assert.ok(content.includes('offset > 100000'), 'Missing history offset upper bound');
	});
});

describe('Cookie Parsing Coverage', () => {
	it('centralizes cookie parsing and sanitization', () => {
		const content = readFile(SERVER_FILE);

		assert.ok(content.includes("const header = safeText(req?.headers?.cookie || '').trim();"));

		const cookieHeaderUses = countMatches(content, /headers\??\.cookie/g);
		assert.strictEqual(cookieHeaderUses, 1, 'Expected cookie header read only in getCookieValue');
	});

	it('uses timing-safe comparisons for cookie values', () => {
		const content = readFile(SERVER_FILE);
		assert.ok(countMatches(content, /timingSafeEqual/g) >= 3);
	});
});

describe('Request-Derived File Paths', () => {
	it('normalizes or hashes request-derived paths', () => {
		const content = readFile(SERVER_FILE);

		assert.ok(content.includes('path.normalize(path.join(imagesDir, req.path))'));
		assert.ok(content.includes('localPath.startsWith(imagesDir + path.sep)'));

		assert.ok(content.includes("const rawRel = safeText(match[2]).replace(/\\\\/g, '/');"));
		assert.ok(content.includes("const rel = rawRel.replace(/^\\/+/, '');"));
		assert.ok(content.includes("segments.some((seg) => seg === '.' || seg === '..' || seg === '')"));
		assert.ok(content.includes('const parsed = path.posix.parse(rel);'));
		assert.ok(/const\s+cacheRel\s*=\s*path\.posix\.join\(parsed\.dir,\s*`\$\{parsed\.name\}\.png`\s*\);/.test(content));
		assert.ok(content.includes('const cacheRoot = path.resolve(getIconCacheDir());'));
		assert.ok(content.includes('const cachePath = path.resolve(cacheRoot, cacheRel);'));
		assert.ok(content.includes('!cachePath.startsWith(cacheRoot + path.sep)'));

		assert.ok(content.includes('const hash = rtspUrlHash(url);'));
		assert.ok(/const\s+filePath\s*=\s*path\.join\(VIDEO_PREVIEW_DIR,\s*`\$\{hash\}\.jpg`\s*\);/.test(content));

		assert.ok(/const\s+rrdPath\s*=\s*path\.join\(rrdDir,\s*`\$\{item\}\.rrd`\s*\);/.test(content));
	});
});

describe('SQL and Command Injection Surfaces', () => {
	it('avoids interpolated SQL in server modules', () => {
		const files = [SERVER_FILE, SESSIONS_FILE];
		const issues = [];

		for (const file of files) {
			const content = readFile(file);
			const lines = content.split('\n');

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];

				if (/crypto\.(createHash|createHmac)/.test(line)) continue;

				if (/['"`](?:SELECT|INSERT|UPDATE|DELETE)\s.*\+.*(?:req\.|user|param|query)/i.test(line)) {
					issues.push(`${path.basename(file)}:${i + 1}: ${line.trim()}`);
				}

				if (/['"`](?:SELECT|INSERT)\s.*`.*\$\{(?!.*escape)/i.test(line)) {
					issues.push(`${path.basename(file)}:${i + 1}: ${line.trim()}`);
				}
			}
		}

		if (issues.length) {
			assert.fail(`Potential SQL interpolation detected:\n${issues.join('\n')}`);
		}
	});

	it('sanitizes inputs for shell execution', () => {
		const content = readFile(SERVER_FILE);

		assert.ok(content.includes('const safeIp = normalizeNotifyIp(ip);'));
		assert.ok(content.includes('const command = liveConfig.authFailNotifyCmd.replace(/\\{IP\\}/g, safeIp).trim();'));
		assert.ok(content.includes("execFile(BIN_SHELL, ['-c', command]"));
	});
});
