import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "../components/composer.tsx";
import type { Dictation } from "../components/dictation.tsx";
import {
	clearOpeningImages,
	preparePendingImages,
	readOpeningImages,
	sniffImageMime,
	stashOpeningImages,
	type PendingImage,
} from "../components/mobile-image-attachments.tsx";
import {
	formatProviderName,
	groupModelsByProvider,
	MobileSessionSheetBody,
} from "../components/mobile-session-sheet.tsx";
import { SettingsDialogBody } from "../components/settings/settings-dialog.tsx";
import { PluginsContext } from "../components/plugins.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import { ReadingThinkingField } from "../components/reading-thinking.tsx";
import { applyVisualViewportToRoot, computeVisualViewportMetrics } from "../components/visual-viewport.tsx";
import type { ModelCatalogEntry } from "../src/core/index.ts";

function makeDictation(overrides: Partial<Dictation> = {}): Dictation {
	return {
		phase: "idle",
		destinationId: "main",
		active: false,
		blocked: false,
		error: null,
		levelRef: { current: 0 },
		toggle: () => {},
		toggleFor: () => {},
		stop: () => {},
		finish: async () => {},
		finishFor: async () => {},
		cancel: () => {},
		clearError: () => {},
		...overrides,
	};
}

const SAMPLE_MODELS: ModelCatalogEntry[] = [
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		provider: "anthropic",
		reasoning: true,
		supportedLevels: ["low", "medium", "high"],
		contextWindow: 200_000,
		maxTokens: 16_384,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		provider: "chatgpt",
		reasoning: true,
		supportedLevels: ["low", "medium", "high", "xhigh"],
		contextWindow: 272_000,
		maxTokens: 32_768,
		input: ["text", "image"],
		cost: null,
	},
	{
		id: "gpt-5.4-mini",
		name: "GPT-5.4 Mini",
		provider: "chatgpt",
		reasoning: true,
		supportedLevels: ["low", "medium", "high"],
		contextWindow: 272_000,
		maxTokens: 32_768,
		input: ["text", "image"],
		cost: null,
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		provider: "google",
		reasoning: true,
		supportedLevels: ["low", "medium", "high"],
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		input: ["text", "image"],
		cost: { input: 1.25, output: 10, cacheRead: 0.3, cacheWrite: 0 },
	},
];

describe("Mobile image attachments (magic-byte sniffing, batch prep, opening handover)", () => {
	it("sniffs JPEG, PNG, WebP, GIF magic bytes and rejects non-images", () => {
		assert.equal(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
		assert.equal(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
		assert.equal(
			sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
			"image/webp",
		);
		assert.equal(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), "image/gif");
		assert.equal(sniffImageMime(new Uint8Array([0x25, 0x50, 0x44, 0x46])), null);
	});

	it("accepts valid images directly, enforces max count, and rejects unsupported files cleanly", async () => {
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
		const pngFile = new File([pngBytes], "diagram.png", { type: "image/png" });
		const txtFile = new File(["hello"], "notes.txt", { type: "text/plain" });

		const ok = await preparePendingImages([pngFile], 0);
		assert.equal(ok.added.length, 1);
		assert.equal(ok.error, null);
		assert.equal(ok.added[0]!.image.mimeType, "image/png");
		assert.equal(ok.added[0]!.image.type, "image");
		assert.ok(ok.added[0]!.image.data.length > 0);

		const bad = await preparePendingImages([txtFile], 0);
		assert.equal(bad.added.length, 0);
		assert.match(bad.error ?? "", /Unsupported file/);

		const capped = await preparePendingImages([pngFile, pngFile], 3, 4);
		assert.equal(capped.added.length, 1);
		assert.match(capped.error ?? "", /Attached first 1 of 2 images/);

		const full = await preparePendingImages([pngFile], 4, 4);
		assert.equal(full.added.length, 0);
		assert.match(full.error ?? "", /Up to 4 images/);
	});

	it("stashes, reads, and clears opening images via sessionStorage", () => {
		const store = new Map<string, string>();
		const prev = (globalThis as { sessionStorage?: Storage }).sessionStorage;
		(globalThis as { sessionStorage?: Storage }).sessionStorage = {
			get length() { return store.size; },
			clear: () => store.clear(),
			key: (i: number) => Array.from(store.keys())[i] ?? null,
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => { store.set(k, v); },
			removeItem: (k: string) => { store.delete(k); },
		};
		try {
			const imgs = [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }];
			assert.equal(stashOpeningImages("chat_img_1", imgs), true);
			assert.deepEqual(readOpeningImages("chat_img_1"), imgs);
			clearOpeningImages("chat_img_1");
			assert.deepEqual(readOpeningImages("chat_img_1"), []);
		} finally {
			if (prev === undefined) delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
			else (globalThis as { sessionStorage?: Storage }).sessionStorage = prev;
		}
	});
});

