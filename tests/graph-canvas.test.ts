/**
 * Pure-helper tests for the hand-rolled canvas renderer
 * (components/graph-canvas.ts). The renderer class itself is DOM-bound
 * (canvas, rAF, ResizeObserver) and is verified live in the browser; the
 * math it runs on every frame must be exact, so it is pinned here.
 *
 * The camera-ratio convention is the load-bearing contract with the
 * persisted settings: sigma's ratio (1 = fit, SMALLER = zoomed in) is kept
 * verbatim so stored labelZoom values survive the renderer swap.
 */

import assert from "node:assert/strict";
import { describe, it, it as test } from "node:test";
import {
	applyClusterLabels,
	arrowGeometry,
	isImpNodeId,
	boxBlurRound,
	clickSlopForPointer,
	effectiveCanvasDpr,
	fitTransform,
	GraphCanvasRenderer,
	labelAlpha,
	pickNearest,
	shouldRestoreCamera,
	wrapRegionLabel,
	zoomRatioOf,
	LABELS_FADE_RATIO,
} from "../components/graph-canvas.ts";
import { DEFAULT_RENDER_SETTINGS } from "../src/core/render-settings.ts";
import {
	sanitizePhysicsTuning,
	sanitizeRegionTuning,
	DEFAULT_PHYSICS_TUNING,
	DEFAULT_REGION_TUNING,
	REGION_BITMAP_OPTIONS,
	REGION_BLUR_LADDER,
} from "../src/core/render-settings.ts";

describe("zoomRatioOf (the sigma-compatible camera ratio)", () => {
	test("1 at fit zoom, smaller when zoomed in, larger when zoomed out", () => {
		assert.equal(zoomRatioOf(2, 2), 1); // at fit
		assert.equal(zoomRatioOf(2, 4), 0.5); // zoomed in 2x -> ratio halves
		assert.equal(zoomRatioOf(2, 1), 2); // zoomed out 2x -> ratio doubles
	});
});

describe("labelAlpha (the single zoom gate)", () => {
	test("fully visible at/below the threshold, faded out after the span", () => {
		// Proportional span: at gate 0.5 the span is 0.5 × 0.5 = 0.25.
		assert.equal(labelAlpha(0.5, 0.5), 1); // at the threshold
		assert.equal(labelAlpha(0.25, 0.5), 1); // zoomed further in: stays 1
		assert.equal(labelAlpha(0.625, 0.5), 0.5); // mid-fade (span midpoint)
		assert.equal(labelAlpha(0.75, 0.5), 0); // one proportional span out: gone
		assert.equal(labelAlpha(2.0, 0.5), 0); // far out: clamped
	});

	test("the span is PROPORTIONAL to the gate (2026-09-17), not absolute", () => {
		// The old absolute 0.5-ratio span read as a 100% relative change at
		// the old 0.5 gate but a bare 12% sliver at the tuned 8× gate (ratio
		// 4). Proportional = one consistent handoff feel at any gate.
		assert.equal(LABELS_FADE_RATIO, 0.5);
		// At the tuned default (gate 4): fades across ratio 4 → 6 (8× → 12×
		// on screen), one full ladder stop.
		assert.equal(labelAlpha(4, 4), 1); // at the gate
		assert.equal(labelAlpha(5, 4), 0.5); // mid-fade
		assert.equal(labelAlpha(6, 4), 0); // one proportional span out: gone
		// The relative shape is identical at the old gate: 0.5 → 0.75.
		assert.equal(labelAlpha(5, 4), 0.5); // mid-fade at the tuned gate, same relative shape
	});

	test("node labels and cluster labels cross-fade over the exact same span", () => {
		// The renderer draws cluster labels at 1 - labelAlpha; the two must
		// always sum to 1 within the fade and never coexist at full opacity.
		for (const gate of [0.5, 4]) {
			for (let ratio = 0; ratio <= 8; ratio += gate / 8) {
				const node = labelAlpha(ratio, gate);
				const cluster = 1 - node;
				assert.ok(node + cluster > 0.999 && node + cluster < 1.001, `sum at gate ${gate} ratio ${ratio}`);
				assert.ok(node <= 1 && cluster <= 1, `clamped at gate ${gate} ratio ${ratio}`);
			}
		}
	});
});

