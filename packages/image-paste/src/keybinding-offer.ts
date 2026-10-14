import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { diag } from "@pi-archimedes/core/log";
import {
  isConfigEnabled,
  loadConfig,
  updateConfig,
  writeAtomicPreservingSymlinks,
} from "@pi-archimedes/core/settings-io";

const NAMESPACE = "archimedes.imagePaste";

/** pi's native clipboard action, the one key this package takes over. */
const UNBIND_KEY = "app.clipboard.pasteImage";

/** pi's published keybindings schema — the `$schema` value the suite writes. */
const PI_KEYBINDINGS_SCHEMA_URL = "https://pi.dev/schemas/keybindings.schema.json";

const CONFIRM_TITLE = "First run";
const CONFIRM_MESSAGE =
  "~/.pi/agent/keybindings.json is missing. Without it, Pi's built-in " +
  "app.clipboard.pasteImage binding (Ctrl+V on Linux/macOS, Alt+V on Windows) " +
  "double-fires with image-paste's Ctrl+V handler. Create the file now with the " +
  "docs snippet? It clears the built-in binding (/reload applies it).";

/**
 * Exactly the snippet from packages/image-paste/README.md → "Paste shortcuts".
 *
 * `$schema` points at pi's published keybindings schema. Read it as
 * forward-compatibility and editor tooling, not as validation: pi 1.2.0 ships
 * `KeybindingsSchema` (`dist/core/keybindings-schema.js:13`) with nothing in the
 * shipped `dist` importing it, and what it validates at startup is *theme* JSON
 * (`setThemeJsonValidator`, `dist/main.js:452`). What matters for us is that the
 * loader ignores the key — `toKeybindingsConfig` does
 * `if (key === "$schema") continue;` (`dist/core/keybindings.js:247-248`) — so
 * the unbinding still applies, and the schema itself declares
 * `"$schema": { "type": "string" }` (verified against the live
 * https://pi.dev/schemas/keybindings.schema.json, whose `$id` is that URL).
 */
const SNIPPET_JSON =
  `{ "$schema": "${PI_KEYBINDINGS_SCHEMA_URL}", "${UNBIND_KEY}": [] }`;

export const CREATED_NOTIFY = "Created ~/.pi/agent/keybindings.json — reloading now";
/** Fallback wording for runtimes whose event ctx has no reload (Pi 0.85.1). */
export const CREATED_RELOAD_HINT =
  "Created ~/.pi/agent/keybindings.json — run /reload to apply";
/**
 * The restore twin of the two texts above. Same flow (see
 * {@link reloadAfterKeybindingChange}), different verb: saying "Created
 * ~/.pi/agent/keybindings.json" immediately after emptying that file would be
 * false, and this suite tells the user what actually happened.
 */
export const RESTORED_NOTIFY =
  "Restored pi's native clipboard paste — app.clipboard.pasteImage removed from ~/.pi/agent/keybindings.json, reloading now";
/** Restore fallback for a ctx whose event context has no `reload`. */
export const RESTORED_RELOAD_HINT =
  "Restored pi's native clipboard paste — run /reload to apply";

interface PromptConfig {
  keybindingsPromptDone: boolean;
}

const PROMPT_DEFAULTS: PromptConfig = { keybindingsPromptDone: false };

/** `archimedes.imagePaste`, the keys this module reads. */
interface ImagePasteConfig {
  suppressNativePaste: boolean;
}

/**
 * Default `true` = today's behaviour: the suite keeps the paste key and pi's
 * native action stays unbound. Only an explicit `false` asks for the key back
 * (strict comparison — `"false"` and `0` are not `false`, same rule as
 * `isConfigEnabled`).
 */
const IMAGE_PASTE_DEFAULTS: ImagePasteConfig = { suppressNativePaste: true };

