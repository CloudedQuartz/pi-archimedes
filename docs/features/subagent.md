---
status: live
last-verified: 2026-10-14
verified-by: reading `packages/subagent/src` (index.ts, tool-schema.ts, spawn.ts, stream.ts, execute.ts, run-outcome.ts, usage.ts, agents.ts, agent-store.ts, local-config.ts, agent-panel.ts, dispatch.ts) against pi 1.2.0's shipped `examples/extensions/subagent/` (index.ts, agents.ts, README.md), and for the cost claim against pi's own accounting path (`createToolResultMessage` in `pi-agent-core/dist/agent-loop.js`, the `role === "toolResult"` branch of `AgentSession.getSessionStats()` in `dist/core/agent-session.js`), claim by claim, on 2026-10-14; the suite's tests (`npx vitest run` — 2430 tests / 145 files, including `run-outcome.test.ts`, `usage.test.ts`, `spawn.test.ts`, `dispatch.test.ts`, `local-config.test.ts`, `tool-validation.test.ts`, `agents-parse.test.ts`) and `tsc --noEmit` clean in all 13 workspace projects. Not verified in this pass: a live dispatch (see "Not verified in this pass").
---

# Subagent (`@pi-archimedes/subagent`)

Tool `subagent`: delegate a task — or a batch of them — to child pi processes, watch each one stream, and get the answers back in the same tool result. Tools `subagent` and `list_agents`, plus the `/agents` manager.

## Dispatch

`packages/subagent/src/index.ts` accepts `task` (single) or `tasks[]` (parallel), with optional `agent`, `model`, and `cwd` per task. A call resolves when every run has settled — the `async` field in `SUBAGENT_PARAMS_SCHEMA` is declared but not honoured, so nothing is fire-and-forget (see `packages/subagent/README.md`). Parallel tasks all start at once: `executeParallel()` maps `Promise.all` over them (`packages/subagent/src/execute.ts`), with one progress slot per task from the start so the rows stay stacked in task order.

The child is a real pi: `spawnSubagent()` in `packages/subagent/src/spawn.ts` builds `--mode json --no-session -p` plus `--model`, `--thinking`, `--tools`, `--no-mcp` and `--system-prompt` as applicable, and always appends `--exclude-tools subagent` so a child cannot spawn children. Its system prompt is passed inline as `--system-prompt`.

Model resolution is one order everywhere (fork and bridge): agent config `model` → per-call `model` → the parent's active model (`resolveModel()`).

## The tool allowlist is closed

pi 1.0.4 changed what a non-empty `--tools` means: MCP tools stay *registered* unless the list names an `mcp__` entry, and 1.1.0 made `+name`/`-name` entries modifiers rather than names. A config reading `tools: read, bash` therefore no longer described the child's tool box. `spawn.ts` closes it: with a non-empty list it also passes `--no-mcp`, and a config that wants servers connecting says so with `mcp: true`. `tools:` entries are validated lexically where they are written — at config read (`agents.ts`) and in the `/agents` panel — and again before the child is spawned: empty or duplicated entries, entries containing a comma, and `+`/`-`-prefixed entries are rejected (pi 1.1.0 treats those as modifiers and its own parser drops the whole `--tools` flag for a mixed list). A name that is well formed but not currently available only warns, because a tool legitimately disappears when its plugin is off or its server is disconnected. See `docs/decisions/0028-subagent-closed-allowlist-and-run-outcomes.md`.

## Run outcomes, not exit codes

`decideRunOutcome()` (`packages/subagent/src/run-outcome.ts`) derives the terminal state from the child's own account of the run rather than from its exit status, in this order: `agent_settled.aborted` → `aborted`; a last `stopReason: "aborted"` → `aborted`; a death by signal → `aborted` for a cancellation signal (`SIGTERM`/`SIGKILL`/`SIGHUP`/`SIGINT`) and failure for any other signal; exit 143 or 129 (pi caught SIGTERM / SIGHUP and exited by itself) → `aborted`; a last `stopReason: "error"` → failure; a last `stopReason: "length"` → `truncated`, whether the child exited 0 or 1; and only then any remaining non-zero exit → failure; otherwise `completed`. The order is not cosmetic at one point: pi 1.2.0 exits **1** on output-token truncation, so the `length` check has to come before the exit-code check or the case the whole table exists for would read as a crash. The reported outcomes are `completed`, `truncated` and `aborted`; a failed run is reported as a tool error and carries no outcome. The table and the pi-version facts behind it (print mode's exit codes, `--mode json` not mapping `stopReason` at all) are in `docs/decisions/0028-subagent-closed-allowlist-and-run-outcomes.md`.

