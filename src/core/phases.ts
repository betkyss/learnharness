/**
 * Teaching-session phases derived sequentially from transcript events,
 * not from plan-tree occupancy or an explicit plan-acceptance flag:
 *
 * - probe: until probe_done has a successful tool result.
 * - plan: after probe completion, until a node-tagged teaching question call.
 * - teach: from that first call onward, without waiting for its answer.
 *
 * Native quiz/explain calls and supported plugin teaching-question annotations
 * supply the teaching boundary. Native-record summaries and projected-view
 * dividers use the same event boundaries; presenting a plan alone does not
 * advance the displayed phase to teach.
 */

import { posedPluginQuestionOfPart } from "./tool-parts.ts";
import { readPluginQuestionMessageAnnotation } from "./plugin-questions.ts";

/** The three phases of a session, as the picker / header / dividers see them. */
export type Phase3 = "probe" | "plan" | "teach";

/**
 * Minimal structural slice of a UI message for the phase scan: parts with
 * a state, an input (a tool call's parsed arguments), and (for concluded
 * calls) an output.
 */
export interface PhaseMessage {
	parts: ReadonlyArray<{ type: string; state?: string; input?: unknown; output?: unknown; pluginQuestion?: unknown }>;
}

/** A quiz call's part input carries `nodeId` iff it is tagged (teach-only —
 *  the probe quiz schema has no nodeId field). */
function taggedNodeId(input: unknown): boolean {
	return (
		typeof input === "object" &&
		input !== null &&
		typeof (input as { nodeId?: unknown }).nodeId === "string" &&
		(input as { nodeId: string }).nodeId.length > 0
	);
}

function isTeachQuestionPart(part: PhaseMessage["parts"][number]): boolean {
	if (part.pluginQuestion !== undefined) {
		const snapshot = posedPluginQuestionOfPart(part);
		return snapshot?.variant === "teach" && taggedNodeId(snapshot.input);
	}
	return (part.type === "tool-quiz" || part.type === "tool-explain") && taggedNodeId(part.input);
}

/** The phase at `upToIndex` (inclusive; default: the last message). */
export function phaseAt3(messages: readonly PhaseMessage[], upToIndex?: number, startPhase: Phase3 = "probe"): Phase3 {
	let phase: Phase3 = startPhase;
	const last = Math.min(upToIndex ?? messages.length - 1, messages.length - 1);
	for (let i = 0; i <= last; i++) {
		phase = advance(phase, messages[i]?.parts);
	}
	return phase;
}

/** One message's advance of the phase (pure fold step). */
function advance(
	phase: Phase3,
	parts: PhaseMessage["parts"] | undefined,
): Phase3 {
	if (!parts) return phase;
	for (const part of parts) {
		// STRICTLY SEQUENTIAL: probe → plan only via a concluded probe_done,
		// plan → teach only via the first nodeId-tagged quiz CALL (the call,
		// not its answer — an errored-and-retried call still proves teaching
		// began, and the retry lands in the same group anyway).
		if (
			phase === "probe" && part.type === "tool-probe_done" && part.state === "output-available" &&
			(part.output as { ok?: unknown } | null | undefined)?.ok !== false
		) {
			phase = "plan";
		}
		// plan → teach via the first nodeId-tagged quizzing CALL — quiz OR
		// explain, whichever mechanic the settings armed (both carry nodeId).
		if (
			phase === "plan" && isTeachQuestionPart(part)
		) {
			phase = "teach";
		}
	}
	return phase;
}

/**
 * WHERE inside the flipping message teaching begins (owner round 8,
 * 2026-10-05 — the stacked-dividers bug): plan→teach flips at the first
 * tagged quiz/explain CALL, but the plan PRESENTATION often lives in the
 * same assistant message — an earlier provider STEP than the quiz call.
 * A message-level seam therefore drew the Teaching divider before the
 * plan presentation too (Planning and Teaching stacked back-to-back).
 * This returns the part index of the STEP BOUNDARY governing the flip
 * call: -1 when the call sits in the message's FIRST step (the divider
 * belongs before the whole message), else the index of the step-start
 * part whose generation contains the call — the divider renders there,
 * between the plan presentation and the teaching block.
 */
export function teachStepIndex(
	parts: PhaseMessage["parts"],
): number {
	let stepStarts = 0; // how many step-start parts seen so far
	let latest = -1; // index of the latest step-start
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (part.type === "step-start") {
			stepStarts++;
			latest = i;
			continue;
		}
		if (isTeachQuestionPart(part)) {
			// The call's governing step: 0–1 step-starts seen = the message's
			// FIRST step → -1 (the divider belongs before the whole message);
			// a later step → that step-start's index (the divider renders at
			// the boundary, replacing the plain hairline there).
			return stepStarts <= 1 ? -1 : latest;
		}
	}
	return -1;
}

/**
 * The phase at EVERY message index, in one forward fold — the transcript
 * dividers render one per boundary, so phaseAt3(m, i) per index would rescan
 * 0..i each time (quadratic); this is the same derivation, linear.
 * out[i] === phaseAt3(messages, i) for every i.
 */
export function phaseTimeline(messages: readonly PhaseMessage[], startPhase: Phase3 = "probe"): Phase3[] {
	const out: Phase3[] = [];
	let phase: Phase3 = startPhase;
	for (let i = 0; i < messages.length; i++) {
		phase = advance(phase, messages[i]?.parts);
		out.push(phase);
	}
	return out;
}

