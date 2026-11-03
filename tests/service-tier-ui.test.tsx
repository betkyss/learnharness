import React, { act } from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ModelControl } from "../components/model-picker.tsx";
import { StatsBar } from "../components/stats-bar.tsx";
import type { ChatSettings, ModelCatalogResponse, TurnUsage } from "../src/core/index.ts";
(globalThis as Record<string, unknown>).React = React;
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0), cancelAnimationFrame: clearTimeout });
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const model = { provider: "chatgpt", id: "gpt-6.1-sol" };
const catalog: ModelCatalogResponse = { models: [
	{ ...model, name: "Sol", input: ["text"], reasoning: true, supportedLevels: ["low", "high"], cost: null, contextWindow: 100000, maxTokens: 1000 },
	{ ...model, id: "gpt-6-luna", name: "Luna", input: ["text"], reasoning: true, supportedLevels: ["low", "high"], cost: null, contextWindow: 100000, maxTokens: 1000 },
], providers: [], defaults: null, slots: { strong: null, cheap: null, vision: null }, rolePins: { researcher: null, demoBuilder: null, visualMaker: null, extractor: null, auditor: null } };
function element(testid: string) { const found = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`); assert(found, testid); return found; }
async function click(testid: string) { await act(async () => element(testid).click()); }

test("chat Speed selector saves explicit modes and inheritance, preserves reasoning, resets incompatible mode", async () => {
	const original = globalThis.fetch;
	let settings: ChatSettings = { model, thinkingLevel: "high" };
	const writes: ChatSettings[] = [];
	globalThis.fetch = async (input, init) => {
		if (input === "/api/models") return Response.json(catalog);
		if (input === "/api/settings") return Response.json({ settings: { models: { strong: { model, serviceTier: "fast" } } } });
		if (input === "/api/chats/fixture/settings") { settings = JSON.parse(init?.body as string); writes.push(settings); return Response.json({ settings }); }
		if (input === "/api/chats/fixture") return Response.json({ settings });
		throw new Error(`Unexpected request ${input}`);
	};
	const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
	try {
		await act(async () => root.render(<ModelControl chatId="fixture" />));
		assert.match(element("stats-speed").textContent ?? "", /Fast/);
		await click("stats-speed"); await click("speed-option-ultrafast");
		assert.equal(writes.at(-1)?.serviceTier, "ultrafast"); assert.equal(writes.at(-1)?.thinkingLevel, "high");
		await click("stats-thinking"); await click("thinking-option-low");
		assert.equal(writes.at(-1)?.serviceTier, "ultrafast"); assert.equal(writes.at(-1)?.thinkingLevel, "low");
		await click("stats-speed"); await click("speed-option-default");
		assert.equal(writes.at(-1)?.serviceTier, "default");
		await click("stats-speed"); await click("speed-option-inherit");
		assert.equal(Object.hasOwn(writes.at(-1)!, "serviceTier"), false);
		assert.match(element("stats-speed").textContent ?? "", /Fast/);
		await click("stats-speed"); await click("speed-option-ultrafast");
		await click("stats-model"); await click("model-option-gpt-6-luna");
		assert.equal(writes.at(-1)?.model?.id, "gpt-6-luna");
		assert.equal(Object.hasOwn(writes.at(-1)!, "serviceTier"), false);
		assert.match(host.textContent ?? "", /Speed reset/);
		await click("stats-speed");
		assert.equal(document.querySelector('[data-testid="speed-option-ultrafast"]'), null);
	} finally { await act(async () => root.unmount()); host.remove(); globalThis.fetch = original; }
});

test("expanded stats show the server result per call instead of the selected speed", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = async (input) => input === "/api/models" ? Response.json(catalog) : Response.json({ settings: {} });
	const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
	const step = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
	const turns: TurnUsage[] = [{ id: "turn", messageId: "message", model: "chatgpt:gpt-6.1-sol", at: "2026-11-03", steps: [
		{ ...step, serviceTier: { requestedServiceTier: "ultrafast", receivedServiceTier: "default" } },
		{ ...step, serviceTier: { requestedServiceTier: "ultrafast", receivedServiceTier: null } },
	] }];
	try {
		await act(async () => root.render(<StatsBar chatId="fixture" turns={turns} />));
		await click("stats-summary");
		const rows = [...document.querySelectorAll('[data-testid="turn-service-tier"]')].map((row) => row.textContent);
		assert.deepEqual(rows, ["Step 1: Requested: Ultrafast · Received: Default", "Step 2: Requested: Ultrafast · Received: Not reported"]);
	} finally { await act(async () => root.unmount()); host.remove(); globalThis.fetch = original; }
});