## Cost is pi's own accounting

The tool result carries a native `usage` object — `toNativeUsage()` for one run, `sumNativeUsage()` for a parallel batch, which is one tool call and so one result (`packages/subagent/src/index.ts`). pi copies a tool result's `usage` onto the toolResult message it persists and folds those into the session totals, so a subagent's spend is counted by `/session` and by the footer's session scan with no side channel. The old bus route (`subagent/src/cost.ts` → `COST_UPDATE` → a footer accumulator) was deleted rather than left unused, because the footer already counts toolResult usage and the accumulator would have added the same money twice — see `packages/subagent/src/usage.ts` and `docs/features/footer.md`. A run the desktop performed (`usageAccountedElsewhere`) is deliberately left out of the sum, because its usage belongs to that session.

## Agent definitions and `agents.local.json`

Agents are Markdown files with YAML frontmatter (`name` and `description` required; `tools` a comma-separated string or a YAML list; body = system prompt), discovered from three scopes with precedence global < user < project: `.agents/agents` (repo) or `~/.agents/agents`, `~/.pi/agent/agents`, and `<repo>/.pi/agents` (`packages/subagent/src/agents.ts`). No agents ship with the package; an unknown name fails and lists what exists.

`~/.pi/agent/agents.local.json` holds per-agent `model` and `thinking` overrides chosen in `/agents`. It is machine-local, takes precedence over frontmatter, is applied by `applyLocalOverrides()`, and is written with `writeAtomicPreservingSymlinks` so a symlinked file stays a symlink (`packages/subagent/src/local-config.ts`, `docs/features/symlink-preserving-settings-writes.md`).

## The `/agents` manager

`registerAgentsCommand()` opens the panel as an overlay: list with `/` search and `n`/`c`/`d` for new, clone and delete; an edit screen whose title carries a `*` while unsaved (`state.editDirty`); model and tool pickers with their own search lines; and a cross-scope warning — `Warning: a <scope> agent "<name>" exists and will take precedence` — when the name being written is shadowed (`packages/subagent/src/agent-panel.ts`).

## Live streaming, and the rest of the suite

`packages/subagent/src/stream.ts` parses the child's JSON event stream and reports current tool, tool count, tokens, cost, duration and output as they happen. On the same stream it lifts the child's `manage_todo_list` results into a column on the todo board (`docs/features/todo.md`), and it pairs with the ask relay: `startAskSocketServer()` opens the socket a child's headless `ask` call connects to, so a child's question is answered in the parent's terminal (`docs/features/ask.md`). When the suite's desktop bridge is active, `dispatchViaBridge()` sends the dispatch to the desktop instead of forking, with an explicit rule for when a transport failure falls back to forking and when an answer (including a cancel) is authoritative (`packages/subagent/src/dispatch.ts`).

`subagent` is declared `exposure: "model-only"`: it is not reachable from a codemode script, while `list_agents` stays callable (`packages/subagent/src/index.ts`).

The package warns at load if the host is below its floor (`reportPiSupport("subagent", "1.2.0")`), because its behaviour depends on host semantics rather than only on types — `docs/decisions/0026-pi-version-contract-runtime-floor.md`.

## vs pi's own (`examples/extensions/subagent/`)

pi ships a subagent example — `index.ts`, `agents.ts`, four sample agents in `agents/`, and three workflow prompts in `prompts/`. It was read in full, including its README. It is a serious reference and much of the shape is shared: `.md` agents with frontmatter, a child `pi --mode json -p --no-session`, live streaming through `onUpdate`, parallel batches, abort propagation to the child process.