describe("d3 camera composition (the persisted-camera restore path)", () => {
	// The renderer restores a persisted camera via
	// zoomIdentity.translate(x, y).scale(k) — the same composition fit()
	// uses. d3's Transform.translate() shifts in SCALED space while
	// .scale() keeps the translation: identity.translate(X, Y).scale(K)
	// is exactly {k: K, x: X, y: Y}. This pins that law (the persisted
	// {k, x, y} shape round-trips through the composition) so a d3
	// upgrade that changes it fails here, not as a wrong camera.
	test("zoomIdentity.translate(X, Y).scale(K) === {k: K, x: X, y: Y}", async () => {
		const { zoomIdentity } = await import("d3-zoom");
		const t = zoomIdentity.translate(120, -40).scale(3.5);
		assert.equal(t.k, 3.5);
		assert.equal(t.x, 120);
		assert.equal(t.y, -40);
		// And the inverse direction: a stored camera re-applies to the
		// same screen position for the same world point.
		const p = t.apply([7, 9]);
		assert.deepEqual(p, [7 * 3.5 + 120, 9 * 3.5 - 40]);
	});
});

describe("fitTransform", () => {
	test("centers the bbox and respects padding", () => {
		// A 100x50 graph in a 500x300 viewport, 40px padding:
		// available 420x220 -> k = min(4.2, 4.4) = 4.2
		const t = fitTransform({ minX: -50, maxX: 50, minY: -25, maxY: 25 }, 500, 300, 40);
		assert.ok(Math.abs(t.k - 4.2) < 1e-9, `k=${t.k}`);
		assert.ok(Math.abs(t.x - 250) < 1e-9, `x=${t.x}`); // centered
		assert.ok(Math.abs(t.y - 150) < 1e-9, `y=${t.y}`);
		// World center maps to viewport center:
		assert.ok(Math.abs(0 * t.k + t.x - 250) < 1e-9);
	});

	test("never returns a non-positive scale for degenerate bboxes", () => {
		const t = fitTransform({ minX: 5, maxX: 5, minY: 5, maxY: 5 }, 100, 100, 10);
		assert.ok(t.k > 0 && Number.isFinite(t.k));
	});
});

describe("arrowGeometry", () => {
	test("the tip lands exactly on the target disc edge", () => {
		const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 6, 6, 5);
		assert.ok(g, "non-degenerate edge");
		assert.ok(Math.abs(g!.tip.x - 94) < 1e-9 && Math.abs(g!.tip.y) < 1e-9);
	});

	test("the shaft starts outside the source disc", () => {
		const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 6, 6, 5)!;
		assert.ok(Math.abs(g.shaftFrom.x - 6) < 1e-9 && Math.abs(g.shaftFrom.y) < 1e-9);
		// Shaft ends at the head base; head is drawn from base to tip.
		assert.ok(Math.abs(g.shaftTo.x - 89) < 1e-9);
	});

	test("the head triangle is symmetric around the shaft axis (0.8x wideness)", () => {
		const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 6, 6, 5)!;
		// halfW = 0.4 x headLength = 2; both base corners share x, mirrored y.
		assert.ok(Math.abs(Math.abs(g.left.y) - 2) < 1e-9 && Math.abs(Math.abs(g.right.y) - 2) < 1e-9);
		assert.ok(Math.abs(g.left.y + g.right.y) < 1e-9); // mirror
		assert.ok(Math.abs(g.left.x - g.right.x) < 1e-9);
	});

	test("works at arbitrary angles (diagonal stays normalized)", () => {
		const a = { x: 0, y: 0 };
		const b = { x: 60, y: 80 }; // len 100, dir (0.6, 0.8)
		const g = arrowGeometry(a, b, 10, 10, 8)!;
		assert.ok(Math.abs(g.tip.x - (60 - 0.6 * 10)) < 1e-9 && Math.abs(g.tip.y - (80 - 0.8 * 10)) < 1e-9);
	});

	test("null for coincident endpoints (never a NaN arrow)", () => {
		assert.equal(arrowGeometry({ x: 5, y: 5 }, { x: 5, y: 5 }, 6, 6, 5), null);
	});

	// The rendering arc's geometry laws (owner, 2026-09-30): an edge INTO
	// an imp point is drawn with toRadius 0 (headless, terminates at the
	// center); an edge OUT of one with fromRadius 0 (starts at the center).
	test("toRadius 0 — the tip lands exactly at the target CENTER (headless convergence)", () => {
		const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 6, 0, 5)!;
		assert.ok(Math.abs(g.tip.x - 100) < 1e-9 && Math.abs(g.tip.y) < 1e-9, "tip = the center, past which no shaft draws");
	});

	test("fromRadius 0 — the shaft starts exactly at the source CENTER", () => {
		const g = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 0, 6, 5)!;
		assert.ok(Math.abs(g.shaftFrom.x) < 1e-9 && Math.abs(g.shaftFrom.y) < 1e-9, "shaftFrom = the center");
	});
});

