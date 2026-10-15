---
status: live
last-verified: 2026-10-15
verified-by: "npx vitest run — packages/image-paste/src/keybinding-offer.test.ts (180 tests: gate matrix, return contract, auto-reload fallback + branch ordering, updateConfig concurrency, generated $schema, the offer text, the accept-set and its edges, one refusal test per refuse reason for the untouched warning, one per claim the wording makes about the file, the gate 1b paste-key skip with its reversible-hatch case and its `existsSync`-spy proof that the hatch-off path never names keybindings.json, and the offer/restore mutual exclusion driven in meta's order including the sequenced pair across a settings change) + packages/image-paste/src/shortcut-gate.test.ts (9 tests: the paste shortcut is not registered while suppressNativePaste is false, per session) + meta/src/factory-lifecycle.test.ts (13 tests: merged first-run handler wiring + sequencing) + meta/src/readme-agreement.test.ts (6 tests: README.md and meta/README.md agree on what the suite writes to keybindings.json, and no user-facing page carries a claim the code makes false). Re-run whole-suite on 2026-10-15 for the gate 1b fix: 2461 tests / 146 files. The before/after frames in the table above are that vitest measurement (a scratch agent dir, two base-shape ctxs), not a terminal capture. The pi-behaviour claims in this file rest on the earlier live capture of 2026-10-14 against pi 1.2.0 in a scratch PI_CODING_AGENT_DIR; the loader claims (legacy-name rename, whole-file discard) were checked against pi 1.2.0 and 0.87.0 dist/core/keybindings.js, and nothing in the gate 1b change re-ran either."
---

# First-run keybinding offer

## What it is

