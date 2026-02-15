'use strict';

/**
 * Shared widget normalization helpers.
 * UMD – works as a CommonJS module (server) and as a browser <script> global.
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory();
	} else {
		root.WidgetNormalizer = factory();
	}
}(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {

	/* ── internal helper (both sides keep their own safeText for other code) ── */
	function safeText(value) {
		return value === null || value === undefined ? '' : String(value);
	}

	/* ── widget field accessors ────────────────────────────────────────────── */

	function widgetType(widget) {
		return safeText(widget?.type || widget?.widgetType || widget?.item?.type || '');
	}

	function widgetLink(widget) {
		return safeText(widget?.linkedPage?.link || widget?.link || '');
	}

	function widgetPageLink(widget) {
		const link = widget?.linkedPage?.link || widget?.link;
		if (typeof link !== 'string') return null;
		if (!link.includes('/rest/sitemaps/')) return null;
		return link;
	}

	function widgetIconName(widget) {
		return safeText(widget?.icon || widget?.staticIcon || widget?.item?.icon || widget?.item?.category || '');
	}

	/* ── keying / label helpers ─────────────────────────────────────────── */

	function deltaKey(widget) {
		const id = safeText(widget?.widgetId || widget?.id || '');
		if (id) return `id:${id}`;
		const itemName = safeText(widget?.item?.name || widget?.itemName || '');
		const type = widgetType(widget);
		const link = widgetLink(widget);
		if (itemName) return `item:${itemName}|${type}|${link}`;
		const label = safeText(widget?.label || widget?.item?.label || widget?.item?.name || '');
		return `label:${label}|${type}|${link}`;
	}

	function splitLabelState(label) {
		const raw = safeText(label);
		// Strip trailing empty brackets [] or [-] (openHAB uses these when no state)
		const cleaned = raw.replace(/\s*\[\s*-?\s*\]\s*$/, '');
		const match = cleaned.match(/^(.*)\s*\[(.+)\]\s*$/);
		if (!match) return { title: cleaned, state: '' };
		return { title: match[1].trim(), state: match[2].trim() };
	}

	/* ── widget key (stable identity for config / visibility lookups) ──── */

	function widgetKey(widget) {
		if (widget?.__section || widgetType(widget) === 'Frame') {
			return `section:${safeText(widget?.label || widget?.item?.label || widget?.item?.name || '')}`;
		}
		const item = safeText(widget?.item?.name || '');
		const fullLabel = safeText(widget?.label || '');
		const label = splitLabelState(fullLabel).title || fullLabel;
		const type = widgetType(widget);
		const link = safeText(widgetPageLink(widget) || '');
		return `widget:${item}|${label}|${type}|${link}`;
	}

	/* ── mapping normalization ──────────────────────────────────────────── */

	function normalizeMapping(mapping) {
		if (!mapping) return [];
		if (Array.isArray(mapping)) {
			return mapping
				.map((m) => {
					if (!m || typeof m !== 'object') return null;
					const command = safeText(m.command ?? '');
					const releaseCommand = safeText(m.releaseCommand ?? '');
					const label = safeText(m.label ?? m.command ?? '');
					const icon = safeText(m.icon ?? '');
					if (!command && !label && !icon) return null;
					return { command, releaseCommand, label: label || command, icon };
				})
				.filter(Boolean);
		}
		if (typeof mapping === 'object') {
			if ('command' in mapping || 'label' in mapping || 'releaseCommand' in mapping || 'icon' in mapping) {
				const command = safeText(mapping.command ?? '');
				const releaseCommand = safeText(mapping.releaseCommand ?? '');
				const label = safeText(mapping.label ?? mapping.command ?? '');
				const icon = safeText(mapping.icon ?? '');
				if (!command && !label && !icon) return [];
				return [{ command, releaseCommand, label: label || command, icon }];
			}
			return Object.entries(mapping)
				.map(([command, mappingValue]) => {
					const isEntryObject = mappingValue && typeof mappingValue === 'object';
					const label = isEntryObject
						? safeText(mappingValue.label ?? command)
						: safeText(mappingValue);
					const icon = isEntryObject ? safeText(mappingValue.icon ?? '') : '';
					return {
						command: safeText(command),
						releaseCommand: '',
						label: label || safeText(command),
						icon,
					};
				});
		}
		return [];
	}

	/* ── buttongrid normalization ────────────────────────────────────────── */

	/**
	 * @param {Object}   widget        – widget object with .buttons / .mappings / .widgets
	 * @param {Function} [resolveState] – optional callback(itemName) → default state string.
	 *                                    Server passes (name) => itemStates.get(name),
	 *                                    frontend omits it (defaults to '').
	 */
	function normalizeButtongridButtons(widget, resolveState) {
		const buttons = [];
		const getState = typeof resolveState === 'function' ? resolveState : () => '';

		if (Array.isArray(widget?.buttons)) {
			for (const b of widget.buttons) {
				if (!b || typeof b !== 'object') continue;
				const itemName = safeText(b?.itemName || b?.item?.name || '');
				buttons.push({
					row: parseInt(b?.row, 10) || 1,
					column: parseInt(b?.column, 10) || 1,
					command: safeText(b?.command || b?.cmd || ''),
					releaseCommand: safeText(b?.releaseCommand || b?.release || ''),
					label: safeText(b?.label || ''),
					icon: safeText(b?.icon || b?.staticIcon || ''),
					itemName,
					state: safeText(b?.state ?? b?.item?.state ?? getState(itemName)),
					stateless: !!b?.stateless,
				});
			}
			return buttons;
		}
		// Inline buttons come through mappings with row/column fields
		const inlineButtons = widget?.mappings || widget?.mapping;
		if (Array.isArray(inlineButtons)) {
			for (const b of inlineButtons) {
				if (b?.row == null && b?.column == null) continue;
				const itemName = safeText(b?.itemName || b?.item?.name || '');
				buttons.push({
					row: parseInt(b?.row, 10) || 1,
					column: parseInt(b?.column, 10) || 1,
					command: safeText(b?.command || b?.cmd || ''),
					releaseCommand: safeText(b?.releaseCommand || b?.release || ''),
					label: safeText(b?.label || ''),
					icon: safeText(b?.icon || b?.staticIcon || ''),
					itemName,
					state: safeText(b?.state ?? b?.item?.state ?? getState(itemName)),
					stateless: !!b?.stateless,
				});
			}
		}
		// Child Button widgets from widget.widgets
		const children = widget?.widgets || widget?.widget;
		if (Array.isArray(children)) {
			for (const c of children) {
				if (safeText(c?.type).toLowerCase() !== 'button') continue;
				const itemName = safeText(c?.itemName || c?.item?.name || '');
				buttons.push({
					row: parseInt(c?.row, 10) || 1,
					column: parseInt(c?.column, 10) || 1,
					command: safeText(c?.command || c?.cmd || c?.click || ''),
					releaseCommand: safeText(c?.releaseCommand || c?.release || ''),
					label: safeText(c?.label || ''),
					icon: safeText(c?.icon || c?.staticIcon || ''),
					itemName,
					state: safeText(c?.state ?? c?.item?.state ?? getState(itemName)),
					stateless: !!c?.stateless,
				});
			}
		}
		return buttons;
	}

	/* ── public API ─────────────────────────────────────────────────────── */

	return {
		safeText,
		widgetType,
		widgetLink,
		widgetPageLink,
		widgetIconName,
		deltaKey,
		splitLabelState,
		widgetKey,
		normalizeMapping,
		normalizeButtongridButtons,
	};

}));