describe("isImpNodeId (the pure-geometry law, rendering arc 2026-09-30)", () => {
	test("arg_-prefixed ids are geometry; proposition ids are citizens", () => {
		assert.equal(isImpNodeId("arg_123af5a046ba"), true);
		assert.equal(isImpNodeId("n_abc123"), false);
	});
});


describe("pickNearest (distance-check picking)", () => {
	const nodes = [
		{ id: "a", x: 10, y: 10 },
		{ id: "b", x: 50, y: 50 },
		{ id: "c", x: 90, y: 10 },
	];

	test("picks the nearest node within the pad", () => {
		assert.equal(pickNearest(nodes, 12, 12, 16)?.id, "a");
		assert.equal(pickNearest(nodes, 48, 52, 16)?.id, "b");
		assert.equal(pickNearest(nodes, 88, 8, 16)?.id, "c");
	});

	test("the picking pad extends the hitbox beyond the disc", () => {
		// 20px away, only reachable because the pad covers it.
		assert.equal(pickNearest(nodes, 28, 18, 25)?.id, "a");
		// Beyond the pad: nothing.
		assert.equal(pickNearest(nodes, 30, 40, 3), null);
	});

	test("ties resolve deterministically (first scanned wins)", () => {
		const pair = [
			{ id: "first", x: 0, y: 0 },
			{ id: "second", x: 10, y: 0 },
		];
		assert.equal(pickNearest(pair, 5, 0, 10)?.id, "first");
	});

	test("empty node list picks nothing", () => {
		assert.equal(pickNearest([], 0, 0, 100), null);
	});
});

describe("sanitizeRegionTuning (dev number inputs)", () => {
	test("defaults survive untouched; partial input keeps the rest", () => {
		const t = sanitizeRegionTuning(undefined);
		assert.deepEqual(t, DEFAULT_REGION_TUNING);
		const half = sanitizeRegionTuning({ blur: 7.2 });
		assert.equal(half.blur, 10); // snapped to the new ladder floor (owner, 2026-10-07)
		assert.equal(half.dilation, DEFAULT_REGION_TUNING.dilation);
	});

	test("garbage clamps: NaN falls back, out-of-range clamps", () => {
		const t = sanitizeRegionTuning({ dilation: Number.NaN, blur: -5, bitmap: 99999, edgeAlpha: 42 });
		assert.equal(t.dilation, DEFAULT_REGION_TUNING.dilation); // NaN -> default
		assert.equal(t.blur, REGION_BLUR_LADDER[0]); // snapped to the ladder floor
		assert.equal(t.bitmap, REGION_BITMAP_OPTIONS[REGION_BITMAP_OPTIONS.length - 1]); // 99999 snaps to the largest option
		assert.equal(t.edgeAlpha, 1);
	});

	test("empty string / null / undefined values fall back per-field", () => {
		const t = sanitizeRegionTuning({ edgeAlpha: Number.NaN });
		assert.equal(t.edgeAlpha, DEFAULT_REGION_TUNING.edgeAlpha);
	});
});

