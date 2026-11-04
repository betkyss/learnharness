import { toolActivityLabel, type LhViewPart } from "@/src/core";

const WORK_TOOLS = new Set(["read", "ls", "find", "grep", "list_sessions", "list_propositions"]);

export interface IndexedPart {
	part: LhViewPart;
	index: number;
	key: string;
}

export type WorkEntry =
	| ({ type: "part" } & IndexedPart)
	| { type: "work"; key: string; parts: IndexedPart[]; activity: string | null };

/** Display-only grouping. Native history and the projection's part order stay intact. */
export function groupWorkParts(
	parts: readonly LhViewPart[],
	phaseBoundary = -1,
	activeMessageId: string | null = null,
): WorkEntry[] {
	const entries: WorkEntry[] = [];
	let work: Extract<WorkEntry, { type: "work" }> | undefined;
	let stepNumber = -1;
	let stepStart = 0;
	let boundary = "start";
	let separator: IndexedPart | undefined;
	const flush = () => { if (work) entries.push(work); work = undefined; };
	const lastActivePart = parts.filter(p => p.sourceMessageId === activeMessageId && p.type !== "step-start").at(-1);

	for (const [index, part] of parts.entries()) {
		if (part.type === "step-start") {
			stepNumber++;
			stepStart = index;
		}
		// Native message IDs are stamped again when the server persists a
		// streamed turn. Its position within this assistant run does not change.
		const localId = part.id?.match(/-[rt]\d+$/)?.[0] ?? part.sourceContentIndex ?? index - stepStart;
		const key = `step:${Math.max(0, stepNumber)}:${part.type}:${localId}`;
		const item = { part, index, key };
		if (part.type === "step-start") {
			if (index === phaseBoundary) {
				flush();
				entries.push({ type: "part", ...item });
				boundary = key;
				separator = undefined;
			} else separator = item;
			continue;
		}
		const technical = part.type === "reasoning" ||
			(part.type.startsWith("tool-") && WORK_TOOLS.has(part.type.slice(5)) && part.state !== "output-error");
		if (technical) {
			// Key the segment by its source and preceding visible boundary, not
			// its first fragment: an empty placeholder can become a tool call.
			work ??= { type: "work", key: `work:${Math.max(0, stepNumber)}:${boundary}`, parts: [], activity: null };
			work.parts.push(item);
			if (part.type.startsWith("tool-") && part.state === "input-streaming") {
				work.activity = toolActivityLabel(part.type.slice(5));
			} else if (part.type === "reasoning" && part === lastActivePart) {
				work.activity = part.text ? "Thinking…" : "Working…";
			}
			separator = undefined;
		} else {
			const hadWork = !!work;
			flush();
			if (separator && !hadWork && entries.length > 0) entries.push({ type: "part", ...separator });
			separator = undefined;
			entries.push({ type: "part", ...item });
			boundary = key;
		}
	}
	flush();
	return entries;
}
