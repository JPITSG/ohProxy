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
			/const\s+\{\s*username,\s*password\s*\}\s*=\s*req\.body\s*\|\|\s*\{\s*\};/,
			/const\s+newSettings\s*=\s*req\.body\s*;/,
			/const\s+body\s*=\s*req\.body\s*;/,
			/const\s+\{\s*widgetId,\s*rules,\s*visibility,\s*defaultMuted\s*\}\s*=\s*req\.body\s*\|\|\s*\{\s*\};/,
			/const\s+\{\s*command\s*\}\s*=\s*req\.body\s*\|\|\s*\{\s*\};/,
			/const\s+widgetId\s*=\s*safeText\(req\.params\.widgetId\)\s*;/,
			/const\s+theme\s*=\s*safeText\(req\.query\?\.theme\)\.toLowerCase\(\)\s*;/,
			/const\s+rawRoot\s*=\s*safeText\(req\.query\?\.root\s*\|\|\s*''\)\s*;/,
			/const\s+rawSitemap\s*=\s*safeText\(req\.query\?\.sitemap\s*\|\|\s*''\)\s*;/,
			/const\s+delta\s*=\s*safeText\(req\.query\?\.delta\s*\|\|\s*''\)\s*;/,
			/const\s+url\s*=\s*safeText\(req\.query\.url\)\.trim\(\)\s*;/,
			/const\s+item\s*=\s*safeText\(req\.query\.item\s*\|\|\s*''\)\.trim\(\)\s*;/,
			/const\s+period\s*=\s*safeText\(req\.query\.period\s*\|\|\s*''\)\.trim\(\)\s*;/,
			/const\s+mode\s*=\s*safeText\(req\.query\.mode\s*\|\|\s*''\)\.trim\(\)\.toLowerCase\(\)\s*\|\|\s*'dark'\s*;/,
			/const\s+title\s*=\s*safeText\(req\.query\.title\s*\|\|\s*''\)\.trim\(\)\s*;/,
			/const\s+title\s*=\s*safeText\(req\.query\.title\s*\|\|\s*''\)\.trim\(\)\s*\|\|\s*item\s*;/,
			/const\s+raw\s*=\s*req\.query\?\.url\s*;/,
			/const\s+rawWidth\s*=\s*parseInt\(req\.query\.w,\s*10\)\s*;/,
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

		assert.ok(content.includes("!username || typeof username !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(username)"));
		assert.ok(content.includes("!password || typeof password !== 'string' || password.length > 200"));

		assert.ok(content.includes('const allowedKeys = ['));
		const requiredKeys = ['slimMode', 'theme', 'fontSize', 'compactView', 'showLabels', 'darkMode', 'paused'];
		for (const key of requiredKeys) {
			assert.ok(content.includes(`'${key}'`), `Missing settings whitelist key: ${key}`);
		}
		assert.ok(content.includes("typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean'"));

		assert.ok(content.includes('widgetId.length > 200'));
		assert.ok(content.includes('Array.isArray(rules)'));
		assert.ok(content.includes("const validOperators = ['=', '!=', '>', '<', '>=', '<=', 'contains', '!contains', 'startsWith', 'endsWith', '*'];"));
		assert.ok(content.includes("const validColors = ['green', 'orange', 'red'];"));
		assert.ok(content.includes("const validVisibilities = ['all', 'normal', 'admin'];"));

		assert.ok(content.includes('command.length > 500'));
		assert.ok(content.includes('const trimmed = command.trim();'));
		assert.ok(content.includes('trimmed.length > 500'));
	});

	it('validates GET query keys and values', () => {
		const content = readFile(SERVER_FILE);

		assert.ok(content.includes("theme !== 'light' && theme !== 'dark'"));
		assert.ok(content.includes("normalized && normalized.includes('/rest/sitemaps/')"));
		assert.ok(content.includes('rootPath = ensureJsonParam(rootPath)'));

		assert.ok(content.includes("delta !== '1' && delta !== 'true'"));

		assert.ok(content.includes("if (!['http:', 'https:', 'rtsp:'].includes(target.protocol))"));
		assert.ok(content.includes('isProxyTargetAllowed(target, liveConfig.proxyAllowlist)'));

		assert.ok(content.includes("if (!['h', 'D', 'W', 'M', 'Y'].includes(period))"));
		assert.ok(content.includes("if (!['light', 'dark'].includes(mode))"));

		assert.ok(content.includes('rawWidth >= 0 && rawWidth <= 10000'));

		assert.ok(content.includes("target.protocol !== 'rtsp:'"));
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