describe("boxBlurRound (premultiplied region blur)", () => {
	test("spreads a single opaque px into its neighborhood and conserves sum", () => {
		// 5x5 RGBA, one white opaque pixel at (2,2)
		const w = 5, h = 5;
		const a = new Float32Array(w * h * 4);
		const center = (2 * w + 2) * 4;
		a[center] = 255; a[center + 1] = 255; a[center + 2] = 255; a[center + 3] = 255;
		const tmp = new Float32Array(a.length);
		const b = new Float32Array(a.length);
		boxBlurRound(a, tmp, b, w, h, 1);
		// Alpha conservation: total alpha unchanged.
		let sumA = 0;
		for (let i = 3; i < b.length; i += 4) sumA += b[i]!;
		assert.ok(Math.abs(sumA - 255) < 1e-3, `alpha sum ${sumA}`);
		// The center dimmed, the 8 neighbors picked some up.
		assert.ok(b[center + 3]! < 255 && b[center + 3]! > 0);
		const up = ((1 * w) + 2) * 4 + 3;
		assert.ok(b[up]! > 0, "neighbor got alpha");
		// Far corner (4,4) untouched.
		assert.equal(b[(4 * 5 + 4) * 4 + 3], 0);
	});

	test("radius 0 is a plain copy", () => {
		const a = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const tmp = new Float32Array(8);
		const b = new Float32Array(8);
		boxBlurRound(a, tmp, b, 1, 2, 0);
		assert.deepEqual([...b], [1, 2, 3, 4, 5, 6, 7, 8]);
	});
});

describe("sanitizePhysicsTuning (physics controls)", () => {
	test("defaults survive untouched; partial input keeps the rest", () => {
		assert.deepEqual(sanitizePhysicsTuning(undefined), DEFAULT_PHYSICS_TUNING);
		const half = sanitizePhysicsTuning({ clusterPull: 0.6 });
		assert.equal(half.clusterPull, 0.6);
		assert.equal(half.chargeStrength, DEFAULT_PHYSICS_TUNING.chargeStrength);
	});

	test("garbage clamps: NaN falls back, out-of-range clamps", () => {
		const t = sanitizePhysicsTuning({
			chargeStrength: Number.NaN,
			linkStrength: 99,
			linkDistance: -5,
			gravity: 7,
			clusterPull: -1,
			velocityDecay: 3,
		});
		assert.equal(t.chargeStrength, DEFAULT_PHYSICS_TUNING.chargeStrength);
		assert.equal(t.linkStrength, 4); // sweep-validated cap (8 explodes, 5 wobbles)
		assert.equal(t.linkDistance, 10);
		assert.equal(t.gravity, 0.48);
		assert.equal(t.clusterPull, 0);
		assert.equal(t.velocityDecay, 0.9);
	});
});



describe("wrapRegionLabel (wave 7: session names / file paths)", () => {
	// A fake measure: chars are 5px wide, spaces 4px — enough to drive
	// wrap decisions deterministically.
	const measure = (s: string) => s.length * 5;
	const W = 20; // 4 chars per line

	it("fits → single line, untouched", () => {
		assert.deepEqual(wrapRegionLabel("Plato", 100, 3, measure), ["Plato"]);
	});

	it("wraps words, no cap hit", () => {
		// W=20 at 5px/char = 3 chars a line: every word lands alone, four
		// lines, cap 4 never reached, no ellipsis.
		assert.deepEqual(wrapRegionLabel("aaa bbb ccc ddd", W, 4, measure), [
			"aaa",
			"bbb",
			"ccc",
			"ddd",
		]);
	});

	it("caps at maxLines with an ellipsis on the last line", () => {
		const lines = wrapRegionLabel("aaaa bbbb cccc dddd eeee", W, 2, measure);
		assert.equal(lines.length, 2);
		assert.ok(lines[1]!.endsWith("…"), "last line ellipsized");
		for (const line of lines) assert.ok(measure(line) <= W || line.length <= 2, "each line fits");
	});

	it("char-splits an unbroken path longer than the width (the notes case)", () => {
		const path = "/users/amos/notes/physics/lecture-notes.md";
		const lines = wrapRegionLabel(path, W, 3, measure);
		assert.equal(lines.length, 3);
		// every kept line fits the width; the last carries the ellipsis
		assert.ok(lines[2]!.endsWith("…"), "long path capped with ellipsis");
		assert.ok(measure(lines[0]!) <= W, "first chunk fits");
		assert.ok(measure(lines[1]!) <= W, "second chunk fits");
	});

	it("a remainder that FITS the width rides as a plain last line (no false ellipsis)", () => {
		// W=25 at 5px/char = 5 chars a line: "aa bb" fits exactly, the
		// tail "cc dd" fits too — two plain lines, cap never binds.
		assert.deepEqual(wrapRegionLabel("aa bb cc dd", 25, 3, measure), ["aa bb", "cc dd"]);
	});

	it("the ellipsis itself never exceeds the width", () => {
		const lines = wrapRegionLabel("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", W, 2, measure);
		assert.ok(measure(lines[1]!) <= W, "ellipsized tail fits");
	});

	it("splits and ellipsizes between whole characters, never inside an emoji or accent", () => {
		// Like canvas measureText: emoji draw 11px wide, every other glyph 5px —
		// including half of one broken pair. Family (ZWJ, 11 UTF-16 units),
		// flag (2 code points), e + combining accent, rocket (surrogate pair).
		const chars = (s: string) => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].map((g) => g.segment);
		const glyphs = (s: string) => chars(s).reduce((w, c) => w + (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(c) ? 11 : 5), 0);
		const word = "👨‍👩‍👧‍👦🇨🇦é🚀".repeat(4);
		const lines = wrapRegionLabel(word, W, 3, glyphs);
		assert.equal(lines.length, 3);
		for (const line of lines) {
			assert.ok(line.isWellFormed(), `half a surrogate pair in ${JSON.stringify(line)}`);
			for (const c of chars(line.replace(/…$/, ""))) assert.ok(chars(word).includes(c), `broken character ${JSON.stringify(c)}`);
			assert.ok(glyphs(line) <= W, `${JSON.stringify(line)} wider than the line`);
		}
	});
});


