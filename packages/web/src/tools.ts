import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { executeSearch } from "./providers/registry.js";
import type { SearchResultItem } from "./providers/types.js";
import { extractContent } from "./extractors/pipeline.js";
import type { ExtractedDoc } from "./extractors/types.js";
import { storeResponse, getResponse } from "./storage/cache.js";
import { findPassages } from "./storage/find.js";
import {
  renderWebSearchCall, renderWebSearchResult,
  renderFetchContentCall, renderFetchContentResult,
  renderGetSearchContentCall, renderGetSearchContentResult
} from "./renderer.js";

// ── Output schemas ───────────────────────────────────────────────────────────
//
// Each schema describes the `structuredContent` the handler really returns, so
// a codemode script resolves to structure where it used to resolve to the
// text (`pi: dist/extensions/codemode/execute.js`, `toScriptValue()`). pi does
// not validate one against the other, so `tools.output-schema.test.ts` runs the
// handlers and validates the payloads against these declarations.
//
// Failure results carry no structured content: a provider that failed, a page
// that could not be fetched and a cache miss are all calls that produced no
// observation, so a script keeps rejecting with the same text it rejected with
// before these schemas existed. (pi's own `bash` does the opposite for a
// non-zero exit, where the failing command *is* the observation.)
//
// Exposure is left at `direct` for all three on purpose: `codemode`/`deferred`
// would take the declarations away from the model, and with no virtual model and
// no MCP server registered (ADR 0029) nothing would hand them back.

/** One hit, as the providers produce them (`SearchResultItem`). */
const SearchResultItemSchema = Type.Object({
  title: Type.String(),
  url: Type.String(),
  snippet: Type.String(),
  publishedDate: Type.Optional(Type.String()),
});

const WebSearchOutputSchema = Type.Object({
  /** Id to hand `get_search_content` to page through this response. */
  responseId: Type.String(),
  provider: Type.String(),
  resultCount: Type.Number(),
  results: Type.Array(SearchResultItemSchema),
});

const FetchContentOutputSchema = Type.Object({
  responseId: Type.String(),
  url: Type.String({ description: "The URL the document was read from, after redirects" }),
  title: Type.String(),
  wordCount: Type.Number(),
  status: Type.Number({ description: "HTTP status of the fetch" }),
  extractor: Type.String(),
  /**
   * The whole document, the same text the `content` block carries. A script
   * cannot read that block — declaring `outputSchema` makes pi hand it this
   * object instead (`toScriptValue()`) — so the document itself belongs here,
   * as it does in pi's own `bash`, whose `structuredContent.output` is the
   * output rather than a preview (`core/tools/bash.js`).
   */
  content: Type.String({ description: "The full extracted document, exactly as the content block reports it" }),
  /** First 500 characters of `content`, for a glanceable confirmation. */
  snippet: Type.String(),
});

const PassageOutputSchema = Type.Object({
  passage: Type.String(),
  offset: Type.Number(),
  match: Type.String(),
});

// The two shapes this tool can answer with: passages for `findText`, text for
// everything else.
const GetSearchContentOutputSchema = Type.Union([
  Type.Object({ responseId: Type.String(), content: Type.String() }),
  Type.Object({ responseId: Type.String(), matches: Type.Array(PassageOutputSchema) }),
]);

