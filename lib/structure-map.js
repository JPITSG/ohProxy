'use strict';

/**
 * Extract widgets recursively from sitemap data
 * @param {Object} widget - Widget object from sitemap
 * @param {Array} result - Accumulator array for extracted widgets
 * @param {Array} path - Current section path
 * @returns {Array} Extracted widgets
 */
function extractWidgets(widget, result = [], path = []) {
	if (!widget) return result;

	// Determine current section name from Frame label or linkedPage title
	let currentPath = path;
	if (widget.type === 'Frame' && widget.label) {
		// Clean label - remove [%s] style placeholders
		const cleanLabel = widget.label.replace(/\s*\[.*?\]\s*$/, '').trim();
		if (cleanLabel) {
			currentPath = [...path, cleanLabel];
		}
	}

	// Extract relevant info from this widget
	if (widget.item || widget.type) {
		const entry = {
			type: widget.type,
			label: widget.label || '',
			section: currentPath.length > 0 ? currentPath.join(' / ') : null,
		};
		if (widget.item) {
			entry.item = widget.item.name;
			entry.itemType = widget.item.type?.replace('Item', '') || widget.item.type;
			entry.state = widget.item.state;
			if (widget.item.stateDescription?.options) {
				// Include both value and label for options
				entry.options = widget.item.stateDescription.options.map(o => ({
					value: o.value,
					label: o.label || o.value
				}));
			}
		}
		// Handle both 'mapping' and 'mappings'
		const mappings = widget.mappings || widget.mapping;
		if (mappings && mappings.length > 0) {
			entry.mappings = mappings.map(m => ({ cmd: m.command, label: m.label }));
		}
		result.push(entry);
	}

	// Recurse into children - handle both 'widget' and 'widgets' (singular and plural)
	const children = widget.widgets || widget.widget;
	if (children) {
		const childArray = Array.isArray(children) ? children : [children];
		for (const child of childArray) {
			extractWidgets(child, result, currentPath);
		}
	}

	// Recurse into linked pages - use linkedPage title as section
	if (widget.linkedPage) {
		const linkedTitle = widget.linkedPage.title || widget.label;
		const cleanLinkedTitle = linkedTitle ? linkedTitle.replace(/\s*\[.*?\]\s*$/, '').trim() : null;
		const linkedPath = cleanLinkedTitle ? [...path, cleanLinkedTitle] : path;

		const linkedChildren = widget.linkedPage.widgets || widget.linkedPage.widget;
		if (linkedChildren) {
			const linkedArray = Array.isArray(linkedChildren) ? linkedChildren : [linkedChildren];
			for (const child of linkedArray) {
				extractWidgets(child, result, linkedPath);
			}
		}
	}

	return result;
}

/**
 * Determine if a widget is writable (accepts commands)
 * @param {Object} w - Widget object
 * @returns {boolean} True if widget is writable
 */
function isWritableWidget(w) {
	// A widget is writable if it has commands available
	if (w.mappings && w.mappings.length > 0) return true;
	if (w.options && w.options.length > 0) return true;
	if (['Switch', 'Dimmer', 'Rollershutter', 'Color', 'Player'].includes(w.itemType)) return true;
	return false;
}

/**
 * Build structure map prompt for AI
 * @param {Object} sitemap - Sitemap object
 * @param {Array} widgets - Filtered widget array
 * @param {string} type - Type of map: 'all', 'writable', or 'readable'
 * @returns {Object} AI request object
 */
