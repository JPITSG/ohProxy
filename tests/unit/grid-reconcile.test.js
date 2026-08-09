'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

function extractFunction(source, name) {
	const start = source.indexOf(`function ${name}(`);
	assert.ok(start >= 0, `${name} must exist`);
	const bodyStart = source.indexOf('{', start);
	let depth = 0;
	for (let i = bodyStart; i < source.length; i += 1) {
		if (source[i] === '{') depth += 1;
		else if (source[i] === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error(`Could not extract ${name}`);
}

// Minimal stand-in for the #grid element and its children. insertBefore is
// instrumented so tests can assert that surviving nodes were never re-inserted
// (re-parenting a DOM node reloads any iframe inside it).
function createGrid() {
	return {
		nodes: [],
		get firstChild() { return this.nodes[0] || null; },
		insertBefore(node, ref) {
			const existing = this.nodes.indexOf(node);
			if (existing !== -1) this.nodes.splice(existing, 1);
			node.inserts += 1;
			node.parent = this;
			const at = ref ? this.nodes.indexOf(ref) : -1;
			this.nodes.splice(at === -1 ? this.nodes.length : at, 0, node);
		},
	};
}

function makeNode({ widgetKey, sectionSig, renderSig, label } = {}) {
	return {
		label: label || widgetKey || sectionSig || '',
		inserts: 0,
		parent: null,
		built: false,
		classList: { contains: (cls) => cls === 'section-header' && sectionSig !== undefined },
		dataset: {
			...(widgetKey !== undefined ? { widgetKey } : {}),
			...(sectionSig !== undefined ? { sectionSig } : {}),
			...(renderSig !== undefined ? { renderSig } : {}),
		},
		get nextSibling() {
			if (!this.parent) return null;
			const i = this.parent.nodes.indexOf(this);
			return i === -1 ? null : (this.parent.nodes[i + 1] || null);
		},
		remove() {
			if (!this.parent) return;
			const i = this.parent.nodes.indexOf(this);
			if (i !== -1) this.parent.nodes.splice(i, 1);
			this.parent = null;
		},
	};
}

function seedGrid(grid, nodes) {
	for (const node of nodes) {
		node.parent = grid;
		grid.nodes.push(node);
	}
	for (const node of nodes) node.inserts = 0;
	return nodes;
}

// Widgets are plain objects: { key, renderSig } for cards,
// { __section: true, sig } for headers. failUpdate forces updateCard() -> false.
function runReconcile(grid, widgets, options = {}) {
	const removed = [];
	const updated = [];
	const els = { grid };
	const reconcileWidgets = Function(
		'els', 'sectionSignature', 'widgetKey', 'getWidgetRenderInfo',
		'updateCard', 'buildCard', 'buildSectionHeader', 'removeGridNode',
		`return (${extractFunction(app, 'reconcileWidgets')});`
	)(
		els,
		(w) => w.sig || '',
		(w) => w.key || '',
		(w) => ({ signature: w.renderSig || '' }),
		(node, w) => {
			if (w.failUpdate) return false;
			updated.push(node);
			node.dataset.renderSig = w.renderSig || '';
			return true;
		},
		(w) => {
			const node = makeNode({ widgetKey: w.key || '', renderSig: w.renderSig, label: `built:${w.key}` });
			node.built = true;
			return node;
		},
		(w) => {
			const node = makeNode({ sectionSig: w.sig || '', label: `built-header:${w.sig}` });
			node.built = true;
			return node;
		},
		(node) => {
			removed.push(node);
			node.remove();
		}
	);
	reconcileWidgets(widgets, options.nodes || [...grid.nodes]);
	return { removed, updated };
}

describe('Grid keyed reconciliation (reconcileWidgets)', () => {
	it('render() structural path delegates to reconcileWidgets instead of wiping the grid', () => {
		assert.match(app, /\} else \{\s*reconcileWidgets\(widgets, nodes\);\s*\}/);
		assert.ok(!app.includes("els.grid.innerHTML = '';"), 'grid must not be wiped wholesale');
	});

	it('inserting a widget above survivors never re-inserts the surviving nodes', () => {
		const grid = createGrid();
		const [a, b] = seedGrid(grid, [
			makeNode({ widgetKey: 'A', renderSig: 'a1' }),
			makeNode({ widgetKey: 'B', renderSig: 'b1' }),
		]);
		runReconcile(grid, [
			{ key: 'X', renderSig: 'x1' },
			{ key: 'A', renderSig: 'a1' },
			{ key: 'B', renderSig: 'b1' },
		]);
		assert.deepStrictEqual(grid.nodes.map((n) => n.dataset.widgetKey), ['X', 'A', 'B']);
		assert.strictEqual(a.inserts, 0, 'surviving node A must not move');
		assert.strictEqual(b.inserts, 0, 'surviving node B must not move');
		assert.ok(grid.nodes[0].built, 'X is newly built');
	});

	it('removing a widget drops its node without touching survivors', () => {
		const grid = createGrid();
		const [x, a, b] = seedGrid(grid, [
			makeNode({ widgetKey: 'X', renderSig: 'x1' }),
			makeNode({ widgetKey: 'A', renderSig: 'a1' }),
			makeNode({ widgetKey: 'B', renderSig: 'b1' }),
		]);
		const { removed } = runReconcile(grid, [
			{ key: 'A', renderSig: 'a1' },
			{ key: 'B', renderSig: 'b1' },
		]);
		assert.deepStrictEqual(grid.nodes, [a, b]);
		assert.deepStrictEqual(removed, [x]);
		assert.strictEqual(a.inserts + b.inserts, 0);
	});

	it('changed signature patches the surviving node in place', () => {
		const grid = createGrid();
		const [a] = seedGrid(grid, [makeNode({ widgetKey: 'A', renderSig: 'a1' })]);
		const { updated, removed } = runReconcile(grid, [{ key: 'A', renderSig: 'a2' }]);
		assert.deepStrictEqual(updated, [a]);
		assert.deepStrictEqual(removed, []);
		assert.strictEqual(a.inserts, 0);
		assert.strictEqual(a.dataset.renderSig, 'a2');
	});

	it('rebuilds in place when updateCard cannot patch', () => {
		const grid = createGrid();
		const [a, b] = seedGrid(grid, [
			makeNode({ widgetKey: 'A', renderSig: 'a1' }),
			makeNode({ widgetKey: 'B', renderSig: 'b1' }),
		]);
		const { removed } = runReconcile(grid, [
			{ key: 'A', renderSig: 'a2', failUpdate: true },
			{ key: 'B', renderSig: 'b1' },
		]);
		assert.deepStrictEqual(removed, [a]);
		assert.deepStrictEqual(grid.nodes.map((n) => n.dataset.widgetKey), ['A', 'B']);
		assert.ok(grid.nodes[0].built, 'A was rebuilt');
		assert.strictEqual(b.inserts, 0, 'B must not move around the rebuild');
	});

	it('pairs duplicate widget keys positionally without moving either node', () => {
		const grid = createGrid();
		const [a1, a2] = seedGrid(grid, [
			makeNode({ widgetKey: 'A', renderSig: 'p1', label: 'first' }),
			makeNode({ widgetKey: 'A', renderSig: 'p2', label: 'second' }),
		]);
		runReconcile(grid, [
			{ key: 'A', renderSig: 'p1' },
			{ key: 'A', renderSig: 'p2' },
		]);
		assert.deepStrictEqual(grid.nodes, [a1, a2]);
		assert.strictEqual(a1.inserts + a2.inserts, 0);
	});

	it('reuses section headers by signature and replaces changed ones', () => {
		const grid = createGrid();
		const [h1, card, h2] = seedGrid(grid, [
			makeNode({ sectionSig: 'Power||0' }),
			makeNode({ widgetKey: 'A', renderSig: 'a1' }),
			makeNode({ sectionSig: 'Water||0' }),
		]);
		const { removed } = runReconcile(grid, [
			{ __section: true, sig: 'Power||0' },
			{ key: 'A', renderSig: 'a1' },
			{ __section: true, sig: 'Water|tint|0' },
		]);
		assert.strictEqual(grid.nodes[0], h1, 'unchanged header is reused');
		assert.strictEqual(grid.nodes[1], card);
		assert.ok(grid.nodes[2].built, 'changed header is rebuilt');
		assert.deepStrictEqual(removed, [h2]);
		assert.strictEqual(card.inserts, 0);
	});

	it('reorders with the minimum number of moves', () => {
		const grid = createGrid();
		const [a, b] = seedGrid(grid, [
			makeNode({ widgetKey: 'A', renderSig: 'a1' }),
			makeNode({ widgetKey: 'B', renderSig: 'b1' }),
		]);
		runReconcile(grid, [
			{ key: 'B', renderSig: 'b1' },
			{ key: 'A', renderSig: 'a1' },
		]);
		assert.deepStrictEqual(grid.nodes, [b, a]);
		assert.strictEqual(b.inserts, 1, 'B moves once');
		assert.strictEqual(a.inserts, 0, 'A stays put');
	});

	it('replaces everything when no keys match (page navigation)', () => {
		const grid = createGrid();
		const [a, b] = seedGrid(grid, [
			makeNode({ widgetKey: 'A', renderSig: 'a1' }),
			makeNode({ widgetKey: 'B', renderSig: 'b1' }),
		]);
		const { removed } = runReconcile(grid, [
			{ key: 'C', renderSig: 'c1' },
			{ key: 'D', renderSig: 'd1' },
		]);
		assert.deepStrictEqual(grid.nodes.map((n) => n.dataset.widgetKey), ['C', 'D']);
		assert.ok(grid.nodes.every((n) => n.built));
		assert.deepStrictEqual(removed, [a, b]);
	});
});