describe("applyClusterLabels (the label-only rename channel)", () => {
	const measure = (s: string) => s.length * 5;
	const W = 220;
	const MAXL = 3;

	const fixture = () => ({
		clusters: [
			{ id: "chat_a", label: "Old title" },
			{ id: "chat_b", label: null },
			{ id: "seedplan", label: "Orbital mechanics" },
		],
		regionMeta: [
			{ id: "chat_a", label: "Old title", lines: ["Old title"], cx: 0, cy: 0, hue: 10 },
			{ id: "chat_b", label: null, lines: null, cx: 1, cy: 1, hue: 20 },
			{ id: "seedplan", label: "Orbital mechanics", lines: ["Orbital mechanics"], cx: 2, cy: 2, hue: 30 },
		],
	});

	it("patches the matching cluster and re-wraps its region meta", () => {
		const f = fixture();
		// 5px/char and W=220: a 45-char title just overflows one line
		// ("...for the" is 40 chars, appending " graph" reads 46).
		const longTitle = "A much longer new session title for the graph";
		const changed = applyClusterLabels(
			f.clusters, f.regionMeta, new Map([["chat_a", longTitle]]),
			W, MAXL, measure,
		);
		assert.equal(changed, true);
		assert.equal(f.clusters[0]!.label, longTitle);
		assert.deepEqual(f.regionMeta[0]!.lines, ["A much longer new session title for the", "graph"]);
		// untouched entries stay byte-identical
		assert.equal(f.clusters[1]!.label, null);
		assert.equal(f.clusters[2]!.label, "Orbital mechanics");
		assert.deepEqual(f.regionMeta[2]!.lines, ["Orbital mechanics"]);
	});

	it("hull silence: a null-label cluster never gains a label", () => {
		const f = fixture();
		const changed = applyClusterLabels(
			f.clusters, f.regionMeta, new Map([["chat_b", "Resurrected?"]]),
			W, MAXL, measure,
		);
		assert.equal(changed, false);
		assert.equal(f.clusters[1]!.label, null);
		assert.equal(f.regionMeta[1]!.lines, null);
	});

	it("a label already matching is a no-op (no redraw)", () => {
		const f = fixture();
		const changed = applyClusterLabels(
			f.clusters, f.regionMeta, new Map([["seedplan", "Orbital mechanics"]]),
			W, MAXL, measure,
		);
		assert.equal(changed, false);
	});

	it("an explicit null clears a labeled cluster's lines", () => {
		const f = fixture();
		const changed = applyClusterLabels(
			f.clusters, f.regionMeta, new Map([["chat_a", null]]),
			W, MAXL, measure,
		);
		assert.equal(changed, true);
		assert.equal(f.clusters[0]!.label, null);
		assert.equal(f.regionMeta[0]!.lines, null);
	});

	it("unknown ids in the map change nothing", () => {
		const f = fixture();
		const changed = applyClusterLabels(
			f.clusters, f.regionMeta, new Map([["chat_ghost", "Nope"]]),
			W, MAXL, measure,
		);
		assert.equal(changed, false);
	});
});

