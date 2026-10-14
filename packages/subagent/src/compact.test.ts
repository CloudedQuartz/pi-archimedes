import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { buildActivityLine, renderCompactSingle, renderCompactParallel } from "./compact.js";
import { RowBlock, type RowSegment, type RowSink } from "./row-block.js";
import type { SubagentResult, SubagentProgress, SubagentDetails, SubagentToolCall } from "./types.js";

// ── The row sink the builders draw into ───────────────────────────────────────────────────────────────────

/**
 * A recording `RowSink`, standing in for the `RowBlock` `render.ts` hands these
 * builders. Deliberately not a `RowBlock`, and deliberately no mock of pi-tui's
 * `Text`: `row-block.ts` takes `sliceByColumn` / `wrapTextWithAnsi` /
 * `visibleWidth` from that module, so mocking it to fake a sink would quietly
 * break the row code the tests are about. What the segments draw is asserted
 * with a real `RowBlock` below.
 */
class RecordingSink implements RowSink {
  private content = "";
  private segments: RowSegment[] | undefined = undefined;

  setText(content: string): void {
    this.content = content;
    this.segments = undefined;
  }

  /** Mirrors `RowBlock.setSegments`: the joined text is what a row draws. */
  setSegments(segments: RowSegment[]): void {
    this.segments = segments;
    this.content = segments.map((s) => s.text).join("\n");
  }

  getContent(): string {
    return this.content;
  }

  getSegments(): RowSegment[] | undefined {
    return this.segments;
  }
}

// Type-safe helper: ActivityData with all optional fields for test convenience
// ActivityData is defined in compact.ts — reconstruct the shape here
type ActivityData = {
  currentTool: string | undefined;
  currentToolArgs: string | undefined;
  currentToolStartedAt: number | undefined;
  finalOutput: string | undefined;
  status: "running" | "completed" | "failed" | undefined;
  error: string | undefined;
  toolCalls?: (SubagentToolCall | string)[] | undefined;
};

function activityData(p: Partial<ActivityData>): ActivityData {
  return {
    currentTool: undefined,
    currentToolArgs: undefined,
    currentToolStartedAt: undefined,
    finalOutput: undefined,
    status: undefined,
    error: undefined,
    toolCalls: undefined,
    ...p,
  };
}

// Mock theme that tracks calls for verification
function makeMockTheme() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];

  const theme = {
    fg: (token: string, text: string) => {
      calls.push({ fn: "fg", args: [token, text] });
      return `[${token}]${text}[/${token}]`;
    },
    bold: (text: string) => {
      calls.push({ fn: "bold", args: [text] });
      return `**${text}**`;
    },
  };

  return { theme, calls };
}

// ── buildActivityLine ──────────────────────────────────────────────────────

