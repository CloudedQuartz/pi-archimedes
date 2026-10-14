import { RowBlock, row, type RowSegment } from "./row-block.js";
import type { SubagentDetails, SubagentProgress, SubagentToolResult } from "./types.js";
import {
  renderCompactSingle,
  renderCompactParallel,
  renderCompactProgress,
  renderCompactParallelProgress,
} from "./compact.js";
import {
  renderExpanded,
  renderProgressExpanded,
  buildProgressExpandedText,
  buildExpandedText,
} from "./expanded.js";

type Theme = { fg: (token: string, text: string) => string; bold: (text: string) => string };
type RenderContext = {
  expanded: boolean;
  isError: boolean;
  lastComponent: RowBlock | undefined;
  state: Record<string, unknown>;
  invalidate: () => void;
};

/**
 * Draw a subagent result (or its live progress) into `rows`.
 *
 * `rows` is a `RowBlock` rather than a plain `Text` because the renderers below
 * hand back whole content: the component is what knows the width pi is drawing
 * at, and it is what cuts each row to that width (`row-block.ts`).
 */
export function renderSubagentResult(
  rows: RowBlock,
  result: SubagentToolResult,
  options: { expanded: boolean },
  theme: Theme,
  context: RenderContext,
): RowBlock {
  const details: SubagentDetails | undefined = result.details;
  const expanded = context.expanded ?? options.expanded;

  if (!details) {
    rows.setText(theme.fg("dim", "  no results"));
    return rows;
  }

  // ── Streaming progress (results empty but progress has data) ──────────
  if (details.results.length === 0 && details.progress && details.progress.length > 0) {
    if (details.progress.length === 1) {
      return renderProgressUpdate(rows, details.progress[0]!, expanded, theme, context);
    }
    return renderProgressUpdatesParallel(rows, details, expanded, theme, context);
  }

  if (details.results.length === 0) {
    rows.setText(theme.fg("dim", "  no results"));
    return rows;
  }

  // ── Single agent ────────────────────────────────────────────────────────
  if (details.mode === "single" || details.results.length === 1) {
    return renderSingleAgent(rows, details.results[0]!, details.progress?.[0], expanded, theme, context);
  }

  // ── Parallel agents ─────────────────────────────────────────────────────
  return renderParallelAgents(rows, details, expanded, theme, context);
}

function renderSingleAgent(
  rows: RowBlock,
  result: SubagentDetails["results"][number],
  progress: SubagentDetails["progress"] extends (infer U)[] | undefined ? U | undefined : undefined,
  expanded: boolean,
  theme: Theme,
  context: RenderContext,
): RowBlock {
  if (expanded) {
    return renderExpanded(rows, result, progress, theme);
  }
  renderCompactSingle(rows, result, progress, theme, context);
  return rows;
}

function renderParallelAgents(
  rows: RowBlock,
  details: SubagentDetails,
  expanded: boolean,
  theme: Theme,
  context: RenderContext,
): RowBlock {
  if (expanded) {
    const progressArr: SubagentProgress[] = details.progress ?? [];
    rows.setSegments(joinBlocks(details.results.map((result, i) => buildExpandedText(result, progressArr[i], theme))));
    return rows;
  }
  renderCompactParallel(rows, details, theme, context);
  return rows;
}

function renderProgressUpdate(
  rows: RowBlock,
  progress: SubagentProgress,
  expanded: boolean,
  theme: Theme,
  context: RenderContext,
): RowBlock {
  if (expanded) {
    return renderProgressExpanded(rows, progress, theme);
  }
  renderCompactProgress(rows, progress, theme, context);
  return rows;
}

function renderProgressUpdatesParallel(
  rows: RowBlock,
  details: SubagentDetails,
  expanded: boolean,
  theme: Theme,
  context: RenderContext,
): RowBlock {
  if (expanded) {
    const progressArr: SubagentProgress[] = details.progress ?? [];
    rows.setSegments(joinBlocks(progressArr.map((progress) => buildProgressExpandedText(progress, theme))));
    return rows;
  }
  renderCompactParallelProgress(rows, details, theme, context);
  return rows;
}

/** One blank row between agents — the spacing the old `join("\n\n")` produced. */
function joinBlocks(blocks: RowSegment[][]): RowSegment[] {
  return blocks.flatMap((blockLines, i) => (i === 0 ? blockLines : [row(""), ...blockLines]));
}
