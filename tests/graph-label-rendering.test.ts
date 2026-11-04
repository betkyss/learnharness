import assert from "node:assert/strict";
import { test } from "node:test";
import { GraphCanvasRenderer } from "../components/graph-canvas.ts";
import { DEFAULT_RENDER_SETTINGS } from "../src/core/render-settings.ts";

/** Exercise the real draw pass; only Canvas 2D and its browser host are replaced. */
function renderLabels(k: number, hover = false) {
	const text: { value: string; alpha: number; color: string; font: string }[] = [];
	const backgrounds: unknown[][] = [];
	const stack: { globalAlpha: number; fillStyle: string; font: string }[] = [];
	const ctx = {
		globalAlpha: 1, fillStyle: "", font: "",
		setTransform() {}, clearRect() {}, fill() {}, stroke() {}, beginPath() {}, arc() {},
		fillRect(...args: unknown[]) { backgrounds.push(args); },
		measureText(value: string) { return { width: value.length * 6 }; },
		createRadialGradient() { return { addColorStop() {} }; },
		save() { stack.push({ globalAlpha: this.globalAlpha, fillStyle: this.fillStyle, font: this.font }); },
		restore() { Object.assign(this, stack.pop()); },
		fillText(value: string) { text.push({ value, alpha: this.globalAlpha, color: this.fillStyle, font: this.font }); },
	};
	const nodes = [{ id: "a", label: "Node A", x: -50, y: 0 }, { id: "b", label: "Node B", x: 50, y: 0 }];
	const renderer = Object.assign(Object.create(GraphCanvasRenderer.prototype), {
		canvas: { clientWidth: 600, clientHeight: 400 }, ctx,
		data: { nodes, fontFamily: "sans-serif", colors: { node: "#ffffff", edge: "#888888", label: "#aaaaaa", hoverText: "#eeeeee", background: "#000000" } },
		settings: DEFAULT_RENDER_SETTINGS, transform: { x: 300, y: 200, k }, kFit: 1,
		geoVersion: 1, builtVersion: 1, regionBuiltVersion: 1, frameCount: 0,
		nodesPath: {}, shaftsPath: {}, headsPath: {},
		world: { nodeR: 2, glowOuter: 4, labelSize: 3, labelGap: 1 },
		worldLabelFont: "500 3px sans-serif",
		labelLines: new Map(nodes.map(node => [node.id, [node.label]])),
		nodeById: new Map(nodes.map(node => [node.id, node])),
		regionMeta: [{ id: "group", cx: 0, cy: -50, hue: 90, lines: ["Group"] }],
		fitInsets: () => ({ top: 0, bottom: 0 }),
		hoverId: hover ? "a" : null, hoverNode: hover ? nodes[0] : null, hoverFade: hover ? 1 : 0,
	});
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", { value: { devicePixelRatio: 1 }, configurable: true });
	try { renderer.draw(); }
	finally {
		if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
		else Reflect.deleteProperty(globalThis, "window");
	}
	return { text, backgrounds };
}

test("overview shows group names without forcing node names on small graphs", () => {
	assert.deepEqual(renderLabels(1).text.map(item => item.value), ["Group"]);
});

test("node and group names cross-fade at the configured zoom threshold", () => {
	const { text } = renderLabels(1 / 0.625);
	assert.deepEqual(text.map(item => [item.value, item.alpha]), [["Node A", 0.5], ["Node B", 0.5], ["Group", 0.5]]);
});

test("zoomed-in names use world font size and no opaque label backgrounds", () => {
	const { text, backgrounds } = renderLabels(2);
	assert.deepEqual(text.map(item => item.value), ["Node A", "Node B"]);
	assert.ok(text.every(item => item.font === "500 3px sans-serif"));
	assert.equal(backgrounds.length, 0);
});

test("hover reveals and brightens a node name while overview names are hidden", () => {
	const { text, backgrounds } = renderLabels(1, true);
	assert.ok(text.some(item => item.value === "Node A" && item.color === "#eeeeee" && item.alpha === 1));
	assert.equal(backgrounds.length, 0);
});