On the first TUI session where the image-paste plugin is active (via suite
composition), if `~/.pi/agent/keybindings.json` is absent **and the suite is
going to hold the paste key** (gate 1b: `suppressNativePaste` is not `false`),
the suite offers once to create it with the docs snippet:

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
1b. **The suite is going to hold the paste key** — `suiteMayClaimPasteKey()`
   must return true (issue #133). `archimedes.imagePaste.suppressNativePaste:
   false` means the install has asked for pi's own paste, and the two halves of
   that promise are already in force elsewhere: `registerImagePaste` registers no
   paste shortcut, and `runNativePasteRestore` removes our unbinding from the
   file. So there is nothing for the offer to fix, and running it would have been
   actively harmful — on a fresh profile it would ask permission to write the very
   entry that leaves `ctrl+v` bound to nobody (pi's action cleared by the file,
   our handler deliberately absent), and the next session's restore would empty
   that file and announce that it had. Like gate 2, this gate does **not** consume
   `keybindingsPromptDone`: the setting is reversible, and the user who closes the
   hatch again has to meet the offer in a later session — the skip leaves the
   offer armed.
   *
   *Why it is numbered 1b rather than inserted as gate 2:* it is a settings read
   of the same namespace as gate 1 and answers the same question ("does this
   install want this flow at all"), so the two configuration preconditions sit
   together. That position also puts the skip ahead of gate 4's stat of
   `keybindings.json` — asserted, not narrated: gate 4's check is
   `existsSync(keybindingsPath)`, `node:fs`'s `existsSync` is spied in the test
   file, and the hatch-off rows assert the path is never named. (Gate 3's flag
   read is also skipped by position, but it is not observable from outside —
   gate 1b reads settings.json itself, as gate 1 already did — so nothing claims
   to prove it.) Renumbering 2/3/4/5 was rejected: those numbers are quoted
   outside the code (this file, ADR 0030's amendment — "gate 4 of the first-run
   offer refuses to touch a file that is already there" — and comments in
   `keybinding-offer.test.ts`), and a renumber would silently point them at the
   wrong check. Gate 1 keeps first place because the ADR 0012 exception it
   documents is the outermost condition, and gate 2 keeps its own reason for not
   consuming the flag in non-TUI modes.
2. **TUI mode** — `ctx.mode === "tui"`. The flag is deliberately NOT consumed in
   non-TUI modes (`rpc`, `json`, `print`), so a later TUI session still gets
   the offer.
3. **Flag unset** — `loadConfig("archimedes.imagePaste", { keybindingsPromptDone: false }).keybindingsPromptDone !== true`.
4. **File absent** — `!existsSync(join(getAgentDir(), "keybindings.json"))`.
5. **Confirm** — `ctx.ui.confirm(title, message)` (title first, per Pi API).

### The invariant: the offer and the restore are mutually exclusive

The offer acts only when `suiteMayClaimPasteKey()` is true (gate 1b); the
restore acts only when it is false (`runNativePasteRestore` returns
`"suppressed"` the moment the predicate is true, and reads the same settings
key with the same strict rule — only a literal `false` counts). **For a given
setting value, exactly one of the two flows can act**, so no session ever
creates `~/.pi/agent/keybindings.json` and then empties it, and one run never
tells the user both *Created ~/.pi/agent/keybindings.json* and *Restored pi's
native clipboard paste* about one file. Issue #133 was exactly that shape: a
fresh profile with the hatch open got the offer, accepted it, and the restore in
the same configuration deleted what had just been created — two contradictory
notices for one file, and a dead `ctrl+v` in between.

What the invariant does **not** forbid is the sequenced pair across a settings
change, and that is deliberate: accept the offer under the default, then set
`suppressNativePaste: false` in a later session, and the restore gives the key
back with its own notice. That is the escape hatch doing what it promises, not a
breach — the exclusivity is per configuration, not per machine. A user who
reports seeing *Created* once and *Restored* later after flipping the setting is
describing correct behaviour; the bug is only when both happen without the
setting ever moving.

The invariant is an artefact, not an intention: the
"the invariant — the offer and the restore cannot both act on keybindings.json"
describe in `packages/image-paste/src/keybinding-offer.test.ts` drives both entry
points in the order `meta/src/index.ts` runs them (the offer from the merged
first-run handler, the restore last in the registration handler because a
successful restore can call `ctx.reload()`), and asserts for every setting value
that at most one flow asks, writes, or speaks about the file. Measured frames for
a fresh profile, before and after the gate:

| Profile (fresh: no `keybindings.json`, no flag) | Before #133 | After #133 |
|---|---|---|
| `suppressNativePaste: false` | confirm asked; file written, then emptied to `{}`; notices: *Created …* **and** *Restored …*; flag spent | confirm never asked; file never created; **no notice at all**; flag still unset (armed) |
| default (key absent) | confirm asked; artefact written; *Created …*; restore `suppressed` | unchanged |
## Offer-once semantics

The `keybindingsPromptDone` flag is set on **every** outcome that reached the
dialog:

- **Accept** (confirm → `true`) — file written, then flag set, then the reload
  path runs: on the Pi versions measured (1.2.0) the event ctx has no `reload`,
  so the user is notified to run `/reload`; a ctx that does expose it reloads
  automatically.
- **Decline** (confirm → `false`) — flag set; file untouched.
- **Cancel** (Esc / session tear-down / timeout — `confirm` resolves `false` either way) — counts as decline; flag set.

The flag is deliberately **not** written by any gate — 1, 1b, 2, 3 and 4 all
return before it. Only reaching the dialog spends it, so every skip is
revisitable: enable the plugin later (gate 1), close the hatch (gate 1b), start a
TUI session instead of a piped one (gate 2) or delete a `keybindings.json` (gate
4) and the offer is still armed. Gate 3 is the terminal one, and it is terminal
only because the dialog already spent the flag — it is the record of an answer,
not a consequence of a skip.

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
ctx that exposes `reload()`). Every other outcome — the gates (1, 1b, 2–4),
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
The gates (1, 1b, 2–4) make any accidental double-wiring a no-op.

## Handing the key back (`suppressNativePaste: false`)

`archimedes.imagePaste.suppressNativePaste: false` is a request for pi's own
paste, and it also silences the offer: gate 1b means an install that will not
hold the key is never asked to unbind it (issue #133, and the invariant above).

`runNativePasteRestore` is the second flow this file owns, and it has two halves
that must both happen — the first half alone was measured on Pi 1.2.0 (captures
below) and does not give anyone their key back:

1. **The file.** `restoreNativePaste()` removes the suite's
   `app.clipboard.pasteImage` entry from `~/.pi/agent/keybindings.json`, leaving
   `{}`. Accept-set: the artefact in either of its two shapes (pre-#123 single
   key, current `$schema` + unbinding pair). Anything else — extra key, foreign
   `$schema`, non-empty binding, unparsable or unreadable file — is left
   byte-for-byte alone, and the one warning it produces branches on the refusal
   (issue #127) instead of ordering every file to delete an entry:

   * still carries our `[]` (a foreign key beside it, or a write that failed) →
     remove that entry and run `/reload`; until it goes nothing answers the key,
     because `suppressNativePaste: false` took our shortcut with it;
   * `app.clipboard.pasteImage` bound by the user → the same instruction, but
     named as **their** binding, and the key is not called dead (their binding
     answers it). If Pi's pre-rename name `pasteImage` sits behind it with `[]`,
     the warning says to clear that entry too — Pi drops the legacy entry only
     while the modern key exists (`keybindings.js:260-264`), so deleting one and
     leaving the other re-deads the key;
   * `[]` under Pi's old name `pasteImage`, and no modern key → the same dead key
     and the same fix, but the entry is named the way the file spells it — naming
     `app.clipboard.pasteImage` here would send the user looking for a line that
     is not in the file. Pi renames it on the way in
     (`KEYBINDING_NAME_MIGRATIONS`, `keybindings.js:225`), which is why the old
     spelling clears the action at all; we never wrote it, so it is refused and
     explained, never rewritten;
   * foreign keys only, or `$schema` only → nothing of ours to clean up and
     nothing for the user to edit: Pi's own paste already answers the key on its
     default binding, so no reload is asked for. No claim is made about who wrote
     the file — `$schema` with Pi's published URL is byte-for-byte what the offer
     writes, and a hand-written file can carry the same line;
   * unreadable, unparsable, not a JSON object → the file is named and the cause
     is named, and what Pi does next is named too: it discards a file it cannot
     use and every action keeps its default (`loadRawConfig` → `{}`,
     `keybindings.js:285-297`), so Pi's paste is answering the key and none of
     the user's other bindings in that file are in force. The user is asked to
     check the file and run `/reload` once it is readable again — no entry is
     named, because none can be seen.

   Every variant names the file path, and `diag` carries the reason on every
   outcome — the same `manualEdit` string the warning shows, so the log and the
   warning cannot tell two stories about one file (asserted, not merely
   intended). Each is pinned by name in `keybinding-offer.test.ts` ("the refuse
   warning says what this file actually holds" and "the refuse warning vs pi's
   own keybindings loader"), so re-merging them into one string is a test failure
   rather than a silent regression.
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
| `archimedes.imagePaste.keybindingsPromptDone` | `false` (absent) | Set to `true` on any outcome that reached the dialog. Not set by the gate 1b and gate 2 skips. Delete to reset the offer. |
| `archimedes.imagePaste.suppressNativePaste` | `true` (absent) | `false` asks for the key back: the file restore above **and** no paste shortcut registered. It also keeps the first-run offer silent (gate 1b) — nothing to unbind. Strict boolean — `"false"` and `0` keep the default. |

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
