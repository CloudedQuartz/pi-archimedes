/**
 * Task 11 item 3 — `subagent` is for the model, not for scripts, and
 * `list_agents` stays reachable both ways.
 *
 * `exposure: "model-only"` is measured, not assumed (see the same file in
 * `ask` for the method and the pi source references). For `subagent` the cost is
 * concrete and it was observed before the change: a codemode script called
 * `tools.subagent({ task: "Reply with exactly the single word: child" })` and
 * got the whole run back as a structured value —
 * `{"mode":"single","results":[{... "outcome":"completed","finalOutput":"child" ...}]}`.
 * After the change that same script line reports
 * `tools.subagent does not exist` and `subagent` is absent from `ALL_TOOLS`.
 *
 * The plan takes the exposure anyway (`docs/roadmap/pi-1-x-alignment.md`,
 * Task 11 item 3): a subagent dispatch is an orchestration step that pi's own
 * docs file under "Use it for orchestrating or interactive tools", the model
 * still drives it, and the nested-call path it does remove is one where the
 * child's row renders inside a script row the user cannot expand. Say so to the
 * maintainer rather than discover it later.
 */

import { describe, it, expect, vi } from "vitest";
import { registerSubagent } from "./index.js";

type RegisteredTool = { name: string; exposure?: string; annotations?: Record<string, boolean> };

function register(): Record<string, RegisteredTool> {
  const tools: RegisteredTool[] = [];
  registerSubagent({
    registerTool: (t: unknown) => tools.push(t as RegisteredTool),
    on: () => {},
    getAllTools: () => [],
    events: { emit: () => {}, on: () => () => {} },
  } as never);
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

describe("subagent exposure", () => {
  it("subagent is model-only: declared to the model, never callable from a script", () => {
    expect(register().subagent!.exposure).toBe("model-only");
  });

  it("list_agents stays direct — a script that dispatches nothing still reads the catalogue", () => {
    expect(register().list_agents!.exposure ?? "direct").toBe("direct");
  });

  it("neither tool carries annotations", () => {
    const tools = register();
    expect(tools.subagent!.annotations).toBeUndefined();
    expect(tools.list_agents!.annotations).toBeUndefined();
  });

  it("nothing in this package is codemode or deferred exposure (ADR 0029)", () => {
    for (const tool of Object.values(register())) {
      expect(["codemode", "deferred", "hidden"]).not.toContain(tool.exposure);
    }
  });
});