/**
 * Whether the suite may claim pi's paste key(s) for itself this session.
 *
 * `true` (the default) is today's behaviour: image-paste registers the paste
 * shortcuts and pi's native `app.clipboard.pasteImage` stays unbound. `false` —
 * the strict boolean, same rule as {@link runNativePasteRestore} — asks for the
 * key back, and then BOTH halves of the promise apply: the file restore removes
 * our unbinding from `keybindings.json`, AND `registerImagePaste` registers no
 * shortcut, so the restored native binding is actually reachable.
 *
 * Why the second half is needed (pi 1.2.0, measured): `app.clipboard.pasteImage`
 * is not in `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` (`dist/core/
 * extensions/runner.js:9-27`), so `restrictOverride === false` and
 * `ExtensionRunner.getShortcuts` keeps the extension shortcut and prints "…
 * Using `<ext>`" (`dist/core/extensions/runner.js:467-474`); and
 * `CustomEditor.handleInput` consults `onExtensionShortcut` before its
 * `app.clipboard.pasteImage` branch and returns (`dist/modes/interactive/
 * components/custom-editor.js:63-70`). While we hold the shortcut, an empty
 * keybinding entry therefore changes nothing except adding a shortcut-conflict
 * diagnostic — the key only comes back when we stop claiming it.
 *
 * Read per call, never cached at module scope: pi caches the extension factory
 * (`dist/core/extensions/loader.js:461-489`) but re-invokes it per session, and
 * the composed suite calls the registration from its own `session_start`
 * handler, so a module-level flag would freeze the first session's answer.
 */