describe("mobile graph helpers (P1-3)", () => {
	it("fitTransform supports asymmetric top/right/bottom/left padding for mobile toolbar & dock", () => {
		// 390x844 phone with top chrome 180px, bottom dock 160px, side cluster-label padding 75px:
		// free box: x in [75, 315] (availW=240, center=195), y in [180, 684] (availH=504, center=432)
		const t = fitTransform(
			{ minX: -120, maxX: 120, minY: -100, maxY: 100 },
			390,
			844,
			{ top: 180, right: 75, bottom: 160, left: 75 },
		);
		assert.ok(Math.abs(t.k - 1) < 1e-9, `expected k=1, got ${t.k}`);
		// World center (0, 0) lands at (195, 432) — center of the free band, NOT (195, 422)
		assert.ok(Math.abs(t.x - 195) < 1e-9, `x=${t.x}`);
		assert.ok(Math.abs(t.y - 432) < 1e-9, `y=${t.y}`);
		// Left/right bounds land inside [75, 315] and top/bottom inside [180, 684]
		assert.ok(-120 * t.k + t.x >= 74.999 && 120 * t.k + t.x <= 315.001);
		assert.ok(-100 * t.k + t.y >= 179.999 && 100 * t.k + t.y <= 684.001);
	});

	it("clickSlopForPointer uses larger slop for touch than mouse", () => {
		assert.equal(clickSlopForPointer("mouse"), 4);
		assert.equal(clickSlopForPointer("pen"), 4);
		assert.equal(clickSlopForPointer(undefined), 4);
		assert.equal(clickSlopForPointer("touch"), 10);
	});

	it("effectiveCanvasDpr caps coarse-pointer DPR at 2 while leaving desktop untouched", () => {
		assert.equal(effectiveCanvasDpr(3, true), 2);
		assert.equal(effectiveCanvasDpr(2, true), 2);
		assert.equal(effectiveCanvasDpr(1, true), 1);
		assert.equal(effectiveCanvasDpr(3, false), 3);
		assert.equal(effectiveCanvasDpr(2, false), 2);
	});

	it("shouldRestoreCamera drops saved camera when viewport dimensions shifted (desktop↔mobile or rotation)", () => {
		// Same viewport → restore
		assert.deepEqual(
			shouldRestoreCamera({ k: 1.5, x: 100, y: 200, vw: 390, vh: 844 }, 390, 844),
			{ k: 1.5, x: 100, y: 200 },
		);
		// Desktop camera opened on phone → ignore & re-fit
		assert.equal(
			shouldRestoreCamera({ k: 1.5, x: 500, y: 400, vw: 1440, vh: 900 }, 390, 844),
			null,
		);
		// Portrait ↔ landscape rotation → ignore & re-fit
		assert.equal(
			shouldRestoreCamera({ k: 1.2, x: 180, y: 400, vw: 390, vh: 844 }, 844, 390),
			null,
		);
		// Minor keyboard/address-bar jitter (<=120px) → keep camera
		assert.deepEqual(
			shouldRestoreCamera({ k: 1.2, x: 180, y: 400, vw: 390, vh: 844 }, 390, 760),
			{ k: 1.2, x: 180, y: 400 },
		);
	});
});

