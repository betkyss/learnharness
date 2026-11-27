"use client";

/**
 * Unified client-side SWR cache (in-memory + bounded sessionStorage) and
 * saveData-aware lightweight prefetching for mobile PWA navigation & settings.
 *
 * Design invariants:
 * - Instant warm reads from memory (and sessionStorage across soft reloads),
 *   paired with silent background revalidation and in-flight request deduplication.
 * - Generation fencing: explicit invalidation bumps a per-key generation so a
 *   slow in-flight response started before a mutation can never resurrect stale data.
 * - Storage budget: each sessionStorage entry is capped (~192 KiB) and total
 *   cached chat tails are LRU-bounded so iOS WebKit quota errors never occur.
 * - Test isolation: entries track the active `globalThis.fetch` identity so
 *   Node tests swapping `globalThis.fetch` per test never leak stale memory state.
 */

import type { ChatListItem, ChatSettings, LhMessage, Phase3, PlanTree, SessionPricing, UserSettings } from "@/src/core";

const STORAGE_PREFIX = "lh:swr:v1:";
const MAX_STORAGE_ENTRY_CHARS = 192_000;
const MAX_CACHED_CHAT_TAILS = 8;

interface CacheEntry<T = unknown> {
	data: T;
	updatedAt: number;
	fetchRef: typeof globalThis.fetch | undefined;
}

interface StoredEnvelope<T = unknown> {
	data: T;
	updatedAt: number;
}

const memoryCache = new Map<string, CacheEntry>();
const inflightMap = new Map<string, { promise: Promise<unknown>; generation: number; fetchRef: typeof globalThis.fetch | undefined }>();
const generations = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

function currentFetchRef(): typeof globalThis.fetch | undefined {
	return typeof globalThis.fetch === "function" ? globalThis.fetch : undefined;
}

function keyGeneration(key: string): number {
	return generations.get(key) ?? 0;
}

function storage(): Storage | null {
	if (typeof window === "undefined") return null;
	try {
		return window.sessionStorage ?? null;
	} catch {
		return null;
	}
}

function readStorage<T>(key: string): CacheEntry<T> | null {
	const store = storage();
	if (!store) return null;
	try {
		const raw = store.getItem(STORAGE_PREFIX + key);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as StoredEnvelope<T>;
		if (!parsed || typeof parsed !== "object" || !("data" in parsed) || typeof parsed.updatedAt !== "number") {
			return null;
		}
		return { data: parsed.data, updatedAt: parsed.updatedAt, fetchRef: currentFetchRef() };
	} catch {
		return null;
	}
}

function writeStorage<T>(key: string, data: T, updatedAt: number): void {
	const store = storage();
	if (!store) return;
	try {
		const serialized = JSON.stringify({ data, updatedAt } satisfies StoredEnvelope<T>);
		if (serialized.length > MAX_STORAGE_ENTRY_CHARS) return;
		store.setItem(STORAGE_PREFIX + key, serialized);
	} catch {
		// Safari private browsing or quota full — evict older chat tails once and retry silently.
		try {
			for (let i = store.length - 1; i >= 0; i--) {
				const k = store.key(i);
				if (k && k.startsWith(`${STORAGE_PREFIX}chat:`)) store.removeItem(k);
			}
			const serialized = JSON.stringify({ data, updatedAt } satisfies StoredEnvelope<T>);
			if (serialized.length <= MAX_STORAGE_ENTRY_CHARS) store.setItem(STORAGE_PREFIX + key, serialized);
		} catch {
			/* memory cache remains active */
		}
	}
}

function removeStorage(key: string): void {
	const store = storage();
	if (!store) return;
	try {
		store.removeItem(STORAGE_PREFIX + key);
	} catch {
		/* ignore */
	}
}

function notifyKey(key: string): void {
	const subs = listeners.get(key);
	if (!subs) return;
	for (const fn of [...subs]) {
		try {
			fn();
		} catch {
			/* observer isolation */
		}
	}
}

function pruneChatTailCache(): void {
	const chatEntries: Array<{ key: string; updatedAt: number }> = [];
	for (const [key, entry] of memoryCache.entries()) {
		if (key.startsWith("chat:")) chatEntries.push({ key, updatedAt: entry.updatedAt });
	}
	if (chatEntries.length <= MAX_CACHED_CHAT_TAILS) return;
	chatEntries.sort((a, b) => a.updatedAt - b.updatedAt);
	const excess = chatEntries.length - MAX_CACHED_CHAT_TAILS;
	for (let i = 0; i < excess; i++) {
		const victim = chatEntries[i]!.key;
		memoryCache.delete(victim);
		removeStorage(victim);
	}
}

