import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";

// ── What this file pins ─────────────────────────────────────────────────────
//
// A `peerDependencies` range protects nobody: `pi install` never installs or
// solves peers and the loader aliases every host specifier to pi's own copy, so
// the only thing that can tell a user "your pi is older than this package was
// built for" is a runtime comparison against the exported `VERSION` (ADR 0026).
// The behaviour that matters, in order of how much it costs if it breaks:
//
//   * warn, never refuse — a package that declines to register makes `/plugins`
//     report something enabled that loaded nothing;
//   * silent by construction — no console write on either path (a stray write
//     smears the fullscreen frame, and a subagent child discards it), the
//     message goes into a registry `meta` prints once;
//   * reload-stable — pi builds a fresh jiti/module registry on every extension
//     load, so module-level `let warned = false` re-arms on `/reload` and the
//     aggregated notice would print a second time. The state lives on
//     `globalThis` under `Symbol.for(...)`, which is the pattern `bus.ts` and
//     `profiler.ts` already use for the same reason.

// ── Mock the host: VERSION is the whole input to the guard ──────────────────
//
// A getter, not a value: the point is to change the running pi version between
// assertions without reloading the module under test. `checkPiSupport` reads
// `VERSION` per call, so the getter is observed each time.
const host = vi.hoisted(() => ({ version: "1.2.0" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  get VERSION() {
    return host.version;
  },
}));

import {
  compareVersions,
  checkPiSupport,
  reportPiSupport,
  piSupportWarnings,
  takePiSupportNotice,
} from "./pi-support.js";

// ── The global contract ─────────────────────────────────────────────────────
//
// `packages/diff` cannot import this module — it is a standalone package with
// no dependency on core (AGENTS.md) — yet its warning still has to reach meta's
// aggregated notice. The two implementations meet on these two `Symbol.for`
// keys and the plain-object entry shape below, so the keys and the shape are
// part of the public surface and are pinned here as well as in
// `packages/diff/src/pi-support.test.ts`.

const WARNINGS_KEY = Symbol.for("archimedes:piSupportWarnings");
const NOTICED_KEY = Symbol.for("archimedes:piSupportNoticed");

const globals = globalThis as Record<symbol, unknown>;

function wipeRegistry(): void {
  delete globals[WARNINGS_KEY];
  delete globals[NOTICED_KEY];
}

beforeEach(() => {
  wipeRegistry();
  host.version = "1.2.0";
});

afterEach(() => {
  wipeRegistry();
});

// ── compareVersions (moved here from ui/src/startup/version.ts) ─────────────

