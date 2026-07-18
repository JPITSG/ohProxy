'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_OPENHAB_CONF_DIR = '/etc/openhab';
const DEFAULT_MAX_MAP_BYTES = 1024 * 1024;
const MAX_MAP_PATTERN_LENGTH = 2048;
const MAX_MAP_CONFIG_LENGTH = 512;

function safeText(value) {
	return value === null || value === undefined ? '' : String(value);
}

function defaultOpenhabTransformDir(env = process.env) {
	const configured = safeText(env?.OPENHAB_CONF).trim();
	const confDir = configured && path.isAbsolute(configured)
		? configured
		: DEFAULT_OPENHAB_CONF_DIR;
	return path.join(confDir, 'transform');
}

function parseMapStatePattern(pattern) {
	const text = safeText(pattern).trim();
	if (!text || text.length > MAX_MAP_PATTERN_LENGTH) return null;
	const match = text.match(/^MAP\s*\((.*)\)\s*:\s*(.+)$/i);
	if (!match) return null;
	const config = match[1].trim();
	const sourceFormat = match[2].trim();
	if (!config || config.length > MAX_MAP_CONFIG_LENGTH || !sourceFormat) return null;
	return { config, sourceFormat };
}

function hasLineContinuation(line) {
	let slashCount = 0;
	for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i--) slashCount += 1;
	return slashCount % 2 === 1;
}

function propertyLogicalLines(content) {
	const physicalLines = safeText(content).replace(/\r\n?/g, '\n').split('\n');
	const logicalLines = [];
	let current = '';
	for (const physicalLine of physicalLines) {
		const next = current ? physicalLine.replace(/^\s+/, '') : physicalLine;
		current += next;
		if (hasLineContinuation(current)) {
			current = current.slice(0, -1);
			continue;
		}
		logicalLines.push(current);
		current = '';
	}
	if (current) logicalLines.push(current);
	return logicalLines;
}

function unescapeProperty(value) {
	const text = safeText(value);
	let out = '';
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== '\\') {
			out += text[i];
			continue;
		}
		if (i + 1 >= text.length) {
			out += '\\';
			continue;
		}
		const escaped = text[++i];
		if (escaped === 't') out += '\t';
		else if (escaped === 'n') out += '\n';
		else if (escaped === 'r') out += '\r';
		else if (escaped === 'f') out += '\f';
		else if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) {
			out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
			i += 4;
		} else {
			out += escaped;
		}
	}
	return out;
}

function parsePropertyLine(rawLine) {
	const line = safeText(rawLine).replace(/^\s+/, '');
	if (!line || line.startsWith('#') || line.startsWith('!')) return null;

	let keyEnd = line.length;
	let valueStart = line.length;
	for (let i = 0; i < line.length; i++) {
		if (line[i] === '\\') {
			i += 1;
			continue;
		}
		if (line[i] === '=' || line[i] === ':') {
			keyEnd = i;
			valueStart = i + 1;
			while (/\s/.test(line[valueStart] || '')) valueStart += 1;
			break;
		}
		if (/\s/.test(line[i])) {
			keyEnd = i;
			valueStart = i;
			while (/\s/.test(line[valueStart] || '')) valueStart += 1;
			if (line[valueStart] === '=' || line[valueStart] === ':') valueStart += 1;
			while (/\s/.test(line[valueStart] || '')) valueStart += 1;
			break;
		}
	}

	return [
		unescapeProperty(line.slice(0, keyEnd)),
		unescapeProperty(line.slice(valueStart)),
	];
}

function parseOpenhabMap(content) {
	const mappings = new Map();
	for (const line of propertyLogicalLines(content)) {
		const entry = parsePropertyLine(line);
		if (entry) mappings.set(entry[0], entry[1]);
	}
	return mappings;
}

function splitUnescaped(value, delimiter) {
	const parts = [];
	let current = '';
	for (let i = 0; i < value.length;) {
		if (value[i] === '\\' && i + 1 < value.length) {
			current += value[i] + value[i + 1];
			i += 2;
			continue;
		}
		if (value.startsWith(delimiter, i)) {
			parts.push(current);
			current = '';
			i += delimiter.length;
			continue;
		}
		current += value[i];
		i += 1;
	}
	parts.push(current);
	return parts;
}

