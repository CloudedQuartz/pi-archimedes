---
status: live
last-verified: 2026-10-14
verified-by: "npx vitest run — packages/image-paste/src/keybinding-offer.test.ts (155 tests: gate matrix, return contract, auto-reload fallback + branch ordering, updateConfig concurrency, generated $schema, the offer text and the untouched warning) + packages/image-paste/src/shortcut-gate.test.ts (9 tests: the paste shortcut is not registered while suppressNativePaste is false, per session) + meta/src/factory-lifecycle.test.ts (13 tests: merged first-run handler wiring + sequencing). Live capture 2026-10-14 against pi 1.2.0 in a scratch PI_CODING_AGENT_DIR."
---

# First-run keybinding offer

## What it is

On the first TUI session where the image-paste plugin is active (via suite
composition), if `~/.pi/agent/keybindings.json` is absent, the suite offers
once to create it with the docs snippet:

```json
{ "$schema": "https://pi.dev/schemas/keybindings.schema.json", "app.clipboard.pasteImage": [] }
```

This clears Pi's built-in `app.clipboard.pasteImage` binding (Ctrl+V on
Linux/macOS, Alt+V on Windows). It is not a clash of two handlers running: with
both bindings live **only one runs**, because `app.clipboard.pasteImage` is not
on Pi's `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS` list, so the extension
shortcut is kept (`ExtensionRunner.getShortcuts`, `dist/core/extensions/runner.js:467-474`)
and `CustomEditor.handleInput` consults `onExtensionShortcut` and returns before
its `app.clipboard.pasteImage` branch (`dist/modes/interactive/components/custom-editor.js:63-70`).
Measured on Pi 1.2.0 (scratch agent dir, stubbed clipboard): one `ctrl+v`, one
insertion — the extension's — and a `[Extension issues]` line
(`Extension shortcut conflict: 'ctrl+v' is built-in shortcut for
app.clipboard.pasteImage and <ext>. Using <ext>`) at every session start. The
offer exists to remove that permanent warning and make the split of the key
explicit. The user must accept; the file is never created silently.

The `$schema` key is the second half of the artefact and it changes nothing at
runtime: Pi's loader skips it (`if (key === "$schema") continue;`,
`dist/core/keybindings.js:247-248`), and Pi validates *theme* JSON at startup,
not keybindings (`KeybindingsSchema` at `dist/core/keybindings-schema.js:13`
has no startup validator). It is for editors and standalone validators — the
file it points at declares `$schema` as a string and accepts the unbinding, and
the generated snippet is checked against that published schema.

> **Note for the restoration work (ADR 0030 Amendment 2026-10-13, and the
> 2026-10-14 follow-up).** The artefact this offer writes has two keys, so "is
> this the file the suite created?" is decided deliberately against
> `$schema` + `app.clipboard.pasteImage: []` — see `isSuiteOwnedUnbinding` and
> ADR 0030's amendment for the accept-set as shipped. And removing that entry is
> only half of handing the key back: while image-paste registers a shortcut for
> the same key, Pi keeps the shortcut and the restored native binding never
> runs, so `registerImagePaste` registers nothing while the setting is off.
> See ADR 0030 (`docs/decisions/0030-image-paste-superset-not-supplement.md`) and
> the package-facing write-up in `docs/features/image-paste.md`.

## Gates (evaluated in order)

1. **Config enabled** — `isConfigEnabled("archimedes.imagePaste")` must return
   true. This is the sanctioned ADR 0012 exception: the check runs in-package,
   from the meta `session_start` handler, before plugin registration, so there
   is no registration gate available. See
   `docs/decisions/0012-plugin-gate-in-package-namespace.md § Exception`.
2. **TUI mode** — `ctx.mode === "tui"`. The flag is deliberately NOT consumed in
   non-TUI modes (`rpc`, `json`, `print`), so a later TUI session still gets
   the offer.
3. **Flag unset** — `loadConfig("archimedes.imagePaste", { keybindingsPromptDone: false }).keybindingsPromptDone !== true`.
4. **File absent** — `!existsSync(join(getAgentDir(), "keybindings.json"))`.
5. **Confirm** — `ctx.ui.confirm(title, message)` (title first, per Pi API).

