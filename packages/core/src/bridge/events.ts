// ── Bridge events (host-event-bus subscriptions — the state machine +
//    subagent forwarding + push events) ────────────────────────────────────
//
// Subscribes the SIX channel-vocabulary events (nothing emits agent_start/
// agent_settled/session_start on the bus — those are pi extension events dispatched via
// pi.on(...) and handled in registerBridge). Channel names map to wire names
// as explicit literals at each call site (no lookup table, no string surgery):
//   COST_UPDATE → cost_update, TODOS_UPDATE → todos_update, TODOS_CLEAR →
//   todos_clear. The ASK_* trio is not forwarded as pushes of their own —
//   ASK_REQUEST drives the refcount + subagent forwarding, ASK_CANCEL cancels
//   the pending Client request, and ASK_RESPONSE additionally triggers a
//   `state` push (refcount-- + pushState).
//
// The bridge is the SOLE emitter of child-path ASK_RESPONSE (spawn.ts only
// signals via ASK_CANCEL). Every forwarded ASK_REQUEST is eventually paired
// with an ASK_RESPONSE (success, error, timeout, or ASK_CANCEL) so the
// refcount never leaks.
//
// The subscriptions live on the CALLER's host handle (`pi.events`), which this
// module does not own — see `start()` / `stop()` for why the pair is mandatory
// now that the transport is the host's.

import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Events, emitOn } from "../events.js";
import { diag } from "../log.js";
import { sendEvent, request } from "./channel.js";

let refcount = 0;
let settled = false;
/** The handle the current subscription set was made on, or undefined when there is no subscription set. */
let subscribedOn: EventBus | undefined;
let sessionCtx: ExtensionContext | undefined;

const pending = new Map<string, { source: string; toolCallId?: string; cancel: () => void }>();
const unsubscribers: Array<() => void> = [];

export function state(): "working" | "idle" | "blocked" {
  return refcount > 0 ? "blocked" : (settled ? "idle" : "working");
}

function pushState(): void {
  sendEvent("state", { state: state() });
}

// ── Pi extension events (NOT bus events — nothing emits them on the bus;
//    they're dispatched by the extension runner via pi.on(...) and DO fire in
//    RPC mode, since the RPC driver runs the same session machinery). ──────

export function onAgentStart(): void {
  settled = false;
  pushState();
}

export function onAgentSettled(): void {
  settled = true;
  pushState();
}

export function onSessionStart(ctx?: ExtensionContext): void {
  if (ctx) sessionCtx = ctx;
  // Re-emitted on every session_start so a lost frame is recoverable; the
  // payload echoes PI_ARCHIMEDES_BRIDGE_SESSION so the Client can assert the
  // connection↔session mapping rather than infer it from the socket path.
  // (Does NOT set `started` — start() is the sole writer of that flag, so a
  // call-order flip can't turn start() into a permanent no-op; the session
  // push is unconditional by design.)
  sendEvent("session", { ...sessionRefs(), bridgeSession: process.env.PI_ARCHIMEDES_BRIDGE_SESSION });
}

function sessionRefs(): Record<string, unknown> {
  const sm = sessionCtx?.sessionManager;
  if (!sm) return {};
  const refs: Record<string, unknown> = {};
  try { refs.sessionId = sm.getSessionId?.(); } catch { /* */ }
  try { refs.sessionFile = sm.getSessionFile?.(); } catch { /* */ }
  try { refs.cwd = sm.getCwd?.(); } catch { /* */ }
  try { refs.sessionName = sm.getSessionName?.(); } catch { /* */ }
  return refs;
}

/**
 * Subscribe the six channel-vocabulary events on a host handle.
 *
 * Idempotent by teardown, not by an early return: it stops any previous
 * subscription set first, so it can be called once per `session_start` without
 * double-delivering. A "we already started, bail out" flag would be wrong
 * here — the host drops every subscription of a runtime when that runtime is
 * invalidated (session replacement, `/reload`), so the second `session_start`
 * of a process genuinely needs new subscriptions.
 *
 * @param events the caller's `pi.events` — the relay never reaches for a bus
 *               of its own, which is the whole point of the migration
 */
