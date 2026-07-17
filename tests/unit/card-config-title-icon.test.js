'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'styles.css'), 'utf8');

describe('Card Config Title Icon', () => {
	it('derives the icon like grid cards do and loads it through the shared pipeline', () => {
		assert.match(app, /const rawTitleIcon = safeText\(widgetIconName\(widget\)\)\.trim\(\);/);
		assert.match(app, /rawTitleIcon\.toLowerCase\(\) === 'buttongrid' \? '' : rawTitleIcon/);
		assert.match(app, /const isDynamicIcon = !widget\?\.staticIcon && !\/\^material:\/i\.test\(titleIcon\);/);
		assert.match(app, /loadBestIcon\(iconImg, iconCandidates\(titleIcon, iconState\)\);/);
	});

	it('prepends the icon into the modal title after the text is set', () => {
		assert.match(app, /iconImg\.className = 'card-config-title-icon';/);
		assert.match(app, /titleEl\.prepend\(iconImg\);/);
	});

	it('sizes the icon without growing the header and hides it until loaded', () => {
		assert.match(styles, /\.card-config-title-icon \{[^}]*height: 1\.8em;/);
		// Negative margins offset the extra 0.6em so the header stays as
		// tall as it was with the original 1.2em icon
		assert.match(styles, /\.card-config-title-icon \{[^}]*margin-top: -0\.3em;\s*margin-bottom: -0\.3em;/);
		assert.match(styles, /\.card-config-title-icon \{[^}]*display: none;/);
		assert.match(styles, /\.card-config-title-icon\.icon-ready \{\s*display: block;/);
		// Equidistant: icon-to-text gap matches the header's 20px edge padding
		assert.match(styles, /\.card-config-header h2 \{[^}]*gap: 20px;/);
	});
});
