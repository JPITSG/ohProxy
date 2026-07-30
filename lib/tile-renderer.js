'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { VectorTile } = require('@mapbox/vector-tile');
const { PbfReader } = require('pbf');

// Rasterizes Protomaps basemap vector tiles (MVT) to 256px PNG tiles with an
// OSM-inspired palette, using Skia compiled to WebAssembly (canvaskit-wasm):
// pure in-process rendering, no native modules, no external binaries.
//
// Display zooms above the data ceiling are drawn by overzooming the ancestor
// tile: geometry is scaled up (stays crisp - it is vector data), while line
// widths and font sizes follow the display zoom.

// Bump whenever the style below changes so cached rendered tiles regenerate.
const RENDER_STYLE_VERSION = 'v2';
const TILE_SIZE = 256;
const MVT_EXTENT = 4096;
const MAX_CONCURRENT_RENDERS = 4;

const COLORS = {
	background: '#f2efe9',
	water: '#aad3df',
	building: '#d9d0c9',
	buildingLine: '#c8bdb2',
	boundary: '#a09aab',
	placeText: '#222222',
	placeSubText: '#7a7268',
	placeHalo: '#ffffff',
	roadText: '#403c36',
	waterText: '#4d7ba3',
};

// Landmark (pois layer) kinds worth labelling, grouped into text colours.
const POI_COLORS = {
	station: '#5a6ab0', bus_station: '#5a6ab0',
	park: '#3f7a3f', garden: '#3f7a3f', playground: '#3f7a3f', nature_reserve: '#3f7a3f',
	wood: '#3f7a3f', forest: '#3f7a3f', zoo: '#3f7a3f', cemetery: '#3f7a3f',
	hospital: '#bf5b5b', clinic: '#bf5b5b', pharmacy: '#bf5b5b',
	school: '#7d5a3c', university: '#7d5a3c', college: '#7d5a3c', kindergarten: '#7d5a3c',
	library: '#7d5a3c', museum: '#7d5a3c', attraction: '#7d5a3c', monument: '#7d5a3c',
	memorial: '#7d5a3c', stadium: '#7d5a3c', sports_centre: '#7d5a3c', supermarket: '#7d5a3c',
	marketplace: '#7d5a3c', place_of_worship: '#7d5a3c', police: '#7d5a3c', post_office: '#7d5a3c',
	theatre: '#7d5a3c', cinema: '#7d5a3c', hotel: '#7d5a3c', townhall: '#7d5a3c', castle: '#7d5a3c',
};

// Earliest display zoom at which each road class shows its street name.
const ROAD_LABEL_MIN_ZOOM = {
	motorway: 12, trunk: 13, primary: 13, secondary: 14, tertiary: 14,
	minor: 15, service: 16, path: 16,
};

// [fill, casing] per road class; null casing means no casing pass.
const ROAD_COLORS = {
	motorway: ['#e892a2', '#dc2a67'],
	trunk: ['#f9b29c', '#cf6649'],
	primary: ['#fcd6a4', '#a06b00'],
	secondary: ['#f7fabf', '#8a9207'],
	tertiary: ['#ffffff', '#8f8f8f'],
	minor: ['#ffffff', '#b5b0a9'],
	service: ['#ffffff', '#c5c0b9'],
	path: ['#996f42', null],
	rail: ['#8b8b8b', null],
	ferry: ['#7ba9d6', null],
};

