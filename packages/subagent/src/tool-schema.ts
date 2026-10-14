import { Type } from "typebox";
import type { SubagentResult, SubagentRunReport } from "./types.js";

// ── JSON Schema for tool parameters (TypeBox) ──────────────────────────────

const TaskItem = Type.Object({
  agent: Type.Optional(Type.String({
    description: "Agent name for this task (optional). If omitted, runs config-less.",
  })),
  task: Type.String(),
  model: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
});

export const SUBAGENT_PARAMS_SCHEMA = Type.Object({
  agent: Type.Optional(Type.String({
    description: "Agent name (optional). If omitted, the subagent runs config-less — parent's current model, all tools, no system-prompt override. Call list_agents to see available agents.",
  })),
  task: Type.Optional(Type.String({
    description: "Task description for the subagent. Required when not using 'tasks' array.",
  })),
  tasks: Type.Optional(Type.Array(TaskItem, {
    description: "Multiple tasks for parallel execution. Required when not using 'task'.",
  })),
  model: Type.Optional(Type.String({
    description: "Model override for the subagent",
  })),
  async: Type.Optional(Type.Boolean({
    description: "Run asynchronously (fire-and-forget)",
  })),
  cwd: Type.Optional(Type.String({
    description: "Working directory for the subagent",
  })),
});

// ── JSON Schema for `structuredContent` ────────────────────────────────
//
// One report per run: what ran, how it ended, what it cost, what it answered.
// It is `details` minus the live-progress blob — `details.progress[i].output`
// is the child's whole streamed scrollback and `toolCalls` its call history, for
// the row renderer, and a script that wants the answer already has
// `finalOutput`. `usageAccountedElsewhere` is left out too: it is this session's
// bookkeeping flag (ADR 0028), not a fact about the run.
//
// pi hands this to a codemode script instead of the text and validates it
// against nothing, so `index.output-schema.test.ts` runs the handler and checks
// the payload against this declaration.
//
// A single run that reports itself as failed is `isError` and carries none of it
// (see the note in `index.ts`), so a script keeps rejecting with the text it
// rejects with today. A parallel batch is the other case: one failed run inside
// a batch does not make the batch an error — it stays a report of N runs, with
// that run's `error` field set inside `results` (pre-existing shape, unchanged
// by these schemas; see the per-run failure markers in `formatParallelResults`).

const UsageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  cost: Type.Number(),
  turns: Type.Number(),
});

const ProgressSummarySchema = Type.Object({
  toolCount: Type.Number(),
  tokens: Type.Number(),
  durationMs: Type.Number(),
});

const RunReportSchema = Type.Object({
  agent: Type.String(),
  task: Type.String(),
  exitCode: Type.Number(),
  childSessionId: Type.Optional(Type.String()),
  outcome: Type.Optional(
    Type.Union([Type.Literal("completed"), Type.Literal("truncated"), Type.Literal("aborted")]),
  ),
  usage: UsageSchema,
  model: Type.Optional(Type.String()),
  finalOutput: Type.Optional(Type.String({ description: "The run's answer text, when it produced one" })),
  error: Type.Optional(Type.String({ description: "Set when the run failed before or during execution" })),
  progressSummary: Type.Optional(ProgressSummarySchema),
});

export const SUBAGENT_OUTPUT_SCHEMA = Type.Object({
  mode: Type.Union([Type.Literal("single"), Type.Literal("parallel")]),
  results: Type.Array(RunReportSchema),
});

/** The report for one run; `undefined` fields are omitted, not null. */
export function subagentStructuredContent(
  mode: "single" | "parallel",
  results: SubagentResult[],
): { mode: "single" | "parallel"; results: SubagentRunReport[] } {
  return {
    mode,
    results: results.map((result) => ({
      agent: result.agent,
      task: result.task,
      exitCode: result.exitCode,
      ...(result.childSessionId !== undefined && { childSessionId: result.childSessionId }),
      ...(result.outcome !== undefined && { outcome: result.outcome }),
      usage: {
        input: result.usage.input,
        output: result.usage.output,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
        cost: result.usage.cost,
        turns: result.usage.turns,
      },
      ...(result.model !== undefined && { model: result.model }),
      ...(result.finalOutput !== undefined && { finalOutput: result.finalOutput }),
      ...(result.error !== undefined && { error: result.error }),
      ...(result.progressSummary !== undefined && { progressSummary: { ...result.progressSummary } }),
    })),
  };
}
