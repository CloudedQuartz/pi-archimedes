---
status: live
last-verified: 2026-10-14
verified-by: reading `packages/ask/src` (tool.ts, picker.ts, dialog.ts, selection.ts, note.ts, ipc-relay.ts, herdr.ts) against pi 1.2.0's shipped `examples/extensions/questionnaire.ts` and `examples/extensions/question.ts`, claim by claim, on 2026-10-14; the suite's tests (`npx vitest run` — 2430 tests / 145 files, which include `tool.test.ts`, `tool.output-schema.test.ts`, `renderer.test.ts`, `note.test.ts`, `herdr.test.ts`, `tool-declarations.test.ts`) and `tsc --noEmit` clean in all 13 workspace projects. Not verified in this pass: the subagent relay and the bridge branch end-to-end against a live desktop (see "Not verified in this pass").
---

# Ask (`@pi-archimedes/ask`)

Tool `ask`: the model asks a structured question, the user answers in the terminal, and the answer comes back as data. One call can carry several related questions.

## The tool contract

Parameters are `{ questions: [{ id, question, description?, options: [{ label }], multi?, recommended? }] }` (`packages/ask/src/tool.ts`, `AskParamsSchema`).

- `description` is Markdown/plain text rendered above the options — both pickers lay it out through pi-tui's `Markdown` component (`picker.ts`, `dialog.ts`); the schema description names headings, lists and code blocks.
- `multi: true` collects several options from one question.
- `recommended` is a 0-indexed option; the label gets ` (Recommended)` appended and the picker's cursor starts there (`appendRecommendedTagToOptionLabels`, `resolveInitialCursorIndexFromRecommendedOption` in `packages/ask/src/selection.ts` / `picker.ts`).
- A freeform row is always present — `OTHER_OPTION = "Other (type your own)"` (`selection.ts`) — which is why the tool description tells the model "Do NOT include an 'Other' option; UI adds it automatically."
- The result declares `outputSchema` = `{ cancelled, results[] }`, where `cancelled` means nothing was selected and nothing typed for every question (`buildAskStructuredContent`). `tool.output-schema.test.ts` runs the handler and validates the payload against the declaration.
- `exposure: "model-only"` — the tool is declared to the model and is deliberately *not* callable from a codemode script (the comment in `tool.ts` records what that cost, measured before it was taken).

The text handed back to the model is `buildAskSessionContent()`: a `User answers:` summary followed by an `Answer context:` block per question, with control characters and stray newlines sanitised out of every field (`toSessionSafeQuestionResult`).

## Two pickers, not one

- Single question without `multi` → `askSingleQuestionWithInlineNote()` (`packages/ask/src/picker.ts`): ↑↓ move, `Enter` submit, `Esc` cancel, `Tab` add/edit a note.
- Anything else — several questions, or one question with `multi` — → `askQuestionsWithTabs()` (`packages/ask/src/dialog.ts`): `←`/`→` move between tabs, `Space` toggles an option in multi-select, `Enter` advances a single-select question and submits on the final review tab, `Tab` opens the note editor, `Esc` cancels — the same keys its own help line spells out.

Both render through `ui.custom`, so a dialog is one blocking prompt from pi's point of view.

## Inline notes

`Tab` opens a one-line editor on the option the cursor is on; the note is kept per option index (`noteByOptionIndex`) and rendered inline on that option's row (`buildWrappedOptionLabelWithInlineNote`, `packages/ask/src/note.ts`), with the caret drawn using pi-tui's `renderFakeCursor()` rather than a hand-rolled reverse-video escape.

The note travels back **inside the answer**: `buildSingleSelectionResult()` / `buildMultiSelectionResult()` (`selection.ts`) return `selectedOptions: ["<label> - <note>"]`, and a note typed on the "Other" row becomes `customInput`. There is no separate note field in the result — the annotation is part of the chosen option string.

## Subagents and the desktop

Three paths reach the user, and they are chosen in `tool.ts` `execute()` in this order:

1. **Bridge** (`getBridge().active`) — the question goes to the desktop Client over the bridge channel (`getBridge().ask(params, toolCallId, signal)`), so the answer arrives in the Client's UI rather than the terminal. The turn's `AbortSignal` is passed through, so cancelling the turn cancels the pending request instead of waiting out the timeout. `Events.ASK_REQUEST` / `ASK_RESPONSE` are still emitted around it, for the bridge's prompt refcount.
2. **Headless child** (`!ctx.hasUI`) — a child pi has no UI, so the tool connects to the socket named by `PI_SUBAGENT_SOCKET` and exchanges one `ask_request` / `ask_response` JSON line pair. That socket is the parent's: `startAskSocketServer()` in `packages/subagent/src/spawn.ts` creates it before spawning and passes the path in the environment. No path, a socket error, a close, or 5 minutes without an answer all resolve to a cancelled answer rather than a hang.
3. **TUI** — the picker or tabs dialog in this process.

