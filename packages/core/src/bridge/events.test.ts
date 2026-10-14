/**
 * Bridge relay over the HOST event bus (`pi.events`), including its lifecycle.
 *
 * The relay used to subscribe to the suite's own `globalThis` bus. It now
 * subscribes through the host handle the caller passes in, which changes what
 * it owes the process:
 *
 * - `pi.events.on()` returns an unsubscribe, and the host **drops every
 *   subscription of a runtime** when that runtime is invalidated (session
 *   replacement, `/reload`) — see `createExtensionRuntime().invalidate` in
 *   `dist/core/extensions/loader.js`. So a module-level "already subscribed"
 *   flag that outlives the session wedges the relay: the subscriptions are gone
 *   but the flag says otherwise, and the bridge goes silently deaf. `stop()` is
 *   the counterpart that makes re-`start()` correct, and the `/new` test below
 *   is the proof.
 * - Subscribing per `session_start` without tearing down first would
 *   double-deliver. The single-delivery test is the guard.
 *
 * `./channel.js` (the socket transport) is mocked — it is unchanged by this
 * migration and covered by `channel.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Events } from "../events.js";
import { start, stop, state, __resetForTests } from "./events.js";
import { registerBridge } from "./index.js";
import { registerSelfUsage } from "./self-usage.js";

const sent: Array<{ name: string; payload: unknown }> = [];
const asked: Array<{ method: string; payload: unknown; opts: unknown }> = [];
let settle: { resolve: (r: { cancelled: boolean; results: unknown[] }) => void; reject: (e: unknown) => void } = {
  resolve: () => {},
  reject: () => {},
};

vi.mock("./channel.js", () => ({
  sendEvent: (name: string, payload: unknown) => sent.push({ name, payload }),
  request: (method: string, payload: unknown, opts: unknown) => {
    asked.push({ method, payload, opts });
    const promise = new Promise<{ cancelled: boolean; results: unknown[] }>((resolve, reject) => {
      settle = { resolve, reject };
    });
    return {
      promise,
      // The real channel settles a cancel by REJECTING it (the socket closes),
      // which is the path events.ts pairs with a cancelled ASK_RESPONSE.
      cancel: () => settle.reject(new Error("cancelled")),
    };
  },
  configure: vi.fn(),
  isActive: () => true,
  BridgeTransportError: class extends Error {},
  BridgeCancelledError: class extends Error {},
}));

function fakeBus() {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown): void {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void): () => void {
      const subs = listeners.get(channel) ?? [];
      subs.push(handler);
      listeners.set(channel, subs);
      return () => {
        const current = listeners.get(channel) ?? [];
        const idx = current.indexOf(handler);
        if (idx !== -1) current.splice(idx, 1);
      };
    },
    listenerCount(channel: string): number {
      return (listeners.get(channel) ?? []).length;
    },
  };
}

const COST = { source: "main", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01 };

beforeEach(() => {
  sent.length = 0;
  asked.length = 0;
  __resetForTests();
});

afterEach(() => {
  __resetForTests();
});

// ── 1. the relay still relays, on the host handle ───────────────────────────

describe("relay over pi.events", () => {
  it("COST_UPDATE reaches the Client as a cost_update frame", () => {
    const bus = fakeBus();
    start(bus);
    bus.emit(Events.COST_UPDATE, COST);
    expect(sent).toEqual([{ name: "cost_update", payload: COST }]);
  });

  it("TODOS_UPDATE / TODOS_CLEAR are forwarded verbatim under their wire names", () => {
    const bus = fakeBus();
    start(bus);
    bus.emit(Events.TODOS_UPDATE, { source: "subagent:x", todos: [] });
    bus.emit(Events.TODOS_CLEAR, { source: "subagent:x" });
    expect(sent).toEqual([
      { name: "todos_update", payload: { source: "subagent:x", todos: [] } },
      { name: "todos_clear", payload: { source: "subagent:x" } },
    ]);
  });

  it("drives the state machine: an ask blocks, its response unblocks it", () => {
    const bus = fakeBus();
    start(bus);
    expect(state()).toBe("working");
    bus.emit(Events.ASK_REQUEST, { source: "main", requestId: "r1", questions: [{ id: "q" }] });
    expect(state()).toBe("blocked");
    bus.emit(Events.ASK_RESPONSE, { requestId: "r1", cancelled: false, results: [] });
    expect(state()).toBe("working");
  });

  it("a spurious ASK_RESPONSE never drives the refcount negative", () => {
    const bus = fakeBus();
    start(bus);
    bus.emit(Events.ASK_RESPONSE, { requestId: "orphan", cancelled: false, results: [] });
    bus.emit(Events.ASK_REQUEST, { source: "main", requestId: "r2", questions: [{ id: "q" }] });
    expect(state()).toBe("blocked");
    bus.emit(Events.ASK_RESPONSE, { requestId: "r2", cancelled: false, results: [] });
    expect(state()).toBe("working");
  });

  /**
   * The ask round-trip, end to end on the new transport: a subagent ask arrives
   * on the bus, the Client is asked, and the Client's answer comes BACK on the
   * same handle — which is what `subagent/spawn.ts` writes to the child socket.
   */
  it("forwards a subagent ask to the Client and answers on the same bus", async () => {
    const bus = fakeBus();
    const responses: unknown[] = [];
    start(bus);
    bus.on(Events.ASK_RESPONSE, (p) => responses.push(p));

    bus.emit(Events.ASK_REQUEST, {
      source: "subagent:x",
      requestId: "sub-req-1",
      toolCallId: "tc1",
      questions: [{ id: "q1" }],
    });
    expect(asked[0]?.method).toBe("ask");
    expect(asked[0]?.opts).toEqual({ source: "subagent:x", toolCallId: "tc1" });

    settle.resolve({ cancelled: false, results: [{ id: "q1", selectedOptions: ["yes"] }] });
    await Promise.resolve();
    await Promise.resolve();
    expect(responses).toEqual([
      { requestId: "sub-req-1", cancelled: false, results: [{ id: "q1", selectedOptions: ["yes"] }] },
    ]);
    expect(state()).toBe("working");
  });

  it("ASK_CANCEL cancels the pending Client request", async () => {
    const bus = fakeBus();
    const responses: unknown[] = [];
    start(bus);
    bus.on(Events.ASK_RESPONSE, (p) => responses.push(p));
    bus.emit(Events.ASK_REQUEST, { source: "subagent:x", requestId: "sub-req-2", questions: [{ id: "q1" }] });
    bus.emit(Events.ASK_CANCEL, { requestId: "sub-req-2", source: "subagent:x" });
    await Promise.resolve();
    await Promise.resolve();
    expect(responses).toEqual([
      { requestId: "sub-req-2", cancelled: true, results: [{ id: "q1", selectedOptions: [] }] },
    ]);
  });
});

