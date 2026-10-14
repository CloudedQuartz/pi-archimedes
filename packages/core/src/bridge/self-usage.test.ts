import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Events } from "../events.js";
import { registerSelfUsage } from "./self-usage.js";

/**
 * The emitter emits on the handle it was handed (`pi.events`), so every test
 * builds its own handle and subscribes its own listener before invoking the
 * handler. Nothing is process-wide any more, so there is no queue and no replay
 * to design around — which is the point of the migration.
 */
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
  };
}

/** The handle this test's emitter was handed. Fresh per test. */
let bus: ReturnType<typeof fakeBus>;

beforeEach(() => {
  bus = fakeBus();
});

/** Subscribe to COST_UPDATE on that handle. */
function captureCostUpdates(): { events: unknown[]; done: () => void } {
  const captured: unknown[] = [];
  const unsub = bus.on(Events.COST_UPDATE, (p: unknown) => captured.push(p));
  return { events: captured, done: unsub };
}

/**
 * Register and capture the turn_end handler, using the repo's mock-ExtensionAPI
 * idiom (verbatim from bridge/index.test.ts — a plain object fails `tsc` with
 * TS2740; the `as unknown as ExtensionAPI` cast and the `mock.calls` re-typing
 * are BOTH required). The handle the emitter gets is this test's bus, so the
 * test can subscribe to the same one.
 */
function registerAndGetTurnEndHandler(): (e: unknown, ctx: unknown) => void {
  const onSpy = vi.fn();
  registerSelfUsage({ on: onSpy, events: bus } as unknown as ExtensionAPI);
  const calls = onSpy.mock.calls as Array<[string, (e: unknown, ctx: unknown) => void]>;
  const handler = calls.find(([event]) => event === "turn_end")![1];
  expect(handler).toBeTruthy();
  return handler;
}

function assistantMessage(overrides: { usage?: unknown }): { role: "assistant"; usage?: unknown } {
  return { role: "assistant", ...overrides };
}

// ── 1. per-turn emit ─────────────────────────────────────────────────────

describe("per-turn emit", () => {
  it("emits a COST_UPDATE with the turn's usage (delta, exact shape — no reasoning/totalTokens)", () => {
    const handler = registerAndGetTurnEndHandler();
    const { events, done } = captureCostUpdates();
    try {
      handler({
        type: "turn_end",
        turnIndex: 0,
        message: assistantMessage({
          usage: {
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 5,
            totalTokens: 165,
            cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
          },
        }),
      }, { mode: "tui" });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        source: "main",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        cost: 0.0033,
      });
    } finally {
      done();
    }
  });
});

// ── 2. no usage → no emit ────────────────────────────────────────────────

describe("no usage", () => {
  it("an assistant message without usage emits nothing", () => {
    const handler = registerAndGetTurnEndHandler();
    const { events, done } = captureCostUpdates();
    try {
      handler({
        type: "turn_end",
        turnIndex: 0,
        message: assistantMessage({}),
      }, { mode: "tui" });
      expect(events).toHaveLength(0);
    } finally {
      done();
    }
  });
});

// ── 3. two turns → two events (delta semantics) ──────────────────────────

describe("delta semantics", () => {
  it("two turns emit two events with per-turn values (NOT accumulated)", () => {
    const handler = registerAndGetTurnEndHandler();
    const { events, done } = captureCostUpdates();
    try {
      handler({
        type: "turn_end",
        turnIndex: 0,
        message: assistantMessage({
          usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
        }),
      }, { mode: "tui" });
      handler({
        type: "turn_end",
        turnIndex: 1,
        message: assistantMessage({
          usage: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 200, cost: { input: 0.002, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 } },
        }),
      }, { mode: "tui" });
      expect(events).toHaveLength(2);
      expect((events[0] as { inputTokens: number }).inputTokens).toBe(100);
      expect((events[1] as { inputTokens: number }).inputTokens).toBe(200); // NOT 300
    } finally {
      done();
    }
  });
});

// ── 4. unaffected by bridge mode ────────────────────────────────────────

describe("bridge independence", () => {
  it("emits without the bridge channel being configured (bus is in-process; only the bridge forwarder is gated)", () => {
    // NO configure() of the bridge channel anywhere in this file — the channel
    // stays inactive by default. The emitter must still fire the bus event
    // (design decision 3: registered unconditionally, not gated on bridge mode).
    const handler = registerAndGetTurnEndHandler();
    const { events, done } = captureCostUpdates();
    try {
      handler({
        type: "turn_end",
        turnIndex: 0,
        message: assistantMessage({
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        }),
      }, { mode: "tui" });
      expect(events).toHaveLength(1);
      expect((events[0] as { source: string }).source).toBe("main");
    } finally {
      done();
    }
  });
});

// ── 5. the queue is gone, and nothing needed it ───────────────────────

describe("no pre-subscriber queue", () => {
  /**
   * The retired `globalThis` bus queued an emit that had no listener and replayed
   * it to whoever subscribed next. The host bus does not: an emit with no
   * subscriber is dropped. That is the property the migration had to answer for,
   * so it is pinned here rather than assumed.
   *
   * Dropping is safe for this emitter, and the reason is call order: it fires at
   * `turn_end`, and its one consumer (`bridge/events.ts`) subscribes at
   * `session_start`, which pi always fires first — a turn cannot end before its
   * session started. Every other emitter in the suite is later still (a tool
   * call, a child's socket, a child's stdout). So no ordering guard was kept, and
   * this is precisely the case that would need one if that ever stopped holding.
   */
  it("an emit with no subscriber is not replayed to the next subscriber", () => {
    const handler = registerAndGetTurnEndHandler();
    handler(
      {
        type: "turn_end",
        turnIndex: 0,
        message: assistantMessage({ usage: { input: 5, output: 1, cost: { total: 0.5 } } }),
      },
      { mode: "tui" },
    );

    const { events, done } = captureCostUpdates();
    expect(events).toHaveLength(0);
    done();
  });

  it("the same emit DOES reach a subscriber that was already listening", () => {
    const handler = registerAndGetTurnEndHandler();
    const { events, done } = captureCostUpdates();
    try {
      handler(
        {
          type: "turn_end",
          turnIndex: 0,
          message: assistantMessage({ usage: { input: 5, output: 1, cost: { total: 0.5 } } }),
        },
        { mode: "tui" },
      );
      expect(events).toHaveLength(1);
    } finally {
      done();
    }
  });
});
