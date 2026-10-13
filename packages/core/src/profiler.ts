/** Lightweight startup profiler — records per-package timings when PI_TIMING=1. */

import { diag } from "./log.js";

const ENABLED = process.env.PI_TIMING === "1";

interface TimingState {
  baseline: number;
  entries: Array<{ label: string; ms: number }>;
}

// Module-level accumulator (survives hot-reloads via Symbol key)
const TIMINGS_KEY = Symbol.for("archimedes:timings");
declare const globalThis: typeof global & Record<typeof TIMINGS_KEY, TimingState>;

function getState(): TimingState {
  if (!globalThis[TIMINGS_KEY]) {
    globalThis[TIMINGS_KEY] = { baseline: Date.now(), entries: [] };
  }
  return globalThis[TIMINGS_KEY];
}

// ── Public API — zero-cost when disabled (early-return when PI_TIMING unset) ──

export function time(label: string): void {
  if (!ENABLED) return;
  const state = getState();
  state.entries.push({ label, ms: Date.now() - state.baseline });
}

/** Reset timings for a fresh session (call on reload). */
export function reset(): void {
  if (!ENABLED) return;
  globalThis[TIMINGS_KEY] = { baseline: Date.now(), entries: [] };
}

/**
 * Append accumulated timings to the diagnostics log. Call once at
 * session_shutdown or on demand.
 *
 * `PI_TIMING=1` decides *what* is measured; `PI_ARCHIMEDES_LOG` decides where
 * it lands. Both are required to see anything, because timings are a developer
 * diagnostic and the console is off-limits: on fullscreen screen a stray write
 * smears the viewport, and in a subagent child it is discarded before anyone
 * reads it.
 */
export function print(): void {
  if (!ENABLED) return;
  const state = getState();
  if (state.entries.length === 0) return;

  let prevMs = 0;
  for (const entry of state.entries) {
    const delta = entry.ms - prevMs;
    prevMs = entry.ms;
    diag("core", `archimedes: ${entry.label}: +${delta}ms (${entry.ms}ms cumulative)`);
  }
}
