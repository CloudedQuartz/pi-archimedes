---
status: live
last-verified: 2026-10-14
verified-by: reading `packages/footer/src` (index.ts, utils/stats.ts, utils/git.ts, utils/jj.ts, utils/format.ts, utils/layout.ts, utils/icons.ts, config.ts) against pi 1.2.0's own built-in footer (`dist/modes/interactive/components/footer.js`, with `setExtensionStatus`/`getExtensionStatuses` in `dist/core/footer-data-provider.js` and the slot itself in `setExtensionFooter`, `dist/modes/interactive/interactive-mode.js`) and its examples `custom-footer.ts`, `status-line.ts` and `model-status.ts`, claim by claim, on 2026-10-14; the suite's tests (`npx vitest run` — 2430 tests / 145 files, including `cost-source.test.ts`, `stats.test.ts`, `git.test.ts`, `jj.test.ts`, `layout.test.ts`, `format.test.ts`, `render-smoke.test.ts`) and `tsc --noEmit` clean in all 13 workspace projects. Not verified in this pass: on-screen rendering at assorted widths (see "Not verified in this pass").
---

# Footer (`@pi-archimedes/footer`)

pi's status-bar slot, replaced by a layout that survives a narrow terminal: `dir | branch [+git status] | worktree | model | thinking | extension statuses | ↑ ↓ R W $cost ━ context%`.

It is installed through pi's own mechanism — `ctx.ui.setFooter(factory)` at `session_start` — which is a takeover of one slot, not an extra line: `setExtensionFooter` clears the footer container and adds only the extension's component, so pi's own `FooterComponent` is not drawn alongside it. Its two subscriptions are released on the way out separately — the branch-change one when pi disposes the footer component (`dispose()`), the git/jj change listener at `session_shutdown`.

## Almost every number here is pi's own data

This is the part worth being precise about, because the footer reads as "archimedes' stats" and is mostly a *presentation* layer over numbers pi already computes:

| What the footer shows | Where it comes from |
|---|---|
| Model id | `ctx.model?.id` (`packages/footer/src/index.ts`) |
| Thinking level | `pi.getThinkingLevel()` |
| ↑ input / ↓ output / R cache-read / W cache-write / `$cost` | a scan of the session entries — `ctx.sessionManager.getEntries()` in `packages/footer/src/utils/stats.ts` |
| Context window and percent | `ctx.getContextUsage()` (cached per session/leaf/entry-count/model), falling back to `ctx.model?.contextWindow` |
| Git branch | `footerData.getGitBranch()`, with `footerData.onBranchChange()` to ask for a frame |
| Extension status texts | `footerData.getExtensionStatuses()` — the same values `ctx.ui.setStatus()` writes |

The usage scan is the same rule pi's own footer uses: it sums `usage` entries, assistant-message usage, **tool-result usage**, and `compaction` / `branch_summary` usage (`extractEntryUsage()`), which is also what `FooterComponent.getSessionStats()` in pi's `dist/modes/interactive/components/footer.js` does. That identity is deliberate and load-bearing: it is why a subagent's cost needs no separate channel. The subagent package reports the child's spend as the native `usage` of its tool result (`packages/subagent/src/usage.ts`, `docs/decisions/0028-subagent-closed-allowlist-and-run-outcomes.md`), and the session scan picks it up like any other tool result's. An earlier version also listened for a bus `COST_UPDATE` and added it on top; since the scan already counted it, that accumulator would have billed the same run twice, so it was deleted rather than left dormant (`docs/features/subagent.md`).

## What is ours

Four things on screen have no pi equivalent, plus the layout:

- **jj bookmarks.** `getJjBookmark()` (`packages/footer/src/utils/jj.ts`) runs `jj log -r "heads(::@ & bookmarks()) | @"` with `--ignore-working-copy` — never snapshotting from a render — and its result wins over the git branch when the repo is a jj repo. jj never shells out to git for status, so `getJjChangedFiles()` fills the "unstaged" (`~N`) slot from jj's own changed-file count.
- **The linked-worktree marker.** `isInsideLinkedWorktree()` (`packages/footer/src/utils/git.ts`) reads `git worktree list --porcelain` and compares against the real `cwd`; a linked worktree swaps the branch glyph for the worktree glyph (`footerIcons.worktree`, `packages/footer/src/utils/icons.ts`). It is not shown in a jj repo.
- **Git status counts.** `getGitStatus()` produces staged / unstaged / untracked / ahead / behind, rendered as `●N ~N UN ↑N ↓N` (`formatGitStatusIndicators`, `packages/footer/src/utils/icons.ts`). pi's footer shows the branch name and nothing about its state.
- **The context bar.** `formatContextBar()` draws `icon ━━━━ N%` into whatever columns remain on the last line, coloured at ≥90 % and ≥70 % (`packages/footer/src/utils/format.ts`). Alongside it the stats section prints used-vs-window tokens, `formatTokenCount(used) + "/" + formatTokenCount(window)`. This is consumption, not headroom.
- **Adaptive packing.** `packFooterLines()` (`packages/footer/src/utils/layout.ts`) treats every section as atomic and wraps rather than truncating: one line if everything fits, two when the tail no longer does, three or more when the left sections alone overflow. Below `splitThreshold` (default 150 columns) it forces at least the two-line split. Oversized extension statuses are word-wrapped into chunks (`wrapStatusToChunks`) instead of being cut.

Both VCS probes are cached with a short TTL (2 s) and, once warm, refreshed in the background so a render does not wait on a subprocess — but the *first* probe of a session is deliberately synchronous (`getGitStatus()` and `getJjBookmark()` take the blocking path "so the first render is correct"), so the first frame can pay up to that probe's 2 s timeout. When a reply changes what the footer shows, it asks pi for a frame (`onVcsChange` → `tui.requestRender()`).