// Draw order for road classes (first drawn = bottom).
const ROAD_ORDER = ['ferry', 'path', 'service', 'minor', 'rail', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway'];

const LANDUSE_COLORS = {
	park: '#cdebb0', garden: '#cdebb0', grass: '#cdebb0', grassland: '#cdebb0', meadow: '#cdebb0',
	village_green: '#cdebb0', allotments: '#c9e1bf', cemetery: '#aacbaf', wood: '#add19e', forest: '#add19e',
	pitch: '#aae0cb', playground: '#aae0cb', recreation_ground: '#cdebb0', dog_park: '#cdebb0',
	residential: '#e2dfda', commercial: '#f2dad9', industrial: '#ebdbe8', railway: '#ebdbe8',
	military: '#f3d9d5', farmland: '#eef0d5', farmyard: '#eef0d5',
	school: '#ffffe5', university: '#ffffe5', college: '#ffffe5', kindergarten: '#ffffe5', hospital: '#ffffe5',
	beach: '#fff1ba', sand: '#fff1ba', pedestrian: '#dddde9', pier: '#dddde9', platform: '#dddde9',
};

// kind_detail -> class; anything unlisted falls back by kind.
const ROAD_DETAIL_CLASS = {
	motorway: 'motorway', motorway_link: 'motorway',
	trunk: 'trunk', trunk_link: 'trunk',
	primary: 'primary', primary_link: 'primary',
	secondary: 'secondary', secondary_link: 'secondary',
	tertiary: 'tertiary', tertiary_link: 'tertiary',
	residential: 'minor', unclassified: 'minor', living_street: 'minor', road: 'minor',
	service: 'service', alley: 'service', driveway: 'service', parking_aisle: 'service', psv: 'service', bus: 'service',
	footway: 'path', sidewalk: 'path', crossing: 'path', steps: 'path', path: 'path', cycleway: 'path',
	track: 'path', pedestrian: 'path', corridor: 'path',
	rail: 'rail', subway: 'rail', light_rail: 'rail', tram: 'rail', narrow_gauge: 'rail', monorail: 'rail',
	funicular: 'rail', depot: 'rail', disused: 'rail', yard: 'rail', siding: 'rail',
};
const ROAD_KIND_CLASS = { highway: 'motorway', major_road: 'primary', minor_road: 'minor', path: 'path', rail: 'rail', ferry: 'ferry' };

// Width ramps: [zoom, px] anchors, linearly interpolated, clamped at the ends.
const WIDTH_RAMPS = {
	motorway: [[6, 0.7], [10, 2], [12, 3.5], [14, 6], [16, 12], [18, 26]],
	trunk: [[6, 0.6], [10, 1.8], [12, 3], [14, 5], [16, 10], [18, 22]],
	primary: [[8, 1], [12, 2.6], [14, 4.5], [16, 9], [18, 20]],
	secondary: [[9, 0.9], [12, 2], [14, 3.5], [16, 7.5], [18, 17]],
	tertiary: [[10, 0.8], [12, 1.6], [14, 3], [16, 6.5], [18, 15]],
	minor: [[12, 1], [14, 2.2], [16, 5.5], [18, 13]],
	service: [[13, 0.7], [14, 1.2], [16, 3], [18, 7]],
	path: [[13, 0.8], [16, 1.5], [18, 3]],
	rail: [[8, 0.7], [12, 1.3], [16, 2.5], [18, 5]],
	ferry: [[8, 1], [18, 2]],
	river: [[10, 1], [14, 2.5], [18, 10]],
	stream: [[13, 0.8], [18, 4]],
	boundary: [[4, 1.4], [10, 1], [18, 1]],
};

function rampWidth(name, z) {
	const ramp = WIDTH_RAMPS[name];
	if (!ramp) return 1;
	if (z <= ramp[0][0]) return ramp[0][1];
	const last = ramp[ramp.length - 1];
	if (z >= last[0]) return last[1];
	for (let i = 1; i < ramp.length; i++) {
		if (z <= ramp[i][0]) {
			const [z0, w0] = ramp[i - 1];
			const [z1, w1] = ramp[i];
			return w0 + ((z - z0) / (z1 - z0)) * (w1 - w0);
		}
	}
	return last[1];
}

function roadClassOf(properties) {
	const detail = properties.kind_detail;
	if (detail && ROAD_DETAIL_CLASS[detail]) return ROAD_DETAIL_CLASS[detail];
	const kind = properties.kind;
	return ROAD_KIND_CLASS[kind] || 'minor';
}

function hexToRgb(hex) {
	const value = parseInt(hex.slice(1), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function polylineLength(points) {
	let total = 0;
	for (let i = 1; i < points.length; i++) {
		total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
	}
	return total;
}

// Point and direction at a distance along a polyline; the angle is normalized
// to (-90, 90] so text drawn along it is never upside-down.
function polylinePointAt(points, distance) {
	let travelled = 0;
	for (let i = 1; i < points.length; i++) {
		const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
		if (travelled + seg >= distance && seg > 0) {
			const t = (distance - travelled) / seg;
			let angle = (Math.atan2(points[i].y - points[i - 1].y, points[i].x - points[i - 1].x) * 180) / Math.PI;
			if (angle > 90) angle -= 180;
			if (angle <= -90) angle += 180;
			return {
				x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
				y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
				angleDeg: angle,
			};
		}
		travelled += seg;
	}
	return null;
}

// Axis-aligned bounds of a text box of width w and height h rotated by angleDeg
// around its centre at (cx, cy) - used for collision between rotated street
// names and horizontal labels.
function rotatedLabelBounds(cx, cy, w, h, angleDeg) {
	const rad = (angleDeg * Math.PI) / 180;
	const halfW = (Math.abs(Math.cos(rad)) * w + Math.abs(Math.sin(rad)) * h) / 2;
	const halfH = (Math.abs(Math.sin(rad)) * w + Math.abs(Math.cos(rad)) * h) / 2;
	return { x0: cx - halfW, y0: cy - halfH, x1: cx + halfW, y1: cy + halfH };
}

// Shared CanvasKit instance: the WASM module is ~7 MB and initializes once.
let canvasKitPromise = null;
function loadCanvasKit() {
	if (!canvasKitPromise) {
		const CanvasKitInit = require('canvaskit-wasm');
		const ckDir = path.dirname(require.resolve('canvaskit-wasm'));
		canvasKitPromise = CanvasKitInit({ locateFile: (file) => path.join(ckDir, file) });
	}
	return canvasKitPromise;
}

function createTileRenderer(options) {
	const opts = options || {};
	const log = typeof opts.log === 'function' ? opts.log : () => {};
	const fontFile = opts.fontFile || '';
	const boldFontFile = opts.boldFontFile
		|| (fontFile && fontFile.includes('.ttf') ? fontFile.replace(/\.ttf$/i, '-Bold.ttf') : '');

	let initPromise = null;
	let CK = null;
	let typeface = null;
	let boldTypeface = null;
	let fontWarned = false;
	let activeRenders = 0;
	const renderQueue = [];

	function ensureInit() {
		if (!initPromise) {
			initPromise = (async () => {
				CK = await loadCanvasKit();
				for (const [file, assign] of [[fontFile, 'regular'], [boldFontFile, 'bold']]) {
					if (!file) continue;
					try {
						const data = fs.readFileSync(file);
						const face = CK.Typeface.MakeTypefaceFromData(data);
						if (assign === 'regular') typeface = face;
						else boldTypeface = face;
					} catch (err) {
						if (assign === 'regular' && !fontWarned) {
							fontWarned = true;
							log(`[TileRender] Font ${file} unavailable, labels disabled: ${err.message || err}`);
						}
					}
				}
				if (!boldTypeface) boldTypeface = typeface;
			})();
		}
		return initPromise;
	}

	function color(hex, alpha = 1) {
		const [r, g, b] = hexToRgb(hex);
		return CK.Color(r, g, b, alpha);
	}

	function makePaint(hex, alpha = 1) {
		const paint = new CK.Paint();
		paint.setAntiAlias(true);
		paint.setColor(color(hex, alpha));
		return paint;
	}

	function strokePaint(hex, width, alpha = 1, dash = null) {
		const paint = makePaint(hex, alpha);
		paint.setStyle(CK.PaintStyle.Stroke);
		paint.setStrokeWidth(width);
		paint.setStrokeCap(CK.StrokeCap.Round);
		paint.setStrokeJoin(CK.StrokeJoin.Round);
		if (dash) paint.setPathEffect(CK.PathEffect.MakeDash(dash));
		return paint;
	}

	function buildPath(geometry, transform, closed) {
		const builder = new CK.PathBuilder();
		for (const ring of geometry) {
			if (!ring.length) continue;
			builder.moveTo(transform.x(ring[0].x), transform.y(ring[0].y));
			for (let i = 1; i < ring.length; i++) {
				builder.lineTo(transform.x(ring[i].x), transform.y(ring[i].y));
			}
			if (closed) builder.close();
		}
		const built = builder.makePath ? builder.makePath() : builder.detach();
		builder.delete();
		return built;
	}

	function drawPathAndFree(canvas, geometry, transform, closed, paints) {
		const built = buildPath(geometry, transform, closed);
		for (const paint of paints) canvas.drawPath(built, paint);
		built.delete();
	}

	function eachFeature(layer, displayZ, callback) {
		if (!layer) return;
		for (let i = 0; i < layer.length; i++) {
			const feature = layer.feature(i);
			const properties = feature.properties;
			const minZoom = Number(properties.min_zoom);
			if (Number.isFinite(minZoom) && displayZ < minZoom) continue;
			callback(feature, properties);
		}
	}

	function measureText(font, text) {
		const ids = font.getGlyphIDs(text);
		const widths = font.getGlyphWidths(ids);
		let total = 0;
		for (const w of widths) total += w;
		return total;
	}

	// Shared labelling engine: place names, water body names, street names
	// along their roads, and landmark labels compete for space in one collision
	// pass, in that priority order.
	function placeAllLabels(canvas, vt, displayZ, transform, roadBuckets) {
		if (!typeface) return;
		const placed = [];
		let drawn = 0;
		const MAX_LABELS = 30;

		const tryPlace = (box) => {
			if (drawn >= MAX_LABELS) return false;
			if (placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) return false;
			placed.push(box);
			drawn++;
			return true;
		};

		const drawHaloText = (text, x, y, font, textColor, haloWidth) => {
			const halo = strokePaint(COLORS.placeHalo, haloWidth, 0.9);
			const fill = makePaint(textColor);
			canvas.drawText(text, x, y, halo, font);
			canvas.drawText(text, x, y, fill, font);
			halo.delete();
			fill.delete();
		};

		// --- Place names (highest priority) ---
		const places = [];
		eachFeature(vt.layers.places, displayZ, (feature, properties) => {
			if (!properties.name) return;
			const point = feature.loadGeometry()[0] && feature.loadGeometry()[0][0];
			if (!point) return;
			const x = transform.x(point.x);
			const y = transform.y(point.y);
			if (x < -48 || x > TILE_SIZE + 48 || y < -24 || y > TILE_SIZE + 24) return;
			places.push({ properties, x, y, sortKey: Number(properties.sort_key) || 0 });
		});
		places.sort((a, b) => a.sortKey - b.sortKey);
		let placeCount = 0;
		for (const c of places) {
			if (placeCount >= 14) break;
			const kind = c.properties.kind;
			const popRank = Number(c.properties.population_rank) || 0;
			let size = 11;
			let bold = false;
			let textColor = COLORS.placeText;
			if (kind === 'locality') {
				if (popRank >= 11) { size = 15; bold = true; }
				else if (popRank >= 8) { size = 13.5; bold = true; }
				else if (popRank >= 4) size = 12;
			} else if (kind === 'country') { size = 13; bold = true; textColor = '#7c7c94'; }
			else if (kind === 'region') { size = 12; textColor = '#9a9186'; }
			else { size = 10.5; textColor = COLORS.placeSubText; }

			const font = new CK.Font(bold ? boldTypeface : typeface, size);
			const text = String(c.properties.name);
			const width = measureText(font, text);
			if (tryPlace({ x0: c.x - width / 2 - 2, y0: c.y - size, x1: c.x + width / 2 + 2, y1: c.y + size * 0.5 })) {
				drawHaloText(text, c.x - width / 2, c.y + size * 0.35, font, textColor, 3);
				placeCount++;
			}
			font.delete();
		}

		// --- Water body names (lakes etc.) ---
		if (displayZ >= 13) {
			eachFeature(vt.layers.water, displayZ, (feature, properties) => {
				if (feature.type !== 3 || !properties.name) return;
				const ring = feature.loadGeometry()[0];
				if (!ring || ring.length < 3) return;
				let cx = 0;
				let cy = 0;
				for (const p of ring) { cx += transform.x(p.x); cy += transform.y(p.y); }
				cx /= ring.length;
				cy /= ring.length;
				if (cx < -20 || cx > TILE_SIZE + 20 || cy < -12 || cy > TILE_SIZE + 12) return;
				const font = new CK.Font(typeface, 10.5);
				const text = String(properties.name);
				const width = measureText(font, text);
				if (tryPlace({ x0: cx - width / 2 - 2, y0: cy - 10.5, x1: cx + width / 2 + 2, y1: cy + 5 })) {
					drawHaloText(text, cx - width / 2, cy + 3.5, font, COLORS.waterText, 2.5);
				}
				font.delete();
			});
		}

		// --- Street names along their roads ---
		const size = displayZ < 15 ? 10 : displayZ < 16 ? 10.5 : displayZ < 17 ? 11 : 12;
		const roadFont = new CK.Font(typeface, size);
		const byName = new Map();
		for (const [cls, list] of roadBuckets) {
			const minZoom = ROAD_LABEL_MIN_ZOOM[cls];
			if (minZoom === undefined || displayZ < minZoom) continue;
			for (const road of list) {
				const name = road.properties.name;
				if (!name) continue;
				for (const part of road.geometry) {
					if (part.length < 2) continue;
					const points = part.map((p) => ({ x: transform.x(p.x), y: transform.y(p.y) }));
					const length = polylineLength(points);
					const existing = byName.get(name);
					if (!existing || length > existing.length) byName.set(name, { points, length });
				}
			}
		}
		const roadCandidates = [...byName.entries()].sort((a, b) => b[1].length - a[1].length);
		let roadCount = 0;
		for (const [name, candidate] of roadCandidates) {
			if (roadCount >= 10) break;
			const text = String(name);
			const width = measureText(roadFont, text);
			if (candidate.length < width * 1.2) continue;
			const mid = polylinePointAt(candidate.points, candidate.length / 2);
			if (!mid) continue;
			if (mid.x < -10 || mid.x > TILE_SIZE + 10 || mid.y < -10 || mid.y > TILE_SIZE + 10) continue;
			if (!tryPlace(rotatedLabelBounds(mid.x, mid.y, width + 4, size + 4, mid.angleDeg))) continue;
			canvas.save();
			canvas.rotate(mid.angleDeg, mid.x, mid.y);
			drawHaloText(text, mid.x - width / 2, mid.y + size * 0.32, roadFont, COLORS.roadText, 2.5);
			canvas.restore();
			roadCount++;
		}
		roadFont.delete();

		// --- Landmarks (pois layer) ---
		if (displayZ >= 14) {
			const poiFont = new CK.Font(typeface, 9.5);
			eachFeature(vt.layers.pois, displayZ, (feature, properties) => {
				if (feature.type !== 1 || !properties.name) return;
				const poiColor = POI_COLORS[properties.kind];
				if (!poiColor) return;
				const point = feature.loadGeometry()[0] && feature.loadGeometry()[0][0];
				if (!point) return;
				const x = transform.x(point.x);
				const y = transform.y(point.y);
				if (x < -8 || x > TILE_SIZE + 8 || y < -8 || y > TILE_SIZE + 8) return;
				const text = String(properties.name);
				const width = measureText(poiFont, text);
				if (!tryPlace({ x0: x - 4, y0: y - 9.5, x1: x + 6 + width + 2, y1: y + 6 })) return;
				const dot = makePaint(poiColor);
				canvas.drawCircle(x, y, 2.2, dot);
				dot.delete();
				drawHaloText(text, x + 5.5, y + 3.2, poiFont, poiColor, 2.5);
			});
			poiFont.delete();
		}
	}

	async function renderTileInner(job) {
		await ensureInit();
		const { mvt, z, x, y, srcZ, srcX, srcY } = job;
		const vt = new VectorTile(new PbfReader(mvt));

		// Overzoom transform: scale the source tile up and shift to the quadrant
		// this display tile occupies.
		const d = z - srcZ;
		const scale = (TILE_SIZE * 2 ** d) / MVT_EXTENT;
		const offX = (x - (srcX << d)) * TILE_SIZE;
		const offY = (y - (srcY << d)) * TILE_SIZE;
		const transform = {
			x: (c) => c * scale - offX,
			y: (c) => c * scale - offY,
		};

		const surface = CK.MakeSurface(TILE_SIZE, TILE_SIZE);
		if (!surface) throw new Error('MakeSurface failed');
		const canvas = surface.getCanvas();
		canvas.clear(color(COLORS.background));

		// Landuse fills
		eachFeature(vt.layers.landuse, z, (feature, properties) => {
			if (feature.type !== 3) return;
			const fillColor = LANDUSE_COLORS[properties.kind];
			if (!fillColor) return;
			const paint = makePaint(fillColor);
			drawPathAndFree(canvas, feature.loadGeometry(), transform, true, [paint]);
			paint.delete();
		});

		// Water polygons then waterway lines
		eachFeature(vt.layers.water, z, (feature) => {
			if (feature.type !== 3) return;
			const paint = makePaint(COLORS.water);
			drawPathAndFree(canvas, feature.loadGeometry(), transform, true, [paint]);
			paint.delete();
		});
		eachFeature(vt.layers.water, z, (feature, properties) => {
			if (feature.type !== 2) return;
			const ramp = properties.kind === 'stream' ? 'stream' : 'river';
			const paint = strokePaint(COLORS.water, rampWidth(ramp, z));
			drawPathAndFree(canvas, feature.loadGeometry(), transform, false, [paint]);
			paint.delete();
		});

		// Boundaries
		eachFeature(vt.layers.boundaries, z, (feature) => {
			if (feature.type !== 2) return;
			const paint = strokePaint(COLORS.boundary, rampWidth('boundary', z), 0.8, [5, 3]);
			drawPathAndFree(canvas, feature.loadGeometry(), transform, false, [paint]);
			paint.delete();
		});

		// Roads: bucket by class, then draw casing+fill class by class so the
		// hierarchy stacks correctly (motorways above minor roads).
		const buckets = new Map();
		eachFeature(vt.layers.roads, z, (feature, properties) => {
			if (feature.type !== 2) return;
			const cls = roadClassOf(properties);
			if (cls === 'path' && z < 13) return;
			if (!buckets.has(cls)) buckets.set(cls, []);
			buckets.get(cls).push({ geometry: feature.loadGeometry(), properties });
		});

		for (const cls of ROAD_ORDER) {
			const list = buckets.get(cls);
			if (!list || !list.length) continue;
			const [fillColor, casingColor] = ROAD_COLORS[cls];
			const baseWidth = rampWidth(cls, z);

			if (casingColor && baseWidth >= 1.6 && z >= 11) {
				const casingWidth = baseWidth + (z >= 15 ? 2 : 1.2);
				for (const road of list) {
					const alpha = road.properties.is_tunnel ? 0.45 : 1;
					const width = road.properties.is_link ? casingWidth * 0.7 : casingWidth;
					const paint = strokePaint(casingColor, width, alpha);
					drawPathAndFree(canvas, road.geometry, transform, false, [paint]);
					paint.delete();
				}
			}
			for (const road of list) {
				const alpha = road.properties.is_tunnel ? 0.55 : 1;
				const width = road.properties.is_link ? baseWidth * 0.7 : baseWidth;
				const dash = cls === 'path' ? [3, 2] : cls === 'ferry' ? [4, 4] : null;
				const paint = strokePaint(fillColor, width, alpha, dash);
				drawPathAndFree(canvas, road.geometry, transform, false, [paint]);
				paint.delete();
				if (cls === 'rail' && z >= 13) {
					const tie = strokePaint('#ffffff', Math.max(0.6, width * 0.55), alpha, [6, 6]);
					drawPathAndFree(canvas, road.geometry, transform, false, [tie]);
					tie.delete();
				}
			}
		}

		// Buildings
		if (z >= 13) {
			eachFeature(vt.layers.buildings, z, (feature) => {
				if (feature.type !== 3) return;
				const fill = makePaint(COLORS.building);
				const paints = [fill];
				let line = null;
				if (z >= 15) {
					line = strokePaint(COLORS.buildingLine, 0.6);
					paints.push(line);
				}
				drawPathAndFree(canvas, feature.loadGeometry(), transform, true, paints);
				fill.delete();
				if (line) line.delete();
			});
		}

		// Labels: places, water names, street names, landmarks - one collision pass.
		placeAllLabels(canvas, vt, z, transform, buckets);

		const image = surface.makeImageSnapshot();
		const png = image.encodeToBytes();
		image.delete();
		surface.delete();
		if (!png || !png.length) throw new Error('PNG encode failed');
		return Buffer.from(png);
	}

	// Small semaphore so a burst of cold tiles cannot occupy every core.
	function renderTile(job) {
		return new Promise((resolve, reject) => {
			renderQueue.push({ job, resolve, reject });
			pumpQueue();
		});
	}

	function pumpQueue() {
		while (activeRenders < MAX_CONCURRENT_RENDERS && renderQueue.length) {
			const entry = renderQueue.shift();
			activeRenders++;
			renderTileInner(entry.job)
				.then(entry.resolve, entry.reject)
				.finally(() => {
					activeRenders--;
					pumpQueue();
				});
		}
	}

	return { renderTile, ensureInit };
}

module.exports = {
	RENDER_STYLE_VERSION,
	TILE_SIZE,
	MVT_EXTENT,
	rampWidth,
	roadClassOf,
	polylineLength,
	polylinePointAt,
	rotatedLabelBounds,
	createTileRenderer,
};