describe("buildActivityLine", () => {
  it("shows error prefix with truncated error when error is present", () => {
    const { theme } = makeMockTheme();
    const result = buildActivityLine(
      activityData({ error: "Something went wrong", status: "running" }),
      theme,
    );
    expect(result).toContain("✗ Something went wrong");
  });

  it("shows '✓ Done' when status is completed", () => {
    const { theme } = makeMockTheme();
    const result = buildActivityLine(
      activityData({ status: "completed" }),
      theme,
    );
    expect(result).toContain("✓ Done");
  });

  it("shows '✗ Failed' when status is failed", () => {
    const { theme } = makeMockTheme();
    const result = buildActivityLine(
      activityData({ status: "failed" }),
      theme,
    );
    expect(result).toContain("✗ Failed");
  });

  it("shows tool name + args when running with current tool", () => {
    const { theme } = makeMockTheme();
    const result = buildActivityLine(
      activityData({
        status: "running",
        currentTool: "read",
        currentToolArgs: '{"path": "foo.ts"}',
      }),
      theme,
    );
    expect(result).toContain("read");
    expect(result).toContain("foo.ts");
  });

  it("shows last tool call when running with no current tool but toolCalls present", () => {
    const { theme } = makeMockTheme();
    const result = buildActivityLine(
      activityData({
        status: "running",
        toolCalls: [
          { name: "bash", argsPreview: "ls -la", error: false },
        ],
      }),
      theme,
    );
    expect(result).toContain("bash");
  });

  it("shows '▸ Starting...' when running with no info", () => {
    const { theme } = makeMockTheme();
    const result = buildActivityLine(
      activityData({ status: "running" }),
      theme,
    );
    // Glyph and label are rendered as separate themed fragments.
    expect(result).toContain("▸ ");
    expect(result).toContain("Starting...");
  });

  it("shows first line of final output when available", () => {
    const { theme } = makeMockTheme();
    const result = buildActivityLine(
      activityData({
        status: "running",
        finalOutput: "first line of output\nsecond line\nthird line",
      }),
      theme,
    );
    expect(result).toContain("first line of output");
    expect(result).not.toContain("second line");
  });

  it("returns empty string when status is undefined and no data", () => {
    const { theme } = makeMockTheme();
    const result = buildActivityLine(activityData({}), theme);
    expect(result).toBe("");
  });

  it("error takes priority over completed status", () => {
    const { theme } = makeMockTheme();
    const result = buildActivityLine(
      activityData({ error: "oops", status: "completed" }),
      theme,
    );
    expect(result).toContain("✗ oops");
    expect(result).not.toContain("✓ Done");
  });

  it("completed status takes priority over currentTool", () => {
    const { theme } = makeMockTheme();
    const result = buildActivityLine(
      activityData({ status: "completed", currentTool: "read" }),
      theme,
    );
    expect(result).toContain("✓ Done");
    expect(result).not.toContain("read");
  });

  it("shows string toolCall in toolCalls array", () => {
    const { theme } = makeMockTheme();
    const result = buildActivityLine(
      activityData({
        status: "running",
        toolCalls: ["some-string-call"],
      }),
      theme,
    );
    expect(result).toContain("some-string-call");
  });

  it("colors last tool call name with error color when error flag set", () => {
    const { theme, calls } = makeMockTheme();
    buildActivityLine(
      activityData({
        status: "running",
        toolCalls: [{ name: "bash", argsPreview: "rm -rf /", error: true }],
      }),
      theme,
    );
    // The tool name "bash" should be colored with "error" token
    const fgCalls = calls.filter(c => c.fn === "fg");
    const errorCall = fgCalls.find(c => c.args[0] === "error" && c.args[1] === "bash");
    expect(errorCall).toBeDefined();
  });

  it("colors last tool call name with success color when no error", () => {
    const { theme, calls } = makeMockTheme();
    buildActivityLine(
      activityData({
        status: "running",
        toolCalls: [{ name: "read", argsPreview: "file.ts", error: false }],
      }),
      theme,
    );
    const fgCalls = calls.filter(c => c.fn === "fg");
    const successCall = fgCalls.find(c => c.args[0] === "success" && c.args[1] === "read");
    expect(successCall).toBeDefined();
  });
});

// ── renderCompactSingle ────────────────────────────────────────────────────

