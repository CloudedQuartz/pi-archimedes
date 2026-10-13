import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ── The rule ────────────────────────────────────────────────────────────────
//
// Nothing in the suite writes to the console. Two independent reasons:
//
// 1. On fullscreen screen a stray `console.*` lands inside the differential
//    frame and smears the viewport until the next full redraw (on regular
//    screen it scrolls away unseen, which is why the habit survived so long).
// 2. Inside a subagent child every write is silently discarded:
//    `subagent/src/stream.ts` drops any non-JSON stdout line (`catch { return }`,
//    a guard for pi's own startup messages), so a warning vanishes exactly when
//    someone is debugging a child run.
//
// Diagnostics go to `diag()` in `log.ts` (a file, only when PI_ARCHIMEDES_LOG
// names one) and messages the user must see go to the notification surface
// (`ctx.ui.notify`). Both are safe on every screen and in a child process.
//
// The pattern demands the open parenthesis, so it is narrower than a loose
// `grep console.log`: a monkey-patch site (`console.log = (…) => {…}`,
// `let orig: typeof console.log`) is not a write and is not reported here.
//
// Every *method* is covered, not just log/warn/error. `console.info` and
// `console.debug` land on stdout/stderr exactly like `console.log`, and
// `console.trace`/`dir`/`table`/`group`/`count`/`clear` write too (and `clear`
// wipes the frame outright), so naming a subset would leave a guard that stays
// green while a future write corrupts the display.
const PATTERN = /console\.[a-zA-Z]+\(/;

interface AllowEntry {
  readonly file: string;
  readonly reason: string;
}

/**
 * Files exempt from the rule, whole-file, each with the reason it is tolerated
 * and when that goes away. A new violation in an exempt file still shows up in
 * the census, so this list can only ever be argued down, not silently widened.
 */
const ALLOW_LIST: readonly AllowEntry[] = [
  {
    file: "packages/core/src/log.ts",
    reason:
      "The diagnostics sink itself. Exempt by construction: it is the one module allowed to own output plumbing, and a last-resort fallback there must not trip the guard. It writes files, never the console.",
  },
  {
    file: "packages/ui/src/startup/capture.ts",
    reason:
      "The console.log monkey patch that scrapes pi's `Model scope:` line — patching the console is its whole job, and Task 8 deletes the file in favour of ctx.scopedModels.",
  },
];

// ── Walking the tree ────────────────────────────────────────────────────────

/** Repo root, resolved from this file (`packages/core/src` → repo root). */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Every `packages/<name>/src` directory, plus `meta/src`. */
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

/** Source files under those trees; tests are excluded (they spy on the console). */
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
  text: string;
}

function findViolations(files: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const lines = readFileSync(join(REPO_ROOT, file), "utf8").split("\n");
    lines.forEach((text, i) => {
      if (PATTERN.test(text)) hits.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return hits;
}

const FILES = collectSourceFiles();
const HITS = findViolations(FILES);
const ALLOWED = new Set(ALLOW_LIST.map((e) => e.file));
const VIOLATIONS = HITS.filter((h) => !ALLOWED.has(h.file));

// ── Tests ───────────────────────────────────────────────────────────────────

describe("console discipline: no console writes from render or event paths", () => {
  it("walks the whole suite, not an empty file set", () => {
    expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
    expect(FILES.length).toBeGreaterThan(50);
    // The trees the guard covers, and the shape of what it skips.
    for (const expected of [
      "packages/core/src/log.ts",
      "packages/ui/src/startup/capture.ts",
      "meta/src/index.ts",
    ]) {
      expect(FILES).toContain(expected);
    }
    expect(FILES.filter((f) => f.endsWith(".test.ts"))).toEqual([]);
  });

  it("reports no console writes outside the allow-list", () => {
    expect(VIOLATIONS.map((v) => `${v.file}:${v.line} ${v.text}`)).toEqual([]);
  });

  it("matches any console write and not a patch site (the guard is not a loose grep)", () => {
    const offenders = [
      'console.log("x");',
      '  console.warn(`y`);',
      "console.error(err);",
      "if (bad) console.error('nope');",
      // The rest of the console writes to the terminal just as hard. `info` and
      // `debug` used to be *pinned* as allowed here, which encoded the hole in
      // the guard rather than the rule; the suite has none today, so widening
      // costs nothing and closes it.
      'console.info("x");',
      'console.debug("x");',
      "console.trace('here');",
      'console.dir(obj);',
      'console.table(rows);',
      'console.group("g");',
      "console.count();",
      "console.clear();",
    ];
    for (const line of offenders) {
      expect(PATTERN.test(line), `expected the guard to reject: ${line}`).toBe(true);
    }

    // Assignments, type references and prose about the console are not writes.
    // This is exactly the difference between the guard and the census grep, and
    // it is why `capture.ts` needs an allow-list entry for its one real write
    // while its patch plumbing does not count.
    const fine = [
      "console.log = (...args) => {};",
      "let _origLog: typeof console.log | undefined;",
      "_origLog = console.log;",
      "console.log = _origLog;",
      "// Patch console.log for model scope capture",
      "const orig = Object.getOwnPropertyDescriptor(console, 'log');",
    ];
    for (const line of fine) {
      expect(PATTERN.test(line), `expected no rule to reject: ${line}`).toBe(false);
    }
  });

  it("keeps the allow-list as small as the work that removes it", () => {
    const sink = "packages/core/src/log.ts";
    for (const entry of ALLOW_LIST) {
      expect(FILES, `allow-listed file is no longer scanned: ${entry.file}`).toContain(entry.file);
      expect(entry.reason.length).toBeGreaterThan(0);
      // Anything exempted beyond the sink itself must name the task that
      // removes it — otherwise the exemption is permanent by accident.
      if (entry.file !== sink) expect(entry.reason).toMatch(/Task \d+/);
    }

    // The capture.ts entry is load-bearing today: it has a real write. The sink
    // entry is exempt by construction, and if it ever does grow a console
    // write, that must be a deliberate choice someone argues about, not a
    // silent widening — so pin which entries are currently exercised.
    const exercised = new Set(HITS.map((h) => h.file));
    expect(exercised.has("packages/ui/src/startup/capture.ts")).toBe(true);
    expect(exercised.has(sink)).toBe(false);
  });
});
