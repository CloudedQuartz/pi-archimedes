/**
 * Task 11 item 2 — `subagent` as a programmatic tool.
 *
 * `details` is the renderer's payload: per-run reports plus the live-progress
 * blob (`progress`, with the child's whole streamed output and its tool-call
 * history). A script wants the run reports, not the scrollback, so the
 * structured content is the report set with `progress` left out — see the
 * comment at the declaration in `index.ts`.
 *
 * `subagent` already reports failure as `isError` rather than throwing (ADR
 * 0028), and that shape is unchanged here; what is new is that the failure
 * results carry no structured content, so a script keeps rejecting with the
 * text it rejects with today.
 *
 * `./agents.js` and `./execute.js` are mocked (as `index.test.ts` does) so the
 * assertions are about the result contract rather than a real child process.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Value } from "typebox/value";

const discoverAgents = vi.hoisted(() => vi.fn());
const executeSubagent = vi.hoisted(() => vi.fn());
const executeParallel = vi.hoisted(() => vi.fn());

vi.mock("./agents.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  discoverAgents,
}));
vi.mock("./execute.js", () => ({ executeSubagent, executeParallel }));

const { registerSubagent } = await import("./index.js");
const { formatSingleResult, formatParallelResults } = await import("./format.js");

type RegisteredTool = {
  name: string;
  outputSchema?: unknown;
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
    structuredContent?: unknown;
    isError?: boolean;
  }>;
};

function subagent(): RegisteredTool {
  const tools: RegisteredTool[] = [];
  registerSubagent({
    registerTool: (t: unknown) => tools.push(t as RegisteredTool),
    on: () => {},
    getAllTools: () => [{ name: "read" }, { name: "bash" }],
    events: { emit: () => {}, on: () => () => {} },
  } as never);
  const tool = tools.find((t) => t.name === "subagent");
  if (!tool) throw new Error("subagent tool was not registered");
  return tool;
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { getAll: () => [], getAvailable: () => [] },
    hasUI: true,
    ui: { notify: vi.fn() },
    ...overrides,
  };
}

/** A completed run, with the live-progress blob a real stream would attach. */
const okResult = {
  agent: "reviewer",
  task: "review it",
  childSessionId: "child-uuid",
  exitCode: 0,
  outcome: "completed" as const,
  usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.01, turns: 1 },
  model: "anthropic/claude-opus-4.5",
  finalOutput: "all good",
  error: undefined,
  progress: {
    agent: "reviewer",
    status: "completed" as const,
    outcome: "completed" as const,
    task: "review it",
    currentTool: undefined,
    currentToolArgs: undefined,
    currentToolStartedAt: undefined,
    toolCount: 1,
    inputTokens: 10,
    outputTokens: 5,
    tokens: 15,
    cost: 0.01,
    durationMs: 10,
    error: undefined,
    model: "anthropic/claude-opus-4.5",
    output: "the child's entire scrollback, which a script does not need twice",
    recentOutput: ["x"],
    toolCalls: [{ name: "read", argsPreview: "file", error: false }],
  },
  progressSummary: { toolCount: 1, tokens: 15, durationMs: 10 },
};

function agentConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: "reviewer",
    description: "d",
    systemPrompt: "p",
    source: "user",
    filePath: "/tmp/agents/reviewer.md",
    ...overrides,
  };
}

function check(tool: RegisteredTool, value: unknown): boolean {
  expect(tool.outputSchema, "subagent declares no outputSchema").toBeDefined();
  return Value.Check(tool.outputSchema as never, value);
}

beforeEach(() => {
  discoverAgents.mockReset();
  executeSubagent.mockReset();
  executeParallel.mockReset();
  discoverAgents.mockReturnValue([agentConfig()]);
  executeSubagent.mockResolvedValue(okResult);
  executeParallel.mockResolvedValue([okResult]);
});

describe("subagent outputSchema", () => {
  it("declares one, describing mode + results", () => {
    const tool = subagent();
    expect(tool.outputSchema).toBeDefined();
    const props = (tool.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props).sort()).toEqual(["mode", "results"]);
  });
});

describe("subagent structuredContent — single mode", () => {
  it("a completed run reports itself structurally, without the live-progress blob", async () => {
    const tool = subagent();
    const result = await tool.execute("c1", { agent: "reviewer", task: "review it" }, undefined, undefined, makeCtx());

    expect(result.content[0]!.text).toBe(formatSingleResult(okResult as never));
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      mode: "single",
      results: [
        {
          agent: "reviewer",
          task: "review it",
          childSessionId: "child-uuid",
          exitCode: 0,
          outcome: "completed",
          usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.01, turns: 1 },
          model: "anthropic/claude-opus-4.5",
          finalOutput: "all good",
          progressSummary: { toolCount: 1, tokens: 15, durationMs: 10 },
        },
      ],
    });
    expect(check(tool, result.structuredContent)).toBe(true);
    // The scrollback stays in `details` for the renderer, out of the structured payload.
    expect(JSON.stringify(result.structuredContent)).not.toContain("scrollback");
  });

  it("a failed run is isError with no structured content, content text unchanged", async () => {
    const failed = { ...okResult, outcome: undefined, error: "child crashed", finalOutput: undefined };
    executeSubagent.mockResolvedValueOnce(failed);

    const tool = subagent();
    const result = await tool.execute("c1", { agent: "reviewer", task: "review it" }, undefined, undefined, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(formatSingleResult(failed as never));
    expect("structuredContent" in result).toBe(false);
  });

  it("an unknown agent stays isError with the same text, and carries no structured content", async () => {
    const tool = subagent();
    const result = await tool.execute("c1", { agent: "ghost", task: "t" }, undefined, undefined, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Unknown agent: "ghost"');
    expect("structuredContent" in result).toBe(false);
  });

  it("a call with no task stays isError with the same text", async () => {
    const tool = subagent();
    const result = await tool.execute("c1", {}, undefined, undefined, makeCtx());

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("Missing task parameter");
    expect("structuredContent" in result).toBe(false);
  });
});

describe("subagent structuredContent — parallel mode", () => {
  it("reports every run, in task order", async () => {
    // Both agents must exist, or the batch is rejected before anything runs.
    discoverAgents.mockReturnValue([agentConfig(), agentConfig({ name: "explorer" })]);
    const second = { ...okResult, agent: "explorer", task: "look around", finalOutput: "noted" };
    executeParallel.mockResolvedValueOnce([okResult, second]);

    const tool = subagent();
    const result = await tool.execute(
      "c2",
      { tasks: [{ agent: "reviewer", task: "review it" }, { agent: "explorer", task: "look around" }] },
      undefined,
      undefined,
      makeCtx(),
    );

    expect(result.content[0]!.text).toBe(formatParallelResults([okResult, second] as never));
    const structured = result.structuredContent as { mode: string; results: Array<{ agent: string }> };
    expect(structured.mode).toBe("parallel");
    expect(structured.results.map((r) => r.agent)).toEqual(["reviewer", "explorer"]);
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("a rejected batch (unknown agent in one task) is isError, no structured content", async () => {
    const tool = subagent();
    const result = await tool.execute(
      "c2",
      { tasks: [{ agent: "ghost", task: "t" }] },
      undefined,
      undefined,
      makeCtx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Unknown agent(s)");
    expect("structuredContent" in result).toBe(false);
  });
});
