'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { generateStructureMap } = require('../../lib/structure-map');

describe('Structure Map Library Sitemap Selection', () => {
	it('requires an explicit sitemap name', async () => {
		await assert.rejects(
			generateStructureMap(
				async () => [{ name: 'alpha' }],
				async () => ({ name: 'alpha', homepage: { widgets: [] } }),
				{}
			),
			/Missing sitemap name/
		);
	});

	it('rejects sitemap names that are not in the provided list', async () => {
		await assert.rejects(
			generateStructureMap(
				async () => [{ name: 'alpha' }, { name: 'beta' }],
				async () => ({ name: 'alpha', homepage: { widgets: [] } }),
				{ sitemapName: 'gamma' }
			),
			/Sitemap "gamma" not found/
		);
	});

	it('generates structure map output for an explicitly selected sitemap', async () => {
		const result = await generateStructureMap(
			async () => [{ name: 'alpha' }],
			async () => ({
				name: 'alpha',
				label: 'Alpha Home',
				homepage: {
					widgets: [
						{
							type: 'Switch',
							label: 'Kitchen Light [OFF]',
							item: {
								name: 'KitchenLight',
								type: 'SwitchItem',
								state: 'OFF',
							},
						},
					],
				},
			}),
			{ sitemapName: 'alpha' }
		);

		assert.strictEqual(result.sitemapName, 'alpha');
		assert.strictEqual(result.stats.total, 1);
		assert.strictEqual(result.stats.writable, 1);
		assert.strictEqual(result.stats.readable, 0);
	});
});