const versionArb = fc.tuple(fc.nat(100), fc.nat(100), fc.nat(100)).map(
  ([major, minor, patch]) => `${major}.${minor}.${patch}`,
);

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("returns 1 when first version is greater", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });

  it("returns -1 when second version is greater", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
  });

  it("handles v prefix on first argument", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  it("handles v prefix on second argument", () => {
    expect(compareVersions("1.2.3", "v1.2.3")).toBe(0);
  });

  it("handles v prefix on both arguments", () => {
    expect(compareVersions("v2.0.0", "v1.0.0")).toBe(1);
  });

  it("handles partial versions (2 parts vs 3 parts)", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });

  it("handles partial versions with difference", () => {
    expect(compareVersions("1.1", "1.0.5")).toBe(1);
  });

  it("handles zero-padded versions", () => {
    expect(compareVersions("01.02.03", "1.2.3")).toBe(0);
  });

  it("compares minor version correctly", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBe(1);
    expect(compareVersions("1.1.0", "1.2.0")).toBe(-1);
  });

  it("compares patch version correctly", () => {
    expect(compareVersions("1.0.5", "1.0.3")).toBe(1);
    expect(compareVersions("1.0.3", "1.0.5")).toBe(-1);
  });

  it("orders a two-digit minor above a single-digit one (numeric, not lexical)", () => {
    // The whole reason this comparator exists: "1.10.0" > "1.2.0" numerically,
    // and a string comparison would get it backwards.
    expect(compareVersions("1.10.0", "1.2.0")).toBe(1);
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
  });

  it("treats a non-numeric component as zero rather than NaN", () => {
    // pi publishes lockstep numeric versions, but a suffix must not turn the
    // comparison into NaN — NaN compares false against everything, which would
    // silently make every floor "satisfied" *and* "violated" at once.
    expect(compareVersions("1.2.0-rc.1", "1.2.0")).toBe(0);
    expect(compareVersions("1.x.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.x.0", "1.9.0")).toBe(-1);
  });

  it("handles all-zero versions", () => {
    expect(compareVersions("0.0.0", "0.0.0")).toBe(0);
  });

  // ── Property tests ──────────────────────────────────────────────────────

  it("property: reflexive — compareVersions(a, a) === 0", () => {
    fc.assert(
      fc.property(versionArb, (a) => {
        return compareVersions(a, a) === 0;
      }),
    );
  });

  it("property: antisymmetric — compareVersions(a, b) === -compareVersions(b, a)", () => {
    fc.assert(
      fc.property(versionArb, versionArb, (a, b) => {
        return compareVersions(a, b) === -compareVersions(b, a);
      }),
    );
  });

  it("property: transitivity — if a<b and b<c then a<c", () => {
    fc.assert(
      fc.property(
        fc.tuple(versionArb, versionArb, versionArb),
        ([a, b, c]) => {
          const ab = compareVersions(a, b);
          const bc = compareVersions(b, c);
          const ac = compareVersions(a, c);
          if (ab < 0 && bc < 0) {
            return ac < 0;
          }
          return true;
        },
      ),
    );
  });
});

// ── checkPiSupport ──────────────────────────────────────────────────────────

describe("checkPiSupport", () => {
  it("accepts the floor exactly (a floor is inclusive)", () => {
    host.version = "1.2.0";
    expect(checkPiSupport("1.2.0")).toEqual({ ok: true, actual: "1.2.0", min: "1.2.0" });
  });

  it("accepts a higher minor", () => {
    host.version = "1.10.0";
    expect(checkPiSupport("1.2.0").ok).toBe(true);
  });

  it("rejects a host below the floor", () => {
    host.version = "0.99.2";
    expect(checkPiSupport("1.2.0")).toEqual({ ok: false, actual: "0.99.2", min: "1.2.0" });
  });

  it("reports the running version and the floor it was measured against", () => {
    host.version = "1.2.0";
    const result = checkPiSupport("0.85.0");
    expect(result).toEqual({ ok: true, actual: "1.2.0", min: "0.85.0" });
  });
});

// ── reportPiSupport: the registry ───────────────────────────────────────────

describe("reportPiSupport", () => {
  it("records nothing on a supported host", () => {
    host.version = "1.2.0";
    reportPiSupport("ui", "1.2.0");
    expect(piSupportWarnings()).toEqual([]);
  });

  it("records the package, the floor and the running version below the floor", () => {
    host.version = "0.99.2";
    reportPiSupport("ui", "1.2.0");
    expect(piSupportWarnings()).toEqual([{ pkg: "ui", min: "1.2.0", actual: "0.99.2" }]);
  });

  it("is idempotent per package (register() runs again on /reload and on /new)", () => {
    host.version = "0.99.2";
    reportPiSupport("ui", "1.2.0");
    reportPiSupport("ui", "1.2.0");
    reportPiSupport("ui", "1.2.0");
    expect(piSupportWarnings()).toHaveLength(1);
  });

  it("keeps one entry per package, so several mismatches do not multiply", () => {
    host.version = "0.99.2";
    reportPiSupport("ui", "1.2.0");
    reportPiSupport("subagent", "1.2.0");
    reportPiSupport("ui", "1.2.0");
    expect(piSupportWarnings().map((w) => w.pkg)).toEqual(["ui", "subagent"]);
  });

  it("stores plain data under the shared Symbol.for key (the contract diff relies on)", () => {
    host.version = "0.99.2";
    reportPiSupport("diff", "1.2.0");
    const registry = globals[WARNINGS_KEY] as Record<string, { pkg: string; min: string; actual: string }>;
    expect(registry).toBeTypeOf("object");
    expect(registry["diff"]).toEqual({ pkg: "diff", min: "1.2.0", actual: "0.99.2" });
  });

  it("writes nothing to the console, on either path", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    host.version = "1.2.0";
    reportPiSupport("ui", "1.2.0");
    host.version = "0.99.2";
    reportPiSupport("ui", "1.2.0");
    takePiSupportNotice();

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });
});