## Offer-once semantics

The `keybindingsPromptDone` flag is set on **every** outcome:

- **Accept** (confirm → `true`) — file written, then flag set, then the reload
  path runs: on the Pi versions measured (1.2.0) the event ctx has no `reload`,
  so the user is notified to run `/reload`; a ctx that does expose it reloads
  automatically.
- **Decline** (confirm → `false`) — flag set; file untouched.
- **Cancel** (Esc / session tear-down / timeout — `confirm` resolves `false` either way) — counts as decline; flag set.

To reset the offer, delete the `keybindingsPromptDone` key from
`archimedes.imagePaste` in `~/.pi/agent/settings.json`.

**Concurrent-session edge:** if the user runs `/new` or `/reload` while the
confirm dialog is open, `ctx.ui.confirm` resolves `false` (the TUI tears down).
This counts as a decline — the flag is set and the offer does not appear again.

## Consent-based, atomic file write

The file is created **only on accept and only when absent**. Write is atomic:

1. Write to `<keybindingsPath>.<pid>.tmp`.
2. **Pre-rename existence re-check** — if the file was created concurrently in
   the window between gate 4 and the rename, the tmp is removed and the offer
   ends without clobbering the existing file. Flag is set (gate 4 will block
   any re-offer anyway).
3. `renameSync(tmpPath, keybindingsPath)` — atomic on POSIX, best-effort on
   Windows.

**File write strictly before flag set.** If the write throws (including the
rename), the flag is NOT set and the offer self-heals next session. A failed
write notifies the user via `ctx.ui.notify` and returns without crashing.

## Auto-reload on accept

After a successful write and flag set, the module checks whether the runtime
exposes `reload()` on the session ctx. If it does, it calls `await
ctx.reload()` — the exact `/reload` TUI flow: re-reads `keybindings.json` and
re-binds extension shortcuts, so the cleared built-in binding applies
immediately. On the versions measured — Pi 0.85.1 (as previously recorded) and
Pi 1.2.0 (measured live: the message the user sees after a restore is the
"run /reload to apply" hint) — `reload()` is attached only to the **command**
context (`runner.js` `createCommandContext`, `context.reload` at `:753`); the
base context event handlers receive has none, so on today's Pi the auto-reload
branch never fires and the notification is the path that runs. It stays for a
version that adds `reload` to the event ctx.

When a reload is attempted, it **must be the last use of `ctx`** — Pi
invalidates the extension runtime on reload. If the reload fails, the TUI
shows its own "Reload failed" status; the file and flag are already
persisted, so a manual `/reload` heals it and the offer is not repeated
(flag gate). A **failed** reload leaves the (still-valid) ctx in place, so
the offer reports `false` and the onboarding still runs on this session.

## Return contract

`offerKeybindingFix` returns `Promise<boolean>`: `true` iff the offer
triggered a **successful** `ctx.reload()` (the successful-accept path on a
ctx that exposes `reload()`). Every other outcome — the gates (1–4),
decline, a failed file write, the file-exists race, a base-shape ctx without
`reload` (manual /reload hint), and a reload that itself failed — resolves
`false`.

## Wiring

`offerKeybindingFix(ctx)` is awaited from a **top-level** `session_start`
handler in `meta/src/index.ts` `register()` — top-level per the AGENTS.md
rule (nested registration accumulates on `/reload`). The handler is the
single **merged first-run handler**: it awaits the offer (a throw is logged,
never propagated — the offer never fails session startup) and, unless the
offer returned `true` (a reload was triggered — the reloaded session runs
the flow again, where the offer is a no-op), it kicks off the first-run
onboarding (`runOnboarding`, fire-and-forget) on the same ctx. Sequencing
the two first-run flows this way means the keybinding confirm (a selector
that replaces the editor container) fully resolves BEFORE the onboarding
overlay shows — no stacked first-run dialogs.

