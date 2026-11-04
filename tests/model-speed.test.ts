import assert from "node:assert/strict";
import { test } from "node:test";
import { supportedModelSpeeds, resolveModelSpeed, modelSpeedTier } from "../src/core/model-speed.ts";
import { resolveConversationSpec, resolveRoleSpec } from "../src/core/settings-resolution.ts";
import { sanitizeUserSettings, BACKGROUND_MODEL_ROLES } from "../src/core/settings.ts";
import { parseSettingsBody, parseAgentSettingsBody, parseModelsSettingsBody } from "../src/server/settings-body.ts";
import { chatGPTPayload } from "../src/agent/chatgpt-stream.ts";

test("speed restrictions use both subscription provider and exact model ID", () => {
	for (const id of ["gpt-6-astra", "gpt-6.1-sol"]) {
		assert.deepEqual(supportedModelSpeeds("chatgpt", id), ["standard", "fast", "ultrafast"]);
		assert.equal(resolveModelSpeed("chatgpt", id, "ultrafast"), "ultrafast");
	}
	assert.deepEqual(supportedModelSpeeds("chatgpt", "gpt-5"), ["standard", "fast"]);
	assert.equal(resolveModelSpeed("chatgpt", "gpt-5", "ultrafast"), "standard");
	assert.deepEqual(supportedModelSpeeds("openai", "gpt-6-astra"), []);
	assert.equal(resolveModelSpeed("openai", "gpt-6-astra", "fast"), undefined);
	assert.equal(modelSpeedTier("fast"), "priority");
});

test("role and chat speed inheritance preserves explicit Standard and independent thinking", () => {
	const model = { provider: "chatgpt", id: "gpt-6.1-sol" };
	const record = { version: 1, models: { strong: { model, speed: "ultrafast" as const }, cheap: { model, speed: "fast" as const }, vision: { model, speed: "ultrafast" as const } }, agent: { models: { researcher: { speed: "standard" as const } } } };
	assert.equal(resolveConversationSpec(undefined, { ...model, speed: "ultrafast" })?.speed, "ultrafast");
	assert.equal(resolveConversationSpec({ speed: "standard", thinkingLevel: "high" }, { ...model, speed: "ultrafast" })?.speed, "standard");
	assert.equal(resolveRoleSpec("researcher", record)?.speed, "standard");
	assert.equal(resolveRoleSpec("auditor", record)?.speed, "fast");
	assert.equal(resolveRoleSpec("pdfReader", record)?.speed, "ultrafast");
	assert.equal(resolveRoleSpec("visualMaker", record)?.speed, "ultrafast");
	assert.equal(resolveConversationSpec({ model: { provider: "chatgpt", id: "gpt-5" } }, { ...model, speed: "ultrafast" })?.speed, "standard");
});

test("all settings parsers retain valid speed, reject malformed input, and sanitizer preserves role overrides", () => {
	const model = { provider: "chatgpt", id: "gpt-6.1-sol" };
	assert.deepEqual(parseSettingsBody({ model, speed: "fast" }), { ok: true, settings: { model, speed: "fast" } });
	assert.equal(parseSettingsBody({ speed: "turbo" }).ok, false);
	assert.equal(parseModelsSettingsBody({ strong: { model, speed: 3 } }).ok, false);
	assert.equal(parseAgentSettingsBody({ models: { pdfReader: { speed: "ultrafast" } } }).ok, true);
	assert.equal(parseAgentSettingsBody({ models: { researcher: { speed: "bad" } } }).ok, false);
	const record = sanitizeUserSettings({ version: 1, models: { strong: { model, speed: "fast" } }, agent: { models: Object.fromEntries(BACKGROUND_MODEL_ROLES.map(role => [role, { speed: "standard" }])) } });
	assert.equal(record?.models?.strong?.speed, "fast");
	for (const role of BACKGROUND_MODEL_ROLES) assert.equal(record?.agent?.models?.[role]?.speed, "standard");
});

test("final payload enforces speed after caller changes, retaining reasoning and excluding forbidden fields", () => {
	for (const [speed, tier] of [["standard", "default"], ["fast", "priority"], ["ultrafast", "ultrafast"]] as const) {
		const body = chatGPTPayload({ input: [], service_tier: "caller-forged", reasoning: { effort: "high" }, metadata: {} }, "gpt-6.1-sol", speed);
		assert.equal(body.service_tier, tier);
		assert.deepEqual(body.reasoning, { effort: "high" });
		assert.equal(body.metadata, undefined);
	}
	assert.equal(chatGPTPayload({ input: [] }, "gpt-5", "ultrafast").service_tier, "default");
});