// ── takePiSupportNotice: once, aggregated ───────────────────────────────────

describe("takePiSupportNotice", () => {
  it("returns nothing when no package reported", () => {
    expect(takePiSupportNotice()).toBeUndefined();
  });

  it("names every reported package and the running version in ONE message", () => {
    host.version = "0.99.2";
    reportPiSupport("ui", "1.2.0");
    reportPiSupport("subagent", "1.2.0");
    const notice = takePiSupportNotice() ?? "";
    expect(notice).toContain("0.99.2");
    expect(notice).toContain("ui");
    expect(notice).toContain("subagent");
    expect(notice).toContain("1.2.0");
    // One message, not one line per package: the whole point of aggregating.
    expect(notice.split("\n").length).toBeLessThanOrEqual(2);
  });

  it("is spent after the first read (meta notifies once, not per package or per session_start)", () => {
    host.version = "0.99.2";
    reportPiSupport("ui", "1.2.0");
    expect(takePiSupportNotice()).toBeDefined();
    expect(takePiSupportNotice()).toBeUndefined();
    expect(takePiSupportNotice()).toBeUndefined();
  });

  it("stays spent even when a later package reports after the notice went out", () => {
    host.version = "0.99.2";
    reportPiSupport("ui", "1.2.0");
    takePiSupportNotice();
    reportPiSupport("subagent", "1.2.0");
    expect(takePiSupportNotice()).toBeUndefined();
  });

  it("does not spend itself on an empty registry (a warning raised later must still be heard)", () => {
    expect(takePiSupportNotice()).toBeUndefined();
    host.version = "0.99.2";
    reportPiSupport("ui", "1.2.0");
    expect(takePiSupportNotice()).toBeDefined();
  });
});

// ── /reload stability ───────────────────────────────────────────────────────

describe("/reload: a fresh module registry must not re-arm the notice", () => {
  it("keeps the registry and the spent notice on globalThis across a module reload", async () => {
    host.version = "0.99.2";
    reportPiSupport("ui", "1.2.0");
    expect(takePiSupportNotice()).toBeDefined();

    // Pi creates a fresh jiti/module registry on every extension load, so
    // `/reload` re-evaluates pi-support.ts with brand-new module bindings.
    // `vi.resetModules()` is the same shape of event: same process, same
    // globalThis, new module instances.
    vi.resetModules();
    const reloaded = await import("./pi-support.js");

    // register() ran again in the reloaded extension: the guard re-reports.
    reloaded.reportPiSupport("ui", "1.2.0");
    expect(reloaded.piSupportWarnings()).toHaveLength(1);
    // …and meta must not print the aggregated notice a second time.
    expect(reloaded.takePiSupportNotice()).toBeUndefined();
  });
});

// ── One comparator per dependency island ─────────────────────────────────────
//
// The plan's original criterion was "one version comparator in the repo". It is
// not achievable: `packages/diff` is standalone by design (AGENTS.md — no
// dependency on core), and its guard needs the same arithmetic, so the honest
// rule is one comparator per dependency island — core, and diff. This test keeps
// that at two instead of letting a third copy appear somewhere else, which is
// where `1.10.0 < 1.2.0` bugs come from.

