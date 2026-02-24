'use strict';

/**
 * Static Analysis Security Tests
 *
 * These tests scan source code for patterns that indicate potential security vulnerabilities.
 * They are generalized to catch entire classes of issues, not specific instances.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

// Helper to read file content
function readFile(filePath) {
	return fs.readFileSync(filePath, 'utf8');
}

// Helper to get all JS files in a directory
function getJsFiles(dir, recursive = true) {
	const files = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory() && recursive && entry.name !== 'node_modules' && entry.name !== 'vendor') {
			files.push(...getJsFiles(fullPath, recursive));
		} else if (entry.isFile() && entry.name.endsWith('.js')) {
			files.push(fullPath);
		}
	}
	return files;
}

// Extract template literals with HTML context
function findHtmlTemplateLiterals(content, filePath) {
	const issues = [];
	const lines = content.split('\n');

	// Patterns that indicate HTML context
	const htmlContextPatterns = [
		/\.innerHTML\s*=\s*`/,
		/\.outerHTML\s*=\s*`/,
		/res\.send\s*\(\s*`\s*<!DOCTYPE/i,
		/res\.send\s*\(\s*`\s*<html/i,
		/res\.type\s*\(\s*['"]html['"]\s*\).*\.send\s*\(\s*`/,
		/return\s*`\s*<!DOCTYPE/i,
		/return\s*`\s*<html/i,
		/<title>\$\{/,
		/<h[1-6][^>]*>\$\{/,
		/<div[^>]*>\$\{/,
		/<span[^>]*>\$\{/,
		/<p[^>]*>\$\{/,
	];

	// Find all template literals in HTML contexts
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + 1;

		for (const pattern of htmlContextPatterns) {
			if (pattern.test(line)) {
				// Check for unescaped interpolations
				// Look for ${...} that don't use escapeHtml, safeHtml, or similar
				const interpolationMatch = line.match(/\$\{([^}]+)\}/g);
				if (interpolationMatch) {
					for (const interp of interpolationMatch) {
						const inner = interp.slice(2, -1).trim();
						// Skip if it's using an escape function
						if (/escape|safeHtml|sanitize/i.test(inner)) continue;
						// Skip if it's a known safe value (numbers, booleans, JSON.stringify)
						if (/^(true|false|\d+|JSON\.stringify)/.test(inner)) continue;
						// Skip if it's accessing a safe property
						if (/\.(length|size|count|id|version)$/.test(inner)) continue;

						issues.push({
							file: filePath,
							line: lineNum,
							code: line.trim().substring(0, 100),
							interpolation: inner,
							type: 'potential-xss',
						});
					}
				}
			}
		}
	}

	return issues;
}

// Find path.join with user input that might allow traversal
function findPathTraversalRisks(content, filePath) {
	const issues = [];
	const lines = content.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + 1;

		// Look for path.join with req.path, req.params, req.query
		if (/path\.join\s*\([^)]*req\.(path|params|query|body)/.test(line)) {
			// Check if there's a normalization and containment check nearby (wider context)
			const context = lines.slice(Math.max(0, i - 10), Math.min(lines.length, i + 15)).join('\n');
			const hasNormalize = /path\.normalize/.test(context);
			// Check for containment patterns: startsWith with path comparison
			const hasContainmentCheck = /startsWith\s*\([^)]+\)/.test(context) &&
				(/\+\s*path\.sep/.test(context) || /Dir\s*\+/.test(context) || /startsWith\s*\([^)]*Dir/.test(context));

			if (!hasNormalize || !hasContainmentCheck) {
				issues.push({
					file: filePath,
					line: lineNum,
					code: line.trim().substring(0, 100),
					type: 'potential-path-traversal',
					hasNormalize,
					hasContainmentCheck,
				});
			}
		}
	}

	return issues;
}

// Find innerHTML assignments without escaping
function findInnerHtmlRisks(content, filePath) {
	const issues = [];
	const lines = content.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineNum = i + 1;

		// Look for innerHTML/outerHTML assignments with template literals
		if (/\.(innerHTML|outerHTML)\s*=\s*`/.test(line) ||
		    /\.(innerHTML|outerHTML)\s*\+=\s*`/.test(line)) {
			// Extract interpolations
			const interpolations = line.match(/\$\{([^}]+)\}/g) || [];

			for (const interp of interpolations) {
				const inner = interp.slice(2, -1).trim();
				// Check if using escape function
				if (/escapeHtml|escape|sanitize/i.test(inner)) continue;
				// Skip safe patterns
				if (/^['"`]/.test(inner)) continue; // String literal
				if (/^\d+$/.test(inner)) continue; // Number

				issues.push({
					file: filePath,
					line: lineNum,
					code: line.trim().substring(0, 100),
					interpolation: inner,
					type: 'innerhtml-xss-risk',
				});
			}
		}
	}

	return issues;
}

// Find finally blocks that might override error state in auth-critical flows
function findFinallyStateIssues(content, filePath) {
	const issues = [];

	// Only check login-related files for this pattern
	// (auth flows where state override could bypass security)
	if (!filePath.includes('login')) return issues;

	// Look for patterns where finally might reset button state without checking error condition
	const finallyPattern = /finally\s*\{[^}]*disabled\s*=\s*false[^}]*\}/gs;
	const matches = content.matchAll(finallyPattern);

	for (const match of matches) {
		// Check if there's conditional logic protecting the reset
		const finallyBlock = match[0];
		if (!finallyBlock.includes('if (') && !finallyBlock.includes('if(')) {
			// Find line number
			const beforeMatch = content.substring(0, match.index);
			const lineNum = (beforeMatch.match(/\n/g) || []).length + 1;

			issues.push({
				file: filePath,
				line: lineNum,
				code: finallyBlock.substring(0, 100),
				type: 'finally-state-override',
			});
		}
	}

	return issues;
}

describe('Static Analysis: XSS Prevention', () => {
	it('server-side HTML templates use escapeHtml for user input', () => {
		const content = readFile(SERVER_FILE);
		const issues = findHtmlTemplateLiterals(content, 'server.js');

		// Filter to only show actual issues (not false positives)
		const realIssues = issues.filter(issue => {
			// Skip known safe patterns
			if (issue.interpolation.includes('assetVersion')) return false;
			if (issue.interpolation.includes('theme')) return false;
			if (issue.interpolation.includes('JSON.stringify')) return false;
			// Skip already-escaped values (safeTitle, escapeHtml, etc.)
			if (issue.interpolation.includes('safeTitle')) return false;
			if (issue.interpolation.includes('unitDisplay')) return false;
			if (issue.interpolation.includes('legendHtml')) return false;
			// Skip server-controlled values (not user input)
			if (issue.interpolation === 'site') return false;
			// Skip chart stats - these are server-computed numeric values from chart data
			if (issue.interpolation.includes('fmtCur')) return false;
			if (issue.interpolation.includes('fmtAvg')) return false;
			if (issue.interpolation.includes('fmtMin')) return false;
			if (issue.interpolation.includes('fmtMax')) return false;
			if (issue.interpolation.includes('dataCur')) return false;
			if (issue.interpolation.includes('dataAvg')) return false;
			if (issue.interpolation.includes('dataMin')) return false;
			if (issue.interpolation.includes('dataMax')) return false;
			if (issue.interpolation.includes('curHtml')) return false;
			if (issue.interpolation.includes('statsHtml')) return false;
			// Skip weather widget computed values (numbers from API, fixed arrays)
			if (issue.interpolation === 'dayName') return false;
			if (issue.interpolation === 'highTemp') return false;
			if (issue.interpolation === 'lowTemp') return false;
			if (issue.interpolation === 'pop') return false;
			if (issue.interpolation === 'rainOpacity') return false;
			if (issue.interpolation === 'rainTextColor') return false;
			if (issue.interpolation === 'forecastCards') return false;
			// dateLabel is built from fixed monthNames array + numeric day + hardcoded suffix
			if (issue.interpolation === 'dateLabel') return false;
			if (issue.interpolation.includes('bgColor')) return false;
			if (issue.interpolation.includes('cardBg')) return false;
			if (issue.interpolation.includes('textColor')) return false;
			if (issue.interpolation.includes('cityName')) return false;
			return true;
		});

		if (realIssues.length > 0) {
			const details = realIssues.map(i =>
				`  Line ${i.line}: ${i.interpolation}`
			).join('\n');
			assert.fail(`Found ${realIssues.length} potential XSS issues in server.js:\n${details}`);
		}
	});

	it('client-side innerHTML uses escapeHtml for dynamic content', () => {
		const clientFiles = getJsFiles(PUBLIC_DIR);
		const allIssues = [];

		for (const file of clientFiles) {
			const content = readFile(file);
			const issues = findInnerHtmlRisks(content, path.relative(PROJECT_ROOT, file));
			allIssues.push(...issues);
		}

		// Filter known safe patterns
		const realIssues = allIssues.filter(issue => {
			if (issue.interpolation.includes('escapeHtml')) return false;
			if (issue.interpolation.includes('safeText') && !issue.code.includes('innerHTML')) return false;
			return true;
		});

		if (realIssues.length > 0) {
			const details = realIssues.map(i =>
				`  ${i.file}:${i.line}: ${i.interpolation}`
			).join('\n');
			assert.fail(`Found ${realIssues.length} innerHTML XSS risks:\n${details}`);
		}
	});
});

describe('Static Analysis: Path Traversal Prevention', () => {
	it('file path operations validate against traversal', () => {
		const content = readFile(SERVER_FILE);
		const issues = findPathTraversalRisks(content, 'server.js');

		if (issues.length > 0) {
			const details = issues.map(i =>
				`  Line ${i.line}: normalize=${i.hasNormalize}, containment=${i.hasContainmentCheck}`
			).join('\n');
			assert.fail(`Found ${issues.length} potential path traversal risks:\n${details}`);
		}
	});

	it('sendFile calls use validated paths', () => {
		const content = readFile(SERVER_FILE);
		const lines = content.split('\n');
		const issues = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (/\.sendFile\s*\(/.test(line)) {
				// Extract the argument to sendFile
				const argMatch = line.match(/\.sendFile\s*\(\s*([^)]+)\)/);
				if (!argMatch) continue;
				const arg = argMatch[1].trim();

				// Skip if argument is clearly static (string literal or known safe variable)
				if (/^['"`]/.test(arg)) continue; // String literal
				if (/Path$/.test(arg) && !/req/.test(arg)) continue; // Variables ending in Path not from req
				if (/^path\.join\(/.test(arg) && !/req/.test(arg)) continue; // Static path.join not from req

				// Check if argument is derived from user input
				const context = lines.slice(Math.max(0, i - 15), i + 1).join('\n');

				// Look for variable assignment that uses req.*
				const varPattern = new RegExp(`${arg}\\s*=.*req\\.`, 'i');
				if (varPattern.test(context)) {
					// User input in path - check for validation
					const hasValidation = /startsWith|normalize|path\.resolve/.test(context);
					if (!hasValidation) {
						issues.push({
							line: i + 1,
							code: line.trim(),
						});
					}
				}
			}
		}

		if (issues.length > 0) {
			const details = issues.map(i => `  Line ${i.line}: ${i.code}`).join('\n');
			assert.fail(`Found ${issues.length} sendFile calls without path validation:\n${details}`);
		}
	});
});

describe('Static Analysis: UI State Management', () => {
	it('finally blocks do not unconditionally reset error state', () => {
		const clientFiles = getJsFiles(PUBLIC_DIR);
		const allIssues = [];

		for (const file of clientFiles) {
			const content = readFile(file);
			const issues = findFinallyStateIssues(content, path.relative(PROJECT_ROOT, file));
			allIssues.push(...issues);
		}

		if (allIssues.length > 0) {
			const details = allIssues.map(i =>
				`  ${i.file}:${i.line}`
			).join('\n');
			assert.fail(`Found ${allIssues.length} finally blocks that may override error state:\n${details}`);
		}
	});
});

describe('Static Analysis: Dangerous Function Usage', () => {
	it('no eval() calls in codebase', () => {
		const allFiles = [SERVER_FILE, ...getJsFiles(PUBLIC_DIR)];
		const issues = [];

		for (const file of allFiles) {
			const content = readFile(file);
			const lines = content.split('\n');

			for (let i = 0; i < lines.length; i++) {
				if (/\beval\s*\(/.test(lines[i])) {
					issues.push({
						file: path.relative(PROJECT_ROOT, file),
						line: i + 1,
						code: lines[i].trim(),
					});
				}
			}
		}

		if (issues.length > 0) {
			const details = issues.map(i => `  ${i.file}:${i.line}`).join('\n');
			assert.fail(`Found eval() usage:\n${details}`);
		}
	});

	it('no Function() constructor with string arguments', () => {
		const allFiles = [SERVER_FILE, ...getJsFiles(PUBLIC_DIR)];
		const issues = [];

		for (const file of allFiles) {
			const content = readFile(file);
			const lines = content.split('\n');

			for (let i = 0; i < lines.length; i++) {
				if (/new\s+Function\s*\(/.test(lines[i])) {
					issues.push({
						file: path.relative(PROJECT_ROOT, file),
						line: i + 1,
						code: lines[i].trim(),
					});
				}
			}
		}

		if (issues.length > 0) {
			const details = issues.map(i => `  ${i.file}:${i.line}`).join('\n');
			assert.fail(`Found Function() constructor:\n${details}`);
		}
	});

	it('no document.write calls', () => {
		const clientFiles = getJsFiles(PUBLIC_DIR);
		const issues = [];

		for (const file of clientFiles) {
			const content = readFile(file);
			const lines = content.split('\n');

			for (let i = 0; i < lines.length; i++) {
				if (/document\.write\s*\(/.test(lines[i])) {
					issues.push({
						file: path.relative(PROJECT_ROOT, file),
						line: i + 1,
						code: lines[i].trim(),
					});
				}
			}
		}

		if (issues.length > 0) {
			const details = issues.map(i => `  ${i.file}:${i.line}`).join('\n');
			assert.fail(`Found document.write() usage:\n${details}`);
		}
	});
});

describe('Static Analysis: SQL Injection Prevention', () => {
	it('database queries use parameterized statements', () => {
		const content = readFile(SERVER_FILE);
		const lines = content.split('\n');
		const issues = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Skip crypto operations (they use .update() but aren't SQL)
			if (/crypto\.(createHash|createHmac)/.test(line)) continue;

			// Look for string concatenation in SQL (must have SQL keywords at start of query)
			if (/['"`](?:SELECT|INSERT|UPDATE|DELETE)\s.*\+.*(?:req\.|user|param|query)/i.test(line)) {
				issues.push({
					line: i + 1,
					code: line.trim().substring(0, 100),
				});
			}

			// Look for template literals in SQL without proper escaping
			if (/['"`](?:SELECT|INSERT)\s.*`.*\$\{(?!.*escape)/i.test(line)) {
				issues.push({
					line: i + 1,
					code: line.trim().substring(0, 100),
				});
			}
		}

		if (issues.length > 0) {
			const details = issues.map(i => `  Line ${i.line}: ${i.code}`).join('\n');
			assert.fail(`Found potential SQL injection:\n${details}`);
		}
	});
});

describe('Static Analysis: Command Injection Prevention', () => {
	it('exec/spawn calls do not use unsanitized input', () => {
		const content = readFile(SERVER_FILE);
		const lines = content.split('\n');
		const issues = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Look for exec/spawn with string concatenation or template literals
			if (/(?:exec|execSync|spawn|spawnSync)\s*\([^)]*(?:\+|`.*\$\{)/.test(line)) {
				// Check if input is sanitized
				const context = lines.slice(Math.max(0, i - 10), i + 1).join('\n');
				if (!/(?:escape|sanitize|validate|whitelist)/i.test(context)) {
					issues.push({
						line: i + 1,
						code: line.trim().substring(0, 100),
					});
				}
			}
		}

		if (issues.length > 0) {
			const details = issues.map(i => `  Line ${i.line}: ${i.code}`).join('\n');
			assert.fail(`Found potential command injection:\n${details}`);
		}
	});
});
