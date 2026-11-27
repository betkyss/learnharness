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
		const markerMsg: LhMessage = {
			id: "msg_marker_1",
			role: "custom",
			customType: "probe-handoff",
			content: "handoff",
			display: true,
			details: { chatId: "chat_1" },
			timestamp: 1200,
		};
		const input = [userMsg, assistantMsg, toolResultMsg, markerMsg];
		const snapshotBefore = JSON.stringify(input);

		const sanitized = sanitizeMessagesForClient(input);

		assert.equal(JSON.stringify(input), snapshotBefore, "input messages and blocks must never be mutated");
		assert.notEqual(sanitized, input);
		assert.equal(sanitized[0], userMsg, "non-assistant messages pass through untouched");
		assert.equal(sanitized[2], toolResultMsg);
		assert.equal(sanitized[3], markerMsg);

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