**What the example does.** One tool, `subagent`, with three modes — single (`agent` + `task`), parallel (`tasks`), and **chain** (`chain`, sequential steps with a `{previous}` placeholder). `MAX_PARALLEL_TASKS = 8` and `MAX_CONCURRENCY = 4` bound a batch via `mapWithConcurrencyLimit`, and `PER_TASK_OUTPUT_CAP` truncates each task's returned output (full text stays in `details`). The system prompt is written to a temp file by `writePromptToTempFile()` and passed as `--append-system-prompt`, then unlinked in a `finally`. Usage is accumulated by hand from the child's JSON stream — `currentResult.usage.input += usage.input || 0; … currentResult.usage.cost += usage.cost?.total || 0;` — and rendered by `formatUsageStats()`; the tool result itself carries only `{ content, details }`. Failure is decided by `isFailedResult(r) = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted"`, and its README documents exactly that. Agent scope is a parameter, `agentScope: "user" | "project" | "both"`, with `confirmProjectAgents` gating repo-controlled prompts. `/implement`-style commands come from the `prompts/*.md` files you install as pi prompts, not from the extension.

**What ours adds on top, and what differs:**

| | pi's example | `@pi-archimedes/subagent` |
|---|---|---|
| Modes | single / parallel / **chain** | single / parallel (no chain) |
| Batch shape | ≤ 8 tasks, 4 concurrent, per-task output capped | `Promise.all` over the tasks given, no cap constant; full output returned in both modes (`docs/decisions/0020-subagent-parallel-full-output.md`) |
| Agent definitions | user dir, plus project dir on request (`agentScope`) | three scopes (global / user / project) always discovered, with shadowing reported in `/agents`; no bundled agents |
| Editing agents | edit the file by hand | `/agents` manager with search, model/tool pickers, dirty tracking, collision warnings |
| Per-machine overrides | none | `agents.local.json` (model + thinking), symlink-preserving write |
| Cost | summed by hand into `details`, shown by its renderer | a native `usage` on the tool result, so pi's own session totals include it |
| Result reporting | exit code + `stopReason`, binary pass/fail | `completed` / `truncated` / `aborted` from `stopReason` and `agent_settled.aborted` |
| System prompt to the child | temp file + `--append-system-prompt` | inline `--system-prompt`, no temp file |
| MCP tools in a child | whatever `--tools` leaves registered | with a non-empty `tools` list, `--no-mcp` unless the config opts in with `mcp: true`; with no `tools` list neither flag is passed, so MCP keeps its normal behaviour and needs no opt-in |
| Recursion guard | none in its spawn argv | `--exclude-tools subagent`, always |
| Other surfaces | tool row only | `list_agents`, todo columns, ask relay, desktop-bridge dispatch |

**What the example has that ours does not.** Chain mode is the clearest one — an ordered `scout → planner → worker` hand-off with `{previous}` substitution is expressible there and not here, where you sequence dispatches yourself (or install a prompt that does it). Its parallel caps bound a fan-out that would otherwise spawn N children at once; ours does not bound it. Its `agentScope` / `confirmProjectAgents` pair asks before running repo-controlled prompts, which ours handles by always discovering all scopes and reporting shadowing rather than by a per-call confirmation. And its output cap protects the parent's context on a wide fan-out, a trade ADR 0020 took deliberately in the other direction.

## Not verified in this pass

- No live dispatch was run for this doc. The spawn argv, the outcome table and the usage attachment are read from source and covered by tests (`spawn.test.ts`, `run-outcome.test.ts`, `usage.test.ts`, `stream.test.ts`), not observed end-to-end here.
- The desktop-bridge dispatch path (`dispatchViaBridge`) against a running Client — read from `dispatch.ts` and its tests only.
- ADR 0028's open follow-up still stands: with a non-empty allowlist, whether `mcp: true` makes MCP tools *callable* or only *registered* is unresolved (see that ADR's verification note), so this doc says only what the code passes to the child.