describe("renderCompactSingle", () => {
  function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
    return {
      agent: "test-agent",
      task: "do something",
      exitCode: 0,
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 3 },
      model: "gpt-4",
      finalOutput: undefined,
      error: undefined,
      progress: undefined,
      progressSummary: { toolCount: 5, tokens: 150, durationMs: 3000 },
      ...overrides,
    };
  }

  it("hands the block to the row sink with the expected structure for a completed agent", () => {
    const { theme } = makeMockTheme();
    const text = new RecordingSink();
    const result = makeResult({ exitCode: 0 });
    const context = { state: {}, invalidate: vi.fn() };

    renderCompactSingle(text, result, undefined, theme, context);

    const output = text.getContent();
    expect(output).toContain("test-agent");
    expect(output).toContain("do something");
    expect(output).toContain("✓ Done");
  });

  it("hands the block to the row sink with the expected structure for a running agent", () => {
    const { theme } = makeMockTheme();
    const text = new RecordingSink();
    const result = makeResult({ exitCode: 1 });
    const progress: SubagentProgress = {
      agent: "test-agent",
      status: "running",
      task: "do something",
      currentTool: "read",
      currentToolArgs: undefined,
      currentToolStartedAt: undefined,
      toolCount: 2,
      inputTokens: 50,
      outputTokens: 30,
      tokens: 80,
      cost: 0.005,
      durationMs: 1000,
      error: undefined,
      model: "gpt-4",
      output: undefined,
      recentOutput: undefined,
      toolCalls: undefined,
    };
    const context = { state: {}, invalidate: vi.fn() };

    renderCompactSingle(text, result, progress, theme, context);

    const output = text.getContent();
    expect(output).toContain("test-agent");
    expect(output).toContain("read");
  });

  it("returns the text instance", () => {
    const { theme } = makeMockTheme();
    const text = new RecordingSink();
    const result = makeResult();
    const context = { state: {}, invalidate: vi.fn() };

    const returned = renderCompactSingle(text, result, undefined, theme, context);
    expect(returned).toBe(text);
  });

  // A task is free text and an error is usually stderr, so both arrive with
  // newlines in them. The collapsed view is three rows per agent, so each field
  // has to reach the row layer as its own `row` segment carrying the whole text:
  // the row then cuts itself at the first newline, at the width it is drawn at.
  // Handed over as one joined string, every newline would become a row and a
  // failed child's stderr would open the collapsed block.
  it("hands over three row segments carrying whole fields, so newlines reach the row cut", () => {
    const { theme } = makeMockTheme();
    const text = new RecordingSink();
    const result = makeResult({
      task: "Review the change\nRun the full suite",
      exitCode: 1,
      error: "spawn failed\ncommand not found: pnpm",
    });

    renderCompactSingle(text, result, undefined, theme, { state: {}, invalidate: vi.fn() });

    const segments = text.getSegments();
    expect(segments?.map((s) => s.kind)).toEqual(["row", "row", "row"]);
    // Fields arrive uncapped — the row decides how much of each one fits.
    expect(segments?.[0]?.text).toContain("Run the full suite");
    expect(segments?.[2]?.text).toContain("command not found: pnpm");

    // And drawn by the real row component, that is three rows: the newline is a
    // boundary inside the row, not a new row.
    const rows = new RowBlock();
    rows.setSegments(segments!);
    const drawn = rows.render(80).map((l) => stripTerminalSequences(l).replace(/\s+$/, ""));
    // Three rows, and the two fields that carry newlines end in the cut marker
    // rather than spilling into rows of their own. (The mock theme marks its
    // spans with markers of its own, so match the tail of each row.)
    expect(drawn).toHaveLength(3);
    expect(drawn[0]).toMatch(/: Review the change\.\.\.$/);
    expect(drawn[1]).toContain("gpt-4");
    expect(drawn[2]).toMatch(/✗ spawn failed\.\.\.$/);
  });
});

// ── renderCompactParallel ──────────────────────────────────────────────────

describe("renderCompactParallel", () => {
  function makeDetails(overrides: Partial<SubagentDetails> = {}): SubagentDetails {
    return {
      mode: "parallel",
      results: [
        {
          agent: "agent-a",
          task: "task a",
          exitCode: 0,
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          model: undefined,
          finalOutput: undefined,
          error: undefined,
          progress: undefined,
          progressSummary: { toolCount: 0, tokens: 0, durationMs: 0 },
        },
        {
          agent: "agent-b",
          task: "task b",
          exitCode: 1,
          usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          model: undefined,
          finalOutput: undefined,
          error: "failed",
          progress: undefined,
          progressSummary: { toolCount: 0, tokens: 0, durationMs: 0 },
        },
      ],
      progress: undefined,
      ...overrides,
    };
  }

  it("renders a full 3-line block per agent (parity with single view)", () => {
    const { theme } = makeMockTheme();
    const text = new RecordingSink();
    const details = makeDetails();
    const context = { state: {}, invalidate: vi.fn() };

    renderCompactParallel(text, details, theme, context);

    const output = text.getContent();
    expect(output).toContain("agent-a");
    expect(output).toContain("agent-b");
    // Each agent is a 3-line block (label / model+stats / activity); with two
    // agents that is 6 lines total — no status-glyph prefix on the label line.
    const lines = output.split("\n");
    expect(lines.length).toBe(6);
    // Status shows only in each agent's activity line, not as a label prefix:
    // agent-a succeeded → "✓ Done"; agent-b failed with an error string →
    // "✗ <error>" (the raw error, here "failed").
    expect(output).toContain("✓ Done");
    expect(output).toContain("✗ ");
    // The label lines carry no leading status glyph.
    expect(lines[0]).not.toContain("✓");
    expect(lines[3]).not.toContain("✗");
  });

  it("returns the text instance", () => {
    const { theme } = makeMockTheme();
    const text = new RecordingSink();
    const details = makeDetails();
    const context = { state: {}, invalidate: vi.fn() };

    const returned = renderCompactParallel(text, details, theme, context);
    expect(returned).toBe(text);
  });
});

