import { appendFileSync } from "node:fs";

// ── Diagnostics sink (sibling of `@pi-archimedes/core/log`) ─────────────────
//
// Nothing in this package writes to the console: on fullscreen screen a stray
// write lands inside the differential frame and smears the viewport, and inside
// a subagent child it is discarded anyway (`subagent/src/stream.ts` drops every
// non-JSON stdout line). Diagnostics therefore go to `$PI_ARCHIMEDES_LOG`, and
// messages the user must see go to the notification surface.
//
// Why a copy rather than the import: `diff` is standalone, and `pi-support.ts`
// is the one place that states what that costs and why it is worth it. The
// canonical implementation is `packages/core/src/log.ts`; keep the two in step
// (pinned here by `log.test.ts`, which mirrors `core/src/log.test.ts`).

/**
 * Append one diagnostic line to `$PI_ARCHIMEDES_LOG`.
 *
 * No-op when the variable is unset or empty. Never throws: losing a log line is
 * always cheaper than failing a render or a tool call, which is what these
 * calls sit next to.
 *
 * @param scope the package the line came from (`"diff"`)
 * @param message the diagnostic text
 */
export function diag(scope: string, message: string): void {
  const file = process.env.PI_ARCHIMEDES_LOG;
  if (!file) return;
  try {
    appendFileSync(file, `[${new Date().toISOString()}] [${scope}] ${message}\n`);
  } catch {
    // Logging must never be the reason something failed.
  }
}
