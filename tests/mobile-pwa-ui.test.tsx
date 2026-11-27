import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { computeMenuPlacement } from "../components/menu-shell.tsx";
import { applyVisualViewportToRoot, computeVisualViewportMetrics } from "../components/visual-viewport.tsx";
import { SessionRow, RenameRow } from "../components/sidebar.tsx";
import { SidebarFolderRow, sidebarNameFont } from "../components/sidebar-folders.tsx";
import { EditableSourceName } from "../components/source-folder-tree.tsx";
import { ThemeCards } from "../components/settings/theme-cards.tsx";
import { AppearanceSection } from "../components/settings/appearance-section.tsx";
import { AgentSection } from "../components/settings/agent-section.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { ConnectionRow } from "../components/settings/connection-controls.tsx";
import { SpeedControl } from "../components/settings/speed-menu.tsx";
import { PromptText } from "../components/settings/prompt-text.tsx";
import { StatsBar } from "../components/stats-bar.tsx";
import { DeleteSessionBody } from "../components/delete-session-dialog.tsx";
import { PhaseChip } from "../components/phase-divider.tsx";
import { CitationCommentEditor } from "../components/citation-comment-editor.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { PluginsContext } from "../components/plugins.tsx";
import { BUILTIN_THEMES } from "../src/core/index.ts";

function makeFakeRoot() {
	const props = new Map<string, string>();
	const dataset: Record<string, string | undefined> = {};
	return {
		props,
		dataset,
		el: {
			style: {
				setProperty: (k: string, v: string) => { props.set(k, v); },
				removeProperty: (k: string) => { props.delete(k); },
			},
			dataset,
		} as unknown as HTMLElement,
	};
}