describe("MobileSessionSheet (T3-Code-inspired fullscreen model/options/stats sheet)", () => {
	it("groups models by provider with active provider first and supports fuzzy search", () => {
		assert.equal(formatProviderName("chatgpt"), "ChatGPT");
		assert.equal(formatProviderName("openai-codex"), "ChatGPT");
		assert.equal(formatProviderName("anthropic"), "Anthropic");

		const grouped = groupModelsByProvider(SAMPLE_MODELS, "", "chatgpt");
		assert.deepEqual(grouped.map((g) => g.provider), ["chatgpt", "anthropic", "google"]);
		assert.equal(grouped[0]!.models.length, 2);

		const searched = groupModelsByProvider(SAMPLE_MODELS, "sonnet", "chatgpt");
		assert.equal(searched.length, 1);
		assert.equal(searched[0]!.provider, "anthropic");
		assert.equal(searched[0]!.models[0]!.id, "claude-sonnet-4-5");
	});

	it("renders fullscreen header (✕/✓), Session stats, Options (Thinking + Speed), provider-grouped Models, and 16px anti-zoom search bar", () => {
		const html = renderToStaticMarkup(
			createElement(MobileSessionSheetBody, {
				chatId: "chat_mobile_ux",
				models: SAMPLE_MODELS,
				effectiveId: "gpt-5.4",
				effectiveProvider: "chatgpt",
				effectiveLevel: "high",
				levels: ["low", "medium", "high", "xhigh"],
				speedValue: "fast",
				inheritedSpeed: "standard",
				error: null,
				turns: [],
				contextTokens: 116_700,
				cliContextWindow: null,
				pricing: {
					cost: 0,
					unpriced: 0,
					subscription: 2,
					subscriptionProviders: ["ChatGPT"],
					turnCosts: {},
					turnCount: 2,
					cliBilled: false,
					cacheHitRate: 0.72,
				},
				onPickModel: () => {},
				onPickThinking: () => {},
				onPickSpeed: () => {},
				onClose: () => {},
			}),
		);

		assert.ok(html.includes('data-testid="mobile-session-sheet"'));
		assert.ok(html.includes('data-testid="mobile-session-sheet-close"'));
		assert.ok(html.includes('data-testid="mobile-session-sheet-done"'));
		assert.ok(html.includes("Session settings"));
		assert.ok(html.includes('data-testid="mobile-session-stats"'));
		assert.ok(html.includes("116.7k / 272k"), `expected formatted context measurement, got: ${html}`);
		assert.ok(html.includes("72.0%"), "expected cache hit rate");
		assert.ok(html.includes('data-testid="mobile-option-thinking"'));
		assert.ok(html.includes('data-testid="mobile-option-speed"'));
		assert.ok(html.includes('data-testid="mobile-model-option-gpt-5_4"'));
		const searchTag = html.match(/<input[^>]*data-testid="mobile-model-search"[^>]*>/)?.[0] ?? "";
		assert.ok(searchTag.includes("text-base"), `mobile model search must use >=16px text-base, got: ${searchTag}`);
	});
});

