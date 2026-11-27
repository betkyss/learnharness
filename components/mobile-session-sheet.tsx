"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, SearchIcon, SparklesIcon, XIcon } from "lucide-react";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	CLAUDE_CODE_PROVIDER,
	fuzzyScore,
	resolveModelSpeed,
	sessionCacheHitRate,
	subscriptionLabel,
	subscriptionLabels,
	supportedModelSpeeds,
	type cliContextWindowOf,
	type ModelCatalogEntry,
	type ModelSpeed,
	type SessionPricing,
	type TurnUsage,
} from "@/src/core";
import { HostDialog } from "@/components/host-dialog";
import { catalogLimits, useSessionModelState } from "@/components/model-picker";
import { contextLimitForModel, formatContextMeasurement } from "@/components/stats-bar";
import { formatTokens, formatUsd, planCostLabel, prettyModel } from "@/components/usage-format";
import { THINKING_LABEL } from "@/components/thinking-default";
import { SPEED_LABEL } from "@/components/settings/speed-menu";

const PROVIDER_LABELS: Record<string, string> = {
	"openai-codex": "ChatGPT",
	chatgpt: "ChatGPT",
	openai: "OpenAI",
	anthropic: "Anthropic",
	"claude-code": "Claude Code",
	google: "Google",
	openrouter: "OpenRouter",
	xai: "xAI",
	groq: "Groq",
	"github-copilot": "GitHub Copilot",
	custom: "Custom",
};

export function formatProviderName(provider: string): string {
	return PROVIDER_LABELS[provider] ?? provider.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function modelPriceSummary(m: ModelCatalogEntry): string {
	if (m.provider === CLAUDE_CODE_PROVIDER) return "CLI";
	const sub = subscriptionLabel(`${m.provider}:${m.id}`);
	if (sub) return sub;
	if (!m.cost) return "Unpriced";
	const fmt = (n: number) => `$${n < 1 ? n.toFixed(2).replace(/0$/, "") : n.toFixed(2)}`;
	return `${fmt(m.cost.input)}/${fmt(m.cost.output)}`;
}

export interface ProviderModelGroup {
	provider: string;
	label: string;
	models: ModelCatalogEntry[];
}

/** Filter and group catalog models by provider for the T3-Code-style fullscreen mobile sheet. */
export function groupModelsByProvider(
	models: readonly ModelCatalogEntry[] | undefined,
	query: string,
	activeProvider?: string,
): ProviderModelGroup[] {
	if (!models || models.length === 0) return [];
	const trimmed = query.trim();
	const filtered = trimmed
		? models
				.map((m) => ({
					model: m,
					score: fuzzyScore(trimmed, m.name, m.id, m.provider, formatProviderName(m.provider)),
				}))
				.filter((item): item is { model: ModelCatalogEntry; score: number } => item.score !== null)
				.sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id))
				.map((item) => item.model)
		: [...models].sort((a, b) => a.id.localeCompare(b.id));

	const byProvider = new Map<string, ModelCatalogEntry[]>();
	for (const m of filtered) {
		const bucket = byProvider.get(m.provider) ?? [];
		bucket.push(m);
		byProvider.set(m.provider, bucket);
	}

	const groups: ProviderModelGroup[] = Array.from(byProvider.entries()).map(([provider, list]) => ({
		provider,
		label: formatProviderName(provider),
		models: list,
	}));

	groups.sort((a, b) => {
		if (activeProvider && a.provider === activeProvider && b.provider !== activeProvider) return -1;
		if (activeProvider && b.provider === activeProvider && a.provider !== activeProvider) return 1;
		return a.label.localeCompare(b.label);
	});
	return groups;
}

