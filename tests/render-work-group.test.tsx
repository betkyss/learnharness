import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { WorkGroup } from "../components/work-group.tsx";
import { groupWorkParts } from "../components/work-groups.ts";
import type { LhViewPart } from "../src/core/view.ts";

it("preserves disclosure and tool input across streaming, tool settlement, and completion", async () => {
	const dom = parseHTML("<html><body></body></html>");
	const previous = Object.getOwnPropertyDescriptors(globalThis);
	Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
		getComputedStyle: () => ({ display: "block", animationName: "none" }),
		requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
		cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle) });
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	const draw = async (parts: LhViewPart[], active: string | null = "a") => {
		const entries = groupWorkParts(parts, -1, active);
		await act(async () => root.render(<>{entries.map(e => e.type === "work" ? <WorkGroup key={e.key} entry={e} /> : null)}</>));
	};
	const step = { type: "step-start", sourceMessageId: "a" };
	try {
		await draw([step, { type: "reasoning", id: "a-r0", sourceMessageId: "a", text: "" }]);
		const trigger = host.querySelector("button")!;
		assert.equal(trigger.textContent, "Working…");
		assert.equal(trigger.getAttribute("aria-expanded"), "false");
		await act(async () => trigger.click());
		assert.equal(trigger.getAttribute("aria-expanded"), "true");
		const tool = { type: "tool-read", sourceMessageId: "a", sourceContentIndex: 0, toolCallId: "read", state: "input-streaming", input: { path: "file.ts" } };
		await draw([step, tool]);
		assert.equal(host.querySelector("button"), trigger, "same group DOM after placeholder becomes tool");
		assert.equal(trigger.getAttribute("aria-expanded"), "true");
		const details = host.querySelector("details")!;
		details.open = true;
		await draw([step, { ...tool, state: "output-available", output: { text: "The result" } }], null);
		assert.equal(host.querySelector("details"), details, "same tool DOM after settling");
		assert.equal(details.open, true);
		assert.equal(trigger.textContent, "Activity");
		await draw([{ ...step, sourceMessageId: "saved-a" }, { ...tool, sourceMessageId: "saved-a", state: "output-available", output: { text: "The result" } }], null);
		assert.equal(host.querySelector("button"), trigger, "server ID stamping preserves group identity");
		assert.equal(host.querySelector("details"), details, "server ID stamping preserves nested tool identity");
		assert.equal(details.open, true);
		await act(async () => new Promise(resolve => setTimeout(resolve, 1100)));
		assert.equal(trigger.getAttribute("aria-expanded"), "true", "completion never auto-closes");
		await draw([step, { type: "reasoning", id: "a-r0", sourceMessageId: "a", text: "First **bold** paragraph.\n\nSecond paragraph with $a<b$." }]);
		assert.ok(host.querySelector("strong"));
		assert.equal(host.querySelectorAll(".katex-error").length, 0);
		assert.ok(host.textContent?.includes("Second paragraph"));
		assert.ok(!host.textContent?.includes("AGENT’S THINKING"));
	} finally {
		await act(async () => root.unmount());
		for (const key of ["window", "document", "Element", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
			if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!); else Reflect.deleteProperty(globalThis, key);
		}
	}
});
