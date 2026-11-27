import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import { runPiTurn } from "../src/server/pi/ui-stream.ts";
import { eventsResponse } from "../src/server/events-stream.ts";
import { connectManagedChannel, createNotifyHub, type EventTargetLike, type NotifySource } from "../components/server-events.tsx";
import { SessionModel } from "../components/session-core.ts";
import { projectView, type LhMessage } from "../src/core/index.ts";

function fakeSource() {
	const events = new Map<string, Set<(data: string) => void>>();
	const opens = new Set<() => void>();
	const errors = new Set<() => void>();
	return {
		closed: false,
		close() { this.closed = true; },
		onOpen(cb: () => void) { opens.add(cb); },
		onEvent(name: string, cb: (data: string) => void) {
			const set = events.get(name) ?? new Set();
			events.set(name, set);
			set.add(cb);
		},
		onError(cb: () => void) { errors.add(cb); },
		push(name: string, payload: unknown) {
			for (const cb of events.get(name) ?? []) cb(JSON.stringify(payload));
		},
		open() { for (const cb of opens) cb(); },
		error() { for (const cb of errors) cb(); },
	} as NotifySource & { push(name: string, payload: unknown): void; open(): void; error(): void; closed: boolean };
}

function fakeTarget(): EventTargetLike & { emit(type: string, event?: unknown): void; listenerCount(type: string): number } {
	const map = new Map<string, Set<(event: unknown) => void>>();
	return {
		addEventListener(type, listener) {
			const set = map.get(type) ?? new Set();
			map.set(type, set);
			set.add(listener);
		},
		removeEventListener(type, listener) {
			map.get(type)?.delete(listener);
		},
		emit(type, event) {
			for (const listener of [...(map.get(type) ?? [])]) listener(event);
		},
		listenerCount(type) {
			return map.get(type)?.size ?? 0;
		},
	};
}

describe("P0-2: ui-stream immediate :open and periodic heartbeat keepalive", () => {
	it("emits : open immediately and periodic : ping frames while turn is active, stopping cleanly on done", async () => {
		let finishTurn!: () => void;
		const listeners: Array<(event: never) => unknown> = [];
		const agent = {
			state: { messages: [] },
			subscribe(l: (event: never) => unknown) { listeners.push(l); return () => {}; },
			async continue() {
				await new Promise<void>((r) => { finishTurn = r; });
				for (const l of listeners) await l({ type: "agent_end", messages: [] } as never);
			},
			abort() {},
		} as unknown as Agent;

		const handle = runPiTurn({ agent, onFinish() {} });
		const stream = (handle.subscribe as (opts?: { heartbeatMs?: number }) => ReadableStream<Uint8Array>)({ heartbeatMs: 25 });
		const reader = stream.getReader();
		const decoder = new TextDecoder();

		const first = await reader.read();
		assert.equal(first.done, false);
		assert.equal(decoder.decode(first.value!), ": open\n\n");

		const second = await reader.read();
		assert.equal(second.done, false);
		assert.equal(decoder.decode(second.value!), ": ping\n\n");

		finishTurn();
		let tail = "";
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			tail += decoder.decode(next.value!);
		}
		assert.ok(tail.includes("data: [DONE]\n\n"));
	});
});

describe("P1-6: events-stream named ping + client watchdog + health auth probe", () => {
	it("eventsResponse emits named event: ping frames at heartbeatMs interval", async () => {
		const res = (eventsResponse as (opts?: { flushOnOpen?: boolean; heartbeatMs?: number }) => Response)({
			flushOnOpen: true,
			heartbeatMs: 20,
		});
		const reader = res.body!.getReader();
		const decoder = new TextDecoder();
		const first = await reader.read();
		assert.equal(decoder.decode(first.value!), ": open\n\n");
		const ping = await reader.read();
		assert.equal(decoder.decode(ping.value!), "event: ping\ndata: {}\n\n");
		await reader.cancel();
	});

	it("connectManagedChannel watchdog reconnects when silent beyond staleTimeoutMs while visible, and resets on ping", async () => {
		const hub = createNotifyHub();
		const sources: ReturnType<typeof fakeSource>[] = [];
		const win = fakeTarget();
		const doc = Object.assign(fakeTarget(), { visibilityState: "visible" });
		let clock = 10_000;

		const stop = connectManagedChannel({
			connect: () => {
				const s = fakeSource();
				sources.push(s);
				return s;
			},
			hub,
			win,
			doc,
			now: () => clock,
			reconnectThrottleMs: 100,
			watchdogIntervalMs: 15,
			staleTimeoutMs: 40_000,
		} as Parameters<typeof connectManagedChannel>[0]);

		assert.equal(sources.length, 1);
		sources[0]!.open();

		// A ping resets the watchdog clock
		clock += 30_000;
		sources[0]!.push("ping", {});
		clock += 20_000; // only 20s since ping (< 40s)
		await new Promise((r) => setTimeout(r, 40));
		assert.equal(sources.length, 1, "ping event must keep watchdog alive");

		// Exceed staleTimeoutMs without any ping/event -> watchdog reconnects
		clock += 25_000; // 45s since ping (> 40s)
		await new Promise((r) => setTimeout(r, 40));
		assert.equal(sources.length, 2, "stale silent EventSource must be reconnected by watchdog");
		assert.equal(sources[0]!.closed, true);

		stop();
	});
});