// ── 2. lifecycle ────────────────────────────────────────────────────────────

describe("subscription lifecycle", () => {
  it("start() twice delivers one event once (a second session_start must not double-subscribe)", () => {
    const bus = fakeBus();
    start(bus);
    start(bus);
    expect(bus.listenerCount(Events.COST_UPDATE)).toBe(1);
    bus.emit(Events.COST_UPDATE, COST);
    expect(sent).toHaveLength(1);
  });

  it("stop() unsubscribes everything it subscribed", () => {
    const bus = fakeBus();
    start(bus);
    expect(bus.listenerCount(Events.COST_UPDATE)).toBe(1);
    stop();
    expect(bus.listenerCount(Events.COST_UPDATE)).toBe(0);
    bus.emit(Events.COST_UPDATE, COST);
    expect(sent).toEqual([]);
  });

  /**
   * The `/new` case. pi fires `session_shutdown`, then invalidates the runtime,
   * which drops the host-side subscriptions; the factories run again and the
   * next `session_start` calls `start()` again. A module-level "started" flag
   * that survived the teardown would make that call a permanent no-op and the
   * bridge would stay deaf for the rest of the process.
   */
  it("start() after stop() subscribes again (a replacement session must not inherit a dead relay)", () => {
    const first = fakeBus();
    start(first);
    stop();
    const second = fakeBus();
    start(second);
    second.emit(Events.COST_UPDATE, COST);
    expect(sent).toEqual([{ name: "cost_update", payload: COST }]);
  });

  it("stop() without start() is a no-op", () => {
    expect(() => stop()).not.toThrow();
  });

  /**
   * A Client reply that settles AFTER the relay restarted belongs to the dead
   * subscription set, not the new one. `stop()` cancels the pending asks, and
   * `channel.request().cancel()` settles synchronously — so the paired
   * `.catch` lands on the very next microtask, by which time `start()` has
   * already re-subscribed on the (possibly replacement) handle. Without a
   * generation guard that stale `ASK_RESPONSE` is emitted into the NEW set.
   *
   * This is not a hypothetical restart: pi fires `session_start` twice per
   * `new_session` in RPC mode (`runtimeHost.newSession()` rebinds through
   * `setRebindSession`, then `rpc-mode.js` calls `rebindSession()` again), so a
   * restart with an ask still pending is a real sequence, verified live against
   * pi 1.2.0.
   */
  it("a reply that settles after the relay restarted does not reach the new subscription set", async () => {
    const bus = fakeBus();
    start(bus);
    bus.emit(Events.ASK_REQUEST, { source: "subagent:x", requestId: "gen1-req", questions: [{ id: "q" }] });

    // Restart while that Client request is still pending.
    start(bus);
    const crossed: unknown[] = [];
    const unsub = bus.on(Events.ASK_RESPONSE, (p) => crossed.push(p));
    await Promise.resolve();
    await Promise.resolve();

    expect(crossed).toEqual([]);
    unsub();
  });

  /**
   * The consequence the guard buys: an ask opened AFTER the restart keeps its
   * own refcount. Without the guard the stale reply is indistinguishable from a
   * real one to the fresh listener, and it unblocks a prompt still on screen.
   */
  it("a stale reply cannot unblock an ask opened after the restart", async () => {
    const bus = fakeBus();
    start(bus);
    bus.emit(Events.ASK_REQUEST, { source: "subagent:x", requestId: "gen1-req", questions: [{ id: "q" }] });

    start(bus); // restart with gen1-req pending
    bus.emit(Events.ASK_REQUEST, { source: "subagent:x", requestId: "gen2-req", questions: [{ id: "q" }] });
    expect(state()).toBe("blocked");

    await Promise.resolve();
    await Promise.resolve();

    // gen1-req's cancelled reply must not be counted against gen2-req.
    expect(state()).toBe("blocked");
    bus.emit(Events.ASK_RESPONSE, { requestId: "gen2-req", cancelled: false, results: [] });
    expect(state()).toBe("working");
  });

  /**
   * Three session generations, each with its own handle: exactly one live
   * subscription per channel in the generation that opened it, and none after
   * the last teardown. The leak this guards is a dropped unsubscribe — the host
   * also drops a runtime's subscriptions on invalidation, but a module that
   * still holds the old unsubscribers would be describing subscriptions that no
   * longer exist, and a same-handle restart would double-deliver.
   */
  it("three generations subscribe once, deliver once, and leave nothing behind", () => {
    const buses = [fakeBus(), fakeBus(), fakeBus()];
    for (const bus of buses) {
      // Twice, because pi really does fire `session_start` twice for one
      // replacement in RPC mode (`setRebindSession` + rpc-mode's own rebind).
      start(bus);
      start(bus);
      expect(bus.listenerCount(Events.COST_UPDATE)).toBe(1);
      expect(bus.listenerCount(Events.ASK_REQUEST)).toBe(1);
      expect(bus.listenerCount(Events.ASK_RESPONSE)).toBe(1);
      expect(bus.listenerCount(Events.ASK_CANCEL)).toBe(1);
      expect(bus.listenerCount(Events.TODOS_UPDATE)).toBe(1);
      expect(bus.listenerCount(Events.TODOS_CLEAR)).toBe(1);
      sent.length = 0;
      bus.emit(Events.COST_UPDATE, COST);
      expect(sent).toHaveLength(1);
      stop();
      for (const other of buses) expect(other.listenerCount(Events.COST_UPDATE)).toBe(0);
    }
  });
});

