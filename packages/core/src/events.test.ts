/**
 * The channel vocabulary (`Events`) + payload types, and the emit helper.
 *
 * This module has NO transport of its own — it holds no listeners and touches
 * no `globalThis` (that was the retired `core/bus` singleton, ADR 0004, now
 * replaced by the host's `pi.events`; see ADR 0029). The tests here are the
 * regression pins for that: the six channel strings must stay byte-identical
 * (they are the wire names the Archimedes Client sees, and the contract
 * between packages that no longer share a bus object), and importing this file
 * must not install a process-wide singleton.
 */
import { describe, it, expect } from "vitest";
import { Events, emitOn } from "./events.js";

describe("Events — channel names", () => {
  it("are byte-identical to the retired bus constants (wire contract with the Client)", () => {
    // Byte-identical on purpose: `core/bridge/events.ts` maps several of these
    // verbatim onto push frames (`cost_update`, `todos_update`, `todos_clear`).
    expect({ ...Events }).toEqual({
      COST_UPDATE: "archimedes:cost_update",
      TODOS_UPDATE: "archimedes:todos_update",
      TODOS_CLEAR: "archimedes:todos_clear",
      ASK_REQUEST: "archimedes:ask_request",
      ASK_RESPONSE: "archimedes:ask_response",
      ASK_CANCEL: "archimedes:ask_cancel",
    });
  });
});

describe("emitOn — the host handle is not ours to trust", () => {
  it("delivers to a listener on the same handle", () => {
    const seen: unknown[] = [];
    const bus = fakeBus();
    bus.on(Events.TODOS_UPDATE, (p) => seen.push(p));
    emitOn(bus, Events.TODOS_UPDATE, { source: "main", todos: [] });
    expect(seen).toEqual([{ source: "main", todos: [] }]);
  });

  /**
   * A real one: `pi.events.emit` THROWS once the extension runtime has been
   * invalidated — verified against a live pi 1.2.0 session, where a deferred
   * `setTimeout` emit after the run ended crashed the process with "This
   * extension ctx is stale after session replacement or reload." Our emitters
   * hang off sockets, child streams and timers, so they CAN outlive the session
   * that handed them the handle. The old `globalThis` bus never threw; this
   * helper keeps that contract.
   */
  it("does not rethrow a handle that throws (stale runtime after session replacement)", () => {
    const stale = {
      emit: () => {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
      on: () => () => {},
    };
    expect(() => emitOn(stale, Events.COST_UPDATE, { source: "main" })).not.toThrow();
  });

  it("is a no-op without a handle (a call site constructed before registration)", () => {
    expect(() => emitOn(undefined, Events.ASK_REQUEST, {})).not.toThrow();
  });
});

/** A minimal stand-in for pi's `createEventBus()` (same emit/on contract). */
export function fakeBus() {
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
    /** Test-only: how many handlers are live on a channel. */
    listenerCount(channel: string): number {
      return (listeners.get(channel) ?? []).length;
    },
  };
}