describe("Single-row mobile composer pill + inline dictation + fullscreen overlays", () => {
	it("renders single-row 48px mobile pill with left + attach, model trigger, mic, and send; swaps input in-place during dictation", () => {
		const idleHtml = renderToStaticMarkup(
			createElement(Composer, {
				busy: false,
				value: "",
				onChange: () => {},
				onSend: () => {},
				onStop: () => {},
				canSend: false,
				dictation: makeDictation(),
				mobileSessionControl: createElement("button", { type: "button", "data-testid": "mock-mobile-model" }, "M"),
				onAttachImages: () => {},
				onRemoveImage: () => {},
				pendingImages: [],
			}),
		);
		assert.ok(idleHtml.includes('data-mobile-pill="true"'));
		assert.ok(idleHtml.includes("max-md:min-h-12"), "mobile pill must be compact 48px height");
		assert.ok(idleHtml.includes('data-testid="mobile-attach-button"'), "mobile web pill must expose + image attach button");
		assert.ok(idleHtml.includes('data-testid="mock-mobile-model"'));
		assert.ok(idleHtml.includes('data-testid="mobile-dictation-toggle"'));
		assert.ok(!idleHtml.includes('data-testid="mobile-dictation-indicator"'), "recording indicator stays hidden while idle");

		const recordingHtml = renderToStaticMarkup(
			createElement(Composer, {
				busy: false,
				value: "",
				onChange: () => {},
				onSend: () => {},
				onStop: () => {},
				canSend: true,
				dictation: makeDictation({ phase: "recording", active: true }),
				mobileSessionControl: createElement("button", { type: "button", "data-testid": "mock-mobile-model" }, "M"),
				onAttachImages: () => {},
				onRemoveImage: () => {},
				pendingImages: [],
			}),
		);
		assert.ok(recordingHtml.includes('data-recording="true"'));
		assert.ok(recordingHtml.includes('data-testid="mobile-dictation-indicator"'), "active dictation must render inline indicator inside the pill");
		assert.ok(recordingHtml.includes("Recording…"), "inline dictation should show compact status label");
		assert.ok(!recordingHtml.includes('data-testid="mobile-attach-button"'), "attach button hides during active recording");
		assert.ok(!recordingHtml.includes('data-testid="mock-mobile-model"'), "model trigger hides during active recording");

		const pendingImages: PendingImage[] = [
			{ id: "p1", name: "photo.png", image: { type: "image", mimeType: "image/png", data: "AAAA" } },
		];
		const withImageHtml = renderToStaticMarkup(
			createElement(Composer, {
				busy: false,
				value: "",
				onChange: () => {},
				onSend: () => {},
				onStop: () => {},
				canSend: true,
				dictation: makeDictation(),
				onAttachImages: () => {},
				onRemoveImage: () => {},
				pendingImages,
			}),
		);
		assert.ok(withImageHtml.includes('data-testid="pending-image-strip"'));
		assert.ok(withImageHtml.includes('data-testid="remove-pending-image-p1"'));
	});

	it("keeps Settings, Setup, and mobile Sidebar 100% fullscreen and TopBar 48px on mobile", () => {
		const settingsHtml = renderToStaticMarkup(
			createElement(
				PluginsContext.Provider,
				{ value: { snapshot: { loading: false, plugins: [] }, manager: null, refresh: async () => {} } as never },
				createElement(SettingsDialogBody, { onClose: () => {} }),
			),
		);
		assert.ok(settingsHtml.includes("max-md:w-full") && settingsHtml.includes("max-md:h-full"), "Settings must be 100% fullscreen on mobile");
		assert.ok(settingsHtml.includes("max-md:rounded-none"), "Settings must be edge-to-edge on mobile");

		const sidebarSrc = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");
		assert.ok(sidebarSrc.includes('"fixed inset-0 z-40 w-full"'), "Mobile sidebar overlay must occupy 100% width and height");

		const setupSrc = readFileSync(new URL("../components/setup-dialog.tsx", import.meta.url), "utf8");
		assert.ok(setupSrc.includes("max-md:h-full max-md:max-h-none max-md:w-full max-md:max-w-none"), "Setup dialog must be 100% fullscreen on mobile");

		const topBarSrc = readFileSync(new URL("../components/top-bar.tsx", import.meta.url), "utf8");
		assert.ok(topBarSrc.includes("h-12 md:h-15"), "TopBar must compact to 48px on mobile while keeping 60px on desktop");

		const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
		assert.ok(css.includes("height: calc(3rem + env(safe-area-inset-top, 0px))"), "globals.css must set 48px + safe-area-top on mobile TopBar");
		assert.ok(css.includes("[data-mobile-placeholder][data-empty=\"true\"]::before"), "globals.css must keep mobile placeholder single-line");
		assert.ok(css.includes('html[data-keyboard-open="true"] .lh-app-root'), "globals.css must pin .lh-app-root to --vv-top when iOS keyboard opens");
		assert.ok(css.includes('html[data-short-viewport="true"] [data-testid="question-dock"] [contenteditable]'), "globals.css must keep QuestionDock editable compact when iOS keyboard shrinks visualViewport");
	});

	it("tracks --vv-top on iOS keyboard pan and clears it on close to prevent black screen void", () => {
		const props = new Map<string, string>();
		const dataset: Record<string, string | undefined> = {};
		const fakeRoot = {
			style: {
				setProperty: (k: string, v: string) => { props.set(k, v); },
				removeProperty: (k: string) => { props.delete(k); },
			},
			dataset,
		} as unknown as HTMLElement;

		// iOS pans visualViewport.offsetTop downward when focusing bottom "Your thinking"
		const panned = computeVisualViewportMetrics({
			innerWidth: 390,
			innerHeight: 844,
			visualViewport: { width: 390, height: 450, offsetTop: 350, offsetLeft: 0, scale: 1 },
		});
		applyVisualViewportToRoot(fakeRoot, panned);
		assert.equal(props.get("--vvh"), "450px");
		assert.equal(props.get("--vv-top"), "350px");
		assert.equal(dataset.keyboardOpen, "true");

		// Overscroll beyond keyboardInset is clamped cleanly
		const overscrolled = computeVisualViewportMetrics({
			innerWidth: 390,
			innerHeight: 844,
			visualViewport: { width: 390, height: 450, offsetTop: 440, offsetLeft: 0, scale: 1 },
		});
		applyVisualViewportToRoot(fakeRoot, overscrolled);
		assert.equal(props.get("--vv-top"), "394px");

		// Keyboard closes → --vvh and --vv-top both removed
		const closed = computeVisualViewportMetrics({
			innerWidth: 390,
			innerHeight: 844,
			visualViewport: { width: 390, height: 797, offsetTop: 0, offsetLeft: 0, scale: 1 },
		});
		applyVisualViewportToRoot(fakeRoot, closed);
		assert.equal(props.has("--vvh"), false);
		assert.equal(props.has("--vv-top"), false);
		assert.equal(dataset.keyboardOpen, undefined);
	});

	it("renders explicit Hide collapse and built-in mobile dictation on QuestionDock, ReadingThinkingField, and PracticeDock", () => {
		const qIdleHtml = renderToStaticMarkup(
			createElement(QuestionDock, {
				toolName: "quiz",
				toolCallId: "call_q1",
				input: {
					question: "Which invariant holds?",
					options: [{ label: "A" }, { label: "B" }],
					correctAnswer: "A",
					explanation: "Because A.",
				},
				expanded: true,
				onExpand: () => {},
				onCollapse: () => {},
				dictation: makeDictation(),
				onSubmit: () => {},
			}),
		);
		assert.ok(qIdleHtml.includes('data-testid="question-dock-collapse"'), "expanded QuestionDock must expose Hide collapse button");
		assert.ok(qIdleHtml.includes('data-testid="question-dictation-toggle"'), "QuestionDock must expose built-in mobile mic button");
		assert.ok(qIdleHtml.includes('data-mobile-pill="true"') && qIdleHtml.includes("max-md:rounded-[24px]") && qIdleHtml.includes("max-md:min-h-12"), "QuestionDock thinking field must match unified 48px mobile pill");
		assert.ok(qIdleHtml.includes('data-mobile-placeholder="Your thinking…"'), "QuestionDock thinking field must use compact mobile placeholder");

		const qRecHtml = renderToStaticMarkup(
			createElement(QuestionDock, {
				toolName: "quiz",
				toolCallId: "call_q1",
				input: {
					question: "Which invariant holds?",
					options: [{ label: "A" }, { label: "B" }],
					correctAnswer: "A",
					explanation: "Because A.",
				},
				expanded: true,
				onExpand: () => {},
				onCollapse: () => {},
				dictation: makeDictation({ phase: "recording", active: true }),
				onSubmit: () => {},
			}),
		);
		assert.ok(qRecHtml.includes('data-testid="question-dictation-indicator"'), "QuestionDock must show inline recording indicator when active");

		const readingIdleHtml = renderToStaticMarkup(
			createElement(ReadingThinkingField, {
				value: "",
				revision: 0,
				onChange: () => {},
				claim: true,
				dictation: makeDictation(),
			}),
		);
		assert.ok(readingIdleHtml.includes('data-testid="reading-dictation-toggle"'), "ReadingThinkingField must expose built-in mobile mic button");
		assert.ok(readingIdleHtml.includes('data-mobile-pill="true"') && readingIdleHtml.includes("max-md:rounded-[24px]") && readingIdleHtml.includes("max-md:min-h-12"), "ReadingThinkingField must match unified 48px mobile pill");
		assert.ok(readingIdleHtml.includes('data-mobile-placeholder="Thinking while reading…"'), "ReadingThinkingField must use compact mobile placeholder");

		const readingRecHtml = renderToStaticMarkup(
			createElement(ReadingThinkingField, {
				value: "",
				revision: 0,
				onChange: () => {},
				claim: true,
				dictation: makeDictation({ phase: "recording", active: true }),
			}),
		);
		assert.ok(readingRecHtml.includes('data-testid="reading-dictation-indicator"'), "ReadingThinkingField must show inline recording indicator when active");

		const practiceHtml = renderToStaticMarkup(
			createElement(PracticeDock, {
				problemCallId: "p_1",
				input: { statement: "Solve x + 1 = 2" },
				expanded: true,
				onExpand: () => {},
				onCollapse: () => {},
				dictation: makeDictation(),
				onSubmit: () => {},
			}),
		);
		assert.ok(practiceHtml.includes('data-testid="practice-dock-collapse"'), "PracticeDock must expose Hide collapse button");
		assert.ok(practiceHtml.includes('data-testid="practice-dictation-toggle"'), "PracticeDock must expose built-in mobile mic button");
		assert.ok(practiceHtml.includes('data-mobile-pill="true"') && practiceHtml.includes("max-md:min-h-12"), "PracticeDock thinking field must match unified 48px mobile pill");
	});
});
