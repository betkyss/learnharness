import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-chat-cache-"));
const prevDataDir = process.env.LH_DATA_DIR;
process.env.LH_DATA_DIR = tempDir;

const { chatStore, chatStoreCacheStats } = await import("../src/store/chats.ts");
const { graphCosts } = await import("../src/server/graph.ts");
const { PATHS } = await import("../config.ts");

describe("chatStore listChats & graphCosts cache", () => {
	before(() => {
		fs.mkdirSync(PATHS.chats, { recursive: true });
	});

	after(() => {
		if (prevDataDir === undefined) delete process.env.LH_DATA_DIR;
		else process.env.LH_DATA_DIR = prevDataDir;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("serves warm listChats() from (mtimeMs, size, ino) cache without disk re-reads", () => {
		const a = chatStore.createChat("Alpha");
		const b = chatStore.createChat("Beta");
		const beforeStats = chatStoreCacheStats();
		const first = chatStore.listChats();
		assert.equal(first.length, 2);
		assert.ok(first.some((c) => c.id === a.id && c.title === "Alpha"));
		assert.ok(first.some((c) => c.id === b.id && c.title === "Beta"));
		const afterFirst = chatStoreCacheStats();
		assert.equal(afterFirst.misses, beforeStats.misses, "writeChat pre-warms cache so listChats has 0 misses");
		assert.equal(afterFirst.hits, beforeStats.hits + 2);

		const second = chatStore.listChats();
		const afterSecond = chatStoreCacheStats();
		assert.equal(second.length, 2);
		assert.equal(afterSecond.misses, afterFirst.misses, "warm listChats() must incur 0 cache misses");
		assert.equal(afterSecond.hits, afterFirst.hits + 2);
	});

	it("updates cache immediately on mutations and serves graphCosts() from cache with 0 misses", () => {
		const chat = chatStore.createChat("Initial Title");
		chatStore.renameChat(chat.id, "Renamed Title");
		assert.equal(chatStore.listChats().find((c) => c.id === chat.id)?.title, "Renamed Title");

		chatStore.appendExtractionUsage(chat.id, {
			startedAt: Date.now(),
			at: new Date().toISOString(),
			durationMs: 120,
			stages: {
				extractor: {
					model: "anthropic:claude-sonnet-4-5",
					steps: [{ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }],
				},
				auditor: {
					model: "anthropic:claude-sonnet-4-5",
					steps: [{ inputTokens: 40, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }],
				},
			},
		});

		const beforeCosts = chatStoreCacheStats();
		assert.equal(typeof chatStore.listChatExtractions, "function");
		const extractions = chatStore.listChatExtractions!();
		const entry = extractions.find((e) => e.id === chat.id);
		assert.ok(entry);
		assert.equal(entry!.extractions.length, 1);

		const costs = graphCosts();
		const afterCosts = chatStoreCacheStats();
		assert.ok(costs.runs.length >= 1);
		assert.equal(afterCosts.misses, beforeCosts.misses, "graphCosts() should hit cache without re-reading JSON");

		assert.equal(chatStore.deleteChat(chat.id), true);
		assert.equal(chatStore.listChats().find((c) => c.id === chat.id), undefined);
		assert.equal(chatStore.listChatExtractions!().find((e) => e.id === chat.id), undefined);
	});

	it("invalidates cache when a chat file is modified externally on disk", () => {
		const chat = chatStore.createChat("Before External Edit");
		assert.equal(chatStore.listChats().find((c) => c.id === chat.id)?.title, "Before External Edit");

		const file = path.join(PATHS.chats, `${chat.id}.json`);
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		raw.title = "After External Edit With Longer Name";
		fs.writeFileSync(file, JSON.stringify(raw, null, "\t"));

		const beforeExternal = chatStoreCacheStats();
		const list = chatStore.listChats();
		const afterExternal = chatStoreCacheStats();
		assert.equal(list.find((c) => c.id === chat.id)?.title, "After External Edit With Longer Name");
		assert.equal(afterExternal.misses, beforeExternal.misses + 1, "external disk edit should trigger 1 cache miss");
	});
});