The parent side of path 2 is `packages/ask/src/ipc-relay.ts`: it listens on the host handle for `archimedes:ask_request` whose `source` is not `"main"`, defers a tick, shows the same picker/dialog in the **parent's** terminal, and writes the answer back as `archimedes:ask_response`, which the child's socket server forwards to the waiting child. While the dialog is open the relay is inert when the bridge is active (`getBridge().active` early-return), so a question is never consumed twice.

`emitBlocked()` (`packages/ask/src/herdr.ts`) reports the open dialog on the shared handle as `herdr:blocked` for the pane-manager integration; it is a no-op when that listener is absent, and every `true` is paired with a `false` in a `finally`.

## vs pi's own (`examples/extensions/questionnaire.ts`, `examples/extensions/question.ts`)

pi ships two question examples; both were read in full. They are one tool each, both interactive-only.

**`questionnaire.ts`** registers `questionnaire` with `questions: [{ id, label?, prompt, options: [{ value, label, description? }], allowOther? }]`. It *is* tabbed for several questions: a tab bar with `■` for answered and `□` for unanswered questions plus a ` ✓ Submit ` tab, `Tab`/`←`/`→` to move, `↑↓` to select, `Enter` to confirm, and `advanceAfterAnswer()` auto-advancing to the next tab after each answer. `allowOther` (default true) appends `{ value: "__other__", label: "Type something." }` and opens a pi-tui `Editor` for it; answers are reported as `"<label>: user selected: 2. X"` or `"(wrote) <text>"`. Options carry a `value` distinct from the display `label`.

**`question.ts`** registers `question` for a single question — no tabs, no ids, no per-question `label` — with the same `Type something.` editor pattern (Escape in the editor returns to the options, Escape on the options cancels), `details: QuestionDetails`, and `executionMode: "sequential"`.

**What ours adds on top, and what differs:**

| | pi's examples | `@pi-archimedes/ask` |
|---|---|---|
| Where an answer can come from | the terminal only — both return `"Error: UI not available (running in non-interactive mode)"` when there is no TUI | terminal, desktop Client (bridge), or the **parent's** terminal for a headless child (`PI_SUBAGENT_SOCKET`) |
| Questions from a subagent | not supported | relayed into the parent TUI mid-stream; the child blocks and resumes with the answer |
| Note on an option | none | `Tab` adds a note per option; it returns inside the answer string |
| Multiple options from one question | no selection model for it | `multi: true` (routes to the tabs dialog, since the single picker is single-select) |
| Suggesting a default | none | `recommended` tags the label and starts the cursor there |
| Context above the options | `prompt` text (plus per-option `description`) | `description` as Markdown, wrapped, above the options |
| Machine-readable answer | `details` only | `details` **plus** a declared `outputSchema` (`cancelled` + `results[]`) |
| Script reachability | default exposure | `exposure: "model-only"` — not callable from a codemode script |

**What pi's examples have that ours does not.** `questionnaire.ts` distinguishes an option's `value` (what the model receives) from its `label` (what the user reads) and supports an optional per-option `description` rendered under the label; ours returns the label text itself and its option schema carries only `label`. The tab bar is *not* a difference: pi's `render` and our `renderTabs` both print `← … →`, mark each question `■` when it is answered and `□` when it is not, and finish with a ` ✓ Submit ` tab (ours titles that tab's content ` Review answers `), and both auto-advance after a selection (`advanceAfterAnswer()` there, `advanceToNextTabOrSubmit()` here). `question.ts` declares `executionMode: "sequential"`; `ask` does not declare an execution mode. A future "is this still earning its place" decision should count the relay and the headless path as the part pi does not do, and the `value`/`label` split plus per-option descriptions as the part pi does do that we do not.

## Not verified in this pass

- The subagent relay and the bridge branch end-to-end (a real child asking into a real parent TUI, and a real desktop Client answering). The claims above are read from `tool.ts`, `ipc-relay.ts` and `spawn.ts`, and the individual pieces are covered by unit tests (`tool.test.ts` covers the headless/bridge branches against fakes), but no live child→parent round trip was run for this doc.
- Whether the ask dialog makes pi report a *terminal* "blocked on user" status. `ui_prompt_start` does fire for `ctx.ui.custom` (pi wraps `select`/`confirm`/`input`/`editor`/`custom` in `runner.js`), but pi's OSC 7501 reporter is driven from the interactive-mode dialog paths, and `showExtensionCustom` does not touch it — see `docs/features/notify.md`.