describe("P0-2 & P0-1: SessionModel foreground recovery, tail loading, and incremental projection", () => {
	it("aborts stuck frozen local stream and reconciles immediately when foreground meta says turnInFlight=false", async () => {
		let streamAborted = false;
		let streamReadStarted!: () => void;
		const reading = new Promise<void>((r) => { streamReadStarted = r; });
		const settledReply: LhMessage = {
			id: "msg_a_done",
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			timestamp: 2000,
			stopReason: "stop",
			usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			content: [{ type: "text", text: "Completed while backgrounded" }],
		};

		let reconciled = false;
		const model = new SessionModel({
			chatId: "chat_fg",
			initialMessages: [{ id: "msg_u_1", role: "user", content: "Explain", timestamp: 1000 }],
			fetch: (async (input, init) => {
				const url = String(input);
				if (url === "/api/chats/chat_fg/stream") {
					init?.signal?.addEventListener("abort", () => { streamAborted = true; });
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(": open\n\n"));
						},
						pull() {
							streamReadStarted();
							return new Promise(() => {}); // frozen iOS socket: never resolves
						},
					});
					return new Response(stream, { status: 200 });
				}
				if (url.startsWith("/api/chats/chat_fg")) {
					reconciled = true;
					return Response.json({
						messages: [{ id: "msg_u_1", role: "user", content: "Explain", timestamp: 1000 }, settledReply],
						turnInFlight: false,
					});
				}
				throw new Error(`Unexpected fetch: ${url}`);
			}) as typeof fetch,
		});

		const resumePromise = model.resumeStream(false);
		await reading;
		assert.equal(model.status, "submitted");
		assert.ok(model.lastStreamActivityAt > 0, "comment frame should update lastStreamActivityAt");

		const action = await model.recoverFromForeground({
			turnInFlight: false,
			messageCount: 2,
			lastMessageId: "msg_a_done",
		});
		await resumePromise;
		assert.equal(action, "settled");
		assert.equal(streamAborted, true, "stuck fetch reader must be aborted");
		assert.equal(reconciled, true);
		assert.equal(model.status, "ready");
		assert.equal(model.getState().messages.at(-1)?.parts.at(-1)?.text, "Completed while backgrounded");
	});

	it("keeps incremental view projection identical to full projectView during live streaming", () => {
		const base: LhMessage[] = [];
		for (let i = 0; i < 10; i++) {
			base.push({ id: `u_${i}`, role: "user", content: `Prompt ${i}`, timestamp: i * 10 });
			base.push({
				id: `a_${i}`,
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				timestamp: i * 10 + 5,
				stopReason: "stop",
				usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				content: [{ type: "text", text: `Reply ${i}` }],
			});
		}
		base.push({ id: "u_last", role: "user", content: "Final question", timestamp: 500 });

		const model = new SessionModel({ chatId: "chat_proj", initialMessages: base });
		const before = model.getState().messages;
		model.applyWireEvent({
			type: "message_start",
			message: { role: "assistant", content: [{ type: "text", text: "Hel" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, provider: "anthropic", model: "claude-sonnet-4-5" },
		});
		const mid1 = model.getState().messages;
		model.applyWireEvent({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "Hello world" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, provider: "anthropic", model: "claude-sonnet-4-5" },
		});
		const mid2 = model.getState().messages;

		// Structural equivalence with full projectView
		const full = projectView(model.getState().nativeMessages);
		assert.deepEqual(mid2, full);
		// Historical prefix rows keep referential identity across streaming updates (React.memo contract)
		assert.equal(mid1[0], before[0], "settled prefix messages must preserve referential identity");
		assert.equal(mid2[0], mid1[0], "streaming update must not recreate settled prefix message objects");
		assert.equal(mid2[mid2.length - 2], mid1[mid1.length - 2]);
	});
});