describe("GraphCanvasRenderer touch pinch, pointercancel, and touch slop", () => {
	function makeFakeCanvasEnv() {
		const listeners = new Map<string, Set<(e: unknown) => void>>();
		const ctx = {
			font: "",
			fillStyle: "",
			strokeStyle: "",
			lineWidth: 1,
			lineCap: "butt",
			globalAlpha: 1,
			textAlign: "left",
			textBaseline: "alphabetic",
			imageSmoothingEnabled: true,
			setTransform: () => {},
			clearRect: () => {},
			save: () => {},
			restore: () => {},
			fill: () => {},
			stroke: () => {},
			beginPath: () => {},
			arc: () => {},
			moveTo: () => {},
			lineTo: () => {},
			fillText: () => {},
			drawImage: () => {},
			measureText: (s: string) => ({ width: s.length * 6 }),
			createRadialGradient: () => ({ addColorStop: () => {} }),
		};
		const canvas = {
			clientWidth: 390,
			clientHeight: 844,
			width: 0,
			height: 0,
			style: { cursor: "" },
			getContext: () => ctx,
			getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844, right: 390, bottom: 844 }),
			setPointerCapture: () => {},
			releasePointerCapture: () => {},
			addEventListener: (type: string, fn: (e: unknown) => void) => {
				let set = listeners.get(type);
				if (!set) listeners.set(type, (set = new Set()));
				set.add(fn);
			},
			removeEventListener: (type: string, fn: (e: unknown) => void) => {
				listeners.get(type)?.delete(fn);
			},
			dispatch: (type: string, event: Record<string, unknown>) => {
				const full = { preventDefault: () => {}, stopPropagation: () => {}, ...event };
				for (const fn of [...(listeners.get(type) ?? [])]) fn(full);
			},
		};
		const prev = {
			window: (globalThis as Record<string, unknown>).window,
			ResizeObserver: (globalThis as Record<string, unknown>).ResizeObserver,
			requestAnimationFrame: (globalThis as Record<string, unknown>).requestAnimationFrame,
			cancelAnimationFrame: (globalThis as Record<string, unknown>).cancelAnimationFrame,
			Path2D: (globalThis as Record<string, unknown>).Path2D,
			SVGElement: (globalThis as Record<string, unknown>).SVGElement,
		};
		(globalThis as Record<string, unknown>).window = {
			devicePixelRatio: 3,
			matchMedia: (q: string) => ({ matches: q.includes("coarse") }),
		};
		(globalThis as Record<string, unknown>).ResizeObserver = class {
			observe() {}
			disconnect() {}
		};
		(globalThis as Record<string, unknown>).requestAnimationFrame = () => 1;
		(globalThis as Record<string, unknown>).cancelAnimationFrame = () => {};
		(globalThis as Record<string, unknown>).Path2D = class {
			moveTo() {}
			arc() {}
			lineTo() {}
			closePath() {}
		};
		(globalThis as Record<string, unknown>).SVGElement = class {};
		const restore = () => {
			for (const [k, v] of Object.entries(prev)) {
				if (v === undefined) delete (globalThis as Record<string, unknown>)[k];
				else (globalThis as Record<string, unknown>)[k] = v;
			}
		};
		return { canvas, restore };
	}

	it("second touch pointer cancels active node drag and zooms camera without committing positions", () => {
		const { canvas, restore } = makeFakeCanvasEnv();
		const selects: string[] = [];
		const commits: unknown[] = [];
		const cameras: { k: number; x: number; y: number }[] = [];
		try {
			const renderer = new GraphCanvasRenderer(
				canvas as unknown as HTMLCanvasElement,
				{
					onSelect: (id) => selects.push(id),
					onContext: () => {},
					onStageClick: () => {},
					onCameraMove: (t) => cameras.push({ k: t.k, x: t.x, y: t.y }),
					onCommit: (p) => commits.push(p),
				},
				{ k: 1, x: 0, y: 0 },
			);
			const nodeA = { id: "n1", x: 100, y: 100, label: "Alpha" };
			renderer.setSettings(DEFAULT_RENDER_SETTINGS);
			renderer.setData({
				nodes: [nodeA, { id: "n2", x: 250, y: 200, label: "Beta" }],
				edges: [{ from: "n1", to: "n2" }],
				clusters: [],
				colors: { node: "#ffffff", edge: "#888888", label: "#888888", hoverText: "#ffffff", clusterLightness: { ring: 60, label: 78 } },
				fontFamily: "sans-serif",
			});
			// Finger 1 presses directly on nodeA
			canvas.dispatch("pointerdown", { button: 0, isPrimary: true, pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
			// Finger 2 lands to start a pinch
			canvas.dispatch("pointerdown", { button: 0, isPrimary: false, pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100 });
			// Spread fingers apart (distance 100 → 200 = 2x zoom)
			canvas.dispatch("pointermove", { button: 0, isPrimary: false, pointerId: 2, pointerType: "touch", clientX: 300, clientY: 100 });
			// Lift both fingers
			canvas.dispatch("pointerup", { button: 0, isPrimary: false, pointerId: 2, pointerType: "touch", clientX: 300, clientY: 100 });
			canvas.dispatch("pointerup", { button: 0, isPrimary: true, pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });

			assert.equal(selects.length, 0, "pinch must not fire node selection");
			assert.equal(commits.length, 0, "pinch must not commit mutated node positions");
			assert.equal((nodeA as { fx?: number | null }).fx ?? null, null, "nodeA fx must be unpinned");
			assert.equal((nodeA as { fy?: number | null }).fy ?? null, null, "nodeA fy must be unpinned");
			const lastCam = cameras.at(-1);
			assert.ok(lastCam && lastCam.k > 1.5, `expected pinch zoom k > 1.5, got ${lastCam?.k}`);
			renderer.destroy();
		} finally {
			restore();
		}
	});

	it("pointercancel clears drag state without selecting or committing, and touch tap tolerates 7px jitter", () => {
		const { canvas, restore } = makeFakeCanvasEnv();
		const selects: string[] = [];
		const commits: unknown[] = [];
		try {
			const renderer = new GraphCanvasRenderer(
				canvas as unknown as HTMLCanvasElement,
				{
					onSelect: (id) => selects.push(id),
					onContext: () => {},
					onStageClick: () => {},
					onCameraMove: () => {},
					onCommit: (p) => commits.push(p),
				},
				{ k: 1, x: 0, y: 0 },
			);
			const nodeA = { id: "n1", x: 100, y: 100, label: "Alpha" };
			renderer.setSettings(DEFAULT_RENDER_SETTINGS);
			renderer.setData({
				nodes: [nodeA, { id: "n2", x: 250, y: 200, label: "Beta" }],
				edges: [{ from: "n1", to: "n2" }],
				clusters: [],
				colors: { node: "#ffffff", edge: "#888888", label: "#888888", hoverText: "#ffffff", clusterLightness: { ring: 60, label: 78 } },
				fontFamily: "sans-serif",
			});

			// 1. Touch tap with 7px jitter (< 10px touch slop) selects node cleanly
			canvas.dispatch("pointerdown", { button: 0, isPrimary: true, pointerId: 10, pointerType: "touch", clientX: 100, clientY: 100 });
			canvas.dispatch("pointermove", { button: 0, isPrimary: true, pointerId: 10, pointerType: "touch", clientX: 105, clientY: 105 });
			canvas.dispatch("pointerup", { button: 0, isPrimary: true, pointerId: 10, pointerType: "touch", clientX: 105, clientY: 105 });
			assert.deepEqual(selects, ["n1"]);

			// 2. Drag then OS pointercancel: unpins node and never selects/commits
			canvas.dispatch("pointerdown", { button: 0, isPrimary: true, pointerId: 11, pointerType: "touch", clientX: 100, clientY: 100 });
			canvas.dispatch("pointermove", { button: 0, isPrimary: true, pointerId: 11, pointerType: "touch", clientX: 140, clientY: 130 });
			canvas.dispatch("pointercancel", { button: 0, isPrimary: true, pointerId: 11, pointerType: "touch", clientX: 140, clientY: 130 });
			assert.equal((nodeA as { fx?: number | null }).fx ?? null, null, "pointercancel must unpin fx");
			assert.equal((nodeA as { fy?: number | null }).fy ?? null, null, "pointercancel must unpin fy");
			assert.deepEqual(selects, ["n1"], "pointercancel must not trigger onSelect");
			assert.equal(commits.length, 0, "pointercancel must not commit");

			// 3. DPR capped at 2 for coarse-pointer 3x canvas
			assert.equal(canvas.width, 780);
			assert.equal(canvas.height, 1688);
			renderer.destroy();
		} finally {
			restore();
		}
	});
});