export function getSwrEntry<T>(key: string, maxAgeMs?: number): { data: T; updatedAt: number; fresh: boolean } | null {
	const fetchRef = currentFetchRef();
	let entry = memoryCache.get(key) as CacheEntry<T> | undefined;
	if (entry && entry.fetchRef !== fetchRef) {
		memoryCache.delete(key);
		entry = undefined;
	}
	if (!entry) {
		const persisted = readStorage<T>(key);
		if (persisted) {
			memoryCache.set(key, persisted);
			entry = persisted;
		}
	}
	if (!entry) return null;
	const fresh = maxAgeMs === undefined ? true : Date.now() - entry.updatedAt <= maxAgeMs;
	return { data: entry.data, updatedAt: entry.updatedAt, fresh };
}

export function getSwrData<T>(key: string, maxAgeMs?: number): T | undefined {
	return getSwrEntry<T>(key, maxAgeMs)?.data;
}

export function setSwrData<T>(key: string, data: T, options?: { persist?: boolean }): void {
	const updatedAt = Date.now();
	memoryCache.set(key, { data, updatedAt, fetchRef: currentFetchRef() });
	if (options?.persist !== false) {
		writeStorage(key, data, updatedAt);
	}
	if (key.startsWith("chat:")) pruneChatTailCache();
	notifyKey(key);
}

export function invalidateSwr(key: string): void {
	generations.set(key, keyGeneration(key) + 1);
	memoryCache.delete(key);
	inflightMap.delete(key);
	removeStorage(key);
	notifyKey(key);
}

export function subscribeSwr(key: string, listener: () => void): () => void {
	let subs = listeners.get(key);
	if (!subs) {
		subs = new Set();
		listeners.set(key, subs);
	}
	subs.add(listener);
	return () => {
		subs?.delete(listener);
		if (subs && subs.size === 0) listeners.delete(key);
	};
}

/**
 * Deduplicated SWR fetch:
 * - If `force` is false and an entry exists within `freshMs`, returns cached data immediately.
 * - If an identical fetch is already in flight for the current fetchRef, shares that promise.
 * - Stores the resolved result only if the key was not invalidated while in flight.
 */
export function fetchSwr<T>(
	key: string,
	fetcher: () => Promise<T>,
	options?: { force?: boolean; freshMs?: number; persist?: boolean },
): Promise<T> {
	const force = options?.force === true;
	const fetchRef = currentFetchRef();
	if (!force && options?.freshMs !== undefined && options.freshMs > 0) {
		const cached = getSwrEntry<T>(key, options.freshMs);
		if (cached?.fresh) return Promise.resolve(cached.data);
	}
	const existing = inflightMap.get(key);
	if (!force && existing && existing.fetchRef === fetchRef) {
		return existing.promise as Promise<T>;
	}
	const gen = force ? keyGeneration(key) + 1 : keyGeneration(key);
	if (force) generations.set(key, gen);
	const promise = Promise.resolve()
		.then(fetcher)
		.then((data) => {
			if (keyGeneration(key) === gen && currentFetchRef() === fetchRef) {
				setSwrData(key, data, { persist: options?.persist });
			}
			return data;
		})
		.finally(() => {
			const cur = inflightMap.get(key);
			if (cur && cur.promise === promise) inflightMap.delete(key);
		});
	inflightMap.set(key, { promise, generation: gen, fetchRef });
	return promise;
}

/** Respect Data Saver / 2G connections before launching speculative prefetches. */
export function canSpeculativelyPrefetch(): boolean {
	if (typeof navigator === "undefined") return false;
	if (navigator.onLine === false) return false;
	const conn = (navigator as Navigator & {
		connection?: { saveData?: boolean; effectiveType?: string };
	}).connection;
	if (conn?.saveData === true) return false;
	if (conn?.effectiveType === "slow-2g" || conn?.effectiveType === "2g") return false;
	return true;
}

// ─── Domain helpers built over the shared SWR store ──────────────────────────

export const SWR_KEYS = {
	settings: "api:settings",
	keys: "api:keys",
	customProvider: "api:custom-provider",
	models: "api:models",
	chats: "api:chats",
	graph: "api:graph",
	graphRenderSettings: "api:graph:render-settings",
	graphCosts: "api:graph:costs",
	chatTail: (id: string) => `chat:tail:${id}`,
	chatSettings: (id: string) => `chat:settings:${id}`,
} as const;

