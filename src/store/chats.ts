/**
 * ChatStore — the fs JSON adapter (one file per chat in data/chats/).
 *
 * Implements core/ports.ts ChatStore; the record shapes live in
 * core/contracts.ts (ChatRecord/ChatSummary). Idioms: sync fs, tiny
 * records, id-guarded filenames, JSON with tab indentation. Wired in the
 * composition root (src/server/stores.ts); nothing else constructs it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { ChatStore } from "../core/ports.ts";
import type { ChatRecord, ChatSettings, ChatSummary, ExtractionRunUsage, ImageSnapshot, PlanTree, SideChatThread, TurnUsage } from "../core/contracts.ts";
import { CURRENT_CHAT_VERSION } from "../core/contracts.ts";
import type { LhMessage } from "../core/native-messages.ts";
import { activeProblemOf, danglingQuestionOf } from "../core/native-messages.ts";
import { phaseAt3Lh } from "../core/phases.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

function chatFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
	return path.join(/* turbopackIgnore: true */ PATHS.chats, `${id}.json`);
}

/** THE SILENCE LAW (push S6, 2026-10-02): chats-changed announces ONLY
 *  list-SHAPE mutations — createChat, renameChat, deleteChat (below,
 *  each emits post-write). The content writers (saveMessages,
 *  appendTurnUsage, appendExtractionUsage, saveSettings, saveTree) are
 *  DELIBERATELY SILENT: saveMessages fires per turn-persist and would
 *  spam the bus, and every list-visible change it causes (title, order,
 *  phase, busy, pendingQuestion) is already announced by turn-started /
 *  turn-settled, which the sidebar refetches on. Silence here is law,
 *  not oversight. */
