import type { RunOutcome, SubagentDetails, SubagentProgress, SubagentResult, SubagentToolCall } from "./types.js";
import { formatDuration, buildStatsLine, buildAgentLabel, buildOutcomeLine } from "./format.js";
import { block, row, type RowBlock, type RowSegment } from "./row-block.js";
import { renderToolCallLine } from "@pi-archimedes/core/tool-render";

type Theme = { fg: (token: string, text: string) => string; bold: (text: string) => string };

// The expanded view mixes two kinds of line and says which is which (see
// `row-block.ts`): a **row** (label, activity, outcome) stays one line and fills
// the frame; a **block** (the stats line, the task text, the tool-call history,
// the output) keeps wrapping, because the expanded view is where all of it is
// meant to be readable (ADR 0020). The stats line is a block and not a row
// because nothing else repeats its numbers: cut at the frame, its tail — tokens,
// duration, cost — would simply be gone on a narrow terminal.

// ── Helpers ─────────────────────────────────────────────────────────────────

// A completed tool call renders with a status glyph (✓ ok / ✗ error) and its
// name coloured to match. Legacy string-form calls (old persisted sessions)
// carry no status, so they render as a neutral success line.
function formatToolCall(call: SubagentToolCall | string, theme: Theme): string {
  if (typeof call === "string") {
    return renderToolCallLine("success", call, "", theme);
  }
  const status = call.error ? "error" : "success";
  const suffix = call.argsPreview ? ": " + call.argsPreview : "";
  return renderToolCallLine(status, call.name, suffix, theme);
}

// The bottom row of a finished view. The *Run outcome* wins over the done/failed
// pair: a truncated answer is not a failed run, and labelling it "✗ Failed" is
// how a useful answer gets thrown away by whoever reads it.
function outcomeRow(
  data: { outcome?: RunOutcome | undefined; error: string | undefined },
  theme: Theme,
  fallback: { failed: string },
): string {
  const line = buildOutcomeLine({ outcome: data.outcome, error: data.error }, theme);
  if (line) return line;
  if (data.error) return theme.fg("error", "✗ " + data.error);
  return theme.fg("error", "✗ " + fallback.failed);
}

// ── Expanded completed result ───────────────────────────────────────────────

export function buildExpandedText(
  result: SubagentResult,
  progress: SubagentProgress | undefined,
  theme: Theme,
): RowSegment[] {
  const lines: RowSegment[] = [];

  lines.push(row(buildAgentLabel(result.agent, result.task, theme)));
  lines.push(row(""));

  // Stats line (same as compact view)
  const modelName = progress?.model ?? result.model;
  const modelLabel = modelName ? theme.fg("accent", modelName) : "";
  const statsLine = buildStatsLine({
    turns: result.usage.turns,
    toolCount: result.progressSummary?.toolCount,
    tokens: result.progressSummary?.tokens,
    durationMs: result.progressSummary?.durationMs,
    cost: result.usage.cost,
  }, theme);
  const statsParts = [modelLabel, statsLine].filter(Boolean);
  if (statsParts.length > 0) {
    // A block, not a row: this is the only place the run's numbers appear, and
    // the expanded view is where they are meant to be readable however narrow
    // the frame is (ADR 0020).
    lines.push(block(statsParts.join(" ")));
  }

  // Task
  if (result.task) {
    lines.push(row(""));
    lines.push(block(theme.fg("dim", "Task: " + result.task)));
  }

  // Tool calls history
  const toolCalls = progress?.toolCalls;
  if (toolCalls && toolCalls.length > 0) {
    lines.push(row(""));
    for (const call of toolCalls) {
      lines.push(block(formatToolCall(call, theme)));
    }
  }

  // Output - show live streaming output or final output
  const outputText = progress?.output ?? result.finalOutput;
  if (outputText) {
    lines.push(row(""));
    lines.push(block(outputText));
  }

  // Error / outcome at the bottom
  if (result.error || result.outcome || result.exitCode === 0) {
    lines.push(row(""));
    if (result.outcome || result.error) {
      lines.push(row(outcomeRow({ outcome: result.outcome, error: result.error }, theme, { failed: "Failed" })));
    } else {
      lines.push(row(theme.fg("success", "✓ Done")));
    }
  } else {
    lines.push(row(""));
    lines.push(row(theme.fg("error", "✗ Failed")));
  }

  return lines;
}

export function renderExpanded(
  rows: RowBlock,
  result: SubagentResult,
  progress: SubagentProgress | undefined,
  theme: Theme,
): RowBlock {
  rows.setSegments(buildExpandedText(result, progress, theme));
  return rows;
}

