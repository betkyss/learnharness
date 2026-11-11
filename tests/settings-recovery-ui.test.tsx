import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { SettingsDialogBody } from "../components/settings/settings-dialog";
import { InteractionLayersProvider } from "../components/interaction-layers";
import { KeysSection } from "../components/settings/keys-section";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
const originalFetch = globalThis.fetch;
afterEach(async () => { await act(async () => root?.unmount()); document.body.innerHTML = ""; globalThis.fetch = originalFetch; });
async function mount(node: React.ReactNode) { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); await act(async () => root!.render(<InteractionLayersProvider>{node}</InteractionLayersProvider>)); }
async function click(selector: string) { const el = document.querySelector(selector); assert.ok(el, selector); await act(async () => { el.dispatchEvent(new dom.window.Event("click", { bubbles: true })); }); }
it("Settings retries in place, preserves the chosen section and ignores a disposed request", async () => {
 let attempts = 0;
 globalThis.fetch = async (input) => {
  assert.equal(String(input), "/api/settings");
  attempts++;
  return attempts === 1 ? new Response("", { status: 503 }) : Response.json({ settings: { version: 1 } });
 };
 await mount(<SettingsDialogBody initialSection="appearance" onClose={() => {}} />);
 assert.match(document.body.textContent!, /Settings could not be loaded/);
 await click('[data-testid="settings-nav-graph"]');
 await click('[role="alert"] button');
 assert.equal(attempts, 2);
 assert.ok(document.querySelector('[data-testid="section-graph"]'));
 assert.equal(document.querySelector('[data-testid="settings-nav-graph"]')?.getAttribute("aria-current"), "true");
 assert.equal(document.querySelector('[role="alert"]'), null);
});
it("Providers distinguishes HTTP failure from empty success and offers a local Retry", async () => {
 let attempts = 0;
 globalThis.fetch = async (input) => {
  if (String(input) === "/api/keys") { attempts++; return attempts === 1 ? new Response("", { status: 503 }) : Response.json({ keys: [], providers: [] }); }
  if (String(input).startsWith("/api/custom-provider")) return Response.json({});
  return Response.json({});
 };
 await mount(<KeysSection />);
 assert.match(document.querySelector('[role="alert"]')!.textContent!, /Providers could not be loaded/);
 assert.equal(document.querySelector('[data-testid="add-provider"]'), null);
 await click('[role="alert"] button');
 assert.equal(attempts, 2);
 assert.ok(document.querySelector('[data-testid="add-provider"]'));
 assert.equal(document.querySelector('[role="alert"]'), null);
});
