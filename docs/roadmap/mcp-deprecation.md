---
status: approved
done-when: The mcp package is removed from the suite (no import/manifest/publish-line), the packages/mcp directory is deleted, README/AGENTS.md/CONTEXT.md no longer describe it, the meta tests pass with 11 non-core plugins, and @pi-archimedes/mcp@2.8.0 is npm-deprecated pointing at pi's built-in MCP (pi >= 0.99).
---

# Deprecate the mcp package (superseded by pi's built-in MCP)

## Context

Pi 0.99 added first-party MCP support: `mcp.json` (global `~/.pi/agent/mcp.json` + per-project `.pi/mcp.json`, trust-gated), stdio + streamable HTTP transports, OAuth with dynamic client registration and auto-refresh, a `/mcp` TUI manager (sign in/out, reconnect, enable/disable, exposure), `pi mcp add|remove|list|login|logout` shell commands, an exposure model (`codemode` default / `codemode-deferred` / `deferred` via `tool_search` / `direct` / `hidden`, plus per-tool `toolExposure` with `*` patterns), resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`), 20KB result truncation with temp-file spill, transient-error retries, `mcp.log`, and process-group cleanup.

Verified in the installed pi 0.99.1 bundle: the built-in `mcp` extension is registered as `replaceable: true` (`dist/extensions/index.js`), and `omitReplacedExtensions` in `dist/core/resource-loader.js` drops any replaceable builtin whose tool/command/flag name is taken by a non-builtin extension — with a warning that the built-in "was not loaded". Our `@pi-archimedes/mcp` v2.8.0 registers the `mcp` command **and** the `mcp` tool, so while the suite is installed the built-in MCP never runs: no `mcp.json` reading, no `mcp__server__tool` tools, no resource tools, no codemode auto-activation. The package doesn't just overlap with the built-in — it actively blocks it.

What the package still offers that the built-in lacks (dropped by this decision): the `/mcp setup` wizard (import from Cursor/Claude Code/Claude Desktop/VS Code + curated presets), MCP prompts, OS keyring credential storage, the metadata cache (offline search/describe), per-server lifecycle modes (keep-alive/lazy/lazy-keep-alive/eager + idle timeout), 6-layer config with write-back, and legacy SSE support.

## Design

### Repo changes

1. **`packages/mcp/`** — delete the entire directory (source, tests, README). Git preserves the history; ADRs 0015–0019 and `docs/research/pi-mcp-adapter-server-config-tools.md` stay as historical records.
2. **`meta/package.json`** — remove `"@pi-archimedes/mcp": "workspace:*"` from `dependencies`.
3. **`meta/src/index.ts`** — remove mcp from the parallel lazy-load tuple (5 → 4 packages) and the `if (mcpMod) { mcpMod.registerMcp(pi); }` block; update the "five packages" comment to "four".
4. **`meta/src/plugins.ts`** — remove the `{ id: "mcp", ... }` entry from the `PLUGINS` manifest. This also drops MCP from the `/plugins` menu and the `/archimedes` settings items (both key off the manifest).
5. **`meta/src/plugins.test.ts`** — remove `"mcp"` from `EXPECTED_IDS` (12 → 11 non-core packages; the "lists exactly the N non-core packages" test text updates to 11); the two gate tests that use `"mcp"` as their example plugin id (`defaults to enabled when config is empty`, `returns false only for the plugin disabled in its own namespace`) switch to another manifest id (e.g. `web` / `footer`), keeping the same assertions.
6. **`meta/src/factory-lifecycle.test.ts`** — remove `vi.mock("@pi-archimedes/mcp", ...)` and the `mcpMod` mention in the dynamic-imports comment.
7. **`.github/workflows/release.yml`** — remove the `pnpm --filter "@pi-archimedes/mcp" publish ...` line (publish order becomes core → ui → sudo → ask → todo → notify → session-name → footer → diff → image-paste → subagent → web → meta).
8. **`AGENTS.md`** — remove `packages/mcp` from the Monorepo Structure list; "Bump all **14** package versions" → **13** (drop `packages/mcp` from the list); "13 package directories (12 components + session-name)" → **12** (11 components + session-name); drop mcp from the publish-order line.
9. **`README.md` + `meta/README.md`** — remove the MCP feature section ("Connect MCP servers … Start with `/mcp setup` …"), the monorepo layout-tree line (`mcp/`), the `pi install npm:@pi-archimedes/mcp` line, the settings-table row (`/mcp`, `/mcp setup`), and the MCP README link in the components list.
10. **`CONTEXT.md`** — delete the "MCP terminology" section (proxy tool, direct tool, metadata cache, needs-auth, callback server, auth entry, host config, config write-back) — all obsolete with the package gone.

The `archimedes.mcp` settings namespace becomes inert: no migration code, existing settings are simply never read.

### npm deprecation + release

- **npm deprecate** (manual release step, maintainer credentials):
  `npm deprecate @pi-archimedes/mcp "Superseded by pi's built-in MCP support (pi >= 0.99). Note: while this package is installed it REPLACES pi's built-in MCP — uninstall it to use the built-in."`
  Last published version stays 2.8.0; no new mcp version is ever published. Existing standalone installers keep working and see the warning.
- **Versioning** — the release is a **minor** bump (removing a component is user-visible). All 13 remaining packages bump together; mcp is not part of the bump.
- **Release notes** (AGENTS.md structure):
  - Headline section: "MCP component deprecated — pi ≥ 0.99 ships first-party MCP".
  - Migration note: config is a no-op in the common case — the built-in reads the same two top-layer files (`~/.pi/agent/mcp.json`, project `.pi/mcp.json`) in the same `mcpServers` shape and ignores our extra fields (`directTools`, `lifecycle`). If you used our other four layers (`<cwd>/.mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, `~/.config/mcp/mcp.json`), move those entries into the built-in's files. `type: "sse"` entries are rejected by the built-in — switch to the streamable-HTTP endpoint. The `archimedes.mcp` settings, `~/.pi/agent/mcp-cache.json`, and keyring auth entries are unused (safe to delete).
  - `## Other changes` — one bullet for the suite change. No external contributors → no thanks section.

## Verification

1. `npx tsc --noEmit` in `meta/` (and every remaining package) — green.
2. `meta/` test suite (vitest) — green, with `plugins.test.ts` asserting 11 non-core ids.
3. `grep -r "@pi-archimedes/mcp\|packages/mcp" --include="*.ts" --include="*.json" --include="*.yml" --include="*.md" .` (excluding node_modules and `docs/decisions/` + `docs/research/`) — no hits.
4. Install the suite in a scratch pi ≥ 0.99 session: the `mcp` command and `mcp` tool are gone, and pi's built-in MCP loads (a `mcp.json` server connects and `mcp__<server>__<tool>` tools are reachable; no "built-in extension mcp was not loaded" warning).
5. `npm view @pi-archimedes/mcp` shows the deprecation message after the manual deprecate step.
