/**
 * Task 11 item 3 — what pi's callers are told about `sudo_exec`.
 *
 * `annotations` are author-declared hints with MCP's meaning, and pi documents
 * them as unverified — the input for a permission gate that decides which calls
 * to confirm, not a guarantee (`pi: dist/core/extensions/types.d.ts`,
 * `ToolAnnotations`). So this test pins the declaration, nothing more: `sudo_exec`
 * runs arbitrary privileged commands, so it is destructive and not read-only.
 */

import { describe, it, expect } from "vitest";
import { createSudoExecTool } from "./tool.js";

const tool = createSudoExecTool() as unknown as {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  exposure?: string;
};

describe("sudo_exec annotations", () => {
  it("says it is destructive", () => {
    expect(tool.annotations?.destructiveHint).toBe(true);
  });

  it("says it is not read-only", () => {
    expect(tool.annotations?.readOnlyHint).toBe(false);
  });

  it("leaves the hints it has not earned undeclared", () => {
    // idempotentHint would be a lie — a second `sudo rm` is not a no-op — and
    // openWorldHint belongs to the tools that reach the web, not this one.
    expect(tool.annotations?.idempotentHint).toBeUndefined();
    expect(tool.annotations?.openWorldHint).toBeUndefined();
  });

  it("stays reachable by default (direct exposure, active on registration)", () => {
    expect(tool.exposure ?? "direct").toBe("direct");
  });
});