describe("P0-5 & R2 P1-1: visualViewport metrics, iOS standalone --vvh policy, and MenuShell placement", () => {
	it("computes keyboardInset and isShortViewport when iOS keyboard shrinks visualViewport (even when iOS pans offsetTop)", () => {
		const m = computeVisualViewportMetrics({
			innerWidth: 390,
			innerHeight: 844,
			visualViewport: { width: 390, height: 472, offsetTop: 12, offsetLeft: 0, scale: 1 },
		});
		assert.equal(m.height, 472);
		assert.equal(m.keyboardInset, 372);
		assert.equal(m.isShortViewport, true);
		assert.equal(m.isKeyboardOpen, true);

		// iOS Safari pans visualViewport.offsetTop downward to keep a bottom composer/QuestionDock
		// in view — keyboardInset must stay >= 100 so --vvh is NOT dropped mid-typing.
		const panned = computeVisualViewportMetrics({
			innerWidth: 390,
			innerHeight: 844,
			visualViewport: { width: 390, height: 500, offsetTop: 290, offsetLeft: 0, scale: 1 },
		});
		assert.equal(panned.isKeyboardOpen, true);
		assert.equal(panned.keyboardInset, 344);

		// Pinch-zoom shrinks visualViewport.height with scale > 1 — must NOT trigger keyboard mode.
		const zoomed = computeVisualViewportMetrics({
			innerWidth: 390,
			innerHeight: 844,
			visualViewport: { width: 195, height: 422, offsetTop: 0, offsetLeft: 0, scale: 2 },
		});
		assert.equal(zoomed.isKeyboardOpen, false);

		const desktop = computeVisualViewportMetrics({
			innerWidth: 1440,
			innerHeight: 900,
			visualViewport: { width: 1440, height: 900, offsetTop: 0, offsetLeft: 0, scale: 1 },
		});
		assert.equal(desktop.keyboardInset, 0);
		assert.equal(desktop.isShortViewport, false);
		assert.equal(desktop.isKeyboardOpen, false);
	});

	it("removes --vvh and keeps --keyboard-inset=0px when keyboard is closed in iOS standalone PWA (844 vs 797)", () => {
		const root = makeFakeRoot();
		// Keyboard opens first → --vvh is set
		const openMetrics = computeVisualViewportMetrics({
			innerWidth: 390,
			innerHeight: 844,
			visualViewport: { width: 390, height: 472, offsetTop: 12, offsetLeft: 0 },
		});
		applyVisualViewportToRoot(root.el, openMetrics);
		assert.equal(root.props.get("--vvh"), "472px");
		assert.equal(root.props.get("--keyboard-inset"), "372px");
		assert.equal(root.dataset.keyboardOpen, "true");
		assert.equal(root.dataset.shortViewport, "true");

		// Keyboard closes in iOS 26.6.2 standalone PWA: visualViewport reports 797px (844 - 47px safe-area-top)
		const standaloneRest = computeVisualViewportMetrics({
			innerWidth: 390,
			innerHeight: 844,
			visualViewport: { width: 390, height: 797, offsetTop: 0, offsetLeft: 0 },
		});
		assert.equal(standaloneRest.isKeyboardOpen, false);
		applyVisualViewportToRoot(root.el, standaloneRest);
		assert.equal(root.props.has("--vvh"), false, "--vvh must be removed when keyboard is closed so standalone PWA uses full 100vh");
		assert.equal(root.props.get("--keyboard-inset"), "0px");
		assert.equal(root.dataset.keyboardOpen, undefined);
		assert.equal(root.dataset.shortViewport, undefined);
	});

	it("pins standalone .lh-app-root to fixed inset-0 with --lh-app-height: 100% and floating-header safe-area rules in globals.css + new-session.tsx", () => {
		const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
		assert.ok(css.includes("--lh-app-height: 100dvh"), "globals.css must declare default --lh-app-height: 100dvh");
		assert.match(css, /@media\s*\(display-mode:\s*standalone\)[\s\S]*\.lh-app-root\s*\{[\s\S]*position:\s*fixed;[\s\S]*inset:\s*0;[\s\S]*--lh-app-height:\s*100%/, "standalone PWA must pin .lh-app-root to fixed inset-0 with --lh-app-height: 100%");
		assert.match(css, /html\[data-keyboard-open="true"\]\s*\.lh-app-root\s*\{[\s\S]*bottom:\s*auto;/, "keyboard-open .lh-app-root must clear bottom: auto so --vvh controls height");
		assert.ok(css.includes("var(--vvh, var(--lh-app-height, 100dvh))"), "surfaces must fall back through --lh-app-height");
		assert.ok(css.includes("html:not(.lh-electron) .lh-floating-header"), "floating header safe-area rule must exist for /chat/new");

		const newSessionSrc = readFileSync(new URL("../components/new-session.tsx", import.meta.url), "utf8");
		assert.ok(newSessionSrc.includes("lh-floating-header"), "DraftShell header must apply lh-floating-header for iOS status-bar clearance");
		assert.ok(newSessionSrc.includes("var(--vvh,var(--lh-app-height,100dvh))"), "DraftShell root must use shared app height token");
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

describe("R2 P1-4, P2-2, P2-5, P2-6: Settings overflow, >=16px inputs, touch targets, code scroll hint, and 409 Delete UX", () => {
	it("P1-4: AppearanceSection colors grid stacks to 1 column on phones and avoids horizontal overflow", () => {
		const html = renderToStaticMarkup(
			createElement(
				InteractionLayersProvider,
				null,
				createElement(AppearanceSection, {
					appearance: undefined,
					onSectionChange: async () => true,
				}),
			),
		);
		assert.ok(html.includes("grid-cols-1 gap-y-2 sm:grid-cols-2 sm:gap-x-10"), "color overrides grid must stack on narrow phones");
		assert.ok(!html.includes('class="grid grid-cols-2 gap-x-10 gap-y-2"'), "must not keep fixed 2-col grid on mobile");
	});

	it("P1-4: AgentSection folder input, EditableSourceName, compact RenameRow, CitationCommentEditor, PromptText use >=16px text-base on mobile", () => {
		const agentHtml = renderToStaticMarkup(
			createElement(
				InteractionLayersProvider,
				null,
				createElement(AgentSection, {
					agent: undefined,
					models: undefined,
					graph: undefined,
					compaction: undefined,
					onSectionChange: async () => true,
					onModelsChange: () => {},
					onCompactionChange: async () => true,
				}),
			),
		);
		const folderInput = agentHtml.match(/<input[^>]*data-testid="file-access-add"[^>]*>/)?.[0] ?? "";
		assert.ok(folderInput.includes("text-base"), `file-access-add must use text-base, got: ${folderInput}`);

		const editableHtml = renderToStaticMarkup(
			createElement(EditableSourceName, {
				name: "Folder A",
				initiallyEditing: true,
				inputClassName: sidebarNameFont(true),
				onSave: async () => {},
			}),
		);
		const editableInput = editableHtml.match(/<input[^>]*data-testid="source-name-input"[^>]*>/)?.[0] ?? "";
		assert.ok(editableInput.includes("text-base"), `EditableSourceName must keep text-base even in compact mode, got: ${editableInput}`);
		assert.ok(!/\b(?<!md:)text-sm\b/.test(editableInput), `EditableSourceName must not have bare text-sm overriding text-base: ${editableInput}`);

		const renameHtml = renderToStaticMarkup(
			createElement(RenameRow, {
				chat: {
					id: "c1",
					title: "Session 1",
					kind: "teach",
					createdAt: "2026-11-27T00:00:00.000Z",
					updatedAt: "2026-11-27T00:00:00.000Z",
					messageCount: 1,
					phase: "probe",
					pendingQuestion: false,
					pendingProblem: false,
					busy: false,
					compacting: false,
				},
				compact: true,
				onCommit: () => {},
				onCancel: () => {},
			}),
		);
		const renameInput = renameHtml.match(/<input[^>]*data-testid="session-rename-input"[^>]*>/)?.[0] ?? "";
		assert.ok(renameInput.includes("text-base"), `compact RenameRow must keep text-base, got: ${renameInput}`);
		assert.ok(!/\b(?<!md:)text-sm\b/.test(renameInput), `compact RenameRow must not override text-base with bare text-sm: ${renameInput}`);

		const citationHtml = renderToStaticMarkup(
			createElement(CitationCommentEditor, {
				initial: "",
				onDraftChange: () => {},
				onSave: () => {},
				onCancel: () => {},
			}),
		);
		assert.ok(citationHtml.includes("text-base"), "CitationCommentEditor textarea must use text-base on mobile");

		const promptHtml = renderToStaticMarkup(
			createElement(PromptText, {
				text: "hello",
				preview: false,
				fieldRef: { current: null },
			}),
		);
		assert.ok(promptHtml.includes("text-base") && promptHtml.includes("md:text-xs"), "PromptText must use text-base on mobile and md:text-xs on desktop");
	});

	it("P2-2: iOS select uses explicit h-10 and mobile touch targets meet >=36px on max-md", () => {
		const settingsHtml = renderToStaticMarkup(
			createElement(
				PluginsContext.Provider,
				{ value: { snapshot: { loading: false, plugins: [] }, manager: null, refresh: async () => {} } as never },
				createElement(SettingsDialogBody, { onClose: () => {} }),
			),
		);
		const selectTag = settingsHtml.match(/<select[^>]*data-testid="settings-section-select"[^>]*>/)?.[0] ?? "";
		assert.ok(/\bh-10\b/.test(selectTag) && !selectTag.includes("min-h-10"), `settings-section-select must use explicit h-10 for iOS WebKit, got: ${selectTag}`);
		const closeBtn = settingsHtml.match(/<button[^>]*data-testid="settings-close"[^>]*>/)?.[0] ?? "";
		assert.ok(closeBtn.includes("max-md:size-10"), `settings-close must expand on mobile, got: ${closeBtn}`);

		const statsHtml = renderToStaticMarkup(
			createElement(
				InteractionLayersProvider,
				null,
				createElement(StatsBar, { chatId: "chat_1", turns: [] }),
			),
		);
		const summaryBtn = statsHtml.match(/<button[^>]*data-testid="stats-summary"[^>]*>/)?.[0] ?? "";
		assert.ok(summaryBtn.includes("max-md:min-h-9"), `stats-summary needs mobile touch height, got: ${summaryBtn}`);

		const speedHtml = renderToStaticMarkup(
			createElement(SpeedControl, {
				provider: "chatgpt",
				modelId: "gpt-5.4",
				value: "fast",
				testid: "stats-speed",
				compact: true,
				onPick: () => {},
			}),
		);
		assert.ok(speedHtml.includes("max-md:min-h-9"), `compact SpeedControl needs mobile touch height, got: ${speedHtml}`);

		const connHtml = renderToStaticMarkup(
			createElement(ConnectionRow, {
				label: "ChatGPT",
				action: "Manage…",
				disabled: false,
				onAction: () => {},
			}),
		);
		assert.ok(connHtml.includes("max-md:min-h-9"), `ConnectionRow button needs mobile touch height, got: ${connHtml}`);
	});

	it("P2-5: code blocks get horizontal scroll affordance and mobile chat TopBar compacts cleanly", () => {
		const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
		assert.ok(css.includes("--lh-code-well") && css.includes("scrollbar-width: thin"), "code-block-body must provide scroll-shadow + thin scrollbar affordance");
		assert.ok(css.includes("font-size: max(16px, var(--lh-prose-size))"), ".lh-input must enforce >=16px on mobile without utility classes");

		const phaseHtml = renderToStaticMarkup(createElement(PhaseChip, { phase: "teach" }));
		assert.ok(phaseHtml.includes("text-xs") && !phaseHtml.includes("text-[10px]"), `PhaseChip must follow typography scale without text-[Npx], got: ${phaseHtml}`);

		const topBarSrc = readFileSync(new URL("../components/top-bar.tsx", import.meta.url), "utf8");
		assert.ok(topBarSrc.includes("gap-1.5 sm:gap-3"), "TopBar should tighten gap on narrow phones");
	});

	it("StatsBar prefers fresh pricing summary over stale turns after tail settle", () => {
		const html = renderToStaticMarkup(
			createElement(
				InteractionLayersProvider,
				null,
				createElement(StatsBar, {
					chatId: "chat_1",
					turns: [{
						id: "t1",
						messageId: "m1",
						at: "2026-11-27T00:00:00.000Z",
						model: "anthropic:claude-sonnet-4-5",
						steps: [],
					}],
					pricing: {
						cost: 0.1234,
						unpriced: 0,
						subscription: 0,
						subscriptionProviders: [],
						turnCosts: {},
						turnCount: 2,
						cliBilled: false,
						cacheHitRate: 0.5,
					},
				}),
			),
		);
		assert.ok(html.includes("$0.12"), `StatsBar must display fresh pricing cost when turns array is stale, got: ${html}`);
	});

	it("P2-6: DeleteSessionBody shows Stop active turn action alongside Try again on 409 turn_in_flight", () => {
		const html = renderToStaticMarkup(
			createElement(DeleteSessionBody, {
				chat: { id: "chat_busy", title: "Busy session" },
				traces: false,
				busy: false,
				failure: { code: "turn_in_flight", error: "A turn is running in this session — try again when it finishes" },
				onTraces: () => {},
				onClose: () => {},
				onRun: () => {},
				onStopTurn: () => {},
			}),
		);
		assert.ok(html.includes('data-testid="delete-failure"'));
		assert.ok(html.includes('data-testid="delete-stop-turn"'), "must offer Stop active turn on turn_in_flight 409");
		assert.ok(html.includes('data-testid="delete-retry"'), "must keep Try again button");
		const cancelBtn = html.match(/<button[^>]*data-testid="delete-cancel"[^>]*>/)?.[0] ?? "";
		assert.ok(cancelBtn.includes("max-md:min-h-10"), "Cancel button must meet mobile touch target size");
	});
});

describe("R2 P1-5 & P2-4: Show earlier scroll anchor, unified group counter, and sidebar turn refresh coalescing", () => {
	it("P1-5: computeAnchorScrollTop preserves the exact viewport offset of the anchor row after prepending earlier rows", async () => {
		const chatMod = await import("../components/chat.tsx");
		assert.equal(typeof chatMod.computeAnchorScrollTop, "function");
		assert.equal(typeof chatMod.formatEarlierMessagesCount, "function");

		// Before clicking Show earlier: scroller at top=60, scrollTop=12, anchor row at top=96 (offset +36 inside scroller)
		// After prepending 40 rows: anchor row moved down to top=1896 (offset +1836 inside scroller)
		const nextTop = chatMod.computeAnchorScrollTop({
			currentScrollTop: 12,
			anchorTopBefore: 96,
			scrollerTopBefore: 60,
			anchorTopAfter: 1896,
			scrollerTopAfter: 60,
		});
		assert.equal(nextTop, 1812, "scrollTop must advance by exact anchor delta (+1800px)");

		// Never returns negative scrollTop
		assert.equal(
			chatMod.computeAnchorScrollTop({
				currentScrollTop: 0,
				anchorTopBefore: 100,
				scrollerTopBefore: 60,
				anchorTopAfter: 80,
				scrollerTopAfter: 60,
			}),
			0,
		);

		// Unified view-group counter never mixes raw native toolResult counts with view groups
		assert.equal(
			chatMod.formatEarlierMessagesCount({
				localHiddenGroups: 5,
				serverOmittedGroups: 42,
				hasEarlierMessages: true,
			}),
			"47 earlier",
		);
		assert.equal(
			chatMod.formatEarlierMessagesCount({
				localHiddenGroups: 0,
				serverOmittedGroups: 42,
				hasEarlierMessages: true,
			}),
			"42 earlier",
		);
		assert.equal(
			chatMod.formatEarlierMessagesCount({
				localHiddenGroups: 3,
				serverOmittedGroups: 0,
				hasEarlierMessages: false,
			}),
			"3 earlier",
		);
	});

	it("P2-4: sidebar turn event coalescing avoids duplicate GET /api/chats on local turn start and settle", async () => {
		const sidebarMod = await import("../components/sidebar.tsx");
		assert.equal(typeof sidebarMod.shouldSkipTurnStartedRefresh, "function");
		assert.equal(typeof sidebarMod.shouldSkipTurnSettledRefresh, "function");

		const chats = [{ id: "c1", busy: true }, { id: "c2", busy: false }];
		assert.equal(sidebarMod.shouldSkipTurnStartedRefresh(chats, "c1"), true, "already optimistically busy → skip duplicate GET");
		assert.equal(sidebarMod.shouldSkipTurnStartedRefresh(chats, "c2"), false, "other idle chat started → must refresh");
		assert.equal(sidebarMod.shouldSkipTurnStartedRefresh(chats, "c3"), false, "unknown new chat → must refresh");

		assert.equal(
			sidebarMod.shouldSkipTurnSettledRefresh({ chatId: "c1", at: 10_000 }, "c1", 10_400),
			true,
			"turn-settled right after lh:turn-state settle refresh → skip duplicate GET",
		);
		assert.equal(
			sidebarMod.shouldSkipTurnSettledRefresh({ chatId: "c1", at: 10_000 }, "c2", 10_400),
			false,
			"different chat settled → must refresh",
		);
		assert.equal(
			sidebarMod.shouldSkipTurnSettledRefresh({ chatId: "c1", at: 10_000 }, "c1", 12_500),
			false,
			"later turn settled after coalesce window → must refresh",
		);
	});
});
