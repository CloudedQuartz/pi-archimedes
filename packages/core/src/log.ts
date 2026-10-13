import { appendFileSync } from "node:fs";

// ── Diagnostics sink ────────────────────────────────────────────────────────
//
// The suite does not write to the console. Two independent reasons:
//
// 1. On fullscreen screen a stray write lands inside the differential frame
//    and smears the viewport until the next full redraw. On regular screen it
//    scrolled away unseen, which is why the habit was cheap to keep.
// 2. In a subagent child every write is discarded anyway:
//    `subagent/src/stream.ts` drops any non-JSON stdout line (a guard for pi's
//    own startup messages), so a warning vanishes exactly when someone is
//    debugging a child run.
//
// So developer diagnostics go here, and a message the user must see goes to the
// notification surface (`ctx.ui.notify`) — never to stdout/stderr.
//
// Logging is opt-in and dumb on purpose: one env var naming a file, one
// appended line per call, and a `try/catch` that swallows every failure. A
// diagnostic that can throw, block, or fill a disk is a new bug class, and the
// whole point of the sink is to be trustworthy while another bug is in flight.
// Nothing else in this module touches the filesystem — it does not create
// directories, rotate, buffer, or truncate.

/**
 * Append one diagnostic line to `$PI_ARCHIMEDES_LOG`.
 *
 * No-op when the variable is unset or empty, so a default install never
 * touches disk. When set, appends `[ISO-8601] [scope] message`. Never throws:
 * an unwritable path (missing directory, EISDIR, EACCES, a full volume) is
 * silently ignored, because losing a log line is always cheaper than failing a
 * render, an event handler, or a session.
 *
 * One *append* per call; the message is kept verbatim, so an entry built by
 * `describeError` spans the lines of its stack — which is the point of it.
 *
 * @param scope the package the line came from (e.g. `"session-name"`)
 * @param message the diagnostic text; multi-line text is kept verbatim
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

/**
 * An error, formatted for `diag` — stack included.
 *
 * Task 6 moved errors off the console, and handing an error object to the
 * console used to print its stack on the way out. Formatting them down to
 * `err.message` would trade a visible stack for an invisible one, and at the sites this exists for —
 * a bus listener that threw, a footer frame that failed, a package whose
 * `import()` was refused — the error is **swallowed**, so this log is the only
 * place it is ever recorded and the stack is the only part naming its origin.
 *
 * Use the message alone (`err.message`) where someone on screen is about to
 * read the text — `ctx.ui.notify`, a tool result, a widget. A stack belongs in a
 * log file, never in a notification.
 *
 * @param err whatever a `catch` caught
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}
