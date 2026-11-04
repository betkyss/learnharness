import assert from "node:assert/strict";
import { it } from "node:test";
import { fitVisibleGraph } from "../components/graph-canvas";

it("fits every graph bound between the mobile toolbar and the measured dock", () => {
 const bounds = { minX: -170, maxX: 260, minY: -100, maxY: 320 };
 for (const [width, height, top, bottom] of [[390,844,148,210],[768,1024,56,160],[1440,900,56,140],[390,420,148,160],[390,420,144,210]]) {
  const camera = fitVisibleGraph(bounds,width!,height!,{top:top!,bottom:bottom!});
  assert.ok(camera.k > 0);
  assert.ok(bounds.minX * camera.k + camera.x >= 0);
  assert.ok(bounds.maxX * camera.k + camera.x <= width!);
  assert.ok(bounds.minY * camera.k + camera.y >= top!);
  assert.ok(bounds.maxY * camera.k + camera.y <= height! - bottom!);
 }
});