export function suiteMayClaimPasteKey(): boolean {
  return loadConfig<ImagePasteConfig>(NAMESPACE, IMAGE_PASTE_DEFAULTS).suppressNativePaste !== false;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The reload path shared by the first-run offer and the restore: notify, then
 * call `ExtensionCommandContext.reload` if this runtime puts it on the ctx
 * (Pi 0.85.1 attaches it to the command context only, so the event ctx may have
 * no `reload` — then the user is told to run `/reload` instead).
 *
 * `reload()` must be the LAST use of `ctx` — the reload invalidates this
 * extension instance. A rejected reload is swallowed: the TUI shows its own
 * "Reload failed" status and the session continues on the still-valid ctx.
 *
 * `opts.notify` (default `true`) suppresses BOTH messages, for a caller running
 * on a UI-less ctx: the texts are UI messages and `runNativePasteRestore`'
 * contract is to stay silent when `ctx.hasUI` is false. The reload itself is
 * unaffected — a host that exposes `reload` still gets the file re-read.
 *
 * @returns `true` iff a reload was available and completed.
 */
async function reloadAfterKeybindingChange(
  ctx: ExtensionContext,
  notifyText: string,
  hintText: string,
  opts?: { notify?: boolean },
): Promise<boolean> {
  const shouldNotify = opts?.notify ?? true;
  // Cast: reload() is typed on ExtensionCommandContext; the session_start
  // handler receives the base ExtensionContext, hence the presence guard.
  const reload = (ctx as ExtensionCommandContext).reload;
  if (typeof reload !== "function") {
    if (shouldNotify) ctx.ui.notify(hintText, "info");
    return false;
  }
  if (shouldNotify) ctx.ui.notify(notifyText, "info");
  try {
    await reload();
    return true;
  } catch {
    // Swallowed on purpose: the TUI shows its own "Reload failed" status, and
    // the file change is already persisted, so a manual /reload heals it.
    return false;
  }
}

/**
 * Persist `keybindingsPromptDone: true` via updateConfig: optimistic re-read
 * check + bounded retry, so a concurrent write to settings.json (e.g. another
 * session's /plugins toggle) is detected and re-read — the flag save cannot
 * clobber a newer `enabled` value. Never throws: a failed save notifies and
 * leaves the flag unset (gate 4 blocks the re-offer once the file exists anyway).
 */
function markPromptDone(ctx: ExtensionContext): void {
  try {
    updateConfig<PromptConfig>(
      NAMESPACE,
      PROMPT_DEFAULTS,
      (cfg) => ({ ...cfg, keybindingsPromptDone: true }),
    );
  } catch (error) {
    ctx.ui.notify(
      `Could not persist keybinding prompt flag: ${messageOf(error)}`,
      "warning",
    );
  }
}

/**
 * First-run keybinding offer (once ever, all platforms).
 *
 * On the first TUI session, if `~/.pi/agent/keybindings.json` does not exist,
 * offer to create it with the docs snippet so Pi's built-in clipboard paste
 * doesn't double-fire with image-paste's Ctrl+V handler. Accepting writes the
 * file (atomic tmp+rename, pre-rename existence re-check) and then sets the
 * one-shot flag and, when the runtime exposes `reload()` on the session ctx,
 * reloads the TUI (the exact /reload flow: re-reads keybindings.json and
 * re-binds shortcuts) so the cleared built-in binding applies immediately. On
 * Pi 0.85.1 the event ctx has no `reload`, so the user is notified to run
 * `/reload` instead. Declining or cancelling (Esc/timeout — `confirm`
 * resolves `false` either way) sets the flag without touching the file. A
 * failed file write leaves the flag unset, so the offer self-heals next session.
 *
 * **Concurrent-session edge:** if the user runs `/new` or `/reload` while the
 * confirm dialog is still open, `ctx.ui.confirm` resolves `false` (the TUI
 * tears down). This counts as a decline — the flag is set and the offer will
 * not appear again. To reset it, delete `archimedes.imagePaste.keybindingsPromptDone`
 * from `~/.pi/agent/settings.json`.
 *
 * **Return contract:** resolves `true` iff the offer triggered a successful
 * `ctx.reload()` (the successful-accept path on a ctx that exposes `reload()`
 * and the reload completed). Every other outcome — the gates (1–4), decline,
 * a failed file write, the file-exists race, a base-shape ctx without
 * `reload` (manual /reload hint), and a reload that itself failed (the TUI
 * shows its own "Reload failed" and the session continues on the still-valid
 * ctx) — resolves `false`. The meta factory uses this to sequence the
 * first-run flows: if `true`, the reloaded session runs the flow again (where
 * the offer is a no-op — keybindings.json now exists), so it skips the
 * onboarding on the now-stale ctx.
 */
export async function offerKeybindingFix(ctx: ExtensionContext): Promise<boolean> {
  // Gate 1: extension on.
  // NOTE: reading archimedes.imagePaste.enabled in-package is a sanctioned
  // exception to the AGENTS.md "Plugin on/off" rule and ADR 0012 — this
  // function runs from the meta session_start handler before plugin
  // registration, so there is no registration gate to catch it here.
  // See docs/decisions/0012-plugin-gate-in-package-namespace.md § Exception.
  if (!isConfigEnabled(NAMESPACE)) {
    return false;
  }

  // Gate 2: interactive TUI only. Deliberate: the flag is NOT consumed in
  // non-TUI modes, so a later TUI session still gets the offer.
  if (ctx.mode !== "tui") {
    return false;
  }

  // Gate 3: not yet consumed
  if (loadConfig<PromptConfig>(NAMESPACE, { ...PROMPT_DEFAULTS }).keybindingsPromptDone === true) {
    return false;
  }

  // Gate 4: file absent — never merge into or rewrite an existing user file
  const keybindingsPath = join(getAgentDir(), "keybindings.json");
  if (existsSync(keybindingsPath)) {
    return false;
  }

  // Gate 5: ask (confirm signature is TITLE first — docs/extensions.md:165)
  const confirmed = await ctx.ui.confirm(CONFIRM_TITLE, CONFIRM_MESSAGE);

  // No, or cancel (Esc/timeout — `confirm` resolves `false` either way counts
  // as decline): set the flag and do nothing else.
  if (!confirmed) {
    markPromptDone(ctx);
    return false;
  }

  // Yes: write the file atomically (tmp + rename) — strictly BEFORE the flag
  // is set, so a failed write leaves both gates open and the offer self-heals.
  const tmpPath = `${keybindingsPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, SNIPPET_JSON, "utf-8");
    // Re-check immediately before the rename so a concurrently created file is
    // never clobbered (TOCTOU).
    if (existsSync(keybindingsPath)) {
      // Someone created the file in the meantime: leave it intact, clean up
      // our tmp, and end the offer (gate 4 blocks re-offer anyway).
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      markPromptDone(ctx);
      return false;
    }
    renameSync(tmpPath, keybindingsPath);
  } catch (error) {
    // File write (or rename) failed: do NOT set the flag — the offer self-
    // heals next session. Best-effort tmp cleanup first.
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    ctx.ui.notify(
      `Could not create keybindings.json: ${messageOf(error)}`,
      "warning",
    );
    return false;
  }

  // File written successfully → THEN set the flag (deliberately after the
  // write, per the design).
  markPromptDone(ctx);

  // Auto-apply goes through the shared reload path
  // ({@link reloadAfterKeybindingChange}): notify, then reload() when this
  // runtime puts it on the ctx. `true` means a reload was triggered, so the
  // caller skips the onboarding on the now-stale ctx; a failed reload is
  // swallowed there (the TUI shows its own "Reload failed"), and the offer
  // never throws.
  return reloadAfterKeybindingChange(ctx, CREATED_NOTIFY, CREATED_RELOAD_HINT);
}

// ── restoreNativePaste — ADR 0030, Amendment (2026-10-13) ───────────────────
//
// "Declining to suppress" cannot help the user who already accepted the
// first-run offer: they hold `~/.pi/agent/keybindings.json` containing our
// unbinding, which is exactly why pi's native `app.clipboard.pasteImage` is
// dead. So `archimedes.imagePaste.suppressNativePaste: false` has to give the
// key back by deleting our own artefact from that file — the narrow exception
// to gate 4's "never rewrite an existing user keybindings file" rule. See
// docs/decisions/0030-image-paste-superset-not-supplement.md § Amendment.

/**
 * Why a file was left alone. All of these mean the same thing to the user —
 * "this one is yours, here is the line to delete" — but the distinction is
 * worth keeping in the diagnostic.
 */
export type UntouchedReason =
  /** Valid JSON that is not an object (an array, a string, a number…). */
  | "not-an-object"
  /** Any key we did not write, including a `$schema` with another URL. */
  | "extra-key"
  /** `app.clipboard.pasteImage` present with a value that is not `[]`. */
  | "binding-not-empty"
  /** The file does not parse. */
  | "unparsable"
  /** The file exists but cannot be read (EISDIR, EACCES…). */
  | "unreadable";

/** What {@link restoreNativePaste} did to `keybindings.json`. */
export type RestoreNativePasteStatus =
  /** No file at all — nothing to restore, nothing written. */
  | { kind: "missing"; path: string }
  /** The file already parses to `{}` — reported WITHOUT rewriting it. */
  | { kind: "already-restored"; path: string }
  /** Our artefact was removed and `{}` written; pi must re-read the file. */
  | { kind: "restored"; path: string; reloadRequired: boolean }
  /** Left byte-for-byte alone; `manualEdit` is the one-line fix. */
  | { kind: "untouched"; path: string; reason: UntouchedReason; manualEdit: string }
  /**
   * The rewrite itself failed (EACCES, EISDIR, ENOSPC…); the file is intact.
   * A symlink LOOP is NOT in this case: `existsSync` follows links, so a loop —
   * like a dangling link — reads as `"missing"` and the write is never
   * attempted. Verified by test.
   */
  | { kind: "failed"; path: string; error: string; manualEdit: string };

/**
 * What {@link runNativePasteRestore} did — the restoration statuses plus
 * `"suppressed"`, meaning the settings did not ask for the key back.
 */
export type NativePasteRestoreOutcome =
  | RestoreNativePasteStatus
  | { kind: "suppressed" };

/**
 * The once-per-process notify guard. It lives on `globalThis`, NOT in module
 * scope, and module scope cannot work here: pi re-evaluates the extension
 * module on every load — `loadExtensionModule()` builds a fresh jiti with
 * **`moduleCache: false`** each time it imports an extension (pi 1.2.0
 * `dist/core/extensions/loader.js:477-481`, `moduleCache: false` at `:478`, the
 * import at `:481`), and `ctx.reload()` clears the cached factory first
 * (`dist/core/resource-loader.js:359` → `clearExtensionCache()`, defined at
 * `dist/core/extensions/loader.js:89-93`). So a `let` at module scope is
 * re-created on `/reload` and the user would be re-warned about the same
 * untouched file.
 *
 * Both codebases already use this exact technique for this exact reason: pi
 * keeps its theme instance on `globalThis` under a `Symbol.for` key — "Use
 * globalThis to share theme across module loaders (node + jiti in dev mode)"
 * (`dist/modes/interactive/theme/theme.js:500-517`; comment `:502`, key `:503`,
 * read `:509`, writes `:516-517`) — and our own deleted `packages/core/src/bus.ts`
 * was a `globalThis` singleton for the same reason.
 */
const RESTORE_NOTIFIED_KEY = Symbol.for("pi-archimedes:image-paste:restore-notified");

/** Spend the guard: `true` the first time per process, `false` afterwards. */
function claimRestoreNotice(): boolean {
  const g = globalThis as Record<symbol, unknown>;
  if (g[RESTORE_NOTIFIED_KEY] === true) return false;
  g[RESTORE_NOTIFIED_KEY] = true;
  return true;
}

/** The one-line manual edit for a file the extension must not touch. */
function manualEditLine(path: string): string {
  return (
    `To give the paste key back to pi, remove the "${UNBIND_KEY}" entry from ` +
    `${path} and run /reload.`
  );
}

function agentKeybindingsPath(): string {
  return join(getAgentDir(), "keybindings.json");
}

/**
 * True only for the artefact this suite has written, in either of its two
 * shapes:
 *
 * * before PR #123 — `{ "app.clipboard.pasteImage": [] }`
 * * since PR #123 — `{ "$schema": "https://pi.dev/schemas/keybindings.schema.json",
 *   "app.clipboard.pasteImage": [] }`
 *
 * **Accept-set decision (the amendment asks for it explicitly):** the `$schema`
 * + `app.clipboard.pasteImage: []` pair IS accepted, because that is literally
 * what the suite writes today — refusing it would leave every current install
 * unable to give the key back without a hand edit. `$schema` counts as ours
 * only with pi's published URL, which keeps the set closed without widening it.
 * Nothing else is ever accepted: not a third key, not a different `$schema`,
 * not a non-empty binding.
 */
function isSuiteOwnedUnbinding(obj: Record<string, unknown>): boolean {
  const binding = obj[UNBIND_KEY];
  if (!Array.isArray(binding) || binding.length !== 0) return false;
  const keys = Object.keys(obj);
  if (keys.length === 1) return true;
  return (
    keys.length === 2 &&
    keys.every((key) => key === UNBIND_KEY || key === "$schema") &&
    obj["$schema"] === PI_KEYBINDINGS_SCHEMA_URL
  );
}

/**
 * Remove the suite's `app.clipboard.pasteImage` unbinding from
 * `~/.pi/agent/keybindings.json` and return what it did. **It never logs and
 * never notifies** — the caller surfaces the outcome (see
 * {@link runNativePasteRestore}), so one run per session cannot produce two
 * messages and a headless caller stays silent on its own.
 *
 * Rules (ADR 0030 amendment):
 *
 * * Only ever acts on the suite's own artefact, and the write only ever
 *   *removes* the key — the result is `{}`.
 * * Anything else — extra keys, a non-empty binding, a foreign `$schema`, a
 *   file that does not parse or cannot be read — is left byte-for-byte alone,
 *   and the returned `"untouched"` status carries the path plus the one-line
 *   edit the user must make themselves.
 * * Idempotent by content: `{}` is reported as `"already-restored"` **without a
 *   rewrite**, so the flag cannot touch a user file on every session start.
 * * Writes atomically through {@link writeAtomicPreservingSymlinks}, so a
 *   `keybindings.json` that is a symlink to somewhere else stays a symlink
 *   (the offer's own tmp+rename-onto-path is deliberately NOT reused — it only
 *   ever *creates* a missing file, where link preservation cannot matter). A
 *   DANGLING link never reaches that helper either: `existsSync` follows the
 *   link, so the status is `"missing"` and nothing is written through it.
 * * Never throws: a failed write comes back as `"failed"`.
 */
export function restoreNativePaste(): RestoreNativePasteStatus {
  const path = agentKeybindingsPath();
  if (!existsSync(path)) return { kind: "missing", path };

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { kind: "untouched", path, reason: "unreadable", manualEdit: manualEditLine(path) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "untouched", path, reason: "unparsable", manualEdit: manualEditLine(path) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "untouched", path, reason: "not-an-object", manualEdit: manualEditLine(path) };
  }

  const obj = parsed as Record<string, unknown>;
  // Already restored: report it and leave the bytes (and their mtime) alone.
  if (Object.keys(obj).length === 0) return { kind: "already-restored", path };

  if (!isSuiteOwnedUnbinding(obj)) {
    // Root cause, for the log: the binding itself being someone else's beats
    // "there is a key we did not write" (a foreign `$schema` alongside a real
    // `[]` unbinding is the extra key, not a live binding).
    const binding = obj[UNBIND_KEY];
    const reason: UntouchedReason =
      UNBIND_KEY in obj && !(Array.isArray(binding) && binding.length === 0)
        ? "binding-not-empty"
        : "extra-key";
    return { kind: "untouched", path, reason, manualEdit: manualEditLine(path) };
  }

  try {
    writeAtomicPreservingSymlinks(path, "{}");
  } catch (error) {
    return { kind: "failed", path, error: messageOf(error), manualEdit: manualEditLine(path) };
  }
  return { kind: "restored", path, reloadRequired: true };
}

/** One-line detail for `diag` — path and key included, never the console. */
function describeRestoreStatus(status: RestoreNativePasteStatus): string {
  switch (status.kind) {
    case "missing":
      return `restoreNativePaste: nothing to restore — ${status.path} does not exist`;
    case "already-restored":
      return `restoreNativePaste: already restored — ${status.path} holds no keys (no rewrite)`;
    case "restored":
      return (
        `restoreNativePaste: restored — removed "${UNBIND_KEY}" from ${status.path}, ` +
        `wrote {} (reloadRequired=${status.reloadRequired})`
      );
    case "untouched":
      return (
        `restoreNativePaste: untouched (${status.reason}) — ${status.path} was left as-is. ` +
        status.manualEdit
      );
    case "failed":
      return `restoreNativePaste: failed — ${status.path}: ${status.error}. ${status.manualEdit}`;
  }
}

/**
 * The `session_start` call site: read the setting, restore if asked, and surface
 * the outcome. Runs from whichever path loaded the package — image-paste's own
 * `session_start` registration for standalone installs, or meta's composed
 * `session_start` for the suite — and from each exactly once per session.
 * Handlers stay registered at the top level of the registering factory, never
 * nested (AGENTS.md).
 *
 * Surfacing rule: the actionable "this file is yours" outcome gets one
 * `ctx.ui.notify(…, "warning")` **per process** — the guard lives on
 * `globalThis` (see {@link RESTORE_NOTIFIED_KEY}) because a module-level flag
 * would be reset by `/reload`. `diag("image-paste", …)` carries the detail on
 * every outcome and both may fire, but `diag` cannot be the only channel: it is
 * a no-op unless `PI_ARCHIMEDES_LOG` names a file, so a default install would be
 * silent while pi's paste stayed dead. No notify at all when `ctx.hasUI` is
 * false — on ANY outcome, including a successful restore, whose info and
 * `/reload`-hint texts are UI messages too — and a headless run does not spend
 * the guard. Nothing here uses
 * `console.*` (`docs/features/ui.md`, guarded by
 * `packages/core/src/log-discipline.test.ts`).
 *
 * A successful restore goes through the existing reload path so pi re-reads
 * `keybindings.json`; on a ctx without `reload` the returned status says
 * `/reload` is required. Never throws — a session start must not fail because a
 * keybinding file is awkward.
 */
export async function runNativePasteRestore(
  ctx: ExtensionContext,
): Promise<NativePasteRestoreOutcome> {
  // Same predicate the shortcut gate reads, so the file restore and the
  // registration can never disagree about what the user asked for.
  if (suiteMayClaimPasteKey()) {
    return { kind: "suppressed" };
  }

  const status = restoreNativePaste();
  diag(
    "image-paste",
    `[archimedes:restore-native-paste] ${describeRestoreStatus(status)}`,
  );

  if (status.kind === "untouched" || status.kind === "failed") {
    // Both mean "we did not touch it, and only you can" — one actionable
    // warning naming the path plus the key, spent at most once per process, and
    // saying plainly that the paste key is unbound in the meantime (the
    // shortcut gate is off for this same setting, so nothing answers it).
    // NOTE the deliberate corner: a file holding only foreign keys and no
    // `app.clipboard.pasteImage` entry lands here too (pi's action is already
    // live in that case). We still never touch the file, and the message names
    // the entry to delete rather than asserting it is present.
    if (ctx.hasUI && claimRestoreNotice()) {
      const failure =
        status.kind === "failed" ? `The write failed (${status.error}). ` : "";
      // The second sentence is the new half of the promise: with the flag off
      // image-paste registers NO paste shortcut, so a file we may not rewrite
      // leaves the key unbound by anyone. Without it the warning reads like
      // "nothing changed", and a dead Ctrl+V looks like a broken extension
      // rather than the state the setting describes.
      ctx.ui.notify(
        `image-paste did not change ${status.path}. ${failure}${status.manualEdit} ` +
          "image-paste is not binding the paste key either (suppressNativePaste is off), " +
          "so that key does nothing until you do.",
        "warning",
      );
    }
    return status;
  }

  if (status.kind === "restored") {
    // Last use of ctx: reload() invalidates this extension instance.
    // `notify: ctx.hasUI` keeps the silence promise for a UI-less ctx: the
    // restore still runs and `diag` still records it, but no UI message is
    // pushed at a host that said it has no UI.
    const reloaded = await reloadAfterKeybindingChange(
      ctx,
      RESTORED_NOTIFY,
      RESTORED_RELOAD_HINT,
      { notify: ctx.hasUI },
    );
    return { ...status, reloadRequired: !reloaded };
  }

  // "missing" / "already-restored": nothing happened and nothing is asked of
  // the user, so no notify — the log line above is the record.
  return status;
}

