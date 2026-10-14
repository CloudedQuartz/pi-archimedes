/**
 * Cross-package transport: `subagent` emits, `todo` receives — on ONE host
 * event bus, which is the property the retired `globalThis` bus used to
 * provide by being process-wide.
 *
 * This is the unit-level shape of the headless proof in the migration report:
 * two packages, two `ExtensionAPI` handles, one delivery. The bus object here
 * stands in for the host's `createEventBus()`; what it must not be is a third
 * package — nothing may own the transport any more.
 *
 * Red-first note: before the migration this failed because both sides talked to
 * `getBus()` (the `globalThis` singleton) and ignored the handle handed to
 * them, so the shared bus below saw nothing.
 */
import { describe, it, expect } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTodo } from "./index.js";

/** The channel literal — the wire contract, not an import, on purpose. */
const TODOS_UPDATE = "archimedes:todos_update";
const TODOS_CLEAR = "archimedes:todos_clear";

function fakeBus() {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown): void {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void): () => void {
      const subs = listeners.get(channel) ?? [];
      subs.push(handler);
      listeners.set(channel, subs);
      return () => {
        const current = listeners.get(channel) ?? [];
        const idx = current.indexOf(handler);
        if (idx !== -1) current.splice(idx, 1);
      };
    },
    listenerCount(channel: string): number {
      return (listeners.get(channel) ?? []).length;
    },
  };
}

function fakePi(bus: ReturnType<typeof fakeBus>) {
  const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
  const captured: { widget?: unknown; tools: Record<string, any> } = { tools: {} };
  const ctx = {
    ui: { setWidget: (_id: string, factory: unknown) => { captured.widget = factory; } },
    sessionManager: { getBranch: () => [] },
  };
  const pi = {
    on(event: string, handler: (e: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event) ?? [];
        const idx = current.indexOf(handler);
        if (idx !== -1) current.splice(idx, 1);
      };
    },
    registerTool(tool: any) {
      captured.tools[tool.name] = tool;
    },
    registerCommand() {},
    events: bus,
  };
  const fire = async (event: string, e: unknown = { type: event }) => {
    for (const handler of [...(handlers.get(event) ?? [])]) await handler(e, ctx);
  };
  return { pi: pi as unknown as ExtensionAPI, fire, ctx, captured };
}

const theme: any = { fg: (_c: unknown, s: unknown) => String(s), strikethrough: (s: unknown) => String(s) };

function widgetLines(widget: unknown): string[] {
  expect(typeof widget).toBe("function");
  return (widget as (tui: unknown, t: unknown) => { render(w: number): string[] })(null, theme).render(200);
}

describe("todo receives subagent todos over the host bus", () => {
  it("a subscriber registered before the emitter receives the update", async () => {
    const bus = fakeBus();
    const todo = fakePi(bus);

    // todo subscribes FIRST (registration time, as it does today) ...
    registerTodo(todo.pi);
    await todo.fire("session_start");
    expect(bus.listenerCount(TODOS_UPDATE)).toBe(1);

    // ... and only then does a producer emit, from another package's handle.
    bus.emit(TODOS_UPDATE, {
      source: "subagent:explorer",
      todos: [{ content: "Read the bridge", status: "in_progress" }],
    });

    const lines = widgetLines(todo.captured.widget).join("\n");
    expect(lines).toContain("Read the bridge");
    // The widget renders the agent NAME for a subagent column, not the raw
    // "subagent:<name>" source — that mapping is the todo package's contract.
    expect(lines).toContain("subagent (explorer)");
  });

  it("TODOS_CLEAR drops the column", async () => {
    const bus = fakeBus();
    const todo = fakePi(bus);
    registerTodo(todo.pi);
    await todo.fire("session_start");
    // A main todo keeps the widget installed, so the assertion below is about
    // the subagent column disappearing and not about the widget going away.
    await todo.captured.tools.manage_todo_list.execute(
      "c1",
      { operation: "write", todoList: [{ content: "Keep the bar up", status: "pending" }] },
      undefined,
      undefined,
      todo.ctx as any,
    );

    bus.emit(TODOS_UPDATE, { source: "subagent:explorer", todos: [{ content: "Temp", status: "pending" }] });
    expect(widgetLines(todo.captured.widget).join("\n")).toContain("Temp");

    bus.emit(TODOS_CLEAR, { source: "subagent:explorer" });
    const after = widgetLines(todo.captured.widget).join("\n");
    expect(after).not.toContain("Temp");
    expect(after).toContain("Keep the bar up");
  });

  /**
   * The AGENTS.md accumulation rule, made observable. Two `session_start`s in
   * one session must not stack a second subscription — that is how a per-session
   * `events.on()` double-delivers.
   */
  it("two session_starts do not cause two deliveries of one event", async () => {
    const bus = fakeBus();
    const todo = fakePi(bus);
    registerTodo(todo.pi);
    await todo.fire("session_start");
    await todo.fire("session_start");
    expect(bus.listenerCount(TODOS_UPDATE)).toBe(1);

    const seen: unknown[] = [];
    bus.on(TODOS_UPDATE, (p) => seen.push(p));
    bus.emit(TODOS_UPDATE, { source: "subagent:x", todos: [{ content: "Once", status: "pending" }] });
    expect(seen).toHaveLength(1);
  });

  it("session_shutdown unsubscribes, so a dead session stops receiving", async () => {
    const bus = fakeBus();
    const todo = fakePi(bus);
    registerTodo(todo.pi);
    await todo.fire("session_start");
    await todo.fire("session_shutdown", { type: "session_shutdown", reason: "new" });
    expect(bus.listenerCount(TODOS_UPDATE)).toBe(0);
    expect(bus.listenerCount(TODOS_CLEAR)).toBe(0);
  });
});

describe("todo's own writes reach the bus a subscriber already holds", () => {
  it("the tool emits TODOS_UPDATE on the handle it was given", async () => {
    const bus = fakeBus();
    const todo = fakePi(bus);
    registerTodo(todo.pi);
    await todo.fire("session_start");

    const seen: unknown[] = [];
    bus.on(TODOS_UPDATE, (p) => seen.push(p));

    await todo.captured.tools.manage_todo_list.execute(
      "c1",
      { operation: "write", todoList: [{ content: "Write the bus out", status: "pending" }] },
      undefined,
      undefined,
      todo.ctx as any,
    );

    expect(seen).toHaveLength(1);
    expect((seen[0] as { source: string }).source).toBe("main");
    expect((seen[0] as { todos: unknown[] }).todos).toEqual([
      { content: "Write the bus out", status: "pending" },
    ]);
  });
});
