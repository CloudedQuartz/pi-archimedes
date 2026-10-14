/**
 * Task 11 item 2 — `web_search`, `fetch_content` and `get_search_content` as
 * programmatic tools.
 *
 * Same referee as `todo`'s: the payloads come from the real handlers, and are
 * validated against the `outputSchema` the registered tool declares
 * (`pi` hands a codemode script `structuredContent` only when one is declared,
 * and validates nothing). The providers and the cache are mocked so the shapes
 * under test are the ones the real modules produce — `SearchResultItem`,
 * the extractor's document fields, and `PassageResult` — not invented ones.
 *
 * The third group is the throw-to-`isError` change. All three handlers used to
 * let a provider failure (or a cache miss) escape; `pi` turned that into an
 * error result whose text was the message (`pi-agent-core: agent-loop.js`,
 * `createErrorToolResult()`, which also attaches `details: {}`). Returning
 * `isError: true` keeps that text byte-identical and moves the failure report
 * out of the harness and into the handler, where the tool can say what it
 * knows. See `AgentToolResult.isError`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Value } from "typebox/value";
import { registerTools } from "./tools.js";

const { executeSearch, extractContent, getResponse, findPassages } = vi.hoisted(() => ({
  executeSearch: vi.fn(),
  extractContent: vi.fn(),
  getResponse: vi.fn(),
  findPassages: vi.fn(),
}));

vi.mock("./config.js", () => ({ loadConfig: () => ({}) }));
vi.mock("./providers/registry.js", () => ({ executeSearch }));
vi.mock("./extractors/pipeline.js", () => ({ extractContent }));
vi.mock("./storage/cache.js", () => ({
  storeResponse: () => "web_test_1",
  getResponse,
}));
vi.mock("./storage/find.js", () => ({ findPassages }));

type RegisteredTool = {
  name: string;
  outputSchema?: unknown;
  execute: (
    id: string,
    params: Record<string, unknown>,
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

function register(): Record<string, RegisteredTool> {
  const tools: Record<string, RegisteredTool> = {};
  registerTools({
    registerTool: (t: unknown) => {
      const tool = t as RegisteredTool;
      tools[tool.name] = tool;
    },
  } as never);
  return tools;
}

const tools = register();

function check(tool: RegisteredTool, value: unknown): boolean {
  expect(tool.outputSchema, `${tool.name} declares no outputSchema`).toBeDefined();
  return Value.Check(tool.outputSchema as never, value);
}

beforeEach(() => {
  vi.clearAllMocks();
  executeSearch.mockResolvedValue({
    provider: "test-provider",
    results: [
      { title: "First", url: "https://example.com/1", snippet: "snap one" },
      {
        title: "Second",
        url: "https://example.com/2",
        snippet: "snap two",
        publishedDate: "2026-01-02",
      },
    ],
  });
  extractContent.mockResolvedValue({
    url: "https://example.com/page",
    title: "A page",
    markdown: "# A page\nbody text",
    wordCount: 42,
    status: 200,
    extractor: "readability",
  });
  getResponse.mockReturnValue({
    id: "web_test_1",
    type: "search",
    content: "cached body",
    timestamp: 1,
  });
  findPassages.mockReturnValue([{ passage: "…cached body…", offset: 2, match: "body" }]);
});

describe("outputSchema declarations", () => {
  it("all three web tools declare one", () => {
    for (const name of ["web_search", "fetch_content", "get_search_content"]) {
      expect(tools[name]!.outputSchema, `${name} declares no outputSchema`).toBeDefined();
    }
  });

});

describe("web_search", () => {
  it("success → structuredContent mirrors the details the renderer already uses", async () => {
    const tool = tools.web_search!;
    const result = await tool.execute("c1", { query: "pi" }, undefined, undefined, {});
    expect(result.content[0]!.text).toBe(
      "[First](https://example.com/1)\n[Second](https://example.com/2)",
    );
    expect(result.structuredContent).toEqual({
      responseId: "web_test_1",
      provider: "test-provider",
      resultCount: 2,
      results: [
        { title: "First", url: "https://example.com/1", snippet: "snap one" },
        {
          title: "Second",
          url: "https://example.com/2",
          snippet: "snap two",
          publishedDate: "2026-01-02",
        },
      ],
    });
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("a provider that rejects comes back as isError, not a thrown error", async () => {
    executeSearch.mockRejectedValueOnce(new Error("provider exploded"));
    const tool = tools.web_search!;
    const result = await tool.execute("c1", { query: "pi" }, undefined, undefined, {});
    expect(result.isError).toBe(true);
    // Same text pi's own catch produced from the throw.
    expect(result.content[0]!.text).toBe("provider exploded");
    expect("structuredContent" in result).toBe(false);
  });

  it("a hit with no publishedDate omits the optional, and still validates", async () => {
    executeSearch.mockResolvedValueOnce({
      provider: "p",
      results: [{ title: "No date", url: "https://example.com/nd", snippet: "s" }],
    });
    const tool = tools.web_search!;
    const result = await tool.execute("c1", { query: "pi" }, undefined, undefined, {});
    expect((result.structuredContent as { results: Array<Record<string, unknown>> }).results[0]).toEqual({
      title: "No date",
      url: "https://example.com/nd",
      snippet: "s",
    });
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("zero hits → results: [], still valid", async () => {
    executeSearch.mockResolvedValueOnce({ provider: "p", results: [] });
    const tool = tools.web_search!;
    const result = await tool.execute("c1", { query: "nothing matches this" }, undefined, undefined, {});
    expect(result.structuredContent).toEqual({ responseId: "web_test_1", provider: "p", resultCount: 0, results: [] });
    expect(check(tool, result.structuredContent)).toBe(true);
  });
});

describe("fetch_content", () => {
  it("success → structuredContent mirrors the details", async () => {
    const tool = tools.fetch_content!;
    const result = await tool.execute("c2", { url: "https://example.com/page" }, undefined, undefined, {});
    expect(result.content[0]!.text).toBe("# A page\nbody text");
    expect(result.structuredContent).toEqual({
      responseId: "web_test_1",
      url: "https://example.com/page",
      title: "A page",
      wordCount: 42,
      status: 200,
      extractor: "readability",
      content: "# A page\nbody text",
      snippet: "# A page\nbody text",
    });
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("an extractor that rejects comes back as isError, not a thrown error", async () => {
    extractContent.mockRejectedValueOnce(new Error("HTTP 404"));
    const tool = tools.fetch_content!;
    const result = await tool.execute("c2", { url: "https://example.com/x" }, undefined, undefined, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("HTTP 404");
    expect("structuredContent" in result).toBe(false);
  });

  it("a document longer than the snippet keeps its FULL text in structuredContent", async () => {
    // Declaring `outputSchema` moves a script from the text (the whole document)
    // to the structured content (pi: `toScriptValue()`), so the structured
    // payload has to carry what the text used to — a 500-character window is not
    // the document. pi's own `bash` does the same: `structuredContent.output`
    // holds the output, not a preview (`core/tools/bash.js`).
    const long = "# Heading\n" + "word ".repeat(400);
    extractContent.mockResolvedValueOnce({
      url: "https://example.com/long",
      title: "Long page",
      markdown: long,
      wordCount: 401,
      status: 200,
      extractor: "readability",
    });
    const tool = tools.fetch_content!;
    const result = await tool.execute("c2", { url: "https://example.com/long" }, undefined, undefined, {});
    const structured = result.structuredContent as Record<string, unknown>;
    // The model still reads the whole document from `content`…
    expect(result.content[0]!.text).toBe(long);
    // …and so does a script, which never sees `content`.
    expect(structured["content"]).toBe(long);
    // The glanceable window stays, unchanged.
    expect(structured["snippet"]).toBe(long.slice(0, 500));
    expect(check(tool, result.structuredContent)).toBe(true);
  });
});

describe("get_search_content", () => {
  it("content branch → { responseId, content }", async () => {
    const tool = tools.get_search_content!;
    const result = await tool.execute("c3", { responseId: "web_test_1" }, undefined, undefined, {});
    expect(result.content[0]!.text).toBe("cached body");
    expect(result.structuredContent).toEqual({ responseId: "web_test_1", content: "cached body" });
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("offset/limit branch → the slice actually handed back", async () => {
    const tool = tools.get_search_content!;
    const result = await tool.execute(
      "c3",
      { responseId: "web_test_1", offset: 1, limit: 3 },
      undefined,
      undefined,
      {},
    );
    expect(result.structuredContent).toEqual({ responseId: "web_test_1", content: "ach" });
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("limit 0 → empty content, still valid against the schema", async () => {
    const tool = tools.get_search_content!;
    const result = await tool.execute("c3", { responseId: "web_test_1", limit: 0 }, undefined, undefined, {});
    expect(result.structuredContent).toEqual({ responseId: "web_test_1", content: "" });
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("findText branch → { responseId, matches }, passages with offset and match", async () => {
    const tool = tools.get_search_content!;
    const result = await tool.execute(
      "c3",
      { responseId: "web_test_1", findText: "body" },
      undefined,
      undefined,
      {},
    );
    expect(result.content[0]!.text).toBe(JSON.stringify([{ passage: "…cached body…", offset: 2, match: "body" }]));
    expect(result.structuredContent).toEqual({
      responseId: "web_test_1",
      matches: [{ passage: "…cached body…", offset: 2, match: "body" }],
    });
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("an unknown responseId is an isError result, not a thrown Error", async () => {
    getResponse.mockReturnValue(undefined);
    const tool = tools.get_search_content!;
    const result = await tool.execute("c3", { responseId: "web_missing" }, undefined, undefined, {});
    expect(result.isError).toBe(true);
    // Byte-identical to the text pi built from `throw new Error("Response not found")`.
    expect(result.content[0]!.text).toBe("Response not found");
    expect("structuredContent" in result).toBe(false);
  });

  it("findText with no matches → matches: [] — the union's second branch, empty", async () => {
    findPassages.mockReturnValueOnce([]);
    const tool = tools.get_search_content!;
    const result = await tool.execute(
      "c3",
      { responseId: "web_test_1", findText: "not in the cache" },
      undefined,
      undefined,
      {},
    );
    expect(result.structuredContent).toEqual({ responseId: "web_test_1", matches: [] });
    expect(check(tool, result.structuredContent)).toBe(true);
  });

  it("an offset past the end → empty content, first branch still valid", async () => {
    const tool = tools.get_search_content!;
    const result = await tool.execute("c3", { responseId: "web_test_1", offset: 999 }, undefined, undefined, {});
    expect(result.structuredContent).toEqual({ responseId: "web_test_1", content: "" });
    expect(check(tool, result.structuredContent)).toBe(true);
  });
});
