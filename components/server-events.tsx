"use client";

/**
 * THE NOTIFICATION CHANNEL'S CLIENT HALF (push-architecture slice 3,
 * 2026-10-02): ONE EventSource("/api/events") per open window, held for
 * the window's lifetime — the channel that retires the app's poll
 * lattice. Every server-initiated change arrives as a named SSE frame;
 * consumers respond by fetching truth (notify → fetch, the architecture's
 * whole trick — see src/core/events.ts and server/events-stream.ts).
 *
 * This file is the ONE place in the app that knows EventSource exists.
 * Auto-reconnect is EventSource's own — never fought, always exploited:
 * every (re)open fires the resync callbacks, so a reconnect heals with
 * one ordinary fetch per consumer (a dev-server restart self-heals here).
 *
 * Shape: the provider holds a hub (window-local fan-out — the client twin
 * of the server bus; per-window, NOT globalThis: each window's connection
 * is its own) and wires ONE source into it. The hooks are thin: latest-ref
 * callbacks (events fire between renders — never trust a stale closure)
 * plus hub membership for the component's lifetime.
 *
 * TEST SEAM: `connect` injects the source factory — the hub + wiring are
 * plain functions the tests drive directly (no React, no server); the
 * React glue is an adapter seam like lh:turn-state (untested by
 * precedent, components/session.ts).
 */
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { SERVER_EVENT_TYPES, type ServerEventType, type ServerEvents } from "@/src/core";

/** The minimal source surface the provider consumes — EventSource behind
 *  this in production, fakes in tests. */
export interface NotifySource {
	close(): void;
	onOpen(cb: () => void): void;
	onEvent(name: string, cb: (data: string) => void): void;
	onError?(cb: () => void): void;
}

export function openEventsChannel(): NotifySource {
	const es = new EventSource("/api/events");
	return {
		close: () => es.close(),
		onOpen: (cb) => {
			es.onopen = () => cb();
		},
		onEvent: (name, cb) => {
			es.addEventListener(name, (ev) => cb((ev as MessageEvent).data));
		},
		onError: (cb) => {
			es.onerror = () => cb();
		},
	};
}

/** The per-window fan-out: typed subscriptions over one source. Listener
 *  errors are isolated per the bus's law (one bad consumer never breaks
 *  the window), and dispatch iterates a snapshot (an unsubscribe during
 *  dispatch is safe). */
export function createNotifyHub() {
	const byType = new Map<string, Set<(data: never) => void>>();
	const resyncs = new Set<() => void>();
	return {
		subscribe<K extends ServerEventType>(type: K, cb: (payload: ServerEvents[K]) => void) {
			const set = byType.get(type) ?? new Set<(data: never) => void>();
			byType.set(type, set);
			const slot = cb as unknown as (data: never) => void;
			set.add(slot);
			return () => set.delete(slot);
		},
		/** Resync callbacks: fired on the source's every (re)open — "you may
		 *  have missed events while disconnected; refetch". A consumer that
		 *  mounts while ALREADY open gets no fire (it missed nothing by
		 *  birth); its own mount fetch is its initial truth. */
		onResync(cb: () => void) {
			resyncs.add(cb);
			return () => resyncs.delete(cb);
		},
		/** One named frame arrived: parse, fan out. Unparseable frames are
		 *  dropped loudly — the channel's payloads are tiny and schemaless,
		 *  a bad frame must never half-fire. */
		dispatch(name: string, raw: string) {
			const set = byType.get(name);
			if (!set) return;
			let payload: unknown;
			try {
				payload = JSON.parse(raw);
			} catch (err) {
				console.error(`[events] unparseable frame for ${name}:`, err);
				return;
			}
			for (const cb of [...set]) {
				try {
					(cb as unknown as (data: unknown) => void)(payload);
				} catch (err) {
					console.error(`[events] ${name} handler failed:`, err);
				}
			}
		},
		fireOpen() {
			for (const cb of [...resyncs]) {
				try {
					cb();
				} catch (err) {
					console.error("[events] resync handler failed:", err);
				}
			}
		},
	};
}

/** Wire one source into a hub — testable without React. Returns the disconnect. */
export function wireSource(
	source: NotifySource,
	hub: ReturnType<typeof createNotifyHub>,
	options?: { onError?: () => void },
): () => void {
	let active = true;
	for (const name of SERVER_EVENT_TYPES) {
		source.onEvent(name, (raw) => {
			if (active) hub.dispatch(name, raw);
		});
	}
	source.onOpen(() => {
		if (active) hub.fireOpen();
	});
	if (options?.onError) {
		source.onError?.(() => {
			if (active) options.onError!();
		});
	}
	return () => {
		active = false;
		source.close();
	};
}

