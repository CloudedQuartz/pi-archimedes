import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ── The rule (ADR 0027) ─────────────────────────────────────────────────────
//
// Screen mode is mutable mid-session: `switchTuiMode()` stops the running TUI,
// builds a new one, re-mounts every child and rebinds extension input
// listeners. A stored `tui` therefore keeps a *stopped* renderer — every write
// is accepted, nothing throws, and the component silently renders into a
// renderer nobody draws from. So: never store a renderer; ask the one you were
// just handed. This test is the mechanical half of that rule.
//
// The `\w*tui\w*` widening (not `\btui\b`) is load-bearing: the shape this
// guard was written for is `let uiTui: TUI | undefined` in
// `packages/ui/src/index.ts`, where `ui` glues straight onto `Tui`, so a
// word-anchored pattern matches nothing of the kind. That declaration is gone
// (Task 8 deleted the startup un-patch that read it), but the pattern stays
// widened — the `catches every shape` test below is what proves the widening
// still has something to catch. The patterns are also case-insensitive for the
// same reason: a name like `uiTui` has a capital T.
//
// Module-scope declarations accept an `export` prefix and an optional type
// annotation, because those are how the binding is really written: `export let
// sharedTui: TUI` and `const appTui: TUI = tui` hoard a renderer just as much
// as `let sharedTui = tui` does, and a pattern that requires the declaration
// keyword at column 0 followed immediately by `=` sees neither. A `const` with
// no type annotation is only caught when its initializer is a renderer, which
// is what keeps the `tuiMode` *setting* — a screen-mode string whose name also
// contains "tui" — out of the net.

interface ViolationRule {
  /** What shape of renderer hoarding this catches. */
  readonly label: string;
  readonly pattern: RegExp;
}

const RULES: readonly ViolationRule[] = [
  { label: "class field holding a renderer", pattern: /(private|public|readonly)\s+\w*tui\w*\s*[:=]/i },
  { label: "renderer assigned to an instance property", pattern: /\bthis\.\w*tui\w*\s*=/i },
  { label: "module-scope mutable renderer binding", pattern: /^(export\s+)?(let|var)\s+\w*tui\w*\b/im },
  { label: "module-scope const typed as a renderer", pattern: /^(export\s+)?const\s+\w*tui\w*\s*:\s*TUI\b/im },
  { label: "module-scope binding initialised from a renderer", pattern: /^(export\s+)?(let|var|const)\s+\w+\s*=\s*\w*tui\w*\s*[;,]?\s*$/im },
];

/**
 * Known violations, each with the one-line reason that keeps it, and the
 * removal point. Matched on the exact trimmed line so a *new* violation in the
 * same file still fails the guard.
 *
 * Empty as of Task 8: the last entry was the `let uiTui` whose only reader was
 * the startup `addChild` un-patch, and both went together. Keep the shape of
 * this list even while it is empty — an exemption without a reason and a
 * removal point is how the guard quietly widens.
 */
interface AllowEntry {
  readonly file: string;
  readonly line: string;
  readonly reason: string;
}

const ALLOW_LIST: readonly AllowEntry[] = [];

// ── Walking the tree ────────────────────────────────────────────────────────

/** Repo root, resolved from this file (`packages/core/src` → repo root). */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// Every `packages/<name>/src` directory, plus `meta/src`.
function sourceDirs(): string[] {
  const dirs: string[] = [];
  for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = join(REPO_ROOT, "packages", entry.name, "src");
    if (existsSync(src)) dirs.push(src);
  }
  const metaSrc = join(REPO_ROOT, "meta", "src");
  if (existsSync(metaSrc)) dirs.push(metaSrc);
  return dirs;
}

/** Source files under those trees, excluding tests (which fake renderers). */
function collectSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(relative(REPO_ROOT, full).split(/[\\/]/).join("/"));
      }
    }
  };
  for (const dir of sourceDirs()) walk(dir);
  return out.sort();
}

interface Hit {
  file: string;
  line: number;
  rule: string;
  text: string;
}

