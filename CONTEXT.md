# pi-archimedes

Visual polish and useful context for the Pi coding agent TUI — a pnpm workspace monorepo of pi extensions providing subagents, structured questions, diff rendering, notifications, and more.

## Language

**Bus**:
The global pub/sub event system (`globalThis` Symbol) that packages use to communicate. Events include `COST_UPDATE`, `ASK_REQUEST`, `TODOS_UPDATE`, `TODOS_CLEAR`.
_Avoid_: Event bus, message bus, event emitter

**Meta**:
The orchestrator package (`pi-archimedes`) that depends on all component packages, wires cross-package concerns, and composes the settings UI.
_Avoid_: Umbrella, root, orchestrator package

**Subagent**:
A child pi process dispatched by the main agent to handle a delegated task. Can be sync (blocking until completion) or async (fire-and-forget). Communicates via IPC.
_Avoid_: Child agent, worker, spawned agent

**Agent**:
A named subagent configuration (e.g. `general`, `reviewer`, `explore`) with optional model, tool, and system prompt overrides. Stored in YAML frontmatter in config files.
_Avoid_: Agent config, agent profile, persona

**Extension**:
A pi extension entry point (`register(pi: ExtensionAPI)`) — each package exports one. Loaded by pi via `pi.extensions` in `package.json`.
_Avoid_: Plugin, module, package entry

**pi-package**:
An npm package tagged with `"keywords": ["pi-package"]` that is loadable by pi's extension system. Requires `"pi": { "extensions": ["./src/index.ts"] }` in `package.json`.
_Avoid_: Pi plugin, pi extension package

**Bridge**:
The mechanism by which the suite, when running as a process managed by the Archimedes Desktop (the **Client**), routes its interactive UI primitives (ask picker, confirmations, masked password input) and ambient state (todos, cost, subagent streams, agent state) to the Client over a local channel (the **bridge channel** — a Unix socket; a named pipe on Windows). Generalizes the subagent socket pattern: the suite talks out-of-band to its manager — the main pi process in subagent mode, the Client when the Client manages the process. See the desktop glossary for the Client-side view.
_Avoid_: Side channel, client mode, host mode

**Bridge mode**:
The suite's operating state when the Client manages the agent process (bridge env vars present at spawn). Interactive prompts are delegated to the Client and ambient state is pushed over the bridge channel. Contrast: TUI mode, subagent mode, headless mode. TUI mode always wins over bridge mode when both could apply.
_Avoid_: RPC mode (overlapping but not identical — the gate is env presence, not `ctx.mode`), client mode, host mode

## Core editor terminology

**Busy episode**:
The span from the agent becoming busy (idle → working) back to idle; the unit that drives spinner-quip selection in the editor border.
_Avoid_: Work session, agent turn, working span

**Spin quip**:
A fun (≤ 64 visible chars, ASCII-only) random label shown in the editor's border spinner window; picked per busy episode and re-picked on a subtle random 15–45 s timer while a long episode continues (a new episode always re-picks and resets the window; idle freezes it, so the label survives gaps); it applies whenever `editorSpinLabel` is left at its default (a custom label wins; empty hides).
_Avoid_: Rotating label, joke text, spinner text

## Notify terminology

**Settled wait**:
The notification condition "the agent's run has fully settled" — work is done, no automatic retry, compaction, or queued continuation will still run. Sourced from the pi `agent_settled` event (not `agent_end`, which can fire while a continuation is pending). Distinct from UI-prompt wait.
_Avoid_: Agent end, idle, done notification

**UI-prompt wait**:
The notification condition "an extension is blocking mid-run on a user-facing `ctx.ui` prompt" — a tabbed ask (direct or subagent-relayed), or a sudo password or command-confirm prompt. Sourced from the pi `ui_prompt_start` event, which fires in the parent process for every blocking prompt of any kind. Distinct from settled wait (the run is not over — it is paused on a prompt).
_Avoid_: Waiting for input (overloaded — the settled-wait notification also says "waiting for input"), question, ask request