export interface EventTargetLike {
	addEventListener(type: string, listener: (event: unknown) => void): void;
	removeEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface ManagedChannelOptions {
	connect: () => NotifySource;
	hub: ReturnType<typeof createNotifyHub>;
	win?: EventTargetLike | null;
	doc?: (EventTargetLike & { visibilityState?: string }) | null;
	fetchImpl?: typeof globalThis.fetch;
	getPathname?: () => string;
	redirectToLogin?: () => void;
	now?: () => number;
	reconnectThrottleMs?: number;
	authProbeCooldownMs?: number;
}

const DEFAULT_RECONNECT_THROTTLE_MS = 1000;
const DEFAULT_AUTH_PROBE_COOLDOWN_MS = 5000;

/** Lifecycle wrapper around wireSource (pure, testable without React):
 *  - On foreground resume (hidden → visible), bfcache pageshow (persisted), or
 *    network online, closes the existing source and opens a fresh one
 *    (throttled) so iOS WebKit sockets suspended in background heal immediately
 *    and trigger resync via onOpen.
 *  - On source error, runs a guarded auth probe against /api/chats; only an
 *    explicit 401 redirects to /_login (never transient network/5xx errors). */
export function connectManagedChannel({
	connect,
	hub,
	win = null,
	doc = null,
	fetchImpl,
	getPathname = () => "",
	redirectToLogin = () => {},
	now = () => Date.now(),
	reconnectThrottleMs = DEFAULT_RECONNECT_THROTTLE_MS,
	authProbeCooldownMs = DEFAULT_AUTH_PROBE_COOLDOWN_MS,
}: ManagedChannelOptions): () => void {
	let disposed = false;
	let disconnect: (() => void) | null = null;
	let wasHidden = doc?.visibilityState === "hidden";
	let lastReconnectAt = -Infinity;
	let authProbeInFlight = false;
	let lastAuthProbeAt = -Infinity;

	const probeAuth = () => {
		if (disposed || !fetchImpl || authProbeInFlight) return;
		const t = now();
		if (t - lastAuthProbeAt < authProbeCooldownMs) return;
		authProbeInFlight = true;
		lastAuthProbeAt = t;
		void Promise.resolve(fetchImpl("/api/chats", { cache: "no-store", credentials: "same-origin" }))
			.then((res) => {
				if (!disposed && res.status === 401 && getPathname() !== "/_login") {
					redirectToLogin();
				}
			})
			.catch(() => {
				/* network or abort failure — never redirect to login */
			})
			.finally(() => {
				authProbeInFlight = false;
			});
	};

	const attach = () => {
		disconnect?.();
		disconnect = wireSource(connect(), hub, { onError: probeAuth });
	};

	const reconnect = () => {
		if (disposed) return;
		const t = now();
		if (t - lastReconnectAt < reconnectThrottleMs) return;
		lastReconnectAt = t;
		attach();
	};

	const onVisibilityChange = () => {
		const state = doc?.visibilityState;
		if (state === "hidden") {
			wasHidden = true;
		} else if (state === "visible" && wasHidden) {
			wasHidden = false;
			reconnect();
		}
	};

	const onPageShow = (event: unknown) => {
		if ((event as { persisted?: boolean } | null)?.persisted === true) {
			wasHidden = false;
			reconnect();
		}
	};

	const onOnline = () => {
		reconnect();
	};

	attach();
	doc?.addEventListener("visibilitychange", onVisibilityChange);
	win?.addEventListener("pageshow", onPageShow);
	win?.addEventListener("online", onOnline);

	return () => {
		disposed = true;
		doc?.removeEventListener("visibilitychange", onVisibilityChange);
		win?.removeEventListener("pageshow", onPageShow);
		win?.removeEventListener("online", onOnline);
		disconnect?.();
		disconnect = null;
	};
}

// ── the React glue ──────────────────────────────────────────────────────────

const EventsContext = createContext<ReturnType<typeof createNotifyHub> | null>(null);

/** Transport adapters may also be mounted in isolation with an injected bridge. */
export function useNotifyHub() { return useContext(EventsContext); }

export function ServerEventsProvider({ children, connect }: { children: ReactNode; connect?: () => NotifySource }) {
	const hub = useMemo(() => createNotifyHub(), []);
	useEffect(
		() =>
			connectManagedChannel({
				connect: connect ?? openEventsChannel,
				hub,
				win: typeof window !== "undefined" ? window : null,
				doc: typeof document !== "undefined" ? document : null,
				fetchImpl: typeof fetch !== "undefined" ? fetch : undefined,
				getPathname: () => (typeof window !== "undefined" ? window.location.pathname : ""),
				redirectToLogin: () => {
					if (typeof window !== "undefined") window.location.replace("/_login");
				},
			}),
		[hub, connect],
	);
	return <EventsContext.Provider value={hub}>{children}</EventsContext.Provider>;
}

/** Subscribe to one event type for this component's lifetime. The callback
 *  is a latest-ref: pass inline closures freely — the freshest render's
 *  closure runs, so state captured at the last completed render is safe to
 *  read (the provider re-stores it every render). */
export function useServerEvent<K extends ServerEventType>(type: K, cb: (payload: ServerEvents[K]) => void): void {
	const hub = useContext(EventsContext);
	if (!hub) throw new Error("useServerEvent requires <ServerEventsProvider>");
	const cbRef = useRef(cb);
	cbRef.current = cb;
	useEffect(() => {
		const off = hub.subscribe(type, (payload) => cbRef.current(payload));
		return () => {
			off();
		};
	}, [hub, type]);
}

/** Refetch truth on every (re)connect of the window's channel — the
 *  self-heal seam for EventSource reconnects and dev-server restarts. */
export function useServerResync(cb: () => void): void {
	const hub = useContext(EventsContext);
	if (!hub) throw new Error("useServerResync requires <ServerEventsProvider>");
	const cbRef = useRef(cb);
	cbRef.current = cb;
	useEffect(() => {
		const off = hub.onResync(() => cbRef.current());
		return () => {
			off();
		};
	}, [hub]);
}