function findViolations(files: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const lines = readFileSync(join(REPO_ROOT, file), "utf8").split("\n");
    lines.forEach((text, i) => {
      for (const rule of RULES) {
        // Fresh lastIndex-free test: these patterns have no /g.
        if (rule.pattern.test(text)) {
          hits.push({ file, line: i + 1, rule: rule.label, text: text.trim() });
        }
      }
    });
  }
  return hits;
}

function isAllowed(hit: Hit): boolean {
  return ALLOW_LIST.some((e) => e.file === hit.file && e.line === hit.text);
}

const FILES = collectSourceFiles();
const VIOLATIONS = findViolations(FILES).filter((h) => !isAllowed(h));

// ── Tests ───────────────────────────────────────────────────────────────────

describe("screen-mode discipline: never store a renderer", () => {
  it("walks the whole suite, not an empty file set", () => {
    expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
    expect(FILES.length).toBeGreaterThan(50);
    // The three trees the guard is supposed to cover.
    for (const expected of [
      "packages/core/src/screen-mode.ts",
      "packages/ui/src/index.ts",
      "meta/src/index.ts",
    ]) {
      expect(FILES).toContain(expected);
    }
  });

  it("reports no renderer hoarding outside the allow-list", () => {
    expect(
      VIOLATIONS.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}`),
    ).toEqual([]);
  });

  it("catches every shape the rule forbids (patterns are not dead)", () => {
    const offenders = [
      "private tui: TUI | undefined;",
      "readonly viewportTui = tui;",
      "this.tui = tui;",
      "this.altTui = next;",
      "let sharedTui: TUI | undefined;",
      "var cachedTui = tui;",
      "const appTui = tui;",
      // Re-exported bindings are the same hoarding with `export` in front —
      // a pattern anchored on `^(let|var|const)` walks straight past them.
      "export let sharedTui: TUI | undefined;",
      "export var cachedTui = tui;",
      "export const appTui = tui;",
      "export let cachedTui;",
      // A type annotation between the name and the initializer is how a
      // renderer binding is actually written in TypeScript, so the shape the
      // guard most needs to see must not be the shape it skips.
      "const appTui: TUI = tui;",
      "export const appTui: TUI = tui;",
      "let currentTui: TUI = tui;",
    ];
    for (const line of offenders) {
      expect(RULES.some((r) => r.pattern.test(line)), `expected a rule to reject: ${line}`).toBe(true);
    }

    // And leaves honest code alone: renderers received as parameters, locals
    // inside a function, unrelated names that merely contain "tui", and the
    // tuiMode *setting* (a screen-mode string, not a renderer) at module
    // scope — widening the declaration patterns must not swallow it.
    const fine = [
      "  const factory = (tui: TUI, theme: Theme) => {",
      "  const tuiMode = settings.tuiMode;",
      "  return screenMode(tui);",
      "    const tui = getRenderer();",
      "export function screenMode(tui: object): ScreenMode {",
      "const tuiMode = settings.tuiMode;",
      "export const tuiModes = [\"regular\", \"fullscreen\"] as const;",
      "const tuiMode: TuiMode = readMode();",
    ];
    for (const line of fine) {
      expect(RULES.some((r) => r.pattern.test(line)), `expected no rule to reject: ${line}`).toBe(false);
    }
  });

  it("keeps the allow-list as small as the work that removes it", () => {
    // The list is empty: every renderer hoard the guard was written to excuse
    // was deleted with the startup patch that needed it (Task 8). An entry
    // reappearing is allowed only with a reason naming the task that removes
    // it, so this assertion is the rule, not a snapshot.
    expect(
      ALLOW_LIST.map((e) => `${e.file}: ${e.line}`),
    ).toEqual([]);
    for (const entry of ALLOW_LIST) {
      const actual = readFileSync(join(REPO_ROOT, entry.file), "utf8").split("\n");
      expect(
        actual.some((l) => l.trim() === entry.line),
        `allow-list entry no longer matches ${entry.file}: ${entry.line}`,
      ).toBe(true);
      expect(entry.reason).toMatch(/Task \d+/);
    }
  });
});