// ── Property tests (fast-check) ────────────────────────────────────────────

// The cap property tests that used to live here pinned "≤ 60 / ≤ 80 characters".
// That rule is gone: rows are cut at the width pi renders them at, which is
// audited against the real renderers in `tool-row.width-audit.test.ts`, and the
// cutting itself (cells, colour, newlines) in `row-block.test.ts`. What these
// builders owe that audit is the *whole* content, so the row — not the builder —
// decides where the line ends.
describe("buildActivityLine hands its row whole content (no character cap)", () => {
  /** Remove the mock theme's `[token]`/`[/token]` markers (fixtures exclude `[`). */
  const stripMarkers = (s: string) => s.replace(/\[\/?(?:muted|running|success|error|dim|accent)\]/g, "");

  it("carries an error far longer than the old 80-character limit", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 81, maxLength: 500 }).filter((s) => !s.includes("[")),
        (error) => {
          const { theme } = makeMockTheme();
          const result = buildActivityLine(
            activityData({ error, status: "running" }),
            theme,
          );
          expect(stripMarkers(result)).toBe("✗ " + error);
        },
      ),
    );
  });

  it("carries args far longer than the old 60-character limit", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes(": ") && !s.includes("\n") && !s.includes("|") && !s.includes("[")),
        fc.string({ minLength: 61, maxLength: 500 }).filter((s) => !s.includes(": ") && !s.includes("\n") && !s.includes("|") && !s.includes("[")),
        (currentTool, currentToolArgs) => {
          const { theme } = makeMockTheme();
          const result = buildActivityLine(
            activityData({ status: "running", currentTool, currentToolArgs }),
            theme,
          );
          const visible = stripMarkers(result);
          expect(visible.includes(currentToolArgs)).toBe(true);
        },
      ),
    );
  });

  it("carries the first line of output whole, and never a second line", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 81, maxLength: 500 }).filter((s) => !s.includes("\n") && !s.includes("[")),
        (firstLine) => {
          const { theme } = makeMockTheme();
          const result = buildActivityLine(
            activityData({ status: "running", finalOutput: `${firstLine}\nsecond line\nthird` }),
            theme,
          );
          const visible = stripMarkers(result);
          expect(visible).toBe("▸ " + firstLine);
        },
      ),
    );
  });

  it("carries a string tool call far longer than the old 60-character limit", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 61, maxLength: 500 }).filter((s) => !s.includes("\n") && !s.includes("[")),
        (toolCallStr) => {
          const { theme } = makeMockTheme();
          const result = buildActivityLine(
            activityData({ status: "running", toolCalls: [toolCallStr] }),
            theme,
          );
          const visible = stripMarkers(result);
          expect(visible.includes(toolCallStr)).toBe(true);
        },
      ),
    );
  });
});

describe("compact activity line: run outcomes", () => {
  it("shows Truncated for a cut-off answer, in warning colour", () => {
    const { theme } = makeMockTheme();
    const line = buildActivityLine(
      activityData({ status: "completed", outcome: "truncated" } as never),
      theme,
    );
    expect(line).toMatch(/truncated/i);
    expect(line).not.toMatch(/Done/);
  });

  it("shows Aborted for a cancelled run", () => {
    const { theme } = makeMockTheme();
    const line = buildActivityLine(
      activityData({ status: "completed", outcome: "aborted" } as never),
      theme,
    );
    expect(line).toMatch(/aborted/i);
  });

  it("shows Done for a completed run, unchanged", () => {
    const { theme } = makeMockTheme();
    const line = buildActivityLine(
      activityData({ status: "completed", outcome: "completed" } as never),
      theme,
    );
    expect(line).toContain("✓ Done");
  });
});