function createChat(title: string, kind?: "practice"): ChatRecord {
	const now = new Date().toISOString();
	const record: ChatRecord = {
		id: `chat_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
		title: title.trim() || "Untitled session",
		createdAt: now,
		updatedAt: now,
		messages: [],
		// Practice sessions carry the marker; teach stays ABSENT (absence
		// reads as teach — pre-practice records never migrate).
		...(kind === "practice" ? { kind: "practice" as const } : {}),
	};
	fs.mkdirSync(PATHS.chats, { recursive: true });
	writeChat(record);
	emit("chats-changed", {});
	return { ...record, version: CURRENT_CHAT_VERSION }; // the in-memory twin of what landed on disk
}

interface ChatCacheEntry {
	mtimeMs: number;
	size: number;
	ino: number;
	summary: ChatSummary | null;
	title: string;
	extractions: ExtractionRunUsage[];
}

const CHAT_CACHE_SYMBOL = Symbol.for("learnharness.chatSummaryCache");
interface ChatSummaryCacheState {
	entries: Map<string, ChatCacheEntry>;
	hits: number;
	misses: number;
}
function getChatSummaryCacheState(): ChatSummaryCacheState {
	const g = globalThis as typeof globalThis & { [CHAT_CACHE_SYMBOL]?: ChatSummaryCacheState };
	if (!g[CHAT_CACHE_SYMBOL]) {
		g[CHAT_CACHE_SYMBOL] = { entries: new Map<string, ChatCacheEntry>(), hits: 0, misses: 0 };
	}
	return g[CHAT_CACHE_SYMBOL];
}

export function chatStoreCacheStats(): { hits: number; misses: number; size: number } {
	const state = getChatSummaryCacheState();
	return { hits: state.hits, misses: state.misses, size: state.entries.size };
}

function buildCacheEntry(record: ChatRecord, stat: { mtimeMs: number; size: number; ino: number }): ChatCacheEntry {
	const { messages, tree: _tree, turns: _turns, extractions, imageSnapshots: _imageSnapshots, sideChats: _sideChats, ...rest } = record;
	let summary: ChatSummary | null = null;
	try {
		summary = {
			...rest,
			...(rest.settings ? { settings: { ...rest.settings } } : {}),
			kind: rest.kind ?? "teach",
			messageCount: messages.length,
			phase: phaseAt3Lh(messages),
			pendingQuestion: danglingQuestionOf(messages) !== null,
			pendingProblem: activeProblemOf(messages) !== null,
		};
	} catch (err) {
		console.error(`[chat ${rest.id}] summary projection failed:`, err);
		summary = null;
	}
	return {
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		ino: stat.ino,
		summary,
		title: record.title ?? record.id,
		extractions: extractions?.length ? [...extractions] : [],
	};
}

function cloneSummary(summary: ChatSummary): ChatSummary {
	return summary.settings
		? { ...summary, settings: { ...summary.settings } }
		: { ...summary };
}

function readCachedEntries(): ChatCacheEntry[] {
	const cacheState = getChatSummaryCacheState();
	const chatSummaryCache = cacheState.entries;
	try {
		fs.mkdirSync(PATHS.chats, { recursive: true });
		const dir = PATHS.chats;
		const prefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
		const files = fs.readdirSync(/* turbopackIgnore: true */ dir).filter((f) => f.endsWith(".json"));
		const seen = new Set<string>();
		const entries: ChatCacheEntry[] = [];
		for (const f of files) {
			const fullPath = path.join(dir, f);
			seen.add(fullPath);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(/* turbopackIgnore: true */ fullPath);
			} catch {
				chatSummaryCache.delete(fullPath);
				continue;
			}
			const cached = chatSummaryCache.get(fullPath);
			if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ino === stat.ino) {
				cacheState.hits++;
				entries.push(cached);
				continue;
			}
			cacheState.misses++;
			const record = getChat(f.slice(0, -5));
			if (!record) {
				chatSummaryCache.delete(fullPath);
				continue;
			}
			const entry = buildCacheEntry(record, stat);
			chatSummaryCache.set(fullPath, entry);
			entries.push(entry);
		}
		for (const key of chatSummaryCache.keys()) {
			if (key.startsWith(prefix) && !seen.has(key)) {
				chatSummaryCache.delete(key);
			}
		}
		return entries;
	} catch {
		return [];
	}
}

/** THE WRITE CHOKE POINT (schema-versioning wave, owner 2026-10-10): every
 *  record persist goes through here and carries the CURRENT version stamp —
 *  lazy migration means existing files only get stamped on their next write.
 *  A future-version guard lives on the read side (getChat). */
function writeChat(record: ChatRecord): void {
	const file = chatFile(record.id);
	const chatSummaryCache = getChatSummaryCacheState().entries;
	const stamped: ChatRecord = { ...record, version: CURRENT_CHAT_VERSION };
	writeFileAtomicSync(file, JSON.stringify(stamped, null, "\t"), { allowInPlaceFallback: true });
	try {
		const stat = fs.statSync(/* turbopackIgnore: true */ file);
		chatSummaryCache.set(file, buildCacheEntry(stamped, stat));
	} catch {
		chatSummaryCache.delete(file);
	}
}

function getChat(id: string): ChatRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ chatFile(id), "utf-8"));
	} catch {
		return null;
	}
	// Honest refusal (owner ruling 2026-10-10): a record stamped NEWER than
	// this build (the downgrade scenario) reads as absent, never misparsed —
	// the next read-modify-write must not rewrite what it doesn't understand.
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_CHAT_VERSION) {
		console.error(`[chat ${id}] record stamped with schema version ${v} > ${CURRENT_CHAT_VERSION} — this app build is older; refusing to read it`);
		return null;
	}
	return parsed as ChatRecord;
}

function listChats(): ChatSummary[] {
	return readCachedEntries()
		.map((entry) => entry.summary)
		.filter((s): s is ChatSummary => s !== null)
		.map(cloneSummary)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function listChatExtractions(): Array<{ id: string; title: string; extractions: ExtractionRunUsage[] }> {
	return readCachedEntries()
		.filter((entry) => entry.summary !== null && entry.extractions.length > 0)
		.map((entry) => ({
			id: entry.summary!.id,
			title: entry.title,
			extractions: entry.extractions,
		}));
}

/** Persist the full native message list (the record IS the agent state —
 *  Wave B: replay is state.messages = record.messages). SILENT by the
 *  events law — see the SILENCE LAW comment at createChat. */
function saveMessages(id: string, messages: LhMessage[]): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	// Side-delivery watermarks are part of the appended native entries,
	// so input + updates commit together without mutating thread history.
	record.messages = messages;
	record.updatedAt = new Date().toISOString();
	writeChat(record);
}

/** A synchronous read/merge/write keeps concurrent worker and turn writes from losing snapshots. */
function saveImageSnapshot(id: string, snapshotId: string, image: ImageSnapshot): void {
	if (!/^[a-f0-9]{64}$/.test(snapshotId) || createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex") !== snapshotId) {
		throw new Error("Invalid image snapshot identity");
	}
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	if (record.imageSnapshots?.[snapshotId]) return;
	record.imageSnapshots = { ...record.imageSnapshots, [snapshotId]: {
		mimeType: image.mimeType, data: image.data, width: image.width, height: image.height,
	} };
	writeChat(record);
}

/** Append one usage entry to the record's turn log — idempotent per
 * turn id: each REQUEST carries its own id, so a replay of the same turn's
 * persist appends once, while continuation turns (which share a response
 *  message id) each keep their usage. */
function appendTurnUsage(id: string, entry: TurnUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.turns = record.turns?.some((t) => t.id === entry.id)
		? record.turns
		: [...(record.turns ?? []), entry];
	writeChat(record);
}

/** Append one extraction-run usage entry to the record's extractions
 * log — idempotent per startedAt: a retry that reaches the append twice
 * (abort replays) does not double-count spend. */
function appendExtractionUsage(id: string, entry: ExtractionRunUsage): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.extractions = record.extractions?.some((r) => r.startedAt === entry.startedAt)
		? record.extractions
		: [...(record.extractions ?? []), entry];
	writeChat(record);
}

/** Persist the per-chat model/thinking settings — replace-whole (the
 * picker sends the complete object; absent = config defaults). */
function saveSettings(id: string, settings: ChatSettings): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	// Like saveTree: a settings tweak is not conversation activity, so it
	// deliberately does NOT bump updatedAt (sidebar order must not churn).
	record.settings = settings;
	writeChat(record);
}

/** Rename a session (the header's click-to-edit title, 2026-09-17). Like
 * saveSettings, a rename is NOT conversation activity: updatedAt stays put
 * so sidebar order never churns. Same fallback as createChat — the empty
 * string becomes "Untitled session" (the API gate rejects it first; this
 * is the honest floor for any other caller). */
function renameChat(id: string, title: string): ChatRecord {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.title = title.trim() || "Untitled session";
	writeChat(record);
	emit("chats-changed", {});
	return record;
}

/** Delete the session record file entirely (session-deletion wave 6,
 *  owner 2026-09-22). False when the id is unknown — the route turns that
 *  into a 404. The record's graph traces and jobs are the route's
 *  choreography (core/graph-deletion.ts), not the store's. */
function deleteChat(id: string): boolean {
	const file = chatFile(id);
	getChatSummaryCacheState().entries.delete(file);
	try {
		fs.unlinkSync(file);
		removeLeftoverTemps(file);
		emit("chats-changed", {}); // only a real removal — the present-entry law
		return true;
	} catch {
		return false; // never existed, already deleted, or unreadable — same answer
	}
}

/** Persist the session plan tree (plan tools call this in execute). */
function saveTree(id: string, tree: PlanTree): void {
	const record = getChat(id);
	if (!record) throw new Error(`Chat not found: ${id}`);
	record.tree = tree;
	// Deliberately does NOT bump updatedAt: tree mutations piggyback on the
	// turn's saveMessages, and sidebar ordering shouldn't churn on tree edits.
	writeChat(record);
}

/** Side-question threads (2026-11-02): one synchronous read-modify-write,
 *  so a concurrent turn's saveMessages (which re-reads the record) never
 *  loses a thread and a thread write never loses messages. Null when the
 *  chat is gone (a side answer finishing after session deletion). Silent
 *  and not conversation activity, like saveSettings. */
function updateSideChats(id: string, update: (threads: SideChatThread[]) => SideChatThread[]): SideChatThread[] | null {
	const record = getChat(id);
	if (!record) return null;
	const next = update(record.sideChats ?? []);
	if (next.length > 0) record.sideChats = next;
	else delete record.sideChats;
	writeChat(record);
	return next;
}

export const chatStore: ChatStore = {
	createChat,
	getChat,
	listChats,
	listChatExtractions,
	saveMessages,
	saveImageSnapshot,
	saveTree,
	saveSettings,
	renameChat,
	deleteChat,
	appendTurnUsage,
	appendExtractionUsage,
	updateSideChats,
};