If the render throws, the failure is logged through the suite's diagnostics (`diag("footer", …)`, never `console.*` — `docs/features/ui.md`) and the user is told once per session that the status bar is empty.

## Settings

`~/.pi/agent/settings.json`, namespace `archimedes.footer` (`packages/footer/src/config.ts`): `splitThreshold` (default `150`, the width below which the two-line layout is forced) and `branchMaxLength` (default `0` = unlimited; git status indicators are never truncated). In the suite, on/off is `archimedes.footer.enabled` via `/plugins`; per ADR 0012 (`docs/decisions/0012-plugin-gate-in-package-namespace.md`) the package never reads that flag.

## vs pi's own (`custom-footer.ts`, `status-line.ts`, `model-status.ts` — and pi's built-in footer)

The three examples are demonstrations of the *slots*, not of the data:

- **`examples/extensions/custom-footer.ts`** registers a footer behind a `/footer` command and is the closest twin. It computes tokens itself — `for (const e of ctx.sessionManager.getBranch()) { … input += m.usage.input; output += m.usage.output; cost += m.usage.cost.total; }` — and its header comment says why: `footerData` exposes `getGitBranch()` and `getExtensionStatuses()`, "Token stats come from ctx.sessionManager/ctx.model (already accessible)". It renders one line, left stats + right `model (branch)`, joined with padding and `truncateToWidth`. Note it scans `getBranch()`; our scan is over `getEntries()` (so `usage`, `compaction` and `branch_summary` entries count too — the same set pi's own footer sums).
- **`examples/extensions/status-line.ts`** shows the other slot: `ctx.ui.setStatus("status-demo", …)` on `session_start` / `turn_start` / `turn_end`. That is the mechanism our other packages use to put text in the bar (`footerData.getExtensionStatuses()` is where our footer reads them back).
- **`examples/extensions/model-status.ts`** demonstrates the `model_select` hook and `ctx.ui.setStatus("model", …)`. It is another way a model name reaches the bar; our footer reads `ctx.model` directly instead.

**The honest baseline is pi's built-in footer, not the examples.** `FooterComponent` in pi's own `dist` already renders, in two lines plus an optional status line: the cwd (with `~`), the git branch in parentheses, the session name, `↑ ↓ R W` tokens, a latest cache-hit-rate `CHxx.x%`, `$cost.toFixed(3)` (with ` (sub)` for subscription-backed providers), the context percentage over the window with an ` (auto)` marker and error/warning colours above 90 %/70 %, an `xp` marker in experimental mode, and on the right the model id plus thinking level, a `→ routed-model` suffix for virtual models and a `(provider)` prefix when more than one provider is configured. Model, context and cost information are pi's, computed from pi's session — there is no archimedes number anywhere in that list.

Against that baseline, ours changes presentation and repository awareness, and gives some things up:

| | pi's built-in footer | `@pi-archimedes/footer` |
|---|---|---|
| Lines | pwd line, stats line, one truncated status line | packed: 1 line when it fits, more when it does not |
| Too-wide content | `truncateToWidth(…, "...")` | wraps to another line; only a single irreducibly long chunk is truncated |
| jj repositories | not represented | bookmark (or `@<change-id>`) + jj changed-file count |
| Worktrees | not represented | distinct glyph for a linked worktree |
| Git state | name only | staged / unstaged / untracked / ahead / behind counts |
| Directory | full cwd, with `~` for home | last path segment only |
| Context | `NN.N%/window`, coloured error/warning above 90 %/70 % | `used/window`, coloured above 95 %/80 %, **plus** a bar that fills the remaining columns, coloured at ≥90 %/≥70 % |
| Session name | shown after cwd | not shown |
| Cache-hit rate `CHxx.x%` | shown | not shown |
| ` (sub)`, ` (auto)`, `xp`, routed-model `→ x`, `(provider)` prefix | shown | not shown |
| Cost precision | 3 decimals | 2 decimals |

**What pi has that ours does not.** The last four rows are the list, stated plainly: our footer shows no session name, no `CHxx.x%` cache-hit rate, no `(sub)` / `(auto)` / `xp` marker, no `→ routed-model` suffix, no `(provider)` prefix, two decimals of cost where pi prints three, and only the last segment of the working directory where pi prints the whole path. None of it is out of reach — `footerData.getAvailableProviderCount()` and `sessionManager.getSessionName()` are the same host APIs an extension is given — these are simply things this layout does not draw. And because the slot is taken over rather than appended to, a reader who wants the cache-hit rate or the routed-model target while a subagent fan-out is running cannot fall back to pi's own footer for it; that visibility is gone for as long as this footer is installed.

## Not verified in this pass

- No screen capture at a spread of widths for this doc. The packing rule is asserted by `packages/footer/src/utils/layout.test.ts` and the pieces by `format.test.ts` / `render-smoke.test.ts`; how a specific terminal's width resolves into 1/2/3 lines was not re-observed here.
- Live jj behaviour. `jj.ts` asserts its command and output parsing in `jj.test.ts`; no jj repository was driven for this doc, and the changed-file count's staleness note (the count comes from the last snapshot, so it lags until jj snapshots) is quoted from the source comment, not measured.
- `getGitStatus()`'s ahead/behind against a real remote — read from `packages/footer/src/utils/git.ts`, not exercised here.
- The "first probe blocks, later ones do not" claim is read from the two source files (`getGitStatus()`'s first-call branch, `getJjBookmark()`'s `execFileSync` with a 2 s timeout) and from `git.test.ts` / `jj.test.ts` for the parsing; no timing was measured for this doc, so "up to that probe's 2 s timeout" is the configured ceiling, not an observation.