describe("the comparator exists once per dependency island", () => {
  const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

  const DECLARATION = /^\s*(export\s+)?function compareVersions\b/m;

  function sourceFiles(): string[] {
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
    const roots: string[] = [];
    const packagesDir = join(REPO_ROOT, "packages");
    for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = join(packagesDir, pkg.name, "src");
      if (existsSync(src)) roots.push(src);
    }
    const metaSrc = join(REPO_ROOT, "meta", "src");
    if (existsSync(metaSrc)) roots.push(metaSrc);
    for (const dir of roots) walk(dir);
    return out.sort();
  }

  it("finds exactly two declarations in the whole suite: core and diff", () => {
    const files = sourceFiles();
    // Non-vacuity: the walk really covers the suite.
    expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
    expect(files.length).toBeGreaterThan(50);

    const owners = files.filter((f) => DECLARATION.test(readFileSync(join(REPO_ROOT, f), "utf8")));
    expect(owners).toEqual([
      "packages/core/src/pi-support.ts",
      // The standalone island's copy. It is a copy on purpose — see the header
      // of the file, and the ruling in docs/roadmap/pi-1-x-alignment.md.
      "packages/diff/src/pi-support.ts",
    ]);
  });

  it("leaves `diff` with no dependency on core (the reason the copy exists)", () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/diff/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@pi-archimedes/core");
    expect(Object.keys(manifest.peerDependencies ?? {})).not.toContain("@pi-archimedes/core");
    // …and nothing in its source reaches across the boundary either. Comments
    // may name the sibling module (they have to, to explain the copy); an
    // import is the thing that would break standalone installation.
    const importCore = /from\s+["']@pi-archimedes\/core/;
    expect(
      sourceFiles()
        .filter((f) => f.startsWith("packages/diff/"))
        .filter((f) => importCore.test(readFileSync(join(REPO_ROOT, f), "utf8"))),
    ).toEqual([]);
  });
});

// ── Reading an entry the OTHER island wrote ─────────────────────────────────
//
// `packages/diff` writes into this registry without importing this module, so
// the notice is built from data this file's own writer did not produce — and a
// standalone `diff` install and an installed suite are independently versioned,
// so the writer may even be a different build. Two things follow: core must
// render exactly what diff writes (the pin below), and it must never turn an
// entry it cannot read into user-visible text.

describe("takePiSupportNotice reads the registry as foreign data", () => {
  it("renders an entry written in the shape `diff` writes it", () => {
    // The literal `packages/diff/src/pi-support.ts` produces, byte for byte —
    // not one this module built. If the two ends ever disagree, this fails.
    globals[WARNINGS_KEY] = {
      diff: { pkg: "diff", min: "1.2.0", actual: "0.99.2" },
    };

    const notice = takePiSupportNotice() ?? "";
    expect(notice).toContain("diff");
    expect(notice).toContain("1.2.0");
    expect(notice).toContain("0.99.2");
    expect(notice).not.toContain("undefined");
  });

  it("skips an entry it cannot read, and says so in the log instead of printing it", () => {
    // An older or newer sibling under the same symbol key is the whole risk of
    // a shared registry. Building the sentence from missing fields used to
    // produce "pi undefined is older than undefined (>=undefined) need." — a
    // user-visible notice made of nothing.
    globals[WARNINGS_KEY] = { sibling: { version: "1.0", floor: "2.0" } };

    expect(takePiSupportNotice()).toBeUndefined();
    // Nothing was spent: a registry with nothing reportable in it must not
    // silence a warning that arrives later.
    globals[WARNINGS_KEY] = { ui: { pkg: "ui", min: "1.2.0", actual: "0.99.2" } };
    expect(takePiSupportNotice()).toContain("ui");
  });
});
