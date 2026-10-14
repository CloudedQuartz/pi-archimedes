/**
 * Task 11 item 2 — `ask` as a programmatic tool.
 *
 * `ask` has four success paths (bridge, headless socket, single-question TUI,
 * tabs dialog) and they all build the same `QuestionResult[]`; only the text
 * differs. The structured content is that answer set plus the one thing a
 * script cannot otherwise tell from the text reliably: whether the user
 * answered at all.
 *
 * As elsewhere in this task, the payload is produced by running the real
 * handler and validated against the schema the registered tool declares. The
 * TUI components are mocked (as `tool.test.ts` does) so the assertions are about
 * the result contract, not about drawing a dialog. A crashed picker still
 * throws — that is an unexpected failure, not a reported one (`tool.test.ts`
 * pins it) — so nothing here converts it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Value } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskTool } from "./tool.js";

const { bridgeState, eventsState } = vi.hoisted(() => {
  const ask = vi.fn();
  return {
    bridgeState: { active: false, ask, confirm: vi.fn(), password: vi.fn(), state: vi.fn(() => "idle") },
    eventsState: { emit: vi.fn(), on: () => () => {} },
  };
});

vi.mock("@pi-archimedes/core/bridge", () => ({ getBridge: () => bridgeState }));
vi.mock("./picker.js", () => ({ askSingleQuestionWithInlineNote: vi.fn() }));
vi.mock("./dialog.js", () => ({ askQuestionsWithTabs: vi.fn() }));

const { askSingleQuestionWithInlineNote } = await import("./picker.js");
const { askQuestionsWithTabs } = await import("./dialog.js");

type RegisteredTool = {
  name: string;
  outputSchema?: unknown;
  execute: (
    id: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: unknown;
    structuredContent?: unknown;
    isError?: boolean;
  }>;
};

function captureTool(): RegisteredTool {
  const registered: RegisteredTool[] = [];
  registerAskTool({ registerTool: (t: unknown) => registered.push(t as RegisteredTool), events: eventsState } as unknown as ExtensionAPI);
  return registered[0]!;
}

function check(tool: RegisteredTool, value: unknown): boolean {
  expect(tool.outputSchema, "ask declares no outputSchema").toBeDefined();
  return Value.Check(tool.outputSchema as never, value);
}

const oneQuestion = {
  questions: [
    { id: "q1", question: "Which option?", description: "Some context", options: [{ label: "A" }, { label: "B" }] },
  ],
};

const twoQuestions = {
  questions: [
    { id: "q1", question: "First?", options: [{ label: "A" }, { label: "B" }] },
    { id: "q2", question: "Second?", multi: true, options: [{ label: "A" }, { label: "B" }] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  bridgeState.active = false;
});

describe("ask outputSchema", () => {
  it("declares one", () => {
    expect(captureTool().outputSchema).toBeDefined();
  });

  it("the answer set is what the schema describes: results + cancelled", () => {
    const tool = captureTool();
    const props = (tool.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props).sort()).toEqual(["cancelled", "results"]);
  });
});

describe("ask structuredContent — success paths", () => {
  it("bridge answer → { cancelled: false, results: [one answered result] }", async () => {
    bridgeState.active = true;
    bridgeState.ask.mockResolvedValue({
      cancelled: false,
      results: [{ id: "q1", selectedOptions: ["B"], customInput: "extra" }],
    });

    const tool = captureTool();
    const result = await tool.execute("t1", oneQuestion, undefined, undefined, { hasUI: true, ui: {} });

    expect(result.structuredContent).toEqual({
      cancelled: false,
      results: [
        {
          id: "q1",
          question: "Which option?",
          description: "Some context",
          options: ["A", "B"],
          multi: false,
          selectedOptions: ["B"],
          customInput: "extra",
        },
      ],
    });
    expect(check(tool, result.structuredContent)).toBe(true);
    // Content text unchanged — the summary line models read.
    expect(result.content[0]!.text).toContain('q1: B + Other: "extra"');
  });

  it("bridge cancel → { cancelled: true, results: [one unanswered result] }, content text unchanged", async () => {
    bridgeState.active = true;
    bridgeState.ask.mockRejectedValue(new Error("bridge is not active"));

    const tool = captureTool();
    const result = await tool.execute("t1", oneQuestion, undefined, undefined, { hasUI: true, ui: {} });

    expect(result.content[0]!.text).toBe("User cancelled the question.");
    expect(result.structuredContent).toEqual({
      cancelled: true,
      results: [
        {
          id: "q1",
          question: "Which option?",
          description: "Some context",
          options: ["A", "B"],
          multi: false,
          selectedOptions: [],
        },
      ],
    });
    expect(check(tool, result.structuredContent)).toBe(true);
    expect(result.isError).toBeUndefined();
  });

  it("single-question TUI → one result, cancelled false, custom input only when given", async () => {
    vi.mocked(askSingleQuestionWithInlineNote).mockResolvedValue({ selectedOptions: ["A"] });

    const tool = captureTool();
    const result = await tool.execute("t2", oneQuestion, undefined, undefined, { hasUI: true, ui: {} });

    expect(result.structuredContent).toEqual({
      cancelled: false,
      results: [
        {
          id: "q1",
          question: "Which option?",
          description: "Some context",
          options: ["A", "B"],
          multi: false,
          selectedOptions: ["A"],
        },
      ],
    });
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("single-question TUI with no selection → cancelled true (the text says (cancelled))", async () => {
    vi.mocked(askSingleQuestionWithInlineNote).mockResolvedValue({ selectedOptions: [] });

    const tool = captureTool();
    const result = await tool.execute("t3", oneQuestion, undefined, undefined, { hasUI: true, ui: {} });

    expect(result.content[0]!.text).toContain("(cancelled)");
    expect((result.structuredContent as { cancelled: boolean }).cancelled).toBe(true);
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("a typed answer with nothing selected → cancelled false, customInput present", async () => {
    // `cancelled` is the tool's own test — nothing selected AND nothing typed —
    // so a typed answer is not a cancellation even with an empty selection, and
    // `customInput` is the only field that says so.
    bridgeState.active = true;
    bridgeState.ask.mockResolvedValue({ cancelled: false, results: [{ id: "q1", selectedOptions: [], customInput: "typed instead" }] });

    const tool = captureTool();
    const result = await tool.execute("t5", oneQuestion, undefined, undefined, { hasUI: true, ui: {} });

    const structured = result.structuredContent as { cancelled: boolean; results: Array<Record<string, unknown>> };
    expect(structured.cancelled).toBe(false);
    expect(structured.results[0]!.selectedOptions).toEqual([]);
    expect(structured.results[0]!.customInput).toBe("typed instead");
    expect(result.content[0]!.text).toContain("typed instead");
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("tabs dialog with two questions → two results, in question order", async () => {
    vi.mocked(askQuestionsWithTabs).mockResolvedValue({
      cancelled: false,
      selections: [{ selectedOptions: ["A"] }, { selectedOptions: ["B"], customInput: "note" }],
    });

    const tool = captureTool();
    const result = await tool.execute("t4", twoQuestions, undefined, undefined, { hasUI: true, ui: {} });

    expect(result.structuredContent).toEqual({
      cancelled: false,
      results: [
        {
          id: "q1",
          question: "First?",
          options: ["A", "B"],
          multi: false,
          selectedOptions: ["A"],
        },
        {
          id: "q2",
          question: "Second?",
          options: ["A", "B"],
          multi: true,
          selectedOptions: ["B"],
          customInput: "note",
        },
      ],
    });
    expect(check(tool, result.structuredContent)).toBe(true);
  });
});