The handler is **not** double-gated with `isPluginEnabled("image-paste")`:
that helper resolves to the same `archimedes.imagePaste.enabled` key as gate 1,
so the check would be redundant. A standalone install (the package's own default
export, loaded directly by Pi) does **not** receive the offer — nothing on that
path calls `offerKeybindingFix`. It is **not** true that standalone mode has no
`session_start` hook: the default export registers its own top-level
`session_start` handler, which resets the per-session queue and runs the
native-paste restore (observed in the live captures below, where a standalone
install restored the file from that handler). So exactly one restore runs per
session, from whichever path loaded the package; the offer runs only under meta.
The five gates make any accidental double-wiring a no-op.

## Handing the key back (`suppressNativePaste: false`)

`runNativePasteRestore` is the second flow this file owns, and it has two halves
that must both happen — the first half alone was measured on Pi 1.2.0 (captures
below) and does not give anyone their key back:

1. **The file.** `restoreNativePaste()` removes the suite's
   `app.clipboard.pasteImage` entry from `~/.pi/agent/keybindings.json`, leaving
   `{}`. Accept-set: the artefact in either of its two shapes (pre-#123 single
   key, current `$schema` + unbinding pair). Anything else — extra key, foreign
   `$schema`, non-empty binding, unparsable or unreadable file — is left
   byte-for-byte alone and the user gets one warning naming the line to delete,
   now also saying that the paste key is left unbound until they delete it.
   Idempotent by content: a file that already reads `{}` is reported without a
   rewrite.
2. **The key.** `registerImagePaste` reads the same setting
   (`suiteMayClaimPasteKey`) and, while it is `false`, registers **no** paste
   shortcut — `ctrl+v`, `alt+v` and `ctrl+alt+v` all stay with Pi. Without this
   half Pi keeps our shortcut (`runner.js:467-474`) and returns before its own
   paste branch (`custom-editor.js:63-70`), so the restored binding would never
   run. The shortcut loop is the package's only entry point to the paste path, so
   nothing else routes a keypress to our handler; the submit-time marker
   attachment and the preview renderer stay registered.

Both halves are evaluated per session (Pi caches the extension factory but
re-invokes it per session; meta registers from its `session_start` handler).

Measured live on Pi 1.2.0 in a scratch `PI_CODING_AGENT_DIR` with a stubbed
clipboard (`wl-paste` on `PATH` advertising `image/png`): flag off with the
snippet present → the file became `{}`, `/reload` then `ctrl+v` inserted Pi's own
`…/pi-clipboard-<uuid>.png` and nothing else (no `[Image #1]`, no
"Image attached from clipboard."); flag absent → `[Image #1]` plus
"Image attached from clipboard." and `keybindings.json` byte-identical; flipping
the setting and pressing `/new` handed the key over without a restart; with the
plugin disabled via `/plugins` the file was not rewritten at all.

## Settings surface

| Key | Default | Notes |
|-----|---------|-------|
| `archimedes.imagePaste.enabled` | `true` (absent) | Suite-managed; toggled via `/plugins`. Never read at runtime except by this gate. |
| `archimedes.imagePaste.keybindingsPromptDone` | `false` (absent) | Set to `true` on any outcome. Delete to reset the offer. |
| `archimedes.imagePaste.suppressNativePaste` | `true` (absent) | `false` asks for the key back: the file restore above **and** no paste shortcut registered. Strict boolean — `"false"` and `0` keep the default. |

`saveConfig` **replaces** the whole namespace object, so all reads and writes
to `archimedes.imagePaste` must go through load-modify-save or through
`updateConfig`. The flag write uses `updateConfig` (see below).

## `updateConfig` concurrency safety

`markPromptDone` calls `updateConfig<PromptConfig>(namespace, defaults, mutate)`:

1. Reads `settings.json` raw string (`before`).
2. Parses and applies the mutate callback.
3. Reads `settings.json` again (`after`).
4. If `before !== after` **and** attempts remain, discards and retries from step 1,
   recomputing from the freshest state.
5. After `maxAttempts` (default 3) or when a clean window is observed, writes via
   `saveConfig` (which performs its own fresh read for sibling namespaces before
   the atomic rename).

The residual last-writer-wins window between the final `after` check and
`saveConfig`'s internal read cannot be eliminated without file locks. Node core
exposes no portable `flock`/`fcntl`, so optimistic retry is the strongest safe
primitive without new dependencies.
