import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { inheritedServiceTier, serviceTierError, serviceTierSummary } from "../src/core/service-tier.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveConversationSpec, resolveRoleSpec, resolveSlot } from "../src/core/settings-resolution.ts";
import { parseSettingsBody, parseModelsSettingsBody, parseAgentSettingsBody } from "../src/server/settings-body.ts";
import { catalogDefaultsFor, rolePinsFor, validateModelsSettings } from "../src/server/model-catalog.ts";
import { composeSlotModel } from "../components/settings/agent-section.tsx";
import { ServiceTierMenu } from "../components/settings/service-tier-menu.tsx";
const model = { provider: "chatgpt", id: "gpt-6.1-sol" };
const slot = { model, serviceTier: "ultrafast" as const, thinkingLevel: "high" as const };

test("speed inheritance stops at model identity changes and explicit default", () => {
	for (const override of [undefined, {}, { model }, { thinkingLevel: "low" as const }]) {
		assert.equal(inheritedServiceTier(override, slot), "ultrafast");
		assert.equal(resolveConversationSpec(override, resolveSlot(slot))?.serviceTier, "ultrafast");
	}
	for (const changed of [{ ...model, id: "gpt-6-astra" }, { ...model, provider: "openai" }]) {
		assert.equal(resolveConversationSpec({ model: changed }, resolveSlot(slot))?.serviceTier, undefined);
		assert.equal(resolveRoleSpec("auditor", { version: 1, models: { cheap: slot }, agent: { models: { auditor: { model: changed } } } })?.serviceTier, undefined);
	}
	for (const serviceTier of ["default", "fast", "ultrafast"] as const) {
		assert.equal(resolveConversationSpec({ serviceTier }, resolveSlot(slot))?.serviceTier, serviceTier);
		assert.equal(resolveRoleSpec("auditor", { version: 1, models: { cheap: slot }, agent: { models: { auditor: { serviceTier } } } })?.serviceTier, serviceTier);
	}
	assert.equal(resolveSlot({ model })?.serviceTier, undefined);
	assert.equal(catalogDefaultsFor(resolveSlot(slot))?.serviceTier, "ultrafast");
	assert.equal(rolePinsFor({ researcher: undefined, demoBuilder: undefined, visualMaker: undefined, extractor: undefined, auditor: resolveRoleSpec("auditor", { version: 1, models: { cheap: slot } }) }).auditor?.serviceTier, "ultrafast");
});

test("speed is validated independently and survives settings sanitization", () => {
	for (const serviceTier of ["default", "fast", "ultrafast"] as const) {
		const value = { ...slot, serviceTier };
		assert.deepEqual(parseSettingsBody(value), { ok: true, settings: value });
		assert.deepEqual(parseModelsSettingsBody({ strong: value }), { ok: true, settings: { strong: value } });
		assert.deepEqual(parseAgentSettingsBody({ models: { auditor: value } }), { ok: true, settings: { models: { auditor: value } } });
		const stored = sanitizeUserSettings(JSON.parse(JSON.stringify({ version: 1, models: { strong: value }, agent: { models: { auditor: value } } })));
		assert.equal(stored?.models?.strong?.serviceTier, serviceTier);
		assert.equal(stored?.agent?.models?.auditor?.serviceTier, serviceTier);
	}
	for (const bad of [null, "priority", "turbo", 1, {}, true]) {
		assert.equal(parseSettingsBody({ model, serviceTier: bad }).ok, false);
		assert.equal(parseModelsSettingsBody({ strong: { model, serviceTier: bad } }).ok, false);
		assert.equal(parseAgentSettingsBody({ models: { auditor: { serviceTier: bad } } }).ok, false);
		assert.equal(sanitizeUserSettings({ version: 1, models: { strong: { model, serviceTier: bad } } })?.models?.strong?.serviceTier, undefined);
	}
	assert(serviceTierError({ provider: "openai", id: model.id }, "fast"));
	assert(serviceTierError({ provider: "chatgpt", id: "unknown" }, "ultrafast"));
	assert.equal(serviceTierError({ provider: "chatgpt", id: "gpt-6.1-terra" }, "fast"), undefined);
	// An unchanged model pin must not bypass tier validation.
	const invalid = { strong: { ...slot, model: { ...model, id: "unknown" } } };
	assert.equal(validateModelsSettings(invalid, invalid).ok, false);
});

test("model and reasoning edits preserve compatible explicit speed, reset incompatible speed", () => {
	assert.equal(composeSlotModel({ strong: slot }, "strong", "", "", "low").strong?.serviceTier, "ultrafast");
	assert.equal(composeSlotModel({ strong: slot }, "strong", model.provider, model.id, "low").strong?.serviceTier, "ultrafast");
	assert.equal(composeSlotModel({ strong: slot }, "strong", "chatgpt", "gpt-6-astra", "high").strong?.serviceTier, "ultrafast");
	assert.equal(composeSlotModel({ strong: slot }, "strong", "openai", model.id, "high").strong?.serviceTier, undefined);
	assert.equal(composeSlotModel({ strong: slot }, "strong", "chatgpt", "gpt-6-luna", "high").strong?.serviceTier, undefined);
});

test("speed choices and reporting distinguish request, default response, and missing response", () => {
	const html = renderToStaticMarkup(createElement(ServiceTierMenu, { ...model, value: "ultrafast", onPick: () => {} }));
	assert.match(html, /speed-option-ultrafast/); assert.match(html, /speed-option-inherit/); assert.match(html, /Requested speed/);
	const unsupported = renderToStaticMarkup(createElement(ServiceTierMenu, { ...model, id: "unknown", onPick: () => {} }));
	assert.doesNotMatch(unsupported, /speed-option-ultrafast|speed-option-fast/);
	assert.equal(serviceTierSummary({ requestedServiceTier: "ultrafast", receivedServiceTier: "default" }), "Requested: Ultrafast · Received: Default");
	assert.equal(serviceTierSummary({ receivedServiceTier: null }), "Requested: Not sent · Received: Not reported");
});
