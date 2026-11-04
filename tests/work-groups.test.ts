import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupWorkParts } from "../components/work-groups.ts";
import { projectView, type LhViewPart } from "../src/core/view.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { firstSourceTextParts } from "../src/core/session-navigation.ts";

const teacher = (id: string, content: unknown[]): LhMessage => ({
	id, role: "assistant", content, stopReason: "stop", timestamp: 0,
	provider: "fixture", model: "fixture",
}) as LhMessage;
const reason = { type: "thinking", thinking: "Check **both** parameters.\n\nKeep the second paragraph." };
const read = { type: "toolCall", id: "read", name: "read", arguments: { path: "a.ts" } };
const step = (id: string): LhViewPart => ({ type: "step-start", sourceMessageId: id });

describe("Worked groups", () => {
	it("combines technical steps, preserving every visible text and its original index", () => {
		const view = projectView([
			teacher("a", [reason, read]), teacher("b", [reason]),
			teacher("c", [{ type: "text", text: "Progress" }]),
			teacher("d", [reason, { type: "text", text: "Result" }]),
		]);
		const message = view[0]!;
		const entries = groupWorkParts(message.parts);
		assert.deepEqual(entries.map(e => e.type), ["work", "part", "work", "part"]);
		assert.deepEqual(entries.filter(e => e.type === "part").map(e => e.part.text), ["Progress", "Result"]);
		const first = entries[0]!;
		assert.equal(first.type === "work" && first.parts.length, 3);
		for (const e of entries) if (e.type === "part") assert.equal(e.part, message.parts[e.index]);
		assert.deepEqual([...firstSourceTextParts(view)], [["c", "c-t0"], ["d", "d-t0"]]);
	});

	it("keeps questions, artifacts, errors, and unknown tools outside the fold", () => {
		for (const type of ["text", "data-plan-block", "tool-quiz", "tool-problem", "tool-research", "tool-pdf", "tool-demo", "tool-visual", "tool-probe_done", "tool-conclude", "tool-unknown"]) {
			const parts = [{ type: "reasoning", text: "A" }, { type }, { type: "reasoning", text: "B" }];
			assert.deepEqual(groupWorkParts(parts).map(e => e.type), ["work", "part", "work"], type);
		}
		for (const errorText of ["Permission denied", "Operation aborted"]) {
			const entries = groupWorkParts([{ type: "reasoning" }, { type: "tool-read", state: "output-error", errorText }, { type: "reasoning" }]);
			assert.deepEqual(entries.map(e => e.type), ["work", "part", "work"]);
		}
	});

	it("keeps Teaching boundaries outside while absorbing plain technical step separators", () => {
		const parts = [step("a"), { type: "reasoning" }, step("b"), { type: "tool-read" }, step("c"), { type: "reasoning" }];
		assert.equal(groupWorkParts(parts).length, 1);
		const entries = groupWorkParts(parts, 4);
		assert.deepEqual(entries.map(e => e.type), ["work", "part", "work"]);
		const divider = entries[1]!;
		assert.equal(divider.type === "part" && divider.index, 4);
	});

	it("keeps the group identity when an empty placeholder becomes a tool or receives more steps", () => {
		const placeholder = groupWorkParts([step("a"), { type: "reasoning", id: "a-r0", text: "" }]);
		const tool = groupWorkParts([step("a"), { type: "tool-read", sourceMessageId: "a", sourceContentIndex: 0 }]);
		const longer = groupWorkParts([step("a"), { type: "reasoning", id: "a-r0", text: "Now reasoning" }, step("b"), { type: "tool-read" }]);
		assert.equal(placeholder[0]!.key, tool[0]!.key);
		assert.equal(placeholder[0]!.key, longer[0]!.key);
	});

	it("qualifies repeated tool IDs by native source location", () => {
		const view = projectView([teacher("a", [read]), teacher("b", [read])]);
		const entry = groupWorkParts(view[0]!.parts)[0]!;
		assert.equal(entry.type, "work");
		if (entry.type === "work") assert.notEqual(entry.parts[0]!.key, entry.parts[1]!.key);
	});

	it("shows activity only from a live tool or the currently streaming native message", () => {
		const parts = [step("old"), { type: "reasoning", sourceMessageId: "old", text: "Old" }, { type: "text", text: "Update" }, step("new"), { type: "reasoning", sourceMessageId: "new", text: "New" }];
		const groups = groupWorkParts(parts, -1, "new").filter(e => e.type === "work");
		assert.equal(groups[0]!.activity, null);
		assert.equal(groups[1]!.activity, "Thinking…");
		assert.ok(groupWorkParts(parts).filter(e => e.type === "work").every(e => e.activity === null));
		const live = groupWorkParts([{ type: "tool-read", state: "input-streaming" }])[0]!;
		assert.equal(live.type === "work" && live.activity, "Reading a file…");
	});

	it("does not create empty groups, and treats send_to_user as visible prose", () => {
		assert.deepEqual(groupWorkParts([step("m")]), []);
		const view = projectView([teacher("m", [reason, { type: "toolCall", id: "send", name: "send_to_user", arguments: { message: "Read this update." } }])]);
		const entries = groupWorkParts(view[0]!.parts);
		assert.deepEqual(entries.map(e => e.type), ["work", "part"]);
		const prose = entries[1]!;
		assert.equal(prose.type === "part" && prose.part.text, "Read this update.");
	});
});