/**
 * The text pi builds from a thrown error (`pi-agent-core: agent-loop.js`,
 * `createErrorToolResult()`), so reporting a failure as `isError` instead of
 * throwing leaves the model-facing text byte-identical.
 */
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      queries: Type.Optional(Type.Array(Type.String())),
      numResults: Type.Optional(Type.Number()),
      provider: Type.Optional(Type.String()),
      recencyFilter: Type.Optional(Type.String()),
      domainFilter: Type.Optional(Type.Array(Type.String())),
      proxy: Type.Optional(Type.String()),
    }),
    outputSchema: WebSearchOutputSchema,
    // Results come from outside this session's domain, which is what the MCP
    // hint means. Author-declared and unverified: pi documents `annotations` as
    // the input for a permission gate, not as a guarantee.
    annotations: { openWorldHint: true },
    renderCall: renderWebSearchCall,
    renderResult: renderWebSearchResult,
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      // `pi` comes from the enclosing registerTools: `getSettings()` is an
      // ExtensionAPI method, so a tool's own ctx cannot answer it.
      const config = loadConfig(pi);
      const queries = params.queries ?? (params.query ? [params.query] : []);
      const proxy = params.proxy ?? config.proxy;
      let search: { provider: string; results: SearchResultItem[] };
      try {
        search = await executeSearch(queries, {
          ...(params.numResults !== undefined && { numResults: params.numResults }),
          ...(params.recencyFilter !== undefined && { recencyFilter: params.recencyFilter }),
          ...(params.domainFilter !== undefined && { domainFilter: params.domainFilter }),
          ...(proxy !== undefined && { proxy }),
          signal
        }, config);
      } catch (error) {
        // Reported, not thrown: same text pi would have built from the throw.
        return {
          content: [{ type: "text", text: failureText(error) }],
          details: { error: failureText(error) },
          isError: true,
        };
      }
      const { provider, results } = search;

      const summary = results.map(r => `[${r.title}](${r.url})`).join('\n');
      const responseId = storeResponse({
        type: "search",
        content: summary,
        metadata: { provider, results },
      });
      
      return { 
        content: [{ type: "text", text: summary }], 
        details: { responseId, provider, resultCount: results.length, results },
        structuredContent: {
          responseId,
          provider,
          resultCount: results.length,
          results: results.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            ...(r.publishedDate !== undefined && { publishedDate: r.publishedDate }),
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description: "Fetch web content",
    parameters: Type.Object({
      url: Type.String(),
      mode: Type.Optional(Type.Union([Type.Literal("readable"), Type.Literal("raw"), Type.Literal("answer")])),
      prompt: Type.Optional(Type.String()),
      proxy: Type.Optional(Type.String()),
    }),
    outputSchema: FetchContentOutputSchema,
    annotations: { openWorldHint: true },
    renderCall: renderFetchContentCall,
    renderResult: renderFetchContentResult,
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      const config = loadConfig(pi);
      const proxy = params.proxy ?? config.proxy;
      let doc: ExtractedDoc;
      try {
        doc = await extractContent(params.url, params.mode ?? "readable", { 
          ...(params.prompt !== undefined && { prompt: params.prompt }),
          ...(proxy !== undefined && { proxy }),
          signal: signal ?? undefined
        });
      } catch (error) {
        return {
          content: [{ type: "text", text: failureText(error) }],
          details: { error: failureText(error) },
          isError: true,
        };
      }
      const responseId = storeResponse({
        type: "fetch",
        content: doc.markdown,
        metadata: { url: doc.url, title: doc.title, wordCount: doc.wordCount, status: doc.status, extractor: doc.extractor },
      });
      const snippet = doc.markdown.slice(0, 500);
      
      return { 
        content: [{ type: "text", text: doc.markdown }], 
        details: { responseId, url: doc.url, title: doc.title, wordCount: doc.wordCount, status: doc.status, extractor: doc.extractor, snippet } ,
        structuredContent: {
          responseId,
          url: doc.url,
          title: doc.title,
          wordCount: doc.wordCount,
          status: doc.status,
          extractor: doc.extractor,
          content: doc.markdown,
          snippet,
        },
      };
    },
  });

  pi.registerTool({
    name: "get_search_content",
    label: "Get Stored Content",
    description: "Get cached search content",
    parameters: Type.Object({
      responseId: Type.String(),
      findText: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    outputSchema: GetSearchContentOutputSchema,
    annotations: { openWorldHint: true },
    renderCall: renderGetSearchContentCall,
    renderResult: renderGetSearchContentResult,
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const item = getResponse(params.responseId);
      if (!item) {
        // Reported, not thrown: pi turned this throw into an error result whose
        // text was the message, and that text is what the model has been reading.
        return {
          content: [{ type: "text", text: "Response not found" }],
          details: { responseId: params.responseId, error: "Response not found" },
          isError: true,
        };
      }
      
      if (params.findText) {
        const matches = findPassages(item.content, [params.findText]);
        return {
          content: [{ type: "text", text: JSON.stringify(matches) }],
          details: { matches },
          structuredContent: {
            responseId: params.responseId,
            matches: matches.map((m) => ({ passage: m.passage, offset: m.offset, match: m.match })),
          },
        };
      }
      
      if (params.limit === 0) {
        return {
          content: [{ type: "text", text: "" }],
          details: { content: "" },
          structuredContent: { responseId: params.responseId, content: "" },
        };
      }
      
      const content = item.content.slice(params.offset ?? 0, params.limit ? (params.offset ?? 0) + params.limit : undefined);
      return {
        content: [{ type: "text", text: content }],
        details: { content },
        structuredContent: { responseId: params.responseId, content },
      };
    },
  });
}