// ─── the native fold (Wave D: record-side phase over LhMessage[]) ───────────

import { activeProblemOccurrenceOf, pendingQuestionOf, probeDoneResultIds, type LhMessage } from "./native-messages.ts";
import { pendingPluginQuestionOf } from "./native-messages.ts";

/** The phase at `upToIndex` (inclusive; default: the last message) of a
 *  NATIVE record. probe→plan advances at the probe_done call's clean
 *  toolResult; plan→teach at the assistant message carrying the first
 *  nodeId-tagged quiz CALL (mirrors the view fold — same seam, native
 *  shape). */
export function phaseAt3Lh(messages: readonly LhMessage[], upToIndex?: number): Phase3 {
	let phase: Phase3 = "probe";
	const last = Math.min(upToIndex ?? messages.length - 1, messages.length - 1);
	const concluded = probeDoneResultIds(messages.slice(0, last + 1));
	for (let i = 0; i <= last; i++) {
		const m = messages[i]!;
		const role = (m as { role?: string }).role;
		if (role === "toolResult") {
			if (phase === "probe" && concluded.has(m.id)) phase = "plan";
		} else if (role === "assistant") {
			const content = (m as { content?: ReadonlyArray<{ type?: string; name?: string; arguments?: unknown }> }).content ?? [];
			if (phase === "plan") {
				for (const [contentIndex, block] of content.entries()) {
					const annotation = readPluginQuestionMessageAnnotation(m, contentIndex);
					if (annotation.status !== "absent") {
						if (annotation.status === "posed" && annotation.snapshot.variant === "teach" && taggedNodeId(annotation.snapshot.input)) { phase = "teach"; break; }
						continue;
					}
					if (
						block.type === "toolCall" &&
						(block.name === "quiz" || block.name === "explain") &&
						taggedNodeId(block.arguments)
					) {
						phase = "teach";
						break;
					}
				}
			}
		}
	}
	return phase;
}

/** Default number of projected view groups shipped on initial SSR and tail GETs. */
export const CLIENT_DEFAULT_TAIL_GROUPS = 30;

export interface ChatTailSlice {
	messages: LhMessage[];
	totalMessages: number;
	omittedMessages: number;
	omittedViewGroups: number;
	startPhase: Phase3;
	truncated: boolean;
}

/**
 * Slice a native message history to the last `maxViewGroups` projected view
 * groups at a clean group boundary (never splitting an assistant group from
 * its toolResults, plan-blocks, or side-question markers, and always keeping
 * any active problem or pending question posing message inside the tail).
 */
export function sliceChatTailForClient(messages: readonly LhMessage[], maxViewGroups: number): ChatTailSlice {
	const total = messages.length;
	if (total === 0 || !Number.isFinite(maxViewGroups) || maxViewGroups <= 0) {
		return { messages: [...messages], totalMessages: total, omittedMessages: 0, omittedViewGroups: 0, startPhase: "probe", truncated: false };
	}
	const groupStarts: number[] = [];
	let inAssistantGroup = false;
	for (let i = 0; i < total; i++) {
		const m = messages[i]!;
		if (m.role === "assistant") {
			if (!inAssistantGroup) {
				groupStarts.push(i);
				inAssistantGroup = true;
			}
		} else if (m.role === "toolResult") {
			if (groupStarts.length === 0) groupStarts.push(i);
		} else if (
			m.role === "custom" &&
			(m.customType === "plan-block" || m.customType === "side-question" || m.customType === "side-question-told")
		) {
			if (groupStarts.length === 0) groupStarts.push(i);
		} else {
			inAssistantGroup = false;
			groupStarts.push(i);
		}
	}
	if (groupStarts.length <= maxViewGroups) {
		return { messages: [...messages], totalMessages: total, omittedMessages: 0, omittedViewGroups: 0, startPhase: "probe", truncated: false };
	}
	let targetGroup = groupStarts.length - maxViewGroups;
	let cutIndex = groupStarts[targetGroup]!;

	// Never cut off an active problem or pending question's posing message.
	const mustIncludeIds: string[] = [];
	const activeProb = activeProblemOccurrenceOf(messages);
	if (activeProb?.messageId) mustIncludeIds.push(activeProb.messageId);
	const pendingQ = pendingQuestionOf(messages);
	if (pendingQ?.messageId) mustIncludeIds.push(pendingQ.messageId);
	const pendingPluginQ = pendingPluginQuestionOf(messages);
	if (pendingPluginQ?.occurrence.messageId) mustIncludeIds.push(pendingPluginQ.occurrence.messageId);
	for (const reqId of mustIncludeIds) {
		const idx = messages.findIndex((m) => m.id === reqId);
		if (idx >= 0 && idx < cutIndex) {
			// Walk targetGroup back to the group containing idx
			while (targetGroup > 0 && groupStarts[targetGroup]! > idx) {
				targetGroup--;
			}
			cutIndex = groupStarts[targetGroup]!;
		}
	}

	if (cutIndex <= 0) {
		return { messages: [...messages], totalMessages: total, omittedMessages: 0, omittedViewGroups: 0, startPhase: "probe", truncated: false };
	}
	return {
		messages: messages.slice(cutIndex),
		totalMessages: total,
		omittedMessages: cutIndex,
		omittedViewGroups: targetGroup,
		startPhase: phaseAt3Lh(messages, cutIndex - 1),
		truncated: true,
	};
}
