import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMenuPlacement, menuAnchorRect, type MenuSide } from "../components/menu-shell.tsx";

/**
 * The shared menu shell's placement decision (fix wave chunk B): the
 * pure math behind every dropdown's anchoring — side preference, the
 * honest-fit flip, the 60vh cap, alignment. The DOM effects (portal,
 * measure-then-show, re-placement on scroll/resize) are live-verified;
 * this pins the geometry.
 */

const rect = (top: number, bottom: number) => ({ top, bottom, left: 100, right: 300 });
const viewport = (height: number) => ({ width: 1280, height });

describe("computeMenuPlacement — side", () => {
	it("keeps the preferred side when it shows the whole menu", () => {
		for (const preferred of ["up", "down"] as MenuSide[]) {
			const p = computeMenuPlacement(rect(400, 440), viewport(800), 300, preferred, "right");
			assert.equal(p.side, preferred);
		}
	});

	it("flips when the preferred side cannot hold the content and the other is roomier", () => {
		// Anchor 30px above the viewport bottom: down has ~2px of room,
		// up has ~380. A 300px menu must flip UP despite preferring down.
		const p = computeMenuPlacement(rect(770, 800), viewport(800), 300, "down", "right");
		assert.equal(p.side, "up");
		// ...and mirrors: an anchor at the very top preferring up flips down.
		const q = computeMenuPlacement(rect(0, 30), viewport(800), 300, "up", "right");
		assert.equal(q.side, "down");
	});

	it("stays put when neither side fits better (the roomier side already preferred)", () => {
		// Short viewport: down has 450, up has 200 — a 600px menu stays
		// down (capped gracefully) because up is NOT roomier.
		const p = computeMenuPlacement(rect(150, 190), viewport(650), 600, "down", "right");
		assert.equal(p.side, "down");
	});

	it("nothing measured yet (contentHeight ≤ 0) keeps the preferred side", () => {
		const p = computeMenuPlacement(rect(770, 800), viewport(800), 0, "down", "right");
		assert.equal(p.side, "down");
	});
});

describe("computeMenuPlacement viewport bounds", () => {
 for (const [width, height] of ([[1440,900], [768,1024], [390,844], [390,420], [100,90]] as const)) {
  for (const anchor of [{left:0,right:20,top:0,bottom:20},{left:width-20,right:width,top:height-20,bottom:height},{left:-100,right:5,top:height/2,bottom:height/2+30}]) {
   for (const side of ["up", "down"] as MenuSide[]) it(`clamps ${width}x${height} ${JSON.stringify(anchor)} ${side}`, () => {
    const p = computeMenuPlacement(anchor,{width,height},1000,side,"right",352);
    const menuWidth = Math.min(352,width-16);
    assert.ok(Number(p.style.left)>=8);
    assert.ok(Number(p.style.left)+menuWidth<=width-8);
    assert.ok(Number(p.style.top)>=8);
    assert.ok(Number(p.style.top)+p.maxHeight<=height-8);
    assert.equal(p.style.maxWidth,width-16);
   });
  }
 }
 it("anchors a fitting menu to the requested edge",()=>{
  const p=computeMenuPlacement(rect(400,440),viewport(800),200,"down","right",240);
  assert.equal(p.style.left,60);assert.equal(p.style.top,444);
 });
});
describe("menuAnchorRect — the anchor seam", () => {
	const doc = { querySelector: () => ({ getBoundingClientRect: () => ({ top: 1, bottom: 2, left: 3, right: 4 }) }) } as unknown as Pick<Document, "querySelector">;
	it("prefers a virtual anchor rect when it yields one", () => {
		assert.deepEqual(menuAnchorRect({ getAnchorRect: () => ({ top: 10, bottom: 20, left: 30, right: 40 }), anchorTestid: "x" }, doc), { top: 10, bottom: 20, left: 30, right: 40 });
	});
	it("falls back to the element seam when the virtual anchor is gone", () => {
		assert.deepEqual(menuAnchorRect({ getAnchorRect: () => null, anchorTestid: "x" }, doc), { top: 1, bottom: 2, left: 3, right: 4 });
	});
	it("is null with no anchor at all", () => {
		assert.equal(menuAnchorRect({}, doc), null);
	});
});
