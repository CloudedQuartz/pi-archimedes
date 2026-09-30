---
status: accepted
date: 2026-09-30
superseded-by:
---

# Deprecate the mcp package in favor of pi's built-in MCP (pi ≥ 0.99)

Pi 0.99 shipped first-party MCP support: `mcp.json` (global + per-project, trust-gated), stdio + streamable HTTP, OAuth with dynamic client registration and auto-refresh, a `/mcp` TUI manager, `pi mcp` shell commands, an exposure model (`codemode` default / `codemode-deferred` / `deferred` via `tool_search` / `direct` / `hidden` + per-tool `toolExposure`), resource tools, and 20KB result truncation. We decided to deprecate `@pi-archimedes/mcp` (v2.8.0, last published): remove it from the suite and npm-deprecate the package.

The deciding factor: pi marks its built-in `mcp` extension `replaceable` — any third-party extension that registers the `/mcp` command (or a `mcp` tool) causes the built-in extension to not load at all (`omitReplacedExtensions` in the resource loader). Our package registers both, so while it is installed the built-in MCP is silently dead: no `mcp.json` reading, no `mcp__server__tool` tools, no resource tools, no codemode auto-activation. Keeping the package on pi ≥ 0.99 doesn't just overlap with the built-in — it actively blocks it.

**Considered Options**

- **Keep as-is** — rejected: the built-in is first-party, better maintained, and wins on the two axes that matter in 0.99 (token efficiency via the codemode/tool_search exposure model, management UX).
- **Remove from the suite, keep the standalone package published** — rejected: we'd keep maintaining ~30 source files of OAuth/lifecycle/config machinery for a shrinking audience (only pi < 0.99 users, who should upgrade).
- **Rewrite as a thin complement (drop `/mcp` + the `mcp` tool, keep the setup wizard and prompts)** — rejected: the built-in's docs already guide the agent through importing foreign client configs, and prompts are niche; the rewrite cost isn't worth the remaining value.

**Consequences**

- We drop the setup wizard (`/mcp setup` imports from Cursor/Claude Code/Claude Desktop/VS Code + curated presets), MCP prompts, OS keyring credential storage, the metadata cache (offline search), per-server lifecycle modes, 6-layer config, and legacy SSE support.
- Migration for users is near-zero: the built-in reads the same two top-layer files (`~/.pi/agent/mcp.json`, project `.pi/mcp.json`) in the same `mcpServers` shape and ignores our extra fields (`directTools`, `lifecycle`). Only entries in our other four config layers, `type: "sse"` entries, and the `archimedes.mcp` settings namespace (now inert) need attention.
- ADRs 0015–0019 (MCP design decisions) and the `packages/mcp` directory history remain in git as the record of how the adapter was built; the package directory is deleted from the repo.
