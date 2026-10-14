/**
 * Task 11 item 2 — the machine-readable half of `manage_todo_list`.
 *
 * pi 1.2.0 hands a codemode script the tool's `structuredContent` instead of its
 * text, but only when the tool declares an `outputSchema`
 * (`pi: dist/extensions/codemode/execute.js`, `toScriptValue()`), and it never
 * validates one against the other. So the schema is a promise with no runtime
 * referee: these tests are the referee. Every payload below is produced by
 * running the real handler, and checked against the schema the same registered
 * tool declares — not against a hand-copied shape.
 *
 * The failure paths are asserted too, and one of them is a decision rather than
 * a fact: a failure result carries NO structured content, so a script keeps
 * rejecting with the text it rejects with today. See `tool.ts`.
 */

import { describe, it, expect } from "vitest";
import { Value } from "typebox/value";
import { createManageTodoListTool } from "./tool.js";
import { TodoStateManager } from "./state-manager.js";

const noopEvents = { emit: () => {}, on: () => () => {} } as never;

function harness() {
  const tool = createManageTodoListTool(new TodoStateManager(), () => {}, noopEvents);
  return {
    tool,
    call: (params: Record<string, unknown>) =>
      tool.execute("call-1", params as never, undefined, undefined, {} as never),
  };
}

/** Validate a real result's structured content against the schema on the tool. */
function check(tool: { outputSchema?: unknown }, value: unknown): boolean {
  expect(tool.outputSchema, "tool declares no outputSchema").toBeDefined();
  return Value.Check(tool.outputSchema as never, value);
}

describe("manage_todo_list outputSchema declaration", () => {
  it("declares an output schema shaped like the structured content", () => {
    const { tool } = harness();
    expect(tool.outputSchema).toBeDefined();
    expect((tool.outputSchema as { properties?: Record<string, unknown> }).properties).toHaveProperty("todos");
  });
});

describe("manage_todo_list structuredContent", () => {
  it("read with an empty list → { operation: read, todos: [] }, valid against the schema", async () => {
    const { tool, call } = harness();
    const result = await call({ operation: "read" });
    expect(result.structuredContent).toEqual({ operation: "read", todos: [] });
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("read after a write → the stored list, items exactly as the model wrote them", async () => {
    const { tool, call } = harness();
    await call({
      operation: "write",
      todoList: [
        { content: "One", status: "pending" },
        { content: "Two", status: "in_progress", description: "with context" },
      ],
    });
    const result = await call({ operation: "read" });
    expect(result.structuredContent).toEqual({
      operation: "read",
      todos: [
        { content: "One", status: "pending" },
        { content: "Two", status: "in_progress", description: "with context" },
      ],
    });
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("write success → { operation: write, todos } matching the schema, content text untouched", async () => {
    const { tool, call } = harness();
    const result = await call({
      operation: "write",
      todoList: [{ content: "Ship it", status: "completed" }],
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      operation: "write",
      todos: [{ content: "Ship it", status: "completed" }],
    });
    expect(check(tool, result.structuredContent)).toBe(true);
    // The model-facing text is unchanged: models and this suite's other tests read it.
    expect(result.content[0]!.text).toContain("1/1 completed");
  });

  it("write without a todoList → isError, and NO structured content (scripts keep rejecting with the text)", async () => {
    const { call } = harness();
    const result = await call({ operation: "write" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("Error: todoList is required for write operation.");
    expect("structuredContent" in result).toBe(false);
  });

  it("write that fails validation → isError, no structured content, content text untouched", async () => {
    const { call } = harness();
    const result = await call({
      operation: "write",
      todoList: [{ content: "   ", status: "pending" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Validation failed:");
    expect("structuredContent" in result).toBe(false);
  });

  it("write of an empty list → { operation: write, todos: [] }, valid (a cleared list is an answer)", async () => {
    const { tool, call } = harness();
    const result = await call({ operation: "write", todoList: [] });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ operation: "write", todos: [] });
    expect(check(tool, result.structuredContent)).toBe(true);
  });
});
