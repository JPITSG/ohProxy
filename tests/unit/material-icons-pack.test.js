'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MATERIAL_SVG_DIR = path.join(__dirname, '..', '..', 'node_modules', '@material-design-icons', 'svg');

describe('Material Icons Pack', () => {
	it('is installed locally', () => {
		assert.ok(fs.existsSync(MATERIAL_SVG_DIR), 'Material SVG package directory should exist');
	});

	it('includes mic_off icon in filled style', () => {
		const iconPath = path.join(MATERIAL_SVG_DIR, 'filled', 'mic_off.svg');
		assert.ok(fs.existsSync(iconPath), 'filled/mic_off.svg should exist');
	});

	it('includes common style variants for mic_off', () => {
		const styles = ['filled', 'outlined', 'round', 'sharp', 'two-tone'];
		for (const style of styles) {
			const iconPath = path.join(MATERIAL_SVG_DIR, style, 'mic_off.svg');
			assert.ok(fs.existsSync(iconPath), `${style}/mic_off.svg should exist`);
		}
	});
});