function parseInlineOpenhabMap(config) {
	let body = safeText(config).slice(1);
	let delimiter = ';';
	if (body.startsWith('?delimiter=')) {
		const delimiterMatch = body.slice('?delimiter='.length).match(/^([^A-Za-z0-9\s]+)([\s\S]*)$/);
		if (!delimiterMatch) return null;
		delimiter = delimiterMatch[1];
		body = delimiterMatch[2];
	}
	if (!delimiter) return null;
	const mappings = new Map();
	for (const part of splitUnescaped(body, delimiter)) {
		const entry = parsePropertyLine(part);
		if (entry) mappings.set(entry[0], entry[1]);
	}
	return mappings;
}

function pathIsWithin(rootPath, targetPath) {
	const relative = path.relative(rootPath, targetPath);
	return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveMapFilePath(transformDir, config) {
	const relativeName = safeText(config).trim();
	if (!relativeName || relativeName.length > MAX_MAP_CONFIG_LENGTH) return '';
	if (relativeName.includes('\0') || relativeName.includes('\\') || path.isAbsolute(relativeName)) return '';
	if (!relativeName.toLowerCase().endsWith('.map')) return '';

	try {
		const rootPath = fs.realpathSync(transformDir);
		const candidatePath = path.resolve(rootPath, relativeName);
		if (!pathIsWithin(rootPath, candidatePath)) return '';
		const realPath = fs.realpathSync(candidatePath);
		return pathIsWithin(rootPath, realPath) ? realPath : '';
	} catch {
		return '';
	}
}

function formatMapSource(rawState, sourceFormat) {
	const source = safeText(rawState);
	const format = safeText(sourceFormat).trim();
	if (!format) return source;
	if (format.includes('%s')) return format.replace(/%s/g, source).replace(/%%/g, '%');

	const match = format.match(/%(?:\d+\$)?[-+ #0,(]*(?:\d+)?(?:\.(\d+))?([df])/i);
	if (!match) return source;
	const number = Number(source.replace(',', '.'));
	if (!Number.isFinite(number)) return source;
	const precision = match[1] === undefined ? null : parseInt(match[1], 10);
	const formatted = match[2].toLowerCase() === 'd'
		? String(Math.round(number))
		: Number.isInteger(precision) && precision >= 0
			? number.toFixed(precision)
			: String(number);
	return format.replace(match[0], formatted).replace(/%%/g, '%');
}

function applyOpenhabMap(mappings, source) {
	if (!(mappings instanceof Map)) return null;
	let transformed;
	if (mappings.has(source)) transformed = mappings.get(source);
	else if (mappings.has('')) transformed = mappings.get('');
	else return source;
	return transformed === '_source_' ? source : transformed;
}

function createOpenhabMapTransformer(options = {}) {
	const transformDir = safeText(options.transformDir).trim() || defaultOpenhabTransformDir();
	const maxMapBytes = Number.isFinite(options.maxMapBytes)
		? Math.max(1, Math.floor(options.maxMapBytes))
		: DEFAULT_MAX_MAP_BYTES;
	const fileCache = new Map();

	function loadFileMap(config) {
		const filePath = resolveMapFilePath(transformDir, config);
		if (!filePath) return null;
		try {
			const stat = fs.statSync(filePath);
			if (!stat.isFile() || stat.size > maxMapBytes) return null;
			const signature = `${stat.mtimeMs}:${stat.size}`;
			const cached = fileCache.get(filePath);
			if (cached?.signature === signature) return cached.mappings;
			const mappings = parseOpenhabMap(fs.readFileSync(filePath, 'utf8'));
			fileCache.set(filePath, { signature, mappings });
			return mappings;
		} catch {
			return null;
		}
	}

	function transform(pattern, rawState) {
		const parsed = parseMapStatePattern(pattern);
		if (!parsed) return null;
		const mappings = parsed.config.startsWith('|')
			? parseInlineOpenhabMap(parsed.config)
			: loadFileMap(parsed.config);
		if (!mappings) return null;
		const source = formatMapSource(rawState, parsed.sourceFormat);
		return applyOpenhabMap(mappings, source);
	}

	return {
		transform,
		clearCache: () => fileCache.clear(),
	};
}

module.exports = {
	MAX_MAP_PATTERN_LENGTH,
	applyOpenhabMap,
	createOpenhabMapTransformer,
	defaultOpenhabTransformDir,
	formatMapSource,
	parseInlineOpenhabMap,
	parseMapStatePattern,
	parseOpenhabMap,
	resolveMapFilePath,
};