export interface MobileSessionSheetBodyProps {
	chatId?: string;
	title?: string;
	models: readonly ModelCatalogEntry[] | undefined;
	effectiveId: string | undefined;
	effectiveProvider: string | undefined;
	effectiveLevel: ThinkingLevel | undefined;
	levels: readonly string[];
	speedValue: ModelSpeed | undefined;
	inheritedSpeed: ModelSpeed | undefined;
	error: string | null;
	turns: readonly TurnUsage[];
	contextTokens: number | null;
	cliContextWindow: ReturnType<typeof cliContextWindowOf>;
	pricing?: SessionPricing;
	onPickModel: (m: ModelCatalogEntry) => void;
	onPickThinking: (level: ThinkingLevel) => void;
	onPickSpeed: (speed: ModelSpeed | undefined) => void;
	onOpenDetail?: () => void;
	onClose: () => void;
	closeBtnRef?: React.RefObject<HTMLButtonElement | null>;
}

/** Pure fullscreen T3-Code-inspired session settings body (exportable for SSR/unit tests). */
export function MobileSessionSheetBody({
	chatId,
	title,
	models,
	effectiveId,
	effectiveProvider,
	effectiveLevel,
	levels,
	speedValue,
	inheritedSpeed,
	error,
	turns,
	contextTokens,
	cliContextWindow,
	pricing,
	onPickModel,
	onPickThinking,
	onPickSpeed,
	onOpenDetail,
	onClose,
	closeBtnRef,
}: MobileSessionSheetBodyProps) {
	const [query, setQuery] = useState("");
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	const [expandedOption, setExpandedOption] = useState<"thinking" | "speed" | null>(null);
	const [turnsExpanded, setTurnsExpanded] = useState(false);

	const groups = useMemo(
		() => groupModelsByProvider(models, query, effectiveProvider),
		[models, query, effectiveProvider],
	);

	// Session stats calculation — mirrors StatsBar exactly.
	const limits = useMemo(() => (models ? catalogLimits({ models: [...models] }) : undefined), [models]);
	const selectedKey = effectiveProvider && effectiveId ? `${effectiveProvider}:${effectiveId}` : undefined;
	const limit = contextLimitForModel(selectedKey, limits, cliContextWindow);
	const contextLabel = formatContextMeasurement(contextTokens, limit);
	const hasFreshTurns = turns.length > 0 && (pricing?.turnCount === undefined || turns.length === pricing.turnCount);
	const turnCount = hasFreshTurns ? turns.length : (pricing?.turnCount ?? turns.length);
	const cacheHitRate = useMemo(
		() => (hasFreshTurns ? sessionCacheHitRate({ turns: [...turns] }) : (pricing?.cacheHitRate ?? null)),
		[hasFreshTurns, turns, pricing?.cacheHitRate],
	);
	const { cost = 0, unpriced = turnCount, subscription = 0 } = pricing ?? {};
	const pricedCount = Math.max(0, turnCount - unpriced - subscription);
	const providers = pricing?.subscriptionProviders ?? subscriptionLabels(turns.map((turn) => turn.model));
	const cliBilled = hasFreshTurns
		? turns.some((turn) => turn.model.startsWith(`${CLAUDE_CODE_PROVIDER}:`))
		: Boolean(pricing?.cliBilled);
	const costLabel = planCostLabel(pricedCount > 0 ? cost : null, cliBilled ? [...providers, "CLI"] : providers);

	const speeds = supportedModelSpeeds(effectiveProvider ?? "", effectiveId ?? "");
	const effectiveSpeed = resolveModelSpeed(effectiveProvider ?? "", effectiveId ?? "", speedValue ?? inheritedSpeed);
	const speedSummary = effectiveSpeed
		? (speedValue === undefined && chatId ? `${SPEED_LABEL[effectiveSpeed]} · Strong` : SPEED_LABEL[effectiveSpeed])
		: null;
	const thinkingSummary = effectiveLevel === undefined
		? (levels.length === 0 ? "None" : "Default")
		: (THINKING_LABEL[effectiveLevel] ?? effectiveLevel);

	const isGroupOpen = (provider: string, index: number) => {
		if (query.trim().length > 0) return true;
		if (collapsed[provider] !== undefined) return !collapsed[provider];
		if (effectiveProvider) return provider === effectiveProvider;
		return index === 0;
	};

	const showStats = Boolean(chatId || turns.length > 0);
	const searching = query.trim().length > 0;

	return (
		<div
			data-testid="mobile-session-sheet"
			className="flex h-full w-full flex-col bg-background text-foreground"
		>
			{/* Header: T3 Code exact geometry (54px + safe-area-top, circular ✕ and ✓) */}
			<header className="lh-mobile-fs-header shrink-0 border-b border-border/60 bg-background">
				<div className="flex h-[54px] items-center justify-between gap-3 px-4">
					<button
						ref={closeBtnRef}
						type="button"
						aria-label="Close session settings"
						data-testid="mobile-session-sheet-close"
						onClick={onClose}
						className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border/80 bg-card text-foreground transition-colors active:bg-accent"
					>
						<XIcon className="size-4" />
					</button>
					<h2 className="min-w-0 truncate text-base font-semibold tracking-tight">
						{title ?? (chatId ? "Session settings" : "Model & options")}
					</h2>
					<button
						type="button"
						aria-label="Done"
						data-testid="mobile-session-sheet-done"
						onClick={onClose}
						className="flex size-10 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity active:opacity-80"
					>
						<CheckIcon className="size-4" />
					</button>
				</div>
			</header>

			{/* Scrollable body */}
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
				<div className="flex flex-col gap-4 pb-3">
					{error && (
						<p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
							{error}
						</p>
					)}

					{/* Session stats card (moved cleanly out of the bottom bar) */}
					{showStats && !searching && (
						<section data-testid="mobile-session-stats" className="flex flex-col gap-1.5">
							<div className="px-1 text-xs font-medium text-muted-foreground">Session stats</div>
							<div className="overflow-hidden rounded-2xl border border-border/70 bg-card divide-y divide-border/50">
								<div className="flex min-h-11 items-center justify-between gap-3 px-4 py-2 text-sm">
									<span className="text-muted-foreground">Context</span>
									<span data-testid="mobile-stats-context" className="tabular-nums font-medium text-card-foreground">
										{contextLabel}
									</span>
								</div>
								<div className="flex min-h-11 items-center justify-between gap-3 px-4 py-2 text-sm">
									<span className="text-muted-foreground">{subscription ? "Usage" : "Total cost"}</span>
									<span data-testid="mobile-stats-cost" className="tabular-nums font-medium text-card-foreground">
										{costLabel}
									</span>
								</div>
								{cacheHitRate !== null && (
									<div className="flex min-h-11 items-center justify-between gap-3 px-4 py-2 text-sm">
										<span className="text-muted-foreground">Cache hit rate</span>
										<span className="tabular-nums font-medium text-card-foreground">
											{(cacheHitRate * 100).toFixed(1)}%
										</span>
									</div>
								)}
								{unpriced > 0 && (
									<div className="flex min-h-11 items-center justify-between gap-3 px-4 py-2 text-sm">
										<span className="text-muted-foreground">Unpriced turns</span>
										<span className="tabular-nums font-medium text-card-foreground">{unpriced}</span>
									</div>
								)}
								{turnCount > 0 && (
									<div>
										<button
											type="button"
											aria-expanded={turnsExpanded}
											data-testid="mobile-stats-turns-toggle"
											onClick={() => {
												const next = !turnsExpanded;
												setTurnsExpanded(next);
												if (next && onOpenDetail && pricing?.turnCount !== undefined && turns.length !== pricing.turnCount) {
													onOpenDetail();
												}
											}}
											className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm transition-colors active:bg-accent"
										>
											<span className="text-muted-foreground">Turns</span>
											<span className="flex items-center gap-1 tabular-nums text-muted-foreground">
												<span>{turnCount}</span>
												{turnsExpanded ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
											</span>
										</button>
										{turnsExpanded && (
											<ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto border-t border-border/50 px-4 py-2.5 text-xs">
												{turns.length === 0 ? (
													<li className="text-muted-foreground">Loading turns…</li>
												) : (
													turns.map((turn, i) => {
														const c = pricing?.turnCosts[turn.id] ?? null;
														return (
															<li key={`${turn.messageId}-${i}`} className="flex items-center justify-between gap-2">
																<span className="truncate text-muted-foreground">
																	#{i + 1} · {prettyModel(turn.model, true)}
																</span>
																<span className="flex shrink-0 items-center gap-2 tabular-nums text-card-foreground">
																	<span className="text-muted-foreground">{turn.steps.length} steps</span>
																	<span>
																		{turn.model.startsWith(`${CLAUDE_CODE_PROVIDER}:`)
																			? "CLI"
																			: subscriptionLabel(turn.model) ?? (c === null ? "—" : formatUsd(c))}
																	</span>
																</span>
															</li>
														);
													})
												)}
											</ul>
										)}
									</div>
								)}
							</div>
						</section>
					)}

					{/* Options section (T3 Code IMG_1028 style — placed right before or below models;
					    visible without scrolling past 50 models when not searching) */}
					{!searching && (
						<section data-testid="mobile-session-options" className="flex flex-col gap-1.5">
							<div className="px-1 text-xs font-medium text-muted-foreground">Options</div>
							<div className="overflow-hidden rounded-2xl border border-border/70 bg-card divide-y divide-border/50">
								{/* Thinking */}
								<div>
									<button
										type="button"
										data-testid="mobile-option-thinking"
										disabled={levels.length === 0}
										aria-expanded={expandedOption === "thinking"}
										onClick={() => setExpandedOption((prev) => (prev === "thinking" ? null : "thinking"))}
										className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm transition-colors active:bg-accent disabled:opacity-50"
									>
										<span className="font-medium text-card-foreground">Thinking</span>
										<span className="flex items-center gap-1.5 text-muted-foreground">
											<span>{thinkingSummary}</span>
											{levels.length > 0 && (
												expandedOption === "thinking"
													? <ChevronUpIcon className="size-4" />
													: <ChevronRightIcon className="size-4" />
											)}
										</span>
									</button>
									{expandedOption === "thinking" && levels.length > 0 && (
										<div className="border-t border-border/50 bg-background/50 px-2 py-1.5">
											{levels.map((level) => {
												const active = level === effectiveLevel;
												return (
													<button
														key={level}
														type="button"
														data-testid={`mobile-thinking-option-${level}`}
														onClick={() => {
															onPickThinking(level as ThinkingLevel);
															setExpandedOption(null);
														}}
														className={`flex min-h-11 w-full items-center justify-between rounded-xl px-3 text-left text-sm transition-colors ${
															active ? "bg-accent font-medium text-foreground" : "text-foreground/90 active:bg-accent"
														}`}
													>
														<span>{THINKING_LABEL[level as ThinkingLevel] ?? level}</span>
														{active && <CheckIcon className="size-4 text-foreground" />}
													</button>
												);
											})}
										</div>
									)}
								</div>

								{/* Speed (only when model supports speeds) */}
								{speeds.length > 0 && speedSummary && (
									<div>
										<button
											type="button"
											data-testid="mobile-option-speed"
											aria-expanded={expandedOption === "speed"}
											onClick={() => setExpandedOption((prev) => (prev === "speed" ? null : "speed"))}
											className="flex min-h-12 w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm transition-colors active:bg-accent"
										>
											<span className="font-medium text-card-foreground">Speed</span>
											<span className="flex items-center gap-1.5 text-muted-foreground">
												<span>{speedSummary}</span>
												{expandedOption === "speed"
													? <ChevronUpIcon className="size-4" />
													: <ChevronRightIcon className="size-4" />}
											</span>
										</button>
										{expandedOption === "speed" && (
											<div className="border-t border-border/50 bg-background/50 px-2 py-1.5">
												{chatId && (
													<button
														type="button"
														data-testid="mobile-speed-option-inherit"
														onClick={() => {
															onPickSpeed(undefined);
															setExpandedOption(null);
														}}
														className={`flex min-h-11 w-full items-center justify-between rounded-xl px-3 text-left text-sm transition-colors ${
															speedValue === undefined ? "bg-accent font-medium text-foreground" : "text-foreground/90 active:bg-accent"
														}`}
													>
														<span>Use Strong</span>
														{speedValue === undefined && <CheckIcon className="size-4 text-foreground" />}
													</button>
												)}
												{speeds.map((speed) => {
													const active = speedValue === speed || (!chatId && effectiveSpeed === speed);
													return (
														<button
															key={speed}
															type="button"
															data-testid={`mobile-speed-option-${speed}`}
															onClick={() => {
																onPickSpeed(speed);
																setExpandedOption(null);
															}}
															className={`flex min-h-11 w-full items-center justify-between rounded-xl px-3 text-left text-sm transition-colors ${
																active ? "bg-accent font-medium text-foreground" : "text-foreground/90 active:bg-accent"
															}`}
														>
															<span>{SPEED_LABEL[speed]}</span>
															{active && <CheckIcon className="size-4 text-foreground" />}
														</button>
													);
												})}
											</div>
										)}
									</div>
								)}
							</div>
						</section>
					)}

					{/* Provider-grouped model list (T3 Code IMG_1027 style) */}
					<section data-testid="mobile-session-models" className="flex flex-col gap-2.5">
						<div className="px-1 text-xs font-medium text-muted-foreground">
							{chatId ? "Session model" : "Default model (Strong)"}
						</div>
						{models === undefined ? (
							<div className="rounded-2xl border border-border/70 bg-card px-4 py-6 text-center text-sm text-muted-foreground">
								Loading models…
							</div>
						) : groups.length === 0 ? (
							<div className="rounded-2xl border border-border/70 bg-card px-4 py-6 text-center text-sm text-muted-foreground">
								{models.length === 0 ? "No models — add a provider key in Settings → Providers." : "No models match."}
							</div>
						) : (
							groups.map((group, idx) => {
								const open = isGroupOpen(group.provider, idx);
								return (
									<div key={group.provider} className="flex flex-col gap-1.5">
										<button
											type="button"
											aria-expanded={open}
											onClick={() => setCollapsed((prev) => ({ ...prev, [group.provider]: open }))}
											className="flex min-h-9 items-center justify-between gap-2 px-1 text-left text-xs font-medium text-muted-foreground"
										>
											<span className="truncate">{group.label}</span>
											<span className="flex shrink-0 items-center gap-1 tabular-nums">
												<span>{group.models.length}</span>
												{open ? <ChevronUpIcon className="size-3.5" /> : <ChevronDownIcon className="size-3.5" />}
											</span>
										</button>
										{open && (
											<div className="overflow-hidden rounded-2xl border border-border/70 bg-card divide-y divide-border/50">
												{group.models.map((m) => {
													const active = m.id === effectiveId && m.provider === (effectiveProvider ?? m.provider);
													return (
														<button
															key={`${m.provider}/${m.id}`}
															type="button"
															data-testid={`mobile-model-option-${m.id.replace(/[^a-z0-9-]/gi, "_")}`}
															onClick={() => onPickModel(m)}
															className={`flex min-h-12 w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors active:bg-accent ${
																active ? "bg-accent/55" : ""
															}`}
														>
															<span className="min-w-0 flex-1">
																<span className="block truncate text-sm font-medium text-card-foreground">{m.name}</span>
																<span className="block truncate text-xs text-muted-foreground tabular-nums">
																	{m.id}
																	{m.contextWindow !== null ? ` · ${formatTokens(m.contextWindow)}` : ""}
																	{` · ${modelPriceSummary(m)}`}
																</span>
															</span>
															{active && <CheckIcon className="size-4 shrink-0 text-foreground" />}
														</button>
													);
												})}
											</div>
										)}
									</div>
								);
							})
						)}
					</section>
				</div>
			</div>

			{/* Sticky bottom search bar (T3 Code IMG_1027 / IMG_1028 style, 16px anti-zoom) */}
			<div className="shrink-0 border-t border-border/50 bg-background/95 px-4 pt-2 pb-[calc(10px+env(safe-area-inset-bottom,0px))] backdrop-blur">
				<div className="flex h-11 items-center gap-2 rounded-full border border-border/80 bg-card px-3.5">
					<SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
					<input
						type="search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Find a model"
						aria-label="Find a model"
						data-testid="mobile-model-search"
						className="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
					/>
					{query.length > 0 && (
						<button
							type="button"
							aria-label="Clear model search"
							onClick={() => setQuery("")}
							className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-accent"
						>
							<XIcon className="size-3.5" />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

/** Compact T3-Code-style model button + fullscreen Session settings sheet for mobile (<768px). */
export function MobileSessionControl({
	chatId,
	turns = [],
	contextTokens = null,
	cliContextWindow = null,
	pricing,
	onModelChange,
	onOpenDetail,
}: {
	chatId?: string;
	turns?: readonly TurnUsage[];
	contextTokens?: number | null;
	cliContextWindow?: ReturnType<typeof cliContextWindowOf>;
	pricing?: SessionPricing;
	onModelChange?: (model: string | undefined) => void;
	onOpenDetail?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const closeBtnRef = useRef<HTMLButtonElement>(null);
	const {
		catalog,
		refresh,
		session,
		strong,
		effectiveId,
		effectiveProvider,
		levels,
		effectiveLevel,
		error,
		setError,
		apply,
		pickModel,
		pickSpeed,
	} = useSessionModelState({ chatId, onModelChange });

	const handleOpen = useCallback(() => {
		setError(null);
		refresh();
		setOpen(true);
	}, [refresh, setError]);

	const handleClose = useCallback(() => {
		setOpen(false);
		return "closed" as const;
	}, []);

	const activeLabel = effectiveId
		? `${prettyModel(effectiveId)}${effectiveLevel ? `, ${THINKING_LABEL[effectiveLevel] ?? effectiveLevel}` : ""}`
		: "Choose model";

	return (
		<>
			<button
				type="button"
				data-testid="mobile-session-settings-trigger"
				aria-label={`Session settings (${activeLabel})`}
				aria-expanded={open}
				aria-haspopup="dialog"
				title={activeLabel}
				onClick={handleOpen}
				className="flex h-11 min-w-11 shrink-0 items-center justify-center gap-0.5 rounded-full px-2 text-muted-foreground transition-colors active:bg-accent hover:text-foreground"
			>
				<SparklesIcon className="size-[17px]" aria-hidden />
				<ChevronDownIcon className="size-3.5 opacity-80" aria-hidden />
			</button>

			<HostDialog
				open={open}
				onClose={handleClose}
				initialFocusRef={closeBtnRef}
				aria-label={chatId ? "Session settings" : "Model & options"}
				backdropProps={{
					className: "fixed inset-0 z-50 bg-background",
					"data-testid": "mobile-session-sheet-backdrop",
				}}
				frame={
					<div className="h-full w-full overflow-hidden bg-background" />
				}
			>
				<MobileSessionSheetBody
					chatId={chatId}
					models={catalog?.models}
					effectiveId={effectiveId}
					effectiveProvider={effectiveProvider}
					effectiveLevel={effectiveLevel}
					levels={levels}
					speedValue={chatId ? session?.settings?.speed : strong?.speed}
					inheritedSpeed={strong?.speed}
					error={error}
					turns={turns}
					contextTokens={contextTokens}
					cliContextWindow={cliContextWindow}
					pricing={pricing}
					onPickModel={pickModel}
					onPickThinking={(level) => apply(effectiveProvider ?? "", effectiveId ?? "", level)}
					onPickSpeed={pickSpeed}
					onOpenDetail={onOpenDetail}
					onClose={handleClose}
					closeBtnRef={closeBtnRef}
				/>
			</HostDialog>
		</>
	);
}
