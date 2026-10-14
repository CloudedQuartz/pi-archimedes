// ── Channel vocabulary ──────────────────────────────────────────────────────
//
// The names packages use to talk to each other, and the payload shapes that
// ride on them. **This module carries no transport.** It keeps no listeners,
// opens no socket, and — unlike the `Bus` singleton it replaces (ADR 0004,
// retired in favour of the host's `pi.events`, ADR 0029) — touches no
// `globalThis`. Call sites share the constants; the host owns the bus.
//
// The six channel strings are byte-identical to the retired `Events`
// constants. They are not free to change: `bridge/events.ts` maps several of
// them straight onto Archimedes Client push frames (`cost_update`,
// `todos_update`, `todos_clear`), so a rename is a wire-protocol change.
//
// Delivery is the host's promise, and it has two edges worth knowing before
// adding a channel:
//
// 1. **No queue.** An emit with no subscriber is dropped. Every emitter here
//    fires from a tool call, a child socket, or a turn — all of which happen
//    after `session_start`, so every subscription (made at registration or at
//    `session_start`) is already live. If you add an emitter that fires during
//    extension load, it needs its own ordering guard at the emitter; do not
//    reintroduce a general-purpose queue.
// 2. **A handle dies with its session.** `pi.events.emit` throws once the
//    extension runtime has been invalidated ("This extension ctx is stale
//    after session replacement or reload."), which a deferred emit — a socket
//    callback, a child stream, a timer — can easily outlive. `emitOn` below is
//    the contract the old bus gave for free: emitting never throws at you.
// 3. **A subscriber's throw is the host's problem, not the emitter's.**
//    `createEventBus()` wraps every handler in its own `try/catch` and prints
//    `Event handler error (<channel>)` with `console.error`, so a listener
//    failure never propagates back to whoever emitted — and never reaches our
//    log file either. A listener with something worth keeping must report it
//    through `diag()` itself. Pinned in `events-host-bus.test.ts`.

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { diag, describeError } from "./log.js";

export const Events = {
  COST_UPDATE: "archimedes:cost_update",
  TODOS_UPDATE: "archimedes:todos_update",
  TODOS_CLEAR: "archimedes:todos_clear",
  ASK_REQUEST: "archimedes:ask_request",
  ASK_RESPONSE: "archimedes:ask_response",
  ASK_CANCEL: "archimedes:ask_cancel",
} as const;

interface CostUpdatePayload {
  source: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}

interface TodoUpdatePayload {
  source: string;       // "main" or "subagent:<agent-name>"
  todos: Array<{ content: string; description?: string; status: "pending" | "in_progress" | "completed" }>;
}

interface TodoClearPayload {
  source: string;
}

interface AskRequestPayload {
  source: string;        // "subagent:<agent-name>"
  requestId: string;     // unique id to match request → response
  toolCallId?: string;   // the tool-call id of the process that invoked the tool (carried for Client correlation)
  questions: Array<{ id: string; question: string; description?: string; options: Array<{ label: string }>; multi?: boolean; recommended?: number }>;
}

interface AskResponsePayload {
  requestId: string;
  cancelled: boolean;
  results: Array<{ id: string; selectedOptions: string[]; customInput?: string }>;
}

interface AskCancelPayload {
  requestId: string;
  source: string;
}

export type { CostUpdatePayload, TodoUpdatePayload, TodoClearPayload, AskRequestPayload, AskResponsePayload, AskCancelPayload };

/**
 * Emit on a host handle without letting the handle's failure become ours.
 *
 * `pi.events.emit` throws when the runtime behind the handle has been
 * invalidated — verified against a live pi 1.2.0 session, where an emit
 * deferred past the end of the run crashed the process. Every emitter in this
 * suite hangs off something asynchronous (a child's socket, a child's stdout,
 * a tool call that outlived its session), so the throw is reachable, and a
 * dropped notification is a better outcome than a dead pi. The retired bus
 * swallowed the same class of failure; `diag` keeps it visible when someone is
 * looking.
 *
 * @param events the host handle, or `undefined` for a call site that was
 *               constructed before there was one to hold
 */
export function emitOn(events: EventBus | undefined, channel: string, payload: unknown): void {
  if (!events) return;
  try {
    events.emit(channel, payload);
  } catch (err) {
    diag("core", `[archimedes:events] emit "${channel}" failed: ${describeError(err)}`);
  }
}
