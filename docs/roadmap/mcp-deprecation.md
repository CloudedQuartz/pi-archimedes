---
status: committed
done-when: The mcp package is removed from the suite (no import/manifest/publish-line/vitest-project), the packages/mcp directory is deleted, README/AGENTS.md/CONTEXT.md no longer describe it, the meta tests pass with 11 non-core plugins, the full test + type-check suite is green, and @pi-archimedes/mcp@2.8.0 is npm-deprecated pointing at pi's built-in MCP (pi >= 0.99) in release v2.9.0.
---

# MCP Deprecation Plan

**Goal:** Remove the deprecated `@pi-archimedes/mcp` package from the suite so pi ≥ 0.99's first-party MCP support (which our package currently *blocks* — see ADR 0024) works for suite users, and npm-deprecate the package.
**Architecture:** The package is a leaf (nothing depends on it; it depends on core). Removal is: drop it from `meta` (dep, lazy-load, manifest, tests), delete `packages/mcp`, stop publishing it (release workflow + root vitest projects), and scrub the docs. No settings-migration code — the `archimedes.mcp` namespace simply becomes inert.
**Tech Stack:** pnpm workspace, TypeScript (jiti, `tsc --noEmit` verification), vitest (root `pnpm test`), GitHub Actions (ci.yml, release.yml).

**Background for the executing agent:** Pi 0.99 ships built-in MCP. Its builtin `mcp` extension is registered `replaceable: true`; pi's resource loader drops a replaceable builtin when a third-party extension registers the same command/tool name (`omitReplacedExtensions`). Our package registers the `mcp` command and the `mcp` tool, so it replaces the built-in entirely. We are deprecating the package in favor of the built-in (decision: `docs/decisions/0024-mcp-deprecated-for-pi-builtin.md`; spec context in git history of this file). Current suite version: 2.8.0 (all 14 packages). Next version: 2.9.0 (minor).

