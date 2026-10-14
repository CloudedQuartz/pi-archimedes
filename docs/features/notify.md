---
status: live
last-verified: 2026-10-14
verified-by: reading `packages/notify/src` (index.ts, cancel-pending tests, OSC 99 tests) against pi 1.2.0's shipped `examples/extensions/notify.ts`, pi's own program-status reporter (`dist/modes/interactive/program-status-reporter.js`, wired at `dist/modes/interactive/interactive-mode.js`) and pi-tui's 7501 layer (`pi-tui/dist/program-status.js`, `programStatusSupported` / `setProgramStatus` / `queryAndEnableKittyProtocol` in `pi-tui/dist/terminal.js`), claim by claim, on 2026-10-14. Behaviour is guarded by the suite (`npx vitest run` — 2430 tests / 145 files) and `tsc --noEmit` is clean in all 13 projects. Not verified in this pass: real desktop notifications on each terminal in the delivery table, and any 7501-capable terminal on screen.
---

# Notify (`@pi-archimedes/notify`)

A desktop notification, **delayed**, for the two moments you might have walked away from — and the cancellations that keep it from crying wolf.

## Two triggers

- **A settled run** — pi's `agent_settled` (`docs/decisions/0013-notify-on-pi-native-events.md`), i.e. no automatic retry, compaction or queued continuation is still to fire. Copy: `Task complete — waiting for input`.
- **A blocking prompt** — pi's `ui_prompt_start`, which pi's extension runner emits around every blocking `ctx.ui` prompt (`select`, `confirm`, `input`, `editor` and `custom` are all wrapped in `dist/core/extensions/runner.js`), so it covers an ask dialog — direct **or** relayed from a subagent, since the relay calls `ctx.ui` in the parent — and the sudo prompt. Copy: `A question needs your answer`.

Both can be switched off individually (`notifyOnAgentEnd`, `notifyOnQuestion`).

## The delay, and what cancels it

Nothing fires at the trigger. `scheduleNotify()` (re)starts a `delayMs` timer — 30 s by default — and the notification goes out only if nothing cancelled it in that window. It is a delay, not an idle timer: nothing measures how long you have been reading.

The cancellations are the feature (`registerNotify()` in `packages/notify/src/index.ts`):

- `input` — you submitted something.
- `before_agent_start` and `agent_start` — a run began, so "task complete" would be a lie whoever caused it. 1.2.0 made `before_agent_start` fire for `pi.sendMessage(…, { triggerTurn: true })` as well as for a submitted prompt; the handler takes no filter on purpose.
- `ui_prompt_end`, scoped to the question trigger only, so a prompt that closes by itself (a confirm that times out) cannot leave a stale "question needs your answer" pending — and cannot wipe a pending "task complete" either.
- `ctx.ui.onTerminalInput`, but only on a **keystroke**. `isKeystroke()` asks pi-tui's `parseKey()` first, and adds the one case the decoder cannot name: a printable non-ASCII character with no control byte in it (an accented key or IME commit on a terminal that does not speak the Kitty keyboard protocol). That rule exists because pi 1.x forwards far more terminal protocol traffic to listeners than older versions did — device-attributes replies, cell-size reports, focus and mouse sequences — and "any byte that arrived" used to let the terminal's own answers cancel an alert nobody dismissed.

`session_shutdown` clears the pending timer and unsubscribes.

## Delivery

