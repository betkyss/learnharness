/**
 * THE NOTIFICATION CHANNEL'S CLIENT HALF (push-architecture S3,
 * 2026-10-02): one EventSource per window fanned out through the hub.
 * The provider's ENTIRE effect body is wireSource(source, hub) — a plain
 * function — so these pins drive the real wiring with a fake source, no
 * React and no server: typed dispatch, resync-on-open, error isolation,
 * and close-stops-dispatch. The React glue around it (hooks/context) is
 * an adapter seam like lh:turn-state (untested by precedent).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { connectManagedChannel, createNotifyHub, wireSource, type EventTargetLike, type NotifySource } from "../components/server-events.tsx";

/** A source the test drives by hand — recordable, closable, honest. */
function fakeSource() {
	const events = new Map<string, Set<(data: string) => void>>();
	const opens = new Set<() => void>();
	const errors = new Set<() => void>();
	const src: NotifySource & {
		push(name: string, payload: unknown): void;
		open(): void;
		error(): void;
		closed: boolean;
	} = {
		closed: false,
		close() {
			this.closed = true;
		},
		onOpen(cb) {
			opens.add(cb);
		},
		onEvent(name, cb) {
			const set = events.get(name) ?? new Set();
			events.set(name, set);
			set.add(cb);
		},
		onError(cb) {
			errors.add(cb);
		},
		push(name, payload) {
			for (const cb of events.get(name) ?? []) cb(JSON.stringify(payload));
		},
		open() {
			for (const cb of opens) cb();
		},
		error() {
			for (const cb of errors) cb();
		},
	};
	return src;
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

describe("notify hub + wireSource (the client channel wiring)", () => {
	it("a named frame dispatches to the right subscriber with the parsed payload", () => {
		const hub = createNotifyHub();
		const src = fakeSource();
		wireSource(src, hub);
		const got: string[] = [];
		hub.subscribe("turn-started", (p) => got.push(p.chatId));
		hub.subscribe("turn-settled", (p) => got.push(`settled:${p.chatId}`));
		src.push("turn-started", { chatId: "chat_wire" });
		src.push("turn-settled", { chatId: "chat_wire" });
		src.push("jobs-changed", { chatId: "chat_wire" }); // no subscriber — no-op
		assert.deepEqual(got, ["chat_wire", "settled:chat_wire"]);
	});

	it("open fires resync (initial AND reconnect — EventSource's own retry exploited)", () => {
		const hub = createNotifyHub();
		const src = fakeSource();
		wireSource(src, hub);
		let resyncs = 0;
		hub.onResync(() => resyncs++);
		src.open();
		src.open(); // the reconnect case: same callback, fired again
		assert.equal(resyncs, 2);
	});

	it("a throwing handler never breaks its neighbors (the bus's isolation law)", () => {
		const hub = createNotifyHub();
		const src = fakeSource();
		wireSource(src, hub);
		hub.subscribe("chats-changed", () => {
			throw new Error("handler bug");
		});
		const got: number[] = [];
		hub.subscribe("chats-changed", () => got.push(1));
		src.push("chats-changed", {});
		assert.deepEqual(got, [1]);
	});

	it("an unparseable frame is dropped loudly, never half-fired", () => {
		const hub = createNotifyHub();
		const src = fakeSource();
		wireSource(src, hub);
		let calls = 0;
		hub.subscribe("activity-changed", () => calls++);
		// dispatch is the seam's own parser — feed it garbage directly
		hub.dispatch("activity-changed", "{not json");
		assert.equal(calls, 0);
	});

	it("unsubscribe stops delivery; close() (the disconnect) is wired through", () => {
		const hub = createNotifyHub();
		const src = fakeSource();
		const disconnect = wireSource(src, hub);
		let calls = 0;
		const off = hub.subscribe("chats-changed", () => calls++);
		src.push("chats-changed", {});
		off();
		src.push("chats-changed", {});
		assert.equal(calls, 1);
		assert.equal(src.closed, false, "connected until the provider unmounts");
		disconnect();
		assert.equal(src.closed, true, "the effect's cleanup closes the source");
	});
});

describe("connectManagedChannel — foreground resume reconnect & 401 auth probe", () => {
	it("reconnects on hidden -> visible, persisted pageshow, and online (throttled)", () => {
		const hub = createNotifyHub();
		const sources: ReturnType<typeof fakeSource>[] = [];
		const win = fakeTarget();
		const doc = Object.assign(fakeTarget(), { visibilityState: "visible" });
		let clock = 10_000;
		let resyncs = 0;
		hub.onResync(() => resyncs++);

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
			reconnectThrottleMs: 1000,
		});

		assert.equal(sources.length, 1);
		sources[0]!.open();
		assert.equal(resyncs, 1);

		// visibilitychange without prior hidden is a no-op
		doc.emit("visibilitychange");
		assert.equal(sources.length, 1);

		// hidden -> visible closes old source and opens a fresh one
		doc.visibilityState = "hidden";
		doc.emit("visibilitychange");
		doc.visibilityState = "visible";
		doc.emit("visibilitychange");
		assert.equal(sources.length, 2);
		assert.equal(sources[0]!.closed, true);
		assert.equal(sources[1]!.closed, false);
		sources[1]!.open();
		assert.equal(resyncs, 2);

		// rapid online within throttle window does not thrash
		clock += 200;
		win.emit("online");
		assert.equal(sources.length, 2);

		// online past throttle window reconnects
		clock += 1000;
		win.emit("online");
		assert.equal(sources.length, 3);
		assert.equal(sources[1]!.closed, true);

		// non-persisted pageshow does nothing; persisted pageshow reconnects
		clock += 2000;
		win.emit("pageshow", { persisted: false });
		assert.equal(sources.length, 3);
		win.emit("pageshow", { persisted: true });
		assert.equal(sources.length, 4);
		assert.equal(sources[2]!.closed, true);

		// stale source events/opens after disconnect are ignored
		sources[0]!.open();
		assert.equal(resyncs, 2);

		stop();
		assert.equal(sources[3]!.closed, true);
		assert.equal(doc.listenerCount("visibilitychange"), 0);
		assert.equal(win.listenerCount("pageshow"), 0);
		assert.equal(win.listenerCount("online"), 0);
	});

	it("probes /api/chats on source error and redirects only on 401 when not already on /_login", async () => {
		const hub = createNotifyHub();
		const src = fakeSource();
		let clock = 0;
		let pathname = "/chat/chat_1";
		let redirects = 0;
		let probeStatus: number | "throw" = 502;
		let probes = 0;

		const stop = connectManagedChannel({
			connect: () => src,
			hub,
			fetchImpl: (async (url) => {
				assert.equal(url, "/api/chats");
				probes++;
				if (probeStatus === "throw") throw new TypeError("offline");
				return new Response(null, { status: probeStatus });
			}) as typeof fetch,
			getPathname: () => pathname,
			redirectToLogin: () => redirects++,
			now: () => clock,
			authProbeCooldownMs: 5000,
		});

		// 502 never redirects
		src.error();
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(probes, 1);
		assert.equal(redirects, 0);

		// cooldown suppresses immediate repeat probe
		clock += 1000;
		src.error();
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(probes, 1);

		// network failure never redirects
		clock += 5000;
		probeStatus = "throw";
		src.error();
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(probes, 2);
		assert.equal(redirects, 0);

		// 401 on /_login does not redirect loop
		clock += 5000;
		probeStatus = 401;
		pathname = "/_login";
		src.error();
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(probes, 3);
		assert.equal(redirects, 0);

		// 401 on a chat page redirects to /_login
		clock += 5000;
		pathname = "/chat/chat_1";
		src.error();
		await new Promise((r) => setTimeout(r, 0));
		assert.equal(probes, 4);
		assert.equal(redirects, 1);

		stop();
	});
});
