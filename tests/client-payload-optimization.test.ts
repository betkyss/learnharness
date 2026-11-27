import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { LhMessage } from "../src/core/index.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-client-payload-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "empty-auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });

const { sanitizeMessagesForClient } = await import("../src/core/index.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { GET } = await import("../app/api/chats/[id]/route.ts");

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function sampleAssistantMessage(): LhMessage {
	return {
		id: "msg_assistant_1",
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		timestamp: 1000,
		stopReason: "toolUse",
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content: [
			{ type: "thinking", thinking: "Step by step reasoning", thinkingSignature: "opaque-thinking-sig-base64" },
			{ type: "text", text: "Visible lesson text", textSignature: "opaque-text-sig-base64" },
			{ type: "toolCall", id: "call_1", name: "quiz", arguments: { question: "What is 2+2?" } },
		],
	};
}

describe("sanitizeMessagesForClient", () => {
	it("strips thinkingSignature and textSignature without mutating input or altering other fields", () => {
		const userMsg: LhMessage = { id: "msg_user_1", role: "user", content: "Teach me", timestamp: 900 };
		const assistantMsg = sampleAssistantMessage();
		const toolResultMsg: LhMessage = {
			id: "msg_tool_1",
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "quiz",
			content: [{ type: "text", text: '{"answer":"4"}' }],
			details: { answer: "4" },
			isError: false,
			timestamp: 1100,
		};
		const errorToolResultMsg: LhMessage = {
			id: "msg_tool_err",
			role: "toolResult",
			toolCallId: "call_err",
			toolName: "read",
			content: [{ type: "text", text: "ENOENT: no such file" }],
			details: { error: "ENOENT" },
			isError: true,
			timestamp: 1120,
		};
		const pluginToolResultMsg: LhMessage = {
			id: "msg_tool_plugin",
			role: "toolResult",
			toolCallId: "call_plugin",
			toolName: "custom_plugin_tool",
			content: [{ type: "text", text: "plugin output text" }],
			details: { custom: true },
			isError: false,
			timestamp: 1140,
		};
		const noDetailsToolResultMsg: LhMessage = {
			id: "msg_tool_nodetails",
			role: "toolResult",
			toolCallId: "call_nodetails",
			toolName: "read",
			content: [{ type: "text", text: "fallback text needed when details is null" }],
			details: null,
			isError: false,
			timestamp: 1150,
		};
		const markerMsg: LhMessage = {
			id: "msg_marker_1",
			role: "custom",
			customType: "probe-handoff",
			content: "handoff",
			display: true,
			details: { chatId: "chat_1" },
			timestamp: 1200,
		};
		const compactionMsg: LhMessage = {
			id: "msg_compaction_1",
			role: "custom",
			customType: "compaction",
			content: "[SESSION HISTORY COMPACTED]\n" + "x".repeat(50_000),
			display: true,
			details: { tokensBefore: 160_000, firstKeptMessageId: "msg_u_1", at: "2026-11-27T00:00:00Z" },
			timestamp: 1250,
		};
		const input = [
			userMsg,
			assistantMsg,
			toolResultMsg,
			errorToolResultMsg,
			pluginToolResultMsg,
			noDetailsToolResultMsg,
			markerMsg,
			compactionMsg,
		];
		const snapshotBefore = JSON.stringify(input);

		const sanitized = sanitizeMessagesForClient(input);

		assert.equal(JSON.stringify(input), snapshotBefore, "input messages and blocks must never be mutated");
		assert.notEqual(sanitized, input);
		assert.equal(sanitized[0], userMsg, "user messages pass through untouched");
		// Builtin non-error toolResult with details strips duplicated content
		assert.notEqual(sanitized[2], toolResultMsg);
		assert.equal(sanitized[2]!.role, "toolResult");
		assert.deepEqual(sanitized[2]!.content, []);
		assert.deepEqual((sanitized[2]! as { details?: unknown }).details, { answer: "4" });
		// Error, plugin, and null-details toolResults keep their content intact
		assert.equal(sanitized[3], errorToolResultMsg);
		assert.equal(sanitized[4], pluginToolResultMsg);
		assert.equal(sanitized[5], noDetailsToolResultMsg);
		assert.equal(sanitized[6], markerMsg);
		// Compaction marker strips unrendered summary content while preserving details
		assert.notEqual(sanitized[7], compactionMsg);
		assert.equal((sanitized[7]! as { content?: unknown }).content, "");
		assert.deepEqual((sanitized[7]! as { details?: unknown }).details, compactionMsg.details);

		const outAssistant = sanitized[1]!;
		assert.equal(outAssistant.role, "assistant");
		assert.notEqual(outAssistant, assistantMsg);
		assert.equal(outAssistant.id, "msg_assistant_1");
		assert.equal(outAssistant.model, "claude-sonnet-4-5");
		assert.deepEqual(outAssistant.content, [
			{ type: "thinking", thinking: "Step by step reasoning" },
			{ type: "text", text: "Visible lesson text" },
			{ type: "toolCall", id: "call_1", name: "quiz", arguments: { question: "What is 2+2?" } },
		]);
		assert.equal("thinkingSignature" in outAssistant.content[0]!, false);
		assert.equal("textSignature" in outAssistant.content[1]!, false);
	});
});

describe("GET /api/chats/[id] single-read and ?tail=N pagination", () => {
	it("serves ?tail=N with clean group boundaries, totalMessages, truncated, and initialPhase while keeping plain GET backwards-compatible", async () => {
		const record = chatStore.createChat("tail pagination fixture");
		const msgs: LhMessage[] = [];
		for (let i = 0; i < 12; i++) {
			msgs.push({ id: `msg_u_${i}`, role: "user", content: `Question ${i}`, timestamp: 1000 + i * 10 });
			msgs.push({
				id: `msg_a_${i}`,
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				timestamp: 1005 + i * 10,
				stopReason: i === 1 ? "toolUse" : "stop",
				usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				content: i === 1
					? [{ type: "toolCall", id: "call_pd", name: "probe_done", arguments: {} }]
					: [{ type: "text", text: `Answer ${i}` }],
			});
			if (i === 1) {
				msgs.push({
					id: "msg_tr_pd",
					role: "toolResult",
					toolCallId: "call_pd",
					toolName: "probe_done",
					content: [{ type: "text", text: "ok" }],
					details: { ok: true },
					isError: false,
					timestamp: 1016,
				});
			}
		}
		chatStore.saveMessages(record.id, msgs);

		// ?tail=4 returns only the last 4 view groups (2 user + 2 assistant = 4 messages)
		const tailRes = await GET(
			new Request(`http://localhost/api/chats/${record.id}?tail=4`),
			{ params: Promise.resolve({ id: record.id }) },
		);
		assert.equal(tailRes.status, 200);
		const tailBody = (await tailRes.json()) as {
			messages: LhMessage[];
			totalMessages: number;
			truncated: boolean;
			initialPhase: string;
		};
		assert.equal(tailBody.totalMessages, msgs.length);
		assert.equal(tailBody.truncated, true);
		assert.equal(tailBody.initialPhase, "plan", "probe_done happened before the tail window");
		assert.equal(tailBody.messages.length, 4);
		assert.equal(tailBody.messages[0]!.id, "msg_u_10");
		assert.equal(tailBody.messages.at(-1)!.id, "msg_a_11");

		// Plain GET without ?tail= returns full history (backwards-compatible)
		const fullRes = await GET(
			new Request(`http://localhost/api/chats/${record.id}`),
			{ params: Promise.resolve({ id: record.id }) },
		);
		assert.equal(fullRes.status, 200);
		const fullBody = (await fullRes.json()) as { messages: LhMessage[] };
		assert.equal(fullBody.messages.length, msgs.length);
		assert.equal(fullBody.messages[0]!.id, "msg_u_0");
	});

	it("reads chat from chatStore only once on normal GET /api/chats/[id]", async () => {
		const record = chatStore.createChat("single-read fixture");
		chatStore.saveMessages(record.id, [
			{ id: "msg_sr_u", role: "user", content: "Hi", timestamp: 1 },
			sampleAssistantMessage(),
		]);
		const { stores } = await import("../src/server/stores.ts");
		const origGetChat = stores.chatStore.getChat;
		let getChatCalls = 0;
		stores.chatStore.getChat = (id: string) => {
			if (id === record.id) getChatCalls++;
			return origGetChat(id);
		};
		try {
			const res = await GET(
				new Request(`http://localhost/api/chats/${record.id}`),
				{ params: Promise.resolve({ id: record.id }) },
			);
			assert.equal(res.status, 200);
			assert.equal(getChatCalls, 1, `expected exactly 1 getChat() call, got ${getChatCalls}`);
		} finally {
			stores.chatStore.getChat = origGetChat;
		}
	});
});

describe("GET /api/chats/[id] lightweight views and signature stripping", () => {
	it("serves ?view=coverage, ?view=settings, ?view=meta and strips signatures on full GET without modifying disk", async () => {
		const record = chatStore.createChat("optimization fixture");
		chatStore.saveSettings(record.id, {
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			thinkingLevel: "high",
		});
		const userMsg: LhMessage = { id: "msg_u1", role: "user", content: "Hello", timestamp: 1 };
		const assistantMsg = sampleAssistantMessage();
		chatStore.saveMessages(record.id, [userMsg, assistantMsg]);

		const diskPath = path.join(scratch, "chats", `${record.id}.json`);
		const diskBefore = fs.readFileSync(diskPath, "utf8");
		assert.ok(diskBefore.includes("opaque-thinking-sig-base64"));
		assert.ok(diskBefore.includes("opaque-text-sig-base64"));

		const coverageRes = await GET(
			new Request(`http://localhost/api/chats/${record.id}?view=coverage`),
			{ params: Promise.resolve({ id: record.id }) },
		);
		assert.equal(coverageRes.status, 200);
		const coverageBody = (await coverageRes.json()) as Record<string, unknown>;
		assert.deepEqual(Object.keys(coverageBody), ["coverage"]);
		assert.equal((coverageBody.coverage as { totalMessages: number }).totalMessages, 2);

		const settingsRes = await GET(
			new Request(`http://localhost/api/chats/${record.id}?view=settings`),
			{ params: Promise.resolve({ id: record.id }) },
		);
		assert.equal(settingsRes.status, 200);
		const settingsBody = (await settingsRes.json()) as Record<string, unknown>;
		assert.deepEqual(settingsBody, {
			settings: {
				model: { provider: "anthropic", id: "claude-sonnet-4-5" },
				thinkingLevel: "high",
			},
		});

		const metaRes = await GET(
			new Request(`http://localhost/api/chats/${record.id}?view=meta`),
			{ params: Promise.resolve({ id: record.id }) },
		);
		assert.equal(metaRes.status, 200);
		const metaBody = (await metaRes.json()) as Record<string, unknown>;
		assert.deepEqual(metaBody, {
			messageCount: 2,
			lastMessageId: "msg_assistant_1",
			turnInFlight: false,
			compacting: false,
		});
		assert.equal("messages" in metaBody, false);

		const fullRes = await GET(
			new Request(`http://localhost/api/chats/${record.id}`),
			{ params: Promise.resolve({ id: record.id }) },
		);
		assert.equal(fullRes.status, 200);
		const fullRaw = await fullRes.text();
		assert.equal(fullRaw.includes("thinkingSignature"), false);
		assert.equal(fullRaw.includes("textSignature"), false);
		assert.ok(fullRaw.includes("Step by step reasoning"));
		assert.ok(fullRaw.includes("Visible lesson text"));

		// Disk storage and chatStore must remain completely untouched
		assert.equal(fs.readFileSync(diskPath, "utf8"), diskBefore);
		const storedAssistant = chatStore.getChat(record.id)!.messages[1]!;
		assert.equal(storedAssistant.role, "assistant");
		assert.equal(
			(storedAssistant.content[0] as { thinkingSignature?: string }).thinkingSignature,
			"opaque-thinking-sig-base64",
		);
		assert.equal(
			(storedAssistant.content[1] as { textSignature?: string }).textSignature,
			"opaque-text-sig-base64",
		);
	});

	it("returns 404 for missing chats on coverage, settings, and meta views", async () => {
		for (const view of ["coverage", "settings", "meta"]) {
			const res = await GET(
				new Request(`http://localhost/api/chats/does-not-exist?view=${view}`),
				{ params: Promise.resolve({ id: "does-not-exist" }) },
			);
			assert.equal(res.status, 404, `view=${view}`);
			assert.deepEqual(await res.json(), { error: "Not found" });
		}
	});
});