// ── 3. the real wiring: registerBridge's own handlers ───────────────────────

describe("registerBridge wiring", () => {
  const ENV_KEYS = [
    "PI_ARCHIMEDES_BRIDGE",
    "PI_ARCHIMEDES_BRIDGE_SOCKET",
    "PI_ARCHIMEDES_BRIDGE_SESSION",
    "PI_ARCHIMEDES_BRIDGE_SERVER_PID",
    "PI_SUBAGENT_SOCKET",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.PI_ARCHIMEDES_BRIDGE = "1";
    process.env.PI_ARCHIMEDES_BRIDGE_SOCKET = "/tmp/relay-test.sock";
    process.env.PI_ARCHIMEDES_BRIDGE_SESSION = "s1";
    process.env.PI_ARCHIMEDES_BRIDGE_SERVER_PID = "4242";
    delete process.env.PI_SUBAGENT_SOCKET;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function fakePi() {
    const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
    const pi = {
      __handlers: handlers,
      on(event: string, handler: (e: unknown, ctx: unknown) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => {
          const current = handlers.get(event) ?? [];
          const idx = current.indexOf(handler);
          if (idx !== -1) current.splice(idx, 1);
        };
      },
      events: fakeBus(),
    };
    const fire = async (event: string, e: unknown = { type: event }, ctx: unknown = { mode: "rpc" }) => {
      for (const handler of [...(handlers.get(event) ?? [])]) await handler(e, ctx);
    };
    return { pi: pi as unknown as ExtensionAPI, fire, bus: pi.events };
  }

  it("two session_starts cause ONE delivery of one event", async () => {
    const { pi, fire, bus } = fakePi();
    registerBridge(pi);
    await fire("session_start");
    await fire("session_start");
    sent.length = 0; // drop the `session` pushes
    bus.emit(Events.COST_UPDATE, COST);
    expect(sent).toEqual([{ name: "cost_update", payload: COST }]);
  });

  it("session_shutdown tears the relay down: a later emit reaches nothing", async () => {
    const { pi, fire, bus } = fakePi();
    registerBridge(pi);
    await fire("session_start");
    await fire("session_shutdown", { type: "session_shutdown", reason: "new" });
    sent.length = 0;
    bus.emit(Events.COST_UPDATE, COST);
    expect(sent).toEqual([]);
  });

  it("the handler is registered at the top level of register(), not nested in session_start (AGENTS.md)", () => {
    const onSpy = vi.fn();
    registerBridge({ on: onSpy, events: fakeBus() } as unknown as ExtensionAPI);
    const events = onSpy.mock.calls.map((c) => c[0] as string);
    expect(events).toContain("session_shutdown");
    // Exactly one registration per event, however many times the handlers fire.
    expect(events.filter((e) => e === "session_shutdown")).toHaveLength(1);
  });

  /**
   * The one emitter that is adjacent to startup, ordered against the relay.
   *
   * `pi.events` has no pre-subscriber queue, so the migration had to answer
   * whether anything emits before its listener exists. `COST_UPDATE` is the
   * candidate — core registers the emitter unconditionally, while the relay only
   * subscribes once `session_start` has decided activation. It is safe: pi fires
   * `session_start` before the first turn, so the relay is listening before the
   * first `turn_end` can emit. This test is that claim, in the order pi uses.
   */
  it("a turn_end COST_UPDATE after session_start reaches the relay (no queue needed)", async () => {
    const { pi, fire, bus } = fakePi();
    registerBridge(pi);
    const turnEnd = captureTurnEnd(pi);
    await fire("session_start");
    sent.length = 0;

    turnEnd({
      type: "turn_end",
      message: { role: "assistant", usage: { input: 7, output: 3, cost: { total: 0.12 } } },
    });

    expect(sent).toEqual([
      {
        name: "cost_update",
        payload: {
          source: "main",
          inputTokens: 7,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0.12,
        },
      },
    ]);
    // …and the same emit has no subscriber before session_start: the host drops
    // it, which is correct — a turn cannot have ended before its session began.
    expect(bus.listenerCount(Events.COST_UPDATE)).toBe(1);
  });
});

/** Register self-usage against the same fake pi and return its turn_end handler. */
function captureTurnEnd(pi: ExtensionAPI): (event: unknown) => void {
  const handlers = (pi as unknown as { __handlers: Map<string, Array<(e: unknown, c: unknown) => unknown>> }).__handlers;
  registerSelfUsage(pi);
  const handler = [...handlers.get("turn_end")!].at(-1)!;
  return (event: unknown) => {
    void handler(event, { mode: "rpc" });
  };
}
