/**
 * Task 11 item 3 — `ask` is for the model, not for scripts.
 *
 * `exposure: "model-only"` means: declared to the model while active, never
 * callable through `ctx.executeTool()` (`pi: dist/core/extensions/types.d.ts`,
 * `ToolExposure`; `dist/core/agent-session.js`, `_getCallableTools()` — only
 * `direct` + active, `codemode` and `deferred` are callable). Codemode builds
 * its callable set from exactly that list
 * (`dist/extensions/codemode/execute.js`), so this costs something real, and it
 * was measured on a real headless pi before shipping:
 *
 *   before (`direct`) — a codemode script's `tools.ask({...})` resolved; it
 *   printed `ASK_TYPE: object {"cancelled":true,...}`.
 *   after (`model-only`) — the same script fails with
 *   `tools.ask does not exist. Available: ...` and `ask` is gone from its
 *   `ALL_TOOLS`.
 *
 * A probe tool carrying only `exposure: "model-only"` showed the same split on
 * the same pi: the model called it and got its result, while a script's
 * `tools.probe_model_only({})` reported it as non-existent. `ask` takes the
 * exposure because a script that asks a question the user never sees (the TUI
 * and bridge paths need a session's UI) orchestrates nothing it can answer for;
 * the interactive tool belongs to the model's turn.
 */

import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskTool } from "./tool.js";

type RegisteredTool = { name: string; exposure?: string; annotations?: Record<string, boolean> };

function captureTool(): RegisteredTool {
  const registered: RegisteredTool[] = [];
  registerAskTool({
    registerTool: (t: unknown) => registered.push(t as RegisteredTool),
    events: { emit: vi.fn(), on: () => () => {} },
  } as unknown as ExtensionAPI);
  return registered[0]!;
}

describe("ask exposure", () => {
  it("is model-only: declared to the model, never callable from a script", () => {
    expect(captureTool().exposure).toBe("model-only");
  });

  it("carries no annotations — nothing here is a hint a permission gate needs", () => {
    expect(captureTool().annotations).toBeUndefined();
  });
});
