'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SERVER_FILE = path.join(PROJECT_ROOT, 'server.js');
const source = fs.readFileSync(SERVER_FILE, 'utf8');

function extractFunction(src, name) {
	const start = src.indexOf(`function ${name}(`);
	assert.ok(start >= 0, `${name} must exist`);
	const bodyStart = src.indexOf('{', start);
	let depth = 0;
	for (let i = bodyStart; i < src.length; i += 1) {
		if (src[i] === '{') depth += 1;
		else if (src[i] === '}') {
			depth -= 1;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	throw new Error(`Could not extract ${name}`);
}

const rotor = new Function(`
${extractFunction(source, 'normalizeDeg')}
${extractFunction(source, 'rotateVecDeg')}
${extractFunction(source, 'rotorRootPointToMapPx')}
${extractFunction(source, 'rotorMapPxToRootPoint')}
${extractFunction(source, 'computeRotorLiveTransform')}
${extractFunction(source, 'computeRotorCommit')}
${extractFunction(source, 'rotorRotationStep')}
return { normalizeDeg, rotateVecDeg, rotorRootPointToMapPx, rotorMapPxToRootPoint, computeRotorLiveTransform, computeRotorCommit, rotorRotationStep };
`)();

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// Screen position of projected point P for a given map state - mirrors the
// content->screen model the commit math inverts.
function screenOf(P, center, res, theta, S) {
	const m = { x: (P.x - center.x) / res, y: -(P.y - center.y) / res };
	const e = rotor.rotateVecDeg(theta, m.x, m.y);
	return { x: S.x + e.x, y: S.y + e.y };
}

describe('Rotor coordinate transforms', () => {
	it('north-up viewport-sized state is a strict identity (regression guard)', () => {
		const m = rotor.rotorRootPointToMapPx(123.4, 567.8, 0, 1920, 1073, 1920, 1073);
		close(m.x, 123.4); close(m.y, 567.8);
		const r = rotor.rotorMapPxToRootPoint(123.4, 567.8, 0, 1920, 1073, 1920, 1073);
		close(r.x, 123.4); close(r.y, 567.8);
	});

	it('rotated oversized transforms round-trip exactly', () => {
		const args = [37.3, 2201, 2201, 1920, 1073];
		const m = rotor.rotorRootPointToMapPx(400, 900, ...args);
		const back = rotor.rotorMapPxToRootPoint(m.x, m.y, ...args);
		close(back.x, 400, 1e-9); close(back.y, 900, 1e-9);
	});

	it('a 90-degree rotation maps screen-up to map-left', () => {
		// Content rotated +90 (clockwise): the point that appears 10px above the
		// root centre lies 10px left of the map-div centre in map pixels.
		const m = rotor.rotorRootPointToMapPx(960, 536.5 - 10, 90, 1920, 1073, 1920, 1073);
		close(m.x, 960 - 10); close(m.y, 536.5);
	});

	it('normalizeDeg wraps into [-180,180]', () => {
		close(rotor.normalizeDeg(190), -170);
		close(rotor.normalizeDeg(-190), 170);
		close(rotor.normalizeDeg(360), 0);
	});
});

describe('Rotor live gesture transform', () => {
	it('an idle gesture is the base transform', () => {
		const t = rotor.computeRotorLiveTransform(25, 1, 0, 300, 300, 300, 300, 960, 536);
		close(t.tx, 0); close(t.ty, 0); close(t.rot, 25); close(t.scale, 1);
	});

	it('pure centroid drift becomes pure translation', () => {
		const t = rotor.computeRotorLiveTransform(0, 1, 0, 300, 300, 340, 280, 960, 536);
		close(t.tx, 40); close(t.ty, -20); close(t.rot, 0); close(t.scale, 1);
	});
});

describe('Rotor gesture commit', () => {
	const S = { x: 960, y: 536 };
	const base = {
		theta0: 0, s: 1, dTheta: 0,
		G0x: S.x, G0y: S.y, G1x: S.x, G1y: S.y,
		Sx: S.x, Sy: S.y,
		cx0: 5000, cy0: 8000, res0: 4, zoom0: 10,
		minZoom: 0, maxZoom: 19,
		resForZoom: (z) => 4 * Math.pow(2, 10 - z),
	};

	it('a centred pinch of 2x is exactly one zoom step with the centre kept', () => {
		const r = rotor.computeRotorCommit({ ...base, s: 2 });
		assert.strictEqual(r.zoom, 11);
		close(r.cx, 5000); close(r.cy, 8000); close(r.theta, 0);
	});

	it('an off-centre pinch keeps the grabbed content under the fingers', () => {
		const G = { x: S.x + 100, y: S.y };
		const r = rotor.computeRotorCommit({ ...base, s: 2, G0x: G.x, G0y: G.y, G1x: G.x, G1y: G.y });
		close(r.cx, 5000 + 100 * 4 - 100 * 2);
		close(r.cy, 8000);
	});

	it('pure rotation about an off-centre point preserves zoom and the finger invariant', () => {
		const G = { x: S.x + 200, y: S.y - 120 };
		const p = { ...base, dTheta: 33, G0x: G.x, G0y: G.y, G1x: G.x, G1y: G.y };
		const r = rotor.computeRotorCommit(p);
		assert.strictEqual(r.zoom, 10);
		close(r.theta, 33);
		// The projected point that started under the fingers must still render there.
		const m0 = rotor.rotateVecDeg(-0, G.x - S.x, G.y - S.y);
		const Pg = { x: base.cx0 + m0.x * base.res0, y: base.cy0 - m0.y * base.res0 };
		const after = screenOf(Pg, { x: r.cx, y: r.cy }, base.resForZoom(r.zoom), r.theta, S);
		close(after.x, G.x, 1e-6); close(after.y, G.y, 1e-6);
	});

	it('combined pinch + rotate + drift still satisfies the finger invariant', () => {
		const p = { ...base, theta0: 20, s: 1.9, dTheta: -47, G0x: 700, G0y: 300, G1x: 1100, G1y: 650 };
		const r = rotor.computeRotorCommit(p);
		const m0 = rotor.rotateVecDeg(-p.theta0, p.G0x - S.x, p.G0y - S.y);
		const Pg = { x: p.cx0 + m0.x * p.res0, y: p.cy0 - m0.y * p.res0 };
		const after = screenOf(Pg, { x: r.cx, y: r.cy }, p.resForZoom(r.zoom), r.theta, S);
		// zoom snaps to the nearest integer step, so the invariant holds exactly
		// only in screen direction terms after the snap-compensated recentre.
		close(after.x, p.G1x, 1e-6); close(after.y, p.G1y, 1e-6);
	});

	it('zoom is clamped to the layer range', () => {
		assert.strictEqual(rotor.computeRotorCommit({ ...base, s: 4096 }).zoom, 19);
		assert.strictEqual(rotor.computeRotorCommit({ ...base, s: 1 / 4096 }).zoom, 0);
	});

	it('sub-step pinches keep the zoom but recentre through the snap', () => {
		const G = { x: S.x + 100, y: S.y };
		const r = rotor.computeRotorCommit({ ...base, s: 1.3, G0x: G.x, G0y: G.y, G1x: G.x, G1y: G.y });
		assert.strictEqual(r.zoom, 10);
		close(r.cx, 5000);
	});
});

describe('Rotor rotation gating', () => {
	function freshGesture(over) {
		return Object.assign({
			engaged: false, zoomLocked: false, acc: 0, accAtEngage: 0, aPrev: 0, dTheta: 0,
			engageDeg: 20, zoomPenaltyDeg: 40, zoomLockSteps: 0.75,
		}, over || {});
	}

	it('finger wander below the base threshold stays a pure pinch', () => {
		const g = freshGesture();
		rotor.rotorRotationStep(g, 18, 1);
		assert.strictEqual(g.dTheta, 0);
		assert.strictEqual(g.engaged, false);
	});

	it('a deliberate pure twist engages without a jump', () => {
		const g = freshGesture();
		rotor.rotorRotationStep(g, 21, 1);
		assert.strictEqual(g.engaged, true);
		assert.strictEqual(g.dTheta, 0, 'rotation restarts from the engage point');
		rotor.rotorRotationStep(g, 27, 1);
		close(g.dTheta, 6);
	});

	it('zooming raises the twist required to engage', () => {
		// s=1.5 is ~0.585 zoom steps: the bar becomes 20 + 40*0.585 ~ 43.4 degrees.
		const g = freshGesture();
		rotor.rotorRotationStep(g, 40, 1.5);
		assert.strictEqual(g.engaged, false, '40 degrees is not enough while zooming');
		rotor.rotorRotationStep(g, 44, 1.5);
		assert.strictEqual(g.engaged, true);
	});

	it('a clear zoom locks the gesture against rotation for good', () => {
		const g = freshGesture();
		rotor.rotorRotationStep(g, 10, 1.7);
		assert.strictEqual(g.zoomLocked, true, '0.766 zoom steps crosses the lock');
		rotor.rotorRotationStep(g, 90, 1);
		assert.strictEqual(g.engaged, false, 'a locked gesture never rotates');
		assert.strictEqual(g.dTheta, 0);
	});

	it('an already-rotated map needs a smaller but still real twist', () => {
		const g = freshGesture({ engageDeg: 8 });
		rotor.rotorRotationStep(g, 6, 1);
		assert.strictEqual(g.engaged, false);
		rotor.rotorRotationStep(g, 9, 1);
		assert.strictEqual(g.engaged, true);
	});

	it('accumulates across the +-180 wrap without jumping', () => {
		const g = freshGesture({ engaged: true });
		rotor.rotorRotationStep(g, 179, 1);
		rotor.rotorRotationStep(g, -179, 1);
		close(g.dTheta, 181);
	});
});

describe('Rotor wiring', () => {
	it('owns the two-finger gesture: OL pinch is deactivated and listeners are bound', () => {
		assert.match(source, /if\(navControl&&navControl\.pinchZoom\)navControl\.pinchZoom\.deactivate\(\);/);
		assert.match(source, /if\(e\.touches&&e\.touches\.length>=2\)rotorGestureStart\(e\);\s*\},\{passive:true,capture:true\}\);/);
		assert.match(source, /if\(rotorGesture\)rotorGestureMove\(e\);\s*\},\{passive:false,capture:true\}\);/);
		assert.match(source, /mapEl\.addEventListener\('touchend',rotorGestureEnd,\{passive:true,capture:true\}\);/);
	});

	it('input and overlay pipelines are rotation-aware', () => {
		assert.match(source, /if\(\(isRotatedViewportMode\(\)\|\|rotorTheta!==0\|\|rotorGesture\)&&evt/);
		assert.match(source, /function positionTooltip\(el,px,offset\)\{\s*if\(!el\|\|!px\|\|!offset\)return;\s*var p=mapPixelToRootPoint\(px\);/);
		assert.match(source, /return mapPixelToRootPoint\(map\.getPixelFromLonLat\(lonlat\)\);/);
		assert.match(source, /var rootPx=mapPixelToRootPoint\(px\);\s*setCtxMenuPosition\(rootPx\.x,rootPx\.y\);/);
		assert.match(source, /var panVec=rotateVecDeg\(-90-rotorTheta,dx,dy\);/);
	});

	it('rotation must be explicit: gating constants and per-state thresholds are wired', () => {
		assert.match(source, /var ROTOR_ENGAGE_DEG=20;\s*var ROTOR_ENGAGE_ROTATED_DEG=8;\s*var ROTOR_ZOOM_PENALTY_DEG=40;\s*var ROTOR_ZOOM_LOCK_STEPS=0\.75;/);
		assert.match(source, /engageDeg:rotorTheta!==0\?ROTOR_ENGAGE_ROTATED_DEG:ROTOR_ENGAGE_DEG,/);
		assert.match(source, /rotorRotationStep\(g,Math\.atan2\(dy,dx\)\*180\/Math\.PI,g\.s\);/);
	});

	it('release auto-snaps near-north and the compass resets the rest', () => {
		assert.match(source, /var ROTOR_SNAP_DEG=7;/);
		assert.match(source, /if\(rotorTheta!==0&&Math\.abs\(rotorTheta\)<=ROTOR_SNAP_DEG\)animateRotorTo\(0\);/);
		assert.match(source, /<button class="map-ctrl-btn" id="map-compass"/);
		assert.match(source, /if\(rotorTheta!==0&&!rotorGesture\)animateRotorTo\(0\);/);
	});

	it('day loads reset the rotor before refitting the extent', () => {
		assert.match(source, /function zoomToMarkers\(\)\{\s*resetRotorInstant\(\);/);
	});

	it('the center-map button reverts to north before recentring', () => {
		assert.match(source, /if\(!singlePointMode\)clearPresenceMapPopups\(\);\s*resetRotorInstant\(\);\s*focusRedMarkerAtDefaultZoom\(\);/);
		assert.match(source, /if\(rotorTheta!==0\)return false;/, 'rotation alone must keep the home button enabled');
		assert.match(source, /updateCompass\(\);\s*syncZoomButtonState\(\);\s*scheduleZoomOverlayReveal\(\);/, 'rotation changes resync the control state');
	});

	it('markers stay upright: creation carries the counter-rotation and settles redraw', () => {
		assert.match(source, /graphicYOffset:-41,rotation:-rotorTheta\}/);
		assert.match(source, /function uprightMapMarkers\(\)\{[\s\S]*?feats\[i\]\.style\.rotation=deg;[\s\S]*?defaultStyle\.rotation=deg;[\s\S]*?layer\.redraw\(\);/);
	});
});
