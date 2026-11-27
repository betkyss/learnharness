import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { computeMenuPlacement } from "../components/menu-shell.tsx";
import { computeVisualViewportMetrics } from "../components/visual-viewport.tsx";
import { SessionRow } from "../components/sidebar.tsx";
import { SidebarFolderRow } from "../components/sidebar-folders.tsx";
import { ThemeCards } from "../components/settings/theme-cards.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { PluginsContext } from "../components/plugins.tsx";
import { BUILTIN_THEMES } from "../src/core/index.ts";

describe("P0-5: visualViewport metrics and MenuShell offsetTop placement", () => {
	it("computes keyboardInset and isShortViewport when iOS keyboard shrinks visualViewport", () => {
		const m = computeVisualViewportMetrics({
			innerWidth: 390,
			innerHeight: 844,
			visualViewport: { width: 390, height: 472, offsetTop: 12, offsetLeft: 0 },
		});
		assert.equal(m.height, 472);
		assert.equal(m.keyboardInset, 360);
		assert.equal(m.isShortViewport, true);
		assert.equal(m.isKeyboardOpen, true);

		const desktop = computeVisualViewportMetrics({
			innerWidth: 1440,
			innerHeight: 900,
			visualViewport: { width: 1440, height: 900, offsetTop: 0, offsetLeft: 0 },
		});
		assert.equal(desktop.keyboardInset, 0);
		assert.equal(desktop.isShortViewport, false);
		assert.equal(desktop.isKeyboardOpen, false);
	});

	it("keeps menus inside visualViewport bounds when offsetTop and keyboard height reduce visible area", () => {
		const p = computeMenuPlacement(
			{ top: 410, bottom: 440, left: 200, right: 370 },
			{ width: 390, height: 460, offsetTop: 20, offsetLeft: 0 },
			240,
			"down",
			"right",
			220,
		);
		assert.equal(p.side, "up", "should flip up when keyboard consumes bottom space");
		assert.ok(Number(p.style.top) >= 28, "top must stay within visualViewport.offsetTop + edge");
		assert.ok(Number(p.style.top) + Math.min(240, p.maxHeight) <= 480 - 8);
	});
});

describe("P0-4: mobile sidebar touch action menus", () => {
	it("renders a touch-accessible action button on SessionRow when onContextMenu is supplied", () => {
		const html = renderToStaticMarkup(
			createElement(SessionRow, {
				chat: {
					id: "chat_mobile_1",
					title: "Linear Algebra",
					kind: "teach",
					createdAt: "2026-11-27T00:00:00.000Z",
					updatedAt: "2026-11-27T00:00:00.000Z",
					messageCount: 4,
					phase: "teach",
					pendingQuestion: false,
					pendingProblem: false,
					busy: false,
					compacting: false,
				},
				active: false,
				onOpen: () => {},
				onContextMenu: () => {},
			}),
		);
		assert.ok(html.includes('data-testid="session-actions-chat_mobile_1"'), "must render visible mobile actions button");
		assert.ok(html.includes('aria-label="Session actions for Linear Algebra"'));
	});

	it("renders a touch-accessible action button on SidebarFolderRow", () => {
		const html = renderToStaticMarkup(
			createElement(SidebarFolderRow, {
				folder: { id: "folder_1", name: "Math", parentId: null, createdAt: "2026-11-27T00:00:00.000Z" },
				depth: 0,
				open: false,
				dropActive: false,
				renaming: false,
				draggable: true,
				onToggle: () => {},
				onContextMenu: () => {},
				onRename: async () => {},
				onRenameDone: () => {},
			}),
		);
		assert.ok(html.includes('data-testid="sidebar-folder-actions-folder_1"'));
		assert.ok(html.includes('aria-label="Folder actions for Math"'));
	});
});

describe("P1-1 & P1-2: mobile Settings plugins access, responsive ThemeCards, and 16px anti-zoom", () => {
	it("includes core-plugins, plugins, and enabled plugins in mobile settings-section-select with text-base anti-zoom", () => {
		const html = renderToStaticMarkup(
			createElement(
				PluginsContext.Provider,
				{
					value: {
						snapshot: {
							loading: false,
							plugins: [
								{
									info: {
										id: "demo-plugin",
										name: "Demo Plugin",
										version: "1.0.0",
										origin: "community",
										enabled: true,
										compatible: true,
										state: "active",
										capabilities: [],
										installPath: "/tmp/demo",
									},
									settings: [],
								} as never,
							],
						} as never,
						manager: null,
						refresh: async () => {},
					} as never,
				},
				createElement(SettingsDialogBody, { onClose: () => {} }),
			),
		);
		const selectMatch = html.match(/<select[^>]*data-testid="settings-section-select"[^>]*>[\s\S]*?<\/select>/);
		assert.ok(selectMatch, "mobile settings section select must render");
		const selectHtml = selectMatch[0]!;
		assert.ok(selectHtml.includes('value="core-plugins"'), "mobile select must expose core-plugins");
		assert.ok(selectHtml.includes('value="plugins"'), "mobile select must expose community plugins");
		assert.ok(selectHtml.includes('value="plugin:demo-plugin"'), "mobile select must expose enabled plugin sections");
		assert.ok(selectHtml.includes("text-base"), "mobile select must use >=16px text-base to avoid iOS zoom");
	});

	it("ThemeCards uses responsive mobile-first grid instead of fixed grid-cols-3", () => {
		const html = renderToStaticMarkup(
			createElement(ThemeCards, {
				themes: BUILTIN_THEMES,
				active: BUILTIN_THEMES[0]!,
				appearance: undefined,
				onSelect: () => {},
				onRemoved: () => {},
				onImported: () => {},
			}),
		);
		assert.ok(html.includes("grid-cols-1"), "ThemeCards must not squeeze 3 columns on narrow phones");
		assert.ok(html.includes("md:grid-cols-3"), "ThemeCards keeps 3 columns on desktop");
	});
});