**Task order matters:** Task 1 before Task 2 (deleting `packages/mcp` while `meta` still imports it breaks `meta`'s type-check).

**Repo-wide hygiene:** `git status` shows pre-existing untracked `*.tgz` build artifacts in every package dir and `meta/` (e.g. `meta/pi-archimedes-2.8.0.tgz`, `packages/*/pi-archimedes-*-2.8.0.tgz`). They are out of scope — **never stage them in any task's commit** (stage explicit paths, or `git add -u` for tracked files only; do not `git add -A`).

---

### Task 1: Remove mcp from the meta package

**Context:**
`meta` is the orchestrator. It lazy-loads every component in a `session_start` handler, gates each on `isPluginEnabled("<id>")` (a suite-managed `enabled` flag read from the plugin's settings namespace), and lists them in the `PLUGINS` manifest (which drives the `/plugins` menu and `/archimedes` settings items). This task removes mcp from all of that, test-first. After this task, the suite no longer loads mcp — pi's built-in MCP becomes active for suite users.

**Files:**
- Modify: `meta/src/plugins.test.ts`
- Modify: `meta/src/plugins.ts`
- Modify: `meta/src/index.ts`
- Modify: `meta/src/factory-lifecycle.test.ts`
- Modify: `meta/package.json`

**What to implement:**

1. `meta/src/plugins.test.ts` (4 mcp references, ~lines 103, 109–110, 209):
   - Line 103: `expect(isPluginEnabled("mcp")).toBe(true);` → `expect(isPluginEnabled("web")).toBe(true);`
   - Lines 109–110:
     ```ts
     mockStore["archimedes.mcp"] = { enabled: false };
     expect(isPluginEnabled("mcp")).toBe(false);
     ```
     →
     ```ts
     mockStore["archimedes.web"] = { enabled: false };
     expect(isPluginEnabled("web")).toBe(false);
     ```
     (keep the surrounding `footer`/`todo` assertions untouched).
   - `EXPECTED_IDS` array (~line 209): remove the `"mcp",` entry (12 → 11 ids).
   - Test title: `it("lists exactly the 12 non-core packages (no drift)", ...)` → `it("lists exactly the 11 non-core packages (no drift)", ...)`.
2. `meta/src/plugins.ts`:
   - Remove the manifest entry (line 31):
     ```ts
     { id: "mcp",          label: "MCP",                description: "MCP client adapter + /mcp commands",             namespace: "archimedes.mcp",         load: () => import("@pi-archimedes/mcp") },
     ```
   - The interface doc comments use mcp as their example — update so no mcp references remain: line 13 `// matches package npm name suffix, e.g. "mcp"` → `e.g. "web"`; line 14 `// human label, e.g. "MCP"` → `e.g. "Web"`; line 16 `// "archimedes.mcp" — the settings.json key ...` → `"archimedes.web"`.
3. `meta/src/index.ts` (5 mcp references):
   - Comment `// ── Parallel lazy-load all five packages (saves ~100ms vs sequential) ──` → `four packages`.
   - `const [diffMod, ipMod, saMod, mcpMod, webMod] = await Promise.all([` → `const [diffMod, ipMod, saMod, webMod] = await Promise.all([`
   - Remove the mcp entry from the `Promise.all` array:
     ```ts
     isPluginEnabled("mcp")
       ? import("@pi-archimedes/mcp").catch((e) => { console.error("[archimedes] mcp load failed:", e); return null; })
       : Promise.resolve(null),
     ```
   - Remove the registration block:
     ```ts
     if (mcpMod) {
       mcpMod.registerMcp(pi);
     }
     ```
   - `archTime("5 packages loaded in parallel");` → `archTime("4 packages loaded in parallel");`
4. `meta/src/factory-lifecycle.test.ts` (2 mcp references):
   - Remove the mock:
     ```ts
     vi.mock("@pi-archimedes/mcp", () => ({
       registerMcp: vi.fn(),
     }));
     ```
   - The comment wraps across two lines (lines 69–70) — replace both lines:
     ```ts
     // properties index.ts uses via destructured `ipMod.*` / `diffMod` / `saMod` /
     // `mcpMod` access (import result objects, not named destructure).
     ```
     →
     ```ts
     // properties index.ts uses via destructured `ipMod.*` / `diffMod` / `saMod`
     // access (import result objects, not named destructure).
     ```
5. `meta/package.json` (2 edits):
   - Remove the `"@pi-archimedes/mcp": "workspace:*",` dependency line.
   - The npm `description` (line 12) still advertises the removed feature and would ship to npm in Task 5: `"Parallel agents, shared task lists, MCP tools, and a polished terminal for the Pi coding agent."` → `"Parallel agents, shared task lists, and a polished terminal for the Pi coding agent."`

**Steps:**
- [ ] Make the `meta/src/plugins.test.ts` changes (item 1 only)
- [ ] Run `cd meta && npx vitest run`
  - Did the test `lists exactly the 11 non-core packages (no drift)` FAIL (manifest still has 12 ids)? If it passed unexpectedly, stop and investigate why.
- [ ] Make the `meta/src/plugins.ts` changes (item 2)
- [ ] Run `cd meta && npx vitest run`
  - Did all meta tests pass? If not, fix and re-run before continuing.
- [ ] Make the `meta/src/index.ts`, `meta/src/factory-lifecycle.test.ts`, and `meta/package.json` changes (items 3–5)
- [ ] Run `pnpm install` (from repo root — updates the lockfile, drops the workspace link)
- [ ] Run `cd meta && npx tsc --noEmit`
  - Did it succeed? If not, fix and re-run.
- [ ] Run `cd meta && npx vitest run`
  - Did all meta tests pass? If not, fix and re-run.
- [ ] Run `pnpm test` (repo root — full suite)
  - Did it pass? (packages/mcp's own tests still run here — they still exist and pass; they go away in Task 2.)
- [ ] Commit with message: `chore(meta): remove the mcp plugin from the suite`

**Acceptance criteria:**
- [ ] `grep -rni "mcp" meta/src/ meta/package.json` returns no hits (case-insensitive — catches `MCP` too).
- [ ] `PLUGINS` has 11 entries; meta's `session_start` lazy-loads exactly 4 packages.
- [ ] `meta` type-checks and its tests pass; the full `pnpm test` is green.
- [ ] `meta/package.json`'s `description` no longer mentions MCP.

---

### Task 2: Delete packages/mcp and the root vitest project entry

**Context:**
With `meta` decoupled (Task 1), the package directory itself goes. `git rm` removes the tracked files; the directory also contains an untracked build artifact (`packages/mcp/pi-archimedes-mcp-2.8.0.tgz`) that `git rm` leaves behind, so the directory is removed afterwards. The root `vitest.config.ts` lists `packages/mcp` as a test project — once the directory is gone, `pnpm test` at the root would fail to resolve it, so the entry is removed in the same commit.

**Files:**
- Delete: `packages/mcp/` (entire directory)
- Modify: `vitest.config.ts`

**What to implement:**
1. `vitest.config.ts`: remove the line `      "packages/mcp",` from the `projects` array.
2. Delete the directory.

**Steps:**
- [ ] Edit `vitest.config.ts` (item 1)
- [ ] Run `git rm -r packages/mcp` then `rm -rf packages/mcp`
- [ ] Run `pnpm install` (drops the workspace entry from the lockfile)
- [ ] Run `pnpm -r exec -- tsc --noEmit` (repo root — all remaining packages)
  - Did it succeed? If not, fix and re-run.
- [ ] Run `pnpm test` (repo root)
  - Did it pass? If not, fix and re-run.
- [ ] Run `grep -rn "@pi-archimedes/mcp" --include="*.ts" --include="*.json" --include="*.yml" . | grep -v node_modules`
  - Expected: **exactly one hit** — the `.github/workflows/release.yml` publish line, which is removed in Task 3. (No `.md` files match this grep, so the ADR is not a hit. Any other hit is a missed Task 1 edit — fix it here.)
- [ ] Commit with message: `chore: delete the deprecated mcp package`

**Acceptance criteria:**
- [ ] `packages/mcp/` no longer exists (tracked or untracked files).
- [ ] Root `pnpm test` and `pnpm -r exec -- tsc --noEmit` are green.

---

### Task 3: Stop publishing @pi-archimedes/mcp in the release workflow

**Context:**
The release workflow publishes every package on a version tag. mcp's line must go, or the next tag republishes the deprecated package. The line sits in dependency order between `subagent` and `web` — removing it leaves the order `… subagent → web → meta` intact.

**Files:**
- Modify: `.github/workflows/release.yml`

**What to implement:**
Remove the line (line 51):
```yaml
          pnpm --filter "@pi-archimedes/mcp" publish --access public --no-git-checks --provenance
```
Do not reorder or reformat any other line.

**Steps:**
- [ ] Remove the line
- [ ] Run `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))"` (if pyyaml is unavailable, use `node -e "new (require('yaml')).parse(...)"` or a visual read — the file is small)
  - Does the YAML parse? If not, fix and re-run.
- [ ] Run `grep -n "mcp" .github/workflows/release.yml`
  - Expected: no hits.
- [ ] Commit with message: `chore(release): stop publishing @pi-archimedes/mcp`

**Acceptance criteria:**
- [ ] The workflow YAML parses and no mcp publish line remains; publish order is core → ui → sudo → ask → todo → notify → session-name → footer → diff → image-paste → subagent → web → meta.

---

### Task 4: Scrub the docs (AGENTS.md, README.md, meta/README.md, CONTEXT.md)

**Context:**
The user-facing docs still describe the MCP component. Every mcp reference goes — including count words that shift by one, and one statement that becomes *factually wrong*: the READMEs say settings.json is strict JSON "unlike MCP server configs, which accept JSONC" — that referred to our package's JSONC-tolerant parser; pi's built-in `mcp.json` loader uses strict `JSON.parse`, so the contrast no longer holds and the parenthetical is deleted. ADRs 0015–0019 and `docs/research/pi-mcp-adapter-server-config-tools.md` are historical records — do NOT touch them.

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `meta/README.md`
- Modify: `CONTEXT.md`

**What to implement:**

1. `AGENTS.md` (5 edits):
   - Monorepo Structure: delete the line `- `packages/mcp` — MCP client adapter (feature parity with pi-mcp-adapter: `/mcp` command family, management + setup panels, OAuth, metadata cache) (depends on core)`.
   - `- `meta` — orchestrator + composed settings (depends on all thirteen)` → `depends on all twelve`.
   - Publishing: `Publishes in dependency order: core → ui → sudo → ask → todo → notify → session-name → footer → diff → image-paste → subagent → mcp → web → meta` → drop `mcp →`.
   - Release step 1: `**Bump all 14 package versions**` → `**Bump all 13 package versions**`; remove `packages/mcp`, from the inline list (the list then reads `… packages/session-name`, `packages/web`, `meta`).
   - Release step 2: `in each of the 13 package directories (12 components + session-name)` → `in each of the 12 package directories (11 components + session-name)`.
2. `README.md` (11 edits):
   - Line 6 (tagline): `**Archimedes brings subagents, shared task lists, MCP tools, and a polished interface to [Pi](https://github.com/earendil-works/pi). Install them together, use what you like, and make the setup yours.**` → `**Archimedes brings subagents, shared task lists, and a polished interface to [Pi](https://github.com/earendil-works/pi). Install them together, use what you like, and make the setup yours.**`
   - ~Line 26: `Your `~/.pi/agent/` stays as it is — Archimedes only adds its namespaces under `settings.json`. Pi's own `auth.json`, `keybindings.json`, agents, and sessions are untouched (and `/mcp setup` only writes the project's `.mcp.json`, when you run it).` → delete the trailing parenthetical, ending the sentence at `...are untouched.`
   - ~Lines 116–121: delete the whole section from `## Bring the tools you already use.` through `Start with `/mcp setup`. Manage it with `/mcp`.` plus one of the two surrounding `---` rules, so the layout is:
     ```
     </p>

     ---

     ## See what changed. Not just that something changed.
     ```
   - ~Line 170: `Toggle the twelve optional extensions` → `Toggle the eleven optional extensions`.
   - ~Line 175: delete the table row `| `/mcp`, `/mcp setup` | MCP component | Manage servers and run logins; the setup wizard scaffolds `.mcp.json` or imports configs from Cursor, Claude Code, Claude Desktop, or VS Code. |`.
   - ~Line 183: in the "Every component keeps its own namespace…" paragraph, delete `[mcp](packages/mcp/README.md), ` from the component list, AND delete the parenthetical `(no comments — unlike MCP server configs, which accept JSONC)` so the sentence reads `…which Pi parses as **strict JSON**. Each component's README documents…`.
   - ~Line 196: delete the table row `| **MCP** | [`@pi-archimedes/mcp`](packages/mcp/README.md) | `/mcp` management, setup wizard, OAuth, config imports |`.
   - ~Line 215: delete the line `pi install npm:@pi-archimedes/mcp` from the "install selectively" block.
   - ~Line 241: delete the layout-tree line `│   ├── mcp/           # MCP client adapter, /mcp commands`.
   - ~Line 247: `└── meta/              # the pi-archimedes orchestrator (depends on all thirteen)` → `depends on all twelve`.
   - Line 162: `Only want the diffs, footer, or MCP tools? Each component is available separately — see [Components](#components).` → `Only want the diffs or footer? Each component is available separately — see [Components](#components).`
3. `meta/README.md` (9 edits — same set as README.md, with its own link forms):
   - Line 6 (tagline): same edit as README.md line 6 (drop `MCP tools, ` from the tagline).
   - ~Line 26: same parenthetical deletion.
   - ~Lines 107–112: same section deletion (`## Bring the tools you already use.` … `Start with `/mcp setup`. Manage it with `/mcp`.` — the link in it is the full GitHub URL form).
   - ~Line 160: `Toggle the ten optional extensions` → `Toggle the eleven optional extensions`. (Note: "ten" was already stale; the correct count after this change is eleven.)
   - ~Line 165: delete the `/mcp`, `/mcp setup` table row (GitHub-URL link form).
   - ~Line 173: delete `[mcp](https://github.com/danielcherubini/pi-archimedes/blob/main/packages/mcp/README.md), ` from the component list, AND delete the `(no comments — unlike MCP server configs, which accept JSONC)` parenthetical (same reason as README.md).
   - ~Line 185: delete the `| **MCP** | …` table row (npmjs link form).
   - ~Line 202: delete the `pi install npm:@pi-archimedes/mcp` line.
   - Line 153: `Only want the diffs, footer, or MCP tools? Each component is available separately — see [Components](#components).` → `Only want the diffs or footer? Each component is available separately — see [Components](#components).`
4. `CONTEXT.md` (2 edits):
   - Delete the entire `## MCP terminology` section (the 8 terms: Proxy tool, Direct tool, Metadata cache, needs-auth, Callback server, Auth entry, Host config, Config write-back) — all obsolete.
   - Line 90, inside **Notify terminology → "UI-prompt wait"**: the example list still names the removed package — `a tabbed ask (direct or subagent-relayed), a sudo password prompt, or an mcp OAuth loader.` → `a tabbed ask (direct or subagent-relayed), or a sudo password prompt.` (the mcp OAuth loader is gone with the package; keep the rest of the entry — the `ui_prompt_start` event description — untouched).
5. Stale mcp mentions in other packages' comments (4 one-line edits, comments only — no behavior change):
   - `packages/core/src/tool-render.ts` line 4: `* Archimedes tools (mcp, todo, …) render a consistent two-part row:` → `* Archimedes tools (todo, …) render a consistent two-part row:`
   - `packages/notify/src/index.ts` line 188: `// Any blocking extension UI prompt (ask, sudo, mcp OAuth) — fires in the` → `// Any blocking extension UI prompt (ask, sudo) — fires in the`
   - `packages/notify/src/index.ts` lines 194–197: replace the whole 4-line comment block
     ```ts
       // A prompt that closes without terminal input (e.g. the mcp OAuth
       // loader finishing from the browser's `done()`) cancels the question
       // timer so a long-gone prompt does not fire a stale "question needs
       // your answer". Scoped so it never wipes a pending "task complete" timer.
     ```
     with (exact, verbatim — the old browser-redirect example referred to the removed mcp OAuth loader; the bridge example uses the suite's own vocabulary, see CONTEXT.md "Bridge"): 
     ```ts
       // A prompt that closes without terminal input (e.g. a bridge-delegated
       // ask or sudo password answered by the Desktop client) cancels the
       // question timer so a long-gone prompt does not fire a stale "question
       // needs your answer". Scoped so it never wipes a pending "task complete" timer.
     ```
   - `packages/notify/README.md` line 32: `…(a tabbed ask, a sudo password prompt, an MCP OAuth loader) — direct **or** subagent-relayed…` → `…(a tabbed ask, a sudo password prompt) — direct **or** subagent-relayed…` (drop `an MCP OAuth loader, `).
   - `packages/notify/README.md` line 34: `…a prompt that closes without you typing (say, the OAuth loader finishing from the browser) cancels its own timer…` → `…a prompt that closes without you typing (say, a bridge-delegated ask or sudo password answered by the Desktop client) cancels its own timer…` (note: this line does not contain the string "mcp" — it is listed here so it is not missed).
   - `packages/sudo/src/tool.ts` line 391: `// fresh-literal excess-property checking (same convention as todo/mcp).` → `// fresh-literal excess-property checking (same convention as todo).`
   - (Review-round addendum, applied 2026-09-30) `.npmrc` carried four mcp-era `public-hoist-pattern` entries — `@modelcontextprotocol/*`, `@napi-rs/keyring`, `@napi-rs/keyring-*`, `open`. All four were removed (verified: `pnpm install`, `pnpm -r exec -- tsc --noEmit`, `pnpm test` all green with the full removal); the `pnpm-lock.yaml` was re-normalized by pnpm 12.5.1 in the same commit (a `@pnpm/exe` self-reference under `packageManagerDependencies` — pnpm-version churn, not mcp-related).
   - Do NOT touch `packages/core/src/tool-render.test.ts` (its `"mcp"` is just a sample tool name, not a reference to the package) or anything under `docs/`.

**Steps:**
- [ ] Make the `AGENTS.md` edits (item 1)
- [ ] Make the `README.md` edits (item 2)
- [ ] Make the `meta/README.md` edits (item 3)
- [ ] Make the `CONTEXT.md` edits (item 4)
- [ ] Make the stale-comment edits (item 5)
- [ ] Run `grep -rin "mcp" AGENTS.md README.md meta/README.md CONTEXT.md`
  - Expected: no hits.
- [ ] Run `grep -rni "mcp" packages/core/src/tool-render.ts packages/notify/src/index.ts packages/sudo/src/tool.ts`
  - Expected: no hits.
- [ ] Run `grep -rni "mcp" packages/ --include="*.ts" --include="*.md" | grep -v tool-render.test.ts`
  - Expected: no hits. (Safe by Task 4's point: `packages/mcp/` was deleted in Task 2; `tool-render.test.ts` is deliberately carved out — its `"mcp"` is a sample tool name, not a package reference.)
- [ ] Commit with message: `docs: remove the MCP component from the docs`

**Acceptance criteria:**
- [ ] `grep -rin "mcp" AGENTS.md README.md meta/README.md CONTEXT.md` returns nothing.
- [ ] All count words are consistent: 13 packages / 12 package directories (11 components + session-name) / 11 non-core plugins / "eleven" / "all twelve".

---

### Task 5: Release v2.9.0 and npm-deprecate @pi-archimedes/mcp

**Context:**
The deprecation ships as a minor version (removing a component is user-visible). All 13 remaining packages bump 2.8.0 → 2.9.0 together (the root `package.json` is private — no version to bump). **Git flow:** Tasks 1–4 commit on `main` (the current branch) or on a feature branch that is merged to `main` first. In either case, **`git push origin main` must complete before tagging** — the tag is pushed to the same remote, and both `gh release create --target main` and the CI check validate *remote* `main`. If working on a feature branch, merge to `main` (per the `finish` skill) and push before starting this task. After the tag triggers the release workflow and publishes, the last published mcp version (2.8.0) is npm-deprecated so `pi install npm:@pi-archimedes/mcp` / `npm i` show a warning pointing at the built-in.

**Files:**
- Modify: the 13 `package.json` files (`packages/core`, `packages/ui`, `packages/sudo`, `packages/ask`, `packages/footer`, `packages/diff`, `packages/image-paste`, `packages/notify`, `packages/subagent`, `packages/todo`, `packages/session-name`, `packages/web`, `meta`)

**What to implement:**
1. Bump `"version": "2.8.0"` → `"2.9.0"` in all 13 package.json files (verify with `grep -h '"version"' packages/*/package.json meta/package.json | sort | uniq -c` → 13× `2.9.0`).
2. `pnpm install` (lockfile).
3. Verify per AGENTS.md Release Steps: `pnpm -r exec -- tsc --noEmit` + `pnpm test` green; CI (latest run on `main`) green.
4. Commit with message: `chore: bump version to 2.9.0`.
5. Tag and push: `git tag -a v2.9.0 -m "Release v2.9.0"` then `git push origin v2.9.0` (triggers the release workflow — mcp is no longer published).
6. After the workflow publishes, run:
   ```
   npm deprecate @pi-archimedes/mcp "Superseded by pi's built-in MCP support (pi >= 0.99). Note: while this package is installed it REPLACES pi's built-in MCP — uninstall it to use the built-in."
   ```
   (requires maintainer npm credentials; if unavailable, hand the exact command to the maintainer.)
7. Create the GitHub Release:
   ```
   gh release create v2.9.0 --title "v2.9.0" --target main --notes "<notes below>"
   ```
   Notes (AGENTS.md structure — headline first, no external contributors so no thanks section):
   ```
   ## MCP component deprecated — pi ≥ 0.99 ships first-party MCP

   The MCP component (`@pi-archimedes/mcp`) is deprecated and removed from the suite. Pi 0.99 ships built-in MCP: `mcp.json` (global + per-project), stdio and streamable HTTP servers, OAuth with automatic token refresh, a `/mcp` manager, `pi mcp add|remove|list|login|logout` shell commands, and a per-server/per-tool exposure model that keeps large tool lists out of the model's context.

   **Migrating from the MCP component:**
   - Config is a no-op in the common case: pi's built-in reads the same top-layer files (`~/.pi/agent/mcp.json`, project `.pi/mcp.json`) in the same `mcpServers` shape and ignores the component's extra fields (`directTools`, `lifecycle`).
   - If you used the component's other config layers (`<cwd>/.mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, `~/.config/mcp/mcp.json`), move those entries into the files above.
   - `type: "sse"` entries are not supported by pi's built-in — switch to the server's streamable-HTTP endpoint.
   - The `archimedes.mcp` settings, `~/.pi/agent/mcp-cache.json`, and the component's keyring auth entries are no longer used (safe to delete).

   ## Other changes

   - **Suite** — the MCP component is no longer loaded; pi's built-in MCP is active again for suite users (it was previously replaced by the component).
   ```

**Steps:**
- [ ] Bump the 13 versions (item 1) and verify the count
- [ ] Run `pnpm install`
- [ ] Run `pnpm -r exec -- tsc --noEmit`
  - Did it succeed? If not, fix and re-run.
- [ ] Run `pnpm test`
  - Did it pass? If not, fix and re-run.
- [ ] Commit: `chore: bump version to 2.9.0`
- [ ] If on a feature branch: merge to `main` (per the `finish` skill)
- [ ] `git push origin main` — wait for the push to complete
- [ ] Check the CI run on the **pushed** `main` commit (the one containing Tasks 1–4 + the version bump) is green
- [ ] Tag `v2.9.0` and push: `git tag -a v2.9.0 -m "Release v2.9.0"` then `git push origin v2.9.0` (triggers the release workflow — mcp is no longer published)
- [ ] Wait for the release workflow to finish publishing (check the run)
- [ ] Run the `npm deprecate` command (item 6) — or hand it to the maintainer
- [ ] Run `npm view @pi-archimedes/mcp deprecated` (the packument field is `deprecated`, not `deprecation`) and confirm the deprecation message is live
- [ ] Create the GitHub Release (item 7)
- [ ] Per the AGENTS.md docs convention (a plan doc is deleted when the feature ships): `git rm -f docs/roadmap/mcp-deprecation.md` (the `-f` is required if the reviewed plan modifications were never committed) and commit with message: `docs: remove the shipped mcp-deprecation plan`

**Acceptance criteria:**
- [ ] All 13 packages are at 2.9.0 and published; `@pi-archimedes/mcp`'s latest version is still 2.8.0.
- [ ] `npm view @pi-archimedes/mcp deprecated` shows the deprecation message.
- [ ] The GitHub Release exists with the migration notes.
- [ ] `docs/roadmap/mcp-deprecation.md` is deleted and committed.
