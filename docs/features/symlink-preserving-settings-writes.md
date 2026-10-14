---
status: live
last-verified: 2026-10-14
verified-by: "read of `packages/core/src/settings-io.ts` (`writeAtomicPreservingSymlinks`, `saveConfig`, `removeConfig`, `updateConfig`) and `packages/image-paste/src/keybinding-offer.ts` on this checkout: the restore path calls `writeAtomicPreservingSymlinks(path, "{}")` and the offer's create path is still `writeFileSync` + `renameSync` with a pre-rename existence re-check; `packages/core/src/settings-io.test.ts` and `packages/image-paste/src/keybinding-offer.test.ts` pass in the suite run (2449 tests / 146 files). No write behaviour changed — the only addition since the last verification is the `$schema` key in the generated snippet, recorded below."
---

# Symlink-preserving settings writes

## What it is

Settings writes — `saveConfig` / `removeConfig` in `packages/core/src/settings-io.ts` and the subagent package's `agents.local.json` writes — are atomic and symlink-preserving. A config file that is a symlink (the Stow/dotfiles scenario: `~/.pi/agent/settings.json` → a dotfiles repo) stays a symlink after a write, and its destination receives the update. A regular file or a missing file behaves exactly as a plain tmp-then-rename would.

## Durable semantics

- **Symlinked file:** the link is resolved to its real destination; the temp file is created beside the destination and the rename targets it. The link is never replaced.
- **Dangling symlink:** a `saveConfig` writes through the link, recreating the destination so the link is live again. A `removeConfig` on a dangling link is a no-op — the link is left untouched.
- **Failed temp write (e.g. ENOSPC):** the temp file is cleaned up and the error re-throws — the live file survives untouched, so a disk-full failure cannot truncate previously-valid settings.
- **Failed rename:** falls back to a direct write-through (which follows symlinks) — best-effort and **non-atomic**: the temp file is removed before the direct write, so if that final write fails mid-way (e.g. disk full) the destination can be truncated. The atomic guarantee (temp write + rename, including the protected failed-temp-write path that leaves the live file untouched) covers the normal path.
- **Symlink loop (ELOOP) / unwritable destination (EACCES):** throw out of the write; nothing is clobbered.

## Implementation

One shared helper, `writeAtomicPreservingSymlinks`, exported from `@pi-archimedes/core` (the `settings-io` subpath), is the single implementation: both `saveConfig` and `removeConfig` delegate to it, and the subagent package's `local-config.ts` writer does the same for `agents.local.json`. image-paste has two writes, and they differ here: the offer's one-shot creation is unaffected by this helper — it only fires when the file is missing, so a live symlink is never hit — while the `suppressNativePaste: false` restore of that same file goes through `writeAtomicPreservingSymlinks`, because a `keybindings.json` that points elsewhere must stay a link when the suite empties its own entry.

## What the generated snippet contains

The offer writes `{ "$schema": "https://pi.dev/schemas/keybindings.schema.json", "app.clipboard.pasteImage": [] }` — the `$schema` line was added so editors and external validators can check the file (Pi itself skips the key when it loads keybindings, and validates *theme* JSON at startup, not keybindings). That changed the file's **content**, not how it is written: the create path is still a plain tmp-file + rename onto a path that must still be absent, and the restore still writes `{}` through `writeAtomicPreservingSymlinks`. The one place the new key has meaning for this feature is the accept-set: `restoreNativePaste()` treats that exact URL as the suite's own, so a file the offer wrote in either shape is restorable, while a `$schema` pointing anywhere else is a foreign key and the file is left alone.
