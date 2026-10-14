/**
 * Task 11 item 3 — how the web tools are declared to the model and to scripts.
 *
 * `openWorldHint` is the MCP hint for "this reaches outside the closed domain",
 * which is exactly what a search provider and an HTTP fetch do. pi documents
 * `annotations` as author-declared and unverified — a permission gate's input,
 * not a guarantee (`pi: dist/core/extensions/types.d.ts`, `ToolAnnotations`).
 *
 * The exposure assertion is the negative half of the plan: these tools stay
 * `direct`. `codemode`/`deferred` would take their declarations away from the
 * model, and the suite does not register virtual models or MCP servers
 * (ADR 0029), so nothing would put them back.
 */

import { describe, it, expect, vi } from "vitest";
import { registerTools } from "./tools.js";

vi.mock("./config.js", () => ({ loadConfig: () => ({}) }));

type RegisteredTool = {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  exposure?: string;
};

const tools: Record<string, RegisteredTool> = {};
registerTools({ registerTool: (t: unknown) => { const tool = t as RegisteredTool; tools[tool.name] = tool; } } as never);

const names = ["web_search", "fetch_content", "get_search_content"];

describe("web tool annotations", () => {
  it.each(names)("%s declares openWorldHint", (name) => {
    expect(tools[name]!.annotations?.openWorldHint).toBe(true);
  });

  it.each(names)("%s declares nothing it has not earned", (name) => {
    const annotations = tools[name]!.annotations ?? {};
    // Only `openWorldHint` is declared. The others are claims this suite has
    // not verified and a permission gate would have to take on trust: a fetch
    // writes to the in-process response cache, so "read-only" is not plainly
    // true of these handlers either.
    expect(annotations.readOnlyHint).toBeUndefined();
    expect(annotations.destructiveHint).toBeUndefined();
    expect(annotations.idempotentHint).toBeUndefined();
  });
});

describe("web tool exposure", () => {
  it.each(names)("%s stays direct: declared to the model and callable from scripts", (name) => {
    expect(tools[name]!.exposure ?? "direct").toBe("direct");
  });
});