`notify()` picks one route (`packages/notify/src/index.ts`): Windows Terminal (`WT_SESSION`) → a PowerShell toast; Kitty (`KITTY_WINDOW_ID`) → OSC 99 (title then body); iTerm2 (`TERM_PROGRAM=iTerm.app` / `ITERM_SESSION_ID`) → OSC 9; everything else → OSC 777. `wrapForTmux()` puts any of those inside a tmux DCS passthrough (`ESC Ptmux; … ESC \`) when `$TMUX` is set, doubling the inner escape so tmux forwards rather than interprets it. Sequences go to **stderr**. If the terminal understands none of these protocols, no alert appears — that is the contract, not a fallback path.

Settings, namespace `archimedes.notify`: `notifyOnAgentEnd`, `notifyOnQuestion`, `delayMs` (default `30000`). On/off in the suite is `/plugins` → `archimedes.notify.enabled`; per ADR 0012 (`docs/decisions/0012-plugin-gate-in-package-namespace.md`) the package never reads that flag.

## vs pi's own (`examples/extensions/notify.ts`, and pi's OSC 7501 program status)

There are two "notifications" in pi, and it helps to keep them apart.

**pi's example, `examples/extensions/notify.ts`.** Read in full. It registers one handler — `pi.on("agent_settled", …)` — and calls `notify("Pi", "Ready for input")` immediately, with the same three routes our dispatcher carries (its own `notifyOSC777`, `notifyOSC99`, and a `windowsToastScript` behind `WT_SESSION`, plus `KITTY_WINDOW_ID` selection). Its comment explains the trigger choice in the same words this suite uses: *"`agent_end` fires after each low-level run; Pi may still retry, compact, or continue with queued follow-ups. Notify only after the full run settles."* It has no question trigger, no delay, no cancellation path, no tmux wrap, and no iTerm2/OSC 9 route.

**pi's native program status (OSC 7501).** Since 1.1.0 pi reports its own state to the terminal. `ProgramStatusReporter` (`dist/modes/interactive/program-status-reporter.js`) keeps a run state and a dialog state and emits through `terminal.setProgramStatus()`, which encodes with pi-tui's `formatProgramStatus()`. The states and kinds are declared in `pi-tui/dist/program-status.d.ts`: `idle | working | blocked | done | error | clear`, with `kind: "permission" | "question" | "auth"` for `blocked`. The mapping to our two triggers is direct:

| Our wait | pi's 7501 state |
|---|---|
| Settled run (`agent_settled`, not aborted) | `done` — the reporter's `agent_settled` branch sets the resting status to the run's outcome, which is `done` unless the last assistant message ended `stopReason: "error"`, in which case it is `error`; an aborted settle rests at `idle` |
| A blocking prompt (`ui_prompt_start`) | `blocked` — `setBlocked("extension-dialog", { kind: "question", message: title })` for the extension selector/input/editor, `{ kind: "permission" }` for `confirm`, and `setBlocked("login", { kind: "auth", … })` for `/login` |

Both are the *same fact about the session*, reported to a different audience: 7501 tells the terminal emulator (the tab, the title, whatever it chooses to draw), and it is only written when the terminal confirmed support — pi-tui queries with `PROGRAM_STATUS_QUERY` at startup, and `PI_PROGRAM_STATUS=1` / `0` overrides that probe; `setProgramStatus()` writes nothing while `programStatusSupported` is false. Its message field carries the session name, a dialog title, or the first line of an error, and pi-tui writes it to stdout with no tmux passthrough wrap of its own.

**So what is left for us?** The part 7501 does not do, stated flatly:

- **A desktop notification.** 7501 is a status report to the controlling terminal; nothing in the paths above raises an OS-level notification. The OS alert comes from OSC 777 / 9 / 99 or a Windows toast.
- **The delay plus the cancellations** — the behaviour the example does not have and 7501 does not model. pi reports `done` the moment the run settles and `blocked` the moment a dialog opens; ours waits 30 s and stands down if you typed, submitted, or started a new run in the meantime. That is the whole reason the package is a circuit breaker rather than an event listener.
- **Coverage of a dialog pi does not mark `blocked`.** pi's reporter is driven from the interactive-mode dialog paths; `showExtensionCustom()` does not call `setBlocked`, so a custom dialog — which is what our ask picker and tabs dialog are — produces no `blocked` report, while pi's runner still fires `ui_prompt_start` for it. Our question trigger therefore covers prompts the 7501 status does not.
- **tmux.** Our sequences are wrapped for passthrough; pi's are emitted unwrapped.
- **The extension alone is enough** — a standalone `pi install npm:@pi-archimedes/notify` gets both triggers and every cancellation above; nothing here depends on the rest of the suite (both triggers are pi-native events).

**What pi has that ours does not.** 7501 is a richer state vocabulary than two notifications: `working` during a run and during compaction (`message: "Compacting context"`), `error` with the first line of the failure, `idle` after an abort, and `clear` — reported continuously and de-duplicated (`lastReport`), with the most recently opened dialog winning. Ours says nothing while work is in flight and says nothing about *why* a run failed. A future "is this still earning its place" decision should weigh that: the two systems answer different questions — "what state is this session in, right now, for the terminal to draw" versus "should I actually interrupt the user with an alert, and only if they have not come back in half a minute".

This package emits no 7501 of its own and no second copy of pi's: `grep` for `7501` or `setProgramStatus` in this repository's source finds nothing. The mapping above is recorded as a comment in `packages/notify/src/index.ts`.

## Not verified in this pass

- No OS-level notification was observed for this doc, on any of the four routes. Routing is read from `notify()` and asserted in `notify-osc99.test.ts` / `cancel-pending.test.ts`; the Windows toast in particular is unexercised here.
- No 7501-capable terminal was on screen, so the mapping table is read from pi's and pi-tui's shipped code rather than observed on a terminal.
- Whether tmux forwards OSC 777/9/99 through the DCS wrap on a given tmux configuration — the wrap is ours and is unit-tested as a string transformation only.
