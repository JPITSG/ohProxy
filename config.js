'use strict';

/* Optional local overrides: create config.local.js to override config.defaults.js. */

const defaults = require('./config.defaults');

let local = {};
try {
	local = require('./config.local');
} catch (err) {
	if (err.code !== 'MODULE_NOT_FOUND' || !String(err.message || '').includes('config.local')) {
		throw err;
	}
}

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const deepMerge = (base, override) => {
	if (!isPlainObject(base)) {
		return override === undefined ? base : override;
	}
	const result = { ...base };
	if (isPlainObject(override)) {
		for (const [key, value] of Object.entries(override)) {
			if (value === undefined) continue;
			if (isPlainObject(value) && isPlainObject(base[key])) {
				result[key] = deepMerge(base[key], value);
			} else {
				result[key] = value;
			}
		}
	}
	return result;
};

module.exports = deepMerge(defaults, isPlainObject(local) ? local : {});
