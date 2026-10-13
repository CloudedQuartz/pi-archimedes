import { VERSION } from "@earendil-works/pi-coding-agent";
import { diag } from "./log.js";

// ── pi-version support guard (sibling of `@pi-archimedes/core/pi-support`) ───
//
// `diff` is a standalone, independently installable package: it declares no
// dependency on `@pi-archimedes/core` (AGENTS.md, README), so anything it needs
// from the suite it carries itself. That trade now has exactly three entries —
// the xterm colour table in `ansi/colors.ts`, the diagnostics sink in `log.ts`,
// and this version guard. This file is the one place that states the reason, so
// the other two point here rather than each repeating it; the reason is simply
// that `pi install @pi-archimedes/diff` must keep working with nothing else
// from the suite present.
//
// Why the check exists at all: a `peerDependencies` range reaches nobody. `pi
// install` omits peers, and the loader aliases host specifiers to pi's own
// copies, so the only thing that can tell a user their pi is older than this
// package was built for is a comparison against the `VERSION` the running host
// exports (ADR 0026). The answer is a warning, never a refusal — a `diff` that
// declined to load would make `/plugins` report an enabled package that
// registered nothing.
//
// How the warning is seen: this writes into the same `globalThis` registry core
// owns, under the same `Symbol.for` key and the same plain-object entry shape.
// A symbol-keyed global is the only shared memory a standalone package and the
// suite have, and it means an installed suite still aggregates `diff` into its
// one notice while a standalone `diff` leaves the entry for `piSupportWarnings()`
// and the log file. `pi-support.test.ts` here and
// `packages/core/src/pi-support.test.ts` pin both ends of that contract; keep
// the two copies in step.

/** Below-floor report. Shape shared with `core/pi-support.ts` — do not drift. */
export interface PiSupportWarning {
  pkg: string;
  min: string;
  actual: string;
}

/** The key `@pi-archimedes/core/pi-support` reads to build its notice. */
const WARNINGS_KEY = Symbol.for("archimedes:piSupportWarnings");

type Registry = Record<string, PiSupportWarning>;

function registry(): Registry {
  const existing = (globalThis as Record<symbol, unknown>)[WARNINGS_KEY];
  return (existing as Registry | undefined) ?? {};
}

/**
 * Numeric three-component comparison, copied from
 * `packages/core/src/pi-support.ts`: -1 / 0 / 1, leading `v` and missing
 * components tolerated, a non-numeric component counting as 0 rather than NaN.
 * Numeric, not lexical, because `1.10.0` must outrank `1.2.0`.
 */
function compareVersions(a: string, b: string): number {
  const part = (v: string, i: number): number => {
    const n = Number(v.replace(/^v/, "").split(".")[i] ?? "0");
    return Number.isFinite(n) ? n : 0;
  };
  for (let i = 0; i < 3; i++) {
    const left = part(a, i);
    const right = part(b, i);
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

/**
 * Record a below-floor warning. Idempotent per package, silent by construction
 * (no console write on either path), and never throws — this runs at the top of
 * registration, where the only acceptable failure mode is "nothing happened,
 * carry on registering".
 */
export function reportPiSupport(pkg: string, min: string): void {
  try {
    const actual = typeof VERSION === "string" ? VERSION : "";
    if (compareVersions(actual, min) >= 0) return;
    const current = registry();
    if (pkg in current) return;
    current[pkg] = { pkg, min, actual };
    (globalThis as Record<symbol, unknown>)[WARNINGS_KEY] = current;
    // A standalone install has no aggregator, so the log file is the only other
    // place this can go.
    diag(pkg, `pi ${actual} is below this package's floor (>=${min}); loaded anyway`);
  } catch {
    // A guard that can throw is a guard that can break registration.
  }
}

/** Recorded warnings, in report order — the standalone view of the registry. */
export function piSupportWarnings(): PiSupportWarning[] {
  try {
    return Object.values(registry());
  } catch {
    return [];
  }
}