// ── Expanded streaming progress ─────────────────────────────────────────────

export function renderProgressExpanded(
  rows: RowBlock,
  progress: SubagentProgress,
  theme: Theme,
): RowBlock {
  const lines: RowSegment[] = [];

  lines.push(row(buildAgentLabel(progress.agent, progress.task, theme)));
  lines.push(row(""));

  // Stats line (same as compact view) — a block: see buildExpandedText.
  const modelLabel = progress.model ? theme.fg("accent", progress.model) : "";
  const statsLine = buildStatsLine({
    turns: undefined,
    toolCount: progress.toolCount,
    tokens: progress.tokens,
    durationMs: progress.durationMs,
    cost: progress.cost,
  }, theme);
  const statsParts = [modelLabel, statsLine].filter(Boolean);
  if (statsParts.length > 0) {
    lines.push(block(statsParts.join(" ")));
  }

  // Task
  if (progress.task) {
    lines.push(row(""));
    lines.push(block(theme.fg("dim", "Task: " + progress.task)));
  }

  // Tool calls history
  if (progress.toolCalls && progress.toolCalls.length > 0) {
    lines.push(row(""));
    for (const call of progress.toolCalls) {
      lines.push(block(formatToolCall(call, theme)));
    }
  }

  // Activity (current tool, marked with the running glyph ▸)
  if (progress.currentTool) {
    lines.push(row(""));
    const argsPreview = progress.currentToolArgs ?? "";
    const durationPart = progress.currentToolStartedAt
      ? " | " + formatDuration(Date.now() - progress.currentToolStartedAt)
      : "";
    const suffix = (argsPreview ? ": " + argsPreview : "") + durationPart;
    lines.push(row(renderToolCallLine("running", progress.currentTool, suffix, theme)));
  }

  // Status at bottom
  if (progress.status === "completed" || progress.outcome) {
    lines.push(row(""));
    const outcomeLine = buildOutcomeLine({ outcome: progress.outcome, error: progress.error }, theme);
    lines.push(row(outcomeLine ?? theme.fg("success", "✓ Done")));
  } else if (progress.status === "failed") {
    lines.push(row(""));
    lines.push(row(outcomeRow({ outcome: undefined, error: progress.error }, theme, { failed: "Failed" })));
  }

  rows.setSegments(lines);
  return rows;
}

// ── Expanded parallel streaming progress ────────────────────────────────────

export function buildProgressExpandedText(
  progress: SubagentProgress,
  theme: Theme,
): RowSegment[] {
  const lines: RowSegment[] = [];

  lines.push(row(buildAgentLabel(progress.agent, progress.task, theme)));
  lines.push(row(""));

  // Stats line (same as compact view) — a block: see buildExpandedText.
  const modelLabel = progress.model ? theme.fg("accent", progress.model) : "";
  const statsLine = buildStatsLine({
    turns: undefined,
    toolCount: progress.toolCount,
    tokens: progress.tokens,
    durationMs: progress.durationMs,
    cost: progress.cost,
  }, theme);
  const statsParts = [modelLabel, statsLine].filter(Boolean);
  if (statsParts.length > 0) {
    lines.push(block(statsParts.join(" ")));
  }

  // Task
  if (progress.task) {
    lines.push(row(""));
    lines.push(block(theme.fg("dim", "Task: " + progress.task)));
  }

  // Tool calls history
  if (progress.toolCalls && progress.toolCalls.length > 0) {
    lines.push(row(""));
    for (const call of progress.toolCalls) {
      lines.push(block(formatToolCall(call, theme)));
    }
  }

  // Activity
  if (progress.currentTool) {
    const argsPreview = progress.currentToolArgs ?? "";
    const durationPart = progress.currentToolStartedAt
      ? " | " + formatDuration(Date.now() - progress.currentToolStartedAt)
      : "";
    let line = theme.fg("muted", progress.currentTool);
    if (argsPreview) {
      line += theme.fg("dim", ": " + argsPreview);
    }
    if (durationPart) {
      line += theme.fg("dim", durationPart);
    }
    lines.push(row(""));
    lines.push(row(line));
  }

  // Status at bottom
  if (progress.status === "completed" || progress.outcome) {
    lines.push(row(""));
    const outcomeLine = buildOutcomeLine({ outcome: progress.outcome, error: progress.error }, theme);
    lines.push(row(outcomeLine ?? theme.fg("success", "✓ Done")));
  } else if (progress.status === "failed") {
    lines.push(row(""));
    lines.push(row(outcomeRow({ outcome: undefined, error: progress.error }, theme, { failed: "Failed" })));
  }

  return lines;
}