export function start(events: EventBus): void {
  stop();
  subscribedOn = events;

  unsubscribers.push(events.on(Events.ASK_REQUEST, (payload: unknown) => {
    const p = payload as {
      source: string;
      requestId: string;
      toolCallId?: string;
      questions: Array<{ id: string }>;
    };
    refcount++;
    // A subagent ask is forwarded to the Client. A source === "main" ask is
    // NOT forwarded here — the root's Client request comes from bridge.ask()
    // directly; the bus event is for the refcount only.
    if (p.source !== "main") {
      const { cancel } = requestAskToClient(p);
      const entry: { source: string; toolCallId?: string; cancel: () => void } = { source: p.source, cancel };
      if (p.toolCallId !== undefined) entry.toolCallId = p.toolCallId;
      pending.set(p.requestId, entry);
    }
  }));

  unsubscribers.push(events.on(Events.ASK_RESPONSE, () => {
    // Defensive floor: a spurious/duplicated ASK_RESPONSE must not drive the
    // refcount negative — a negative count would make every later ask
    // off-by-one (state reports working/idle while a prompt is pending, never
    // blocked again). The floor keeps the machine honest. A decrement at
    // refcount === 0 is a bug signal (by the module's own invariant, every
    // ASK_REQUEST is paired) — log it so the protocol violation doesn't
    // disappear without a trace.
    if (refcount === 0) diag("core", "[archimedes:bridge] unpaired ASK_RESPONSE received (refcount already 0)");
    refcount = Math.max(0, refcount - 1);
    pushState();
  }));

  unsubscribers.push(events.on(Events.ASK_CANCEL, (payload: unknown) => {
    const p = payload as { requestId: string };
    const entry = pending.get(p.requestId);
    // cancel() closes the socket → the request rejects → the .catch below
    // emits the cancelled ASK_RESPONSE → refcount-- + pending.delete. The
    // ASK_CANCEL itself does not touch the refcount (no double-decrement).
    if (entry) entry.cancel();
  }));

  // Bus payload types ARE the wire types — forward verbatim.
  unsubscribers.push(events.on(Events.TODOS_UPDATE, (payload: unknown) => {
    sendEvent("todos_update", payload);
  }));

  unsubscribers.push(events.on(Events.TODOS_CLEAR, (payload: unknown) => {
    sendEvent("todos_clear", payload);
  }));

  unsubscribers.push(events.on(Events.COST_UPDATE, (payload: unknown) => {
    sendEvent("cost_update", payload);
  }));
}

/**
 * Tear the subscription set down. The counterpart `start()` needs, and the
 * reason the relay survives a replacement session: the host unsubscribes a
 * runtime's handles when it invalidates it, so without an explicit teardown
 * the module-level state (refcount, pending asks, "am I subscribed") would
 * outlive the subscriptions it describes.
 *
 * Also releases the asks that died with the session — a Client request that
 * can never be answered would otherwise pin the state machine at `blocked` for
 * every session after this one.
 *
 * Safe to call when nothing is subscribed.
 */
export function stop(): void {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  subscribedOn = undefined;
  // Cancel first, then drop: a cancelled Client request settles asynchronously
  // and its paired ASK_RESPONSE finds no listener by then (the refcount is
  // reset below, not decremented, so the pair cannot double-count).
  for (const [, entry] of pending) entry.cancel();
  pending.clear();
  refcount = 0;
}

/**
 * Send a forwarded (subagent) ask to the Client and wire the response. The
 * bridge is the sole emitter of child-path ASK_RESPONSE: on a settled ask it
 * emits the Client's response verbatim; on a failure (error / timeout /
 * cancel / child exit) it emits a cancelled ASK_RESPONSE so the refcount
 * always pairs.
 *
 * The answer rides back out on the handle this subscription set was started
 * on — the same handle `subagent/spawn.ts` is listening on to write it down the
 * child's socket.
 */
function requestAskToClient(
  payload: {
    requestId: string;
    source: string;
    toolCallId?: string;
    questions: Array<{ id: string }>;
  },
): { cancel: () => void } {
  const opts: { toolCallId?: string; source?: string } = { source: payload.source };
  if (payload.toolCallId !== undefined) opts.toolCallId = payload.toolCallId;
  const handle = request<{
    cancelled: boolean;
    results: Array<{ id: string; selectedOptions: string[]; customInput?: string }>;
  }>("ask", payload.questions, opts);

  handle.promise
    .then((resp) => {
      emitOn(subscribedOn, Events.ASK_RESPONSE, {
        requestId: payload.requestId,
        cancelled: resp.cancelled,
        results: resp.results,
      });
      pending.delete(payload.requestId);
    })
    .catch(() => {
      emitOn(subscribedOn, Events.ASK_RESPONSE, {
        requestId: payload.requestId,
        cancelled: true,
        results: payload.questions.map((q) => ({ id: q.id, selectedOptions: [] })),
      });
      pending.delete(payload.requestId);
    });

  return { cancel: handle.cancel };
}

/** Test seam: reset the module singletons and tear down the subscriptions. */
export function __resetForTests(): void {
  refcount = 0;
  settled = false;
  sessionCtx = undefined;
  pending.clear();
  for (const u of unsubscribers) u();
  unsubscribers.length = 0;
  subscribedOn = undefined;
}
