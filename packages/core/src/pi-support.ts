// ── Runtime pi-version support guard ─────────────────────────────────────────
//
// A published `peerDependencies` range protects nobody. `pi install` installs
// extensions with peers omitted (`--legacy-peer-deps` /
// `--config.auto-install-peers=false` / `--omit=peer`), and at runtime the
// extension loader aliases every host specifier to pi's own copy, so a range is
// never installed, never solved, and never parsed. The only mechanism that can
// reach a user running an older host is a comparison against the `VERSION` the
// running pi exports, at the moment the package registers itself (ADR 0026).
//
// Two rules the shape of this module follows from:
//
// 1. **Warn and still register.** A package that refuses to load makes `/plugins`
//    report an enabled package that loaded nothing — strictly worse than a
//    warning. Nothing here can prevent registration; `reportPiSupport` only
//    records.
// 2. **Silent by construction.** No console write on either path. A stray write
//    smears the fullscreen frame and is discarded by a subagent child, so the
//    warning goes into a registry that `meta` prints once, through the
//    notification surface, and to `diag()` for anyone reading the log file.
//
// Reload-stability: pi builds a fresh jiti/module registry on every extension
// load, so a module-level `let warned = false` re-arms on `/reload` and the
// aggregated notice would be printed again. Both pieces of state therefore live
// on `globalThis` under `Symbol.for(...)`, the same device `bus.ts` and
// `profiler.ts` use.
//
// The `Symbol.for` keys and the plain-object entry shape are a contract, not an
// implementation detail: `packages/diff` is a standalone package with no
// dependency on core (AGENTS.md), so it keeps a sibling copy of this logic and
// reports into the same registry through the same keys. Keep the two in step —
// `pi-support.test.ts` here and `packages/diff/src/pi-support.test.ts` pin both
// ends of it.

import { VERSION } from "@earendil-works/pi-coding-agent";
import { diag } from "./log.js";

/** Result of measuring the running pi against one package's floor. */
export interface PiSupport {
  ok: boolean;
  /** The version the host reports (`VERSION` as exported by pi). */
  actual: string;
  /** The floor the package asked for. */
  min: string;
}

/** One below-floor report. Plain data: `diff` writes this same shape itself. */
export interface PiSupportWarning {
  pkg: string;
  min: string;
  actual: string;
}

const WARNINGS_KEY = Symbol.for("archimedes:piSupportWarnings");
const NOTICED_KEY = Symbol.for("archimedes:piSupportNoticed");

type Registry = Record<string, PiSupportWarning>;

// Type-safe globalThis access, as in `bus.ts`.
function getGlobal<T>(key: symbol): T | undefined {
  return (globalThis as Record<symbol, unknown>)[key] as T | undefined;
}
function setGlobal<T>(key: symbol, value: T): void {
  (globalThis as Record<symbol, unknown>)[key] = value;
}

function registry(): Registry {
  return getGlobal<Registry>(WARNINGS_KEY) ?? {};
}

/**
 * Numeric three-component comparison: -1 when `a` is older, 1 when newer, 0
 * when equal. Leading `v` and absent components are tolerated (`"1.0"` is
 * `"1.0.0"`), and a component that is not numeric counts as 0 rather than NaN —
 * NaN compares false against everything, which would make a floor
 * simultaneously satisfied and violated.
 *
 * This is the suite's only comparator on the core side of the dependency
 * islands; `packages/diff` keeps a copy because it does not depend on core.
 */
export function compareVersions(a: string, b: string): number {
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

/** Measure the running pi against `min`. Inclusive: a host at the floor is ok. */
export function checkPiSupport(min: string): PiSupport {
  const actual = typeof VERSION === "string" ? VERSION : "";
  return { ok: compareVersions(actual, min) >= 0, actual, min };
}

/**
 * Record a below-floor warning for `meta` to print, aggregated, once.
 *
 * Never throws and never writes to the console: this runs at the top of a
 * package's `register()`, where the only acceptable failure mode is "nothing
 * happened, carry on registering". Idempotent per package, so a `/reload` or a
 * `/new` (both re-run registration) does not multiply the entry.
 */
export function reportPiSupport(pkg: string, min: string): void {
  try {
    const support = checkPiSupport(min);
    if (support.ok) return;
    const current = registry();
    if (pkg in current) return;
    current[pkg] = { pkg, min, actual: support.actual };
    setGlobal(WARNINGS_KEY, current);
    // The log file is the only other place this can go: a standalone install
    // has no aggregator, and a subagent child discards stdout.
    diag(pkg, `pi ${support.actual} is below this package's floor (>=${min}); loaded anyway`);
  } catch {
    // A guard that can throw is a guard that can break registration.
  }
}

/** Every warning recorded so far, in report order (mainly for `meta` and tests). */
export function piSupportWarnings(): PiSupportWarning[] {
  try {
    return Object.values(registry());
  } catch {
    return [];
  }
}

/**
 * Is this registry entry something this module can actually report?
 *
 * The registry is shared memory: `packages/diff` writes it without importing
 * here, and a standalone `diff` and an installed suite are installed and
 * versioned separately, so an entry may predate or postdate this shape. A
 * sentence built from missing fields reads "pi undefined is older than
 * undefined (>=undefined) need.", which is worse than saying nothing — so an
 * unrecognisable entry is left out of the notice and named in the log instead.
 */
function isReportable(entry: unknown): entry is PiSupportWarning {
  const w = entry as Partial<PiSupportWarning> | null | undefined;
  return (
    typeof w === "object" &&
    w !== null &&
    typeof w.pkg === "string" &&
    typeof w.min === "string" &&
    typeof w.actual === "string"
  );
}

/**
 * The one aggregated message, or `undefined` when there is nothing to say or it
 * has already been handed out.
 *
 * Reading it spends it: a second call returns `undefined`, which is how `meta`
 * prints one line per session rather than one per package, and how a `/reload`
 * (fresh modules, same `globalThis`) stays quiet — the pi version cannot change
 * without restarting the process, so repeating the notice would be noise. An
 * empty registry does not spend anything, so a floor raised later in the
 * process is still heard.
 */
export function takePiSupportNotice(): string | undefined {
  try {
    const entries = Object.entries(registry());
    const warnings = entries.filter(([, entry]) => isReportable(entry)).map(([, entry]) => entry);
    const unreadable = entries.length - warnings.length;
    if (unreadable > 0) {
      // Loud in the log, silent on screen: a dropped warning must never be a
      // silent one, and a shape this module cannot read is a drift bug someone
      // needs to be able to find.
      diag(
        "core",
        `pi-support registry held ${unreadable} entr${unreadable === 1 ? "y" : "ies"} outside the agreed shape; left out of the host-version notice`,
      );
    }
    if (warnings.length === 0) return undefined;
    if (getGlobal<boolean>(NOTICED_KEY)) return undefined;
    setGlobal(NOTICED_KEY, true);
    const floors = warnings.map((w) => `${w.pkg} (>=${w.min})`).join(", ");
    return [
      `pi-archimedes: pi ${warnings[0]!.actual} is older than ${floors} need.`,
      "Everything still loaded; update pi if something behaves oddly.",
    ].join("\n");
  } catch {
    return undefined;
  }
}
