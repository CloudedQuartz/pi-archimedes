/**
 * The emit helper against pi's REAL event bus (`createEventBus()`), not the
 * suite's synchronous stand-in.
 *
 * Every other test in this migration drives a hand-written bus whose `emit`
 * calls listeners inline and lets their throws escape. pi's bus is not built
 * that way: `createEventBus()` (`dist/core/event-bus.js`) wraps each handler in
 * an `async` function with its own `try/catch`, so a subscriber's throw is
 * contained by the host and printed with `console.error`. The two transports
 * are NOT interchangeable on that point, and the difference has two
 * consequences worth having in writing:
 *
 * - Nothing in the suite can rely on a subscriber's throw reaching the emitter.
 *   The retired bus caught and logged it too, so no caller is broken, but a
 *   future "let the emitter see it" plan would be silently dead on arrival.
 * - Where a listener failure is *reported* changed: the old bus wrote to
 *   `diag()` (our log file); the host writes to `console.error`, which is the
 *   one surface `log-discipline.test.ts` forbids precisely because it smears a
 *   fullscreen frame. Our listeners therefore have to report their own failures.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { Events, emitOn } from "./events.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pi's real event bus, as our emitters and listeners meet it", () => {
  it("delivers a payload to a subscriber on the same handle", () => {
    const bus = createEventBus();
    const seen: unknown[] = [];
    const unsub = bus.on(Events.TODOS_UPDATE, (p) => seen.push(p));
    emitOn(bus, Events.TODOS_UPDATE, { source: "main", todos: [] });
    expect(seen).toEqual([{ source: "main", todos: [] }]);
    unsub();
    bus.clear();
  });

  /**
   * RED-FIRST EVIDENCE, kept as a pin. The migration note in
   * `docs/decisions/0029` claimed a throwing subscriber is "still rethrown into
   * the emitter, which is what the old bus did". It is not: written as
   * `expect(() => emitOn(bus, …)).toThrow()` this test failed ("expected
   * [Function] to throw an error") against pi 1.2.0, and the same is true of a
   * bare `bus.emit`. The host swallows it.
   */
  it("does NOT rethrow a subscriber's throw into the emitter", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = createEventBus();
    const unsub = bus.on(Events.COST_UPDATE, () => {
      throw new Error("listener exploded");
    });

    expect(() => bus.emit(Events.COST_UPDATE, { source: "main" })).not.toThrow();
    expect(() => emitOn(bus, Events.COST_UPDATE, { source: "main" })).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    // The host does report it — on the console, which is not our log file.
    expect(errSpy.mock.calls.some((call) => String(call[0]).includes("Event handler error"))).toBe(true);
    unsub();
    bus.clear();
  });

  it("a throwing subscriber does not cost the other subscribers the payload", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = createEventBus();
    const seen: unknown[] = [];
    const a = bus.on(Events.TODOS_UPDATE, () => {
      throw new Error("first listener exploded");
    });
    const b = bus.on(Events.TODOS_UPDATE, (p) => seen.push(p));

    emitOn(bus, Events.TODOS_UPDATE, { source: "subagent:x", todos: [] });
    expect(seen).toEqual([{ source: "subagent:x", todos: [] }]);
    a();
    b();
    bus.clear();
    await new Promise((resolve) => setImmediate(resolve));
    expect(errSpy).toHaveBeenCalled();
  });

  it("still swallows handle-death, which is what emitOn exists for", () => {
    const stale = {
      emit: () => {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
      on: () => () => {},
    };
    // Unlike a subscriber throw, a dead handle DOES throw at the caller — and
    // that is the only throw `emitOn` is written to absorb.
    expect(() => emitOn(stale, Events.COST_UPDATE, { source: "main" })).not.toThrow();
  });

  it("an unsubscribe returned by the host really removes the subscriber", () => {
    const bus = createEventBus();
    const seen: unknown[] = [];
    const unsub = bus.on(Events.TODOS_CLEAR, (p) => seen.push(p));
    unsub();
    emitOn(bus, Events.TODOS_CLEAR, { source: "subagent:x" });
    expect(seen).toEqual([]);
    bus.clear();
  });

  it("an emit with no subscriber is dropped, not queued for the next one", () => {
    const bus = createEventBus();
    emitOn(bus, Events.TODOS_UPDATE, { source: "subagent:x", todos: [] });
    const seen: unknown[] = [];
    const unsub = bus.on(Events.TODOS_UPDATE, (p) => seen.push(p));
    expect(seen).toEqual([]);
    unsub();
    bus.clear();
  });
});