export interface SettingsApiPayload {
	settings: UserSettings | null;
	fileAccessError?: string | null;
}

/** Shared deduplicated GET /api/settings reader used across Settings, ModelPicker, Dictation & CoverageRing. */
export function fetchSettingsSwr(options?: { force?: boolean; freshMs?: number }): Promise<SettingsApiPayload> {
	return fetchSwr<SettingsApiPayload>(
		SWR_KEYS.settings,
		async () => {
			const res = await fetch("/api/settings");
			if (!res.ok) throw new Error(`status ${res.status}`);
			return (await res.json()) as SettingsApiPayload;
		},
		{ force: options?.force, freshMs: options?.freshMs ?? 0, persist: true },
	);
}

export interface CachedChatTail {
	id: string;
	title?: string;
	kind?: "teach" | "practice";
	messages: LhMessage[];
	totalMessages?: number;
	omittedViewGroups?: number;
	truncated?: boolean;
	initialPhase?: Phase3;
	tree?: PlanTree | null;
	pricing?: SessionPricing;
	settings?: ChatSettings;
	turnInFlight?: boolean;
	turnError?: string;
}

/** Cache a chat tail snapshot (from live Chat mount/reconcile OR speculative prefetch). */
export function cacheChatTail(id: string, snapshot: CachedChatTail): void {
	setSwrData(SWR_KEYS.chatTail(id), snapshot, { persist: true });
}

export function getCachedChatTail(id: string): CachedChatTail | undefined {
	return getSwrData<CachedChatTail>(SWR_KEYS.chatTail(id));
}

/** Lightweight tail prefetch (respects saveData + dedupes in-flight + skips fresh entries). */
export function prefetchChatTail(id: string, meta?: Pick<ChatListItem, "title" | "kind">): void {
	if (!id || !canSpeculativelyPrefetch()) return;
	void fetchSwr<CachedChatTail>(
		SWR_KEYS.chatTail(id),
		async () => {
			const res = await fetch(`/api/chats/${encodeURIComponent(id)}?tail=12`, { cache: "no-store" });
			if (!res.ok) throw new Error(`chat prefetch ${res.status}`);
			const body = (await res.json()) as Partial<CachedChatTail> & { messages?: LhMessage[] };
			return {
				id,
				title: body.title ?? meta?.title,
				kind: body.kind ?? meta?.kind,
				messages: Array.isArray(body.messages) ? body.messages : [],
				totalMessages: body.totalMessages,
				omittedViewGroups: body.omittedViewGroups,
				truncated: body.truncated,
				initialPhase: body.initialPhase,
				tree: body.tree ?? null,
				pricing: body.pricing,
				settings: body.settings,
				turnInFlight: body.turnInFlight,
				turnError: body.turnError,
			};
		},
		{ freshMs: 25_000, persist: true },
	).catch(() => {
		/* speculative prefetch errors are always silent */
	});
}

/** Parallel warm-up for Settings → Providers & Agent (eliminates Settings → Keys waterfall). */
export function prefetchSettingsBundle(options?: { force?: boolean }): void {
	void fetchSettingsSwr({ force: options?.force, freshMs: options?.force ? 0 : 10_000 }).catch(() => {});
	void fetchSwr(
		SWR_KEYS.keys,
		async () => {
			const res = await fetch("/api/keys");
			if (!res.ok) throw new Error(`status ${res.status}`);
			return res.json();
		},
		{ force: options?.force, freshMs: options?.force ? 0 : 10_000, persist: true },
	).catch(() => {});
	void fetchSwr(
		SWR_KEYS.customProvider,
		async () => {
			const res = await fetch("/api/custom-provider");
			if (!res.ok) return null;
			return res.json();
		},
		{ force: options?.force, freshMs: options?.force ? 0 : 10_000, persist: true },
	).catch(() => {});
}

/** Clear all in-memory & sessionStorage SWR state (tests only). */
export function _resetSwrCacheForTests(): void {
	memoryCache.clear();
	inflightMap.clear();
	generations.clear();
	const store = storage();
	if (!store) return;
	try {
		for (let i = store.length - 1; i >= 0; i--) {
			const k = store.key(i);
			if (k && k.startsWith(STORAGE_PREFIX)) store.removeItem(k);
		}
	} catch {
		/* ignore */
	}
}
