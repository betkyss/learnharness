import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-speed-storage-"));
process.env.LH_DATA_DIR = directory;
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
process.env.LH_IGNORE_ENV_KEYS = "1";
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
process.env.LH_DESKTOP_SERVER = "1";
process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
const oldSend = Object.getOwnPropertyDescriptor(process, "send"), oldConnected = Object.getOwnPropertyDescriptor(process, "connected");
Object.defineProperty(process, "connected", { configurable: true, value: true });
const model = { provider: "chatgpt", id: "gpt-6.1-sol" };
Object.defineProperty(process, "send", { configurable: true, value: (message: { op: string; id: string }, callback?: () => void) => {
	assert.equal(message.op, "models", "storage checks must not lease credentials");
	queueMicrotask(() => (process.emit as (event: string, value: unknown) => boolean)("message", { channel: "lh:chatgpt", id: message.id, op: message.op, ok: true, value: {
		epoch: 1, authorityRevision: 1, revision: 1, accountId: "fixture-account",
		status: { available: true, pending: false, allowBackgroundUse: true, activeId: "fixture-account", accounts: [{ id: "fixture-account", email: "fixture@example.invalid", registration: "fixture", connected: true, planEnabled: true }], error: null },
		models: [{ id: model.id, name: model.id }],
	} }));
	callback?.(); return true;
} });
const { refreshConnectionCatalog, stores, readSettingsRecord } = await import("../src/server/index.ts");
const { PUT: settingsPut } = await import("../app/api/settings/[section]/route.ts");
const { POST: createChat } = await import("../app/api/chats/route.ts");
const { PUT: chatPut } = await import("../app/api/chats/[id]/settings/route.ts");
const { resolveRoleSpec, resolveConversationSpec, resolveSlot } = await import("../src/core/settings-resolution.ts");
const request = (body: unknown) => new Request("http://localhost/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const put = (section: string, body: unknown) => settingsPut(request(body), { params: Promise.resolve({ section }) });
after(() => {
	if (oldSend) Object.defineProperty(process, "send", oldSend); else delete process.send;
	if (oldConnected) Object.defineProperty(process, "connected", oldConnected); else delete (process as { connected?: boolean }).connected;
	fs.rmSync(directory, { recursive: true, force: true });
});

test("real settings routes persist speed, stamp a new chat, and reject incompatible role and chat writes", async () => {
	await refreshConnectionCatalog("chatgpt");
	const strong = { model, thinkingLevel: "high", serviceTier: "ultrafast" };
	let response = await put("models", { strong, cheap: strong });
	assert.equal(response.status, 200, await response.text());
	assert.equal(readSettingsRecord()?.models?.strong?.serviceTier, "ultrafast");
	const created = await createChat(request({ title: "Speed fixture" }));
	assert.equal(created.status, 200);
	const { id } = await created.json();
	assert.equal(stores.chatStore.getChat(id)?.settings?.serviceTier, "ultrafast");
	response = await chatPut(request({ model, thinkingLevel: "low", serviceTier: "fast" }), { params: Promise.resolve({ id }) });
	assert.equal(response.status, 200, await response.text());
	assert.equal(stores.chatStore.getChat(id)?.settings?.serviceTier, "fast");
	response = await put("agent", { models: { auditor: { serviceTier: "default" } } });
	assert.equal(response.status, 200, await response.text());
	assert.equal(resolveRoleSpec("auditor", readSettingsRecord())?.serviceTier, "default");
	response = await put("agent", { models: { auditor: { model: { provider: "openai", id: model.id }, serviceTier: "ultrafast" } } });
	assert.equal(response.status, 400);
	assert.equal(readSettingsRecord()?.agent?.models?.auditor?.serviceTier, "default");
	response = await chatPut(request({ model: { provider: "openai", id: model.id }, serviceTier: "ultrafast" }), { params: Promise.resolve({ id }) });
	assert.equal(response.status, 400);
	assert.equal(stores.chatStore.getChat(id)?.settings?.serviceTier, "fast");
	response = await chatPut(request({ model, serviceTier: "default" }), { params: Promise.resolve({ id }) });
	assert.equal(response.status, 200);
	assert.equal(resolveConversationSpec(stores.chatStore.getChat(id)?.settings, resolveSlot(readSettingsRecord()?.models?.strong))?.serviceTier, "default");
	response = await chatPut(request({ model }), { params: Promise.resolve({ id }) });
	assert.equal(response.status, 200);
	assert.equal(stores.chatStore.getChat(id)?.settings?.serviceTier, undefined);
	assert.equal(resolveConversationSpec(stores.chatStore.getChat(id)?.settings, resolveSlot(readSettingsRecord()?.models?.strong))?.serviceTier, "ultrafast");
});
