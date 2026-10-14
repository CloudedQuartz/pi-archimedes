---
status: live
last-verified: 2026-10-14
verified-by: "commands run on this checkout: `grep -rn \"console\\.[a-zA-Z]*(\" packages/*/src meta/src --include=*.ts | grep -v \".test.ts:\"` → no output (exit 1); the same census for renderer hoarding (`grep -rnE \"^(export )?(let|var) [a-zA-Z_]*[Tt]ui|private [a-zA-Z_]*[Tt]ui|this\\.[a-zA-Z_]*[Tt]ui *=\" …`) → no output (exit 1); `npx vitest run packages/core/src/screen-mode.test.ts packages/core/src/screen-mode-discipline.test.ts packages/core/src/log-discipline.test.ts` → 14 passed; `npx vitest run packages/ui/src/index.screen-mode.test.ts packages/image-paste/src/paste-dispatch.test.ts` → 40 passed; `grep -rn \"screenMode\\|screenCapabilities\\|frameBounded\\|transcriptWrite\" packages/*/src meta/src --include=*.ts | grep -v \"screen-mode.ts\"` → hits only in test files and prose comments, which is what backs the \"no production reader\" statement below. The pi-side claims (`switchTuiMode()` stops and rebuilds the TUI and re-mounts children; a switch is refused while an overlay is open) are ADR 0027's, cited into pi's own `dist/`; they were not re-measured against a live pi in this verification"
---

# Screen mode (`@pi-archimedes/core` → `screen-mode`)

## What it is

Pi 1.0.0 made **fullscreen screen** the default `tuiMode`: components render into a clipped, height-allocated, wheel-routed viewport instead of terminal scrollback. `packages/core/src/screen-mode.ts` (published as the `@pi-archimedes/core/screen-mode` subpath, `packages/core/package.json`) is the suite's single answer to the question "which screen am I drawing into", and the policy that answer implies. The vocabulary is `CONTEXT.md`'s — **screen mode**, **screen capability** — and the thing it deliberately is not is the suite's *operating* mode (TUI / bridge / subagent / headless); pi's setting name `tuiMode` is a false friend there.

## What the module decides

- **`screenMode(tui)`** → `"regular" | "fullscreen"`. One line: it asks pi-tui's `isViewportTUI(tui)` about **the renderer it was just handed**. It caches nothing, because a retained renderer is a stopped renderer after a `tuiMode` switch and it accepts every write without throwing.
- **`screenCapabilities(mode)`** → the two capabilities a screen mode implies: `transcriptWrite` (may append into terminal scrollback — off on fullscreen) and `frameBounded` (must fit an allocated, wheel-routed viewport — on fullscreen). They are inverses today and are the only two differences that exist; a third goes here rather than into a component.

`screenCapabilities()` takes the **mode**, not the renderer, on purpose: pi-tui does not export the `VIEWPORT_TUI` marker its own predicate reads, so a test cannot fabricate a viewport TUI. Passing the mode keeps the capability table unit-testable (`packages/core/src/screen-mode.test.ts`, 6 tests) while `screenMode()` stays a single delegation to pi.

**As shipped, nothing outside `core` reads this module.** A grep for `screenMode|screenCapabilities|frameBounded|transcriptWrite` over `packages/*/src` and `meta/src` returns test files and prose comments only. That is a documented outcome, not drift: ADR 0027's amendment records that once Task 8 deleted the startup `addChild` un-patch there was no scrollback-native listing left to suppress, so `transcriptWrite` "has no production reader left and survives only as the named capability it documents". The module still earns its place as the place a future difference gets named, and as the thing the discipline guard below measures.

## How the fullscreen gates behave today

Nothing in the suite switches its behaviour *by screen mode* any more — that is the guarantee, not the absence of one:

- **The startup splash runs on either screen.** It advances a frame counter and asks the renderer it was handed for a frame, so there is nothing screen-specific to gate (`packages/ui/src/index.screen-mode.test.ts`, 15 tests, asserts the animation, the reveal, the settling and the disposal on both a regular and a faked viewport renderer, plus "renders the same block on either screen, whatever renderer it is handed").
- **The editor's border spinner runs on either screen.** The renderer is handed straight to the editor and never kept, and idleness comes from `ctx.isIdle()` rather than from the renderer, so a `tuiMode` switch cannot strand it (`packages/ui/src/index.ts`, the `setEditorComponent` block).
- **The paste path is screen-mode independent** because it never holds a renderer — pinned by `packages/image-paste/src/paste-dispatch.test.ts` ("screen-mode independence").
- **Idle repaints stop.** On fullscreen an idle frame costs a whole viewport redraw, so the splash's frame timer retires itself once the reveal has settled (`packages/ui/src/startup/index.ts`, `startFrameTimer`).
- **Nothing writes to the console** — see *Never-do rules* in `docs/features/ui.md`. A stray write used to scroll away unseen on regular screen; inside a viewport it smears the frame until the next full redraw, and inside a subagent child it is discarded anyway.

One interaction remains a documented wart rather than code: pi's `switchTuiMode()` refuses to switch while an overlay is open, so with `/agents` or `/archimedes` showing, a `tuiMode` change is refused. There is no API to pre-empt it (ADR 0027).

## What frame-bounded sizing guarantees

A frame-bounded screen allocates the height itself, so anything that pads itself to the terminal becomes the whole viewport and starves the editor. The suite's answer is that custom blocks size to **their own content**, on both screens, and therefore never need to know which screen they are on:

- The splash header "is exactly its content on both screens" (`renderHeader`, `packages/ui/src/startup/index.ts`). Sizing it by the screen is what previously pushed pi's own startup listing a screen down on regular terminal, and on fullscreen it would have taken the viewport.
- Because nothing is measured per screen, the header factory takes no screen reading at all (`packages/ui/src/index.ts`, `headerFactory`). That matters because pi re-invokes the header factory on a new session, `/reload` or any `setHeader()`, and **never** on a `tuiMode` switch — a per-screen measurement taken there would be the stale one the header kept until the next replacement.
- Tool rows carry the host's numbers, not their own: `packages/ui/src/index.ts` and the `packages/diff` renderers apply `ctx.outputPad` where they draw their own shell, and `packages/ui`'s renderers read `ctx.durationMs` instead of running local timers, so row width and the "Took" line come from pi (ADR 0029).

## What must never be stored

**No `tui.*` binding, anywhere.** No class field, no `this.x = tui`, no module-scope `let`/`var`/`const` holding a renderer — ask the renderer you were just handed, every time. `switchTuiMode()` stops the running TUI, builds a new one, re-mounts every child and rebinds extension input listeners, so a stored reference keeps a *stopped* renderer: writes are accepted, nothing throws, and the component renders into a viewport nobody draws from.

The mechanical half is `packages/core/src/screen-mode-discipline.test.ts`, which walks every `packages/<name>/src` and `meta/src` (excluding `*.test.ts`) against five declaration shapes and pins that the patterns are still alive by asserting both offenders (`private tui: TUI | undefined;`, `export const appTui = tui;`, `const appTui: TUI = tui;` …) and honest code (`const tuiMode = settings.tuiMode;`, `return screenMode(tui);` — the `tuiMode` **setting** is a screen-mode string and must not land in the net).

**Its allow-list is empty.** `const ALLOW_LIST: readonly AllowEntry[] = []` — the last entry was the `let uiTui` whose only reader was the startup `addChild` un-patch, and both went together. The list keeps its shape while empty deliberately: an exemption may only reappear with a reason naming the task that removes it, which the test asserts, so the guard cannot quietly widen.