function buildStructureMapPrompt(sitemap, widgets, type = 'all', model = 'claude-3-haiku-20240307') {
	// Group widgets by section
	const itemWidgets = widgets.filter(w => w.item);
	const sections = new Map();

	for (const w of itemWidgets) {
		const section = w.section || 'Home';
		if (!sections.has(section)) {
			sections.set(section, []);
		}
		sections.get(section).push(w);
	}

	// Build output grouped by section
	const lines = [];
	for (const [section, items] of sections) {
		lines.push(`## ${section}`);
		for (const w of items) {
			// Clean label - remove [%s] style state placeholders
			const cleanLabel = (w.label || '').replace(/\s*\[.*?\]\s*$/, '').trim();
			let line = `- ${w.item} (${w.itemType || 'Unknown'}): "${cleanLabel}"`;
			if (w.mappings && w.mappings.length > 0) {
				// Include both command and label: "2=2 Minutes, 1=1 Minute"
				line += ` [commands: ${w.mappings.map(m => m.label ? `${m.cmd}="${m.label}"` : m.cmd).join(', ')}]`;
			} else if (w.options && w.options.length > 0) {
				// Include both value and label for options
				line += ` [options: ${w.options.map(o => o.label && o.label !== o.value ? `${o.value}="${o.label}"` : o.value).join(', ')}]`;
			} else if (w.itemType === 'Switch') {
				line += ` [commands: ON, OFF]`;
			} else if (w.itemType === 'Dimmer') {
				line += ` [commands: ON, OFF, 0-100]`;
			} else if (w.itemType === 'Rollershutter') {
				line += ` [commands: UP, DOWN, STOP, 0-100]`;
			}
			lines.push(line);
		}
		lines.push(''); // Empty line between sections
	}
	const itemSummary = lines.join('\n').trim();

	return {
		model: model,
		max_tokens: 4096,
		system: `You are an assistant that creates structured mappings for home automation voice commands.
Your task is to analyze the provided openHAB items and create a concise structure map that can be used to match voice commands to item actions.

Output a JSON object with the following structure:
{
  "items": [
    {
      "name": "ItemName",
      "aliases": ["living room light", "main light", "living room"],
      "actions": {
        "on": "ON",
        "off": "OFF",
        "toggle": "TOGGLE"
      }
    }
  ],
  "rooms": ["living room", "kitchen", "bedroom"],
  "capabilities": ["lights", "temperature", "locks", "blinds"]
}

Be concise. Extract room names and device types from labels. Create natural language aliases people would use in voice commands.`,
		messages: [
			{
				role: 'user',
				content: `Here is the sitemap "${sitemap.name}" (${sitemap.label || 'Home'}) with its ${type === 'readable' ? 'read-only' : type === 'writable' ? 'controllable' : ''} items:

${itemSummary}

Create a structure map JSON for voice command matching.`
			}
		]
	};
}

/**
 * Generate structure map data from sitemap
 * @param {Function} fetchSitemapList - async () => Array of sitemaps
 * @param {Function} fetchSitemapFull - async (name) => sitemap object
 * @param {Object} options - { sitemapName: string }
 * @returns {Object} { sitemapName, all, writable, readable, stats }
 */
async function generateStructureMap(fetchSitemapList, fetchSitemapFull, options = {}) {
	const sitemaps = await fetchSitemapList();
	if (!sitemaps || sitemaps.length === 0) {
		throw new Error('No sitemaps found');
	}

	const sitemapName = String(options?.sitemapName || '').trim();
	if (!sitemapName) {
		throw new Error('Missing sitemap name');
	}

	const found = sitemaps.find((s) => String(s?.name || '').trim() === sitemapName);
	if (!found) {
		throw new Error(`Sitemap "${sitemapName}" not found. Available: ${sitemaps.map(s => s.name).join(', ')}`);
	}

	const sitemap = await fetchSitemapFull(sitemapName);

	// Extract all widgets recursively
	const widgets = [];
	const homepageWidgets = sitemap.homepage?.widgets || sitemap.homepage?.widget;
	if (homepageWidgets) {
		const widgetArray = Array.isArray(homepageWidgets) ? homepageWidgets : [homepageWidgets];
		for (const widget of widgetArray) {
			extractWidgets(widget, widgets);
		}
	}

	// Split widgets into readable and writable
	const itemWidgets = widgets.filter(w => w.item);
	const writableWidgets = itemWidgets.filter(isWritableWidget);
	const readableWidgets = itemWidgets.filter(w => !isWritableWidget(w));

	// Build prompts for each type
	const model = options.model || 'claude-3-haiku-20240307';
	const requestAll = buildStructureMapPrompt(sitemap, itemWidgets, 'all', model);
	const requestWritable = buildStructureMapPrompt(sitemap, writableWidgets, 'writable', model);
	const requestReadable = buildStructureMapPrompt(sitemap, readableWidgets, 'readable', model);

	return {
		sitemapName,
		all: {
			itemCount: itemWidgets.length,
			request: requestAll,
		},
		writable: {
			itemCount: writableWidgets.length,
			request: requestWritable,
		},
		readable: {
			itemCount: readableWidgets.length,
			request: requestReadable,
		},
		stats: {
			total: itemWidgets.length,
			writable: writableWidgets.length,
			readable: readableWidgets.length,
		},
	};
}

module.exports = {
	extractWidgets,
	isWritableWidget,
	buildStructureMapPrompt,
	generateStructureMap,
};
