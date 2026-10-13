import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── What this file pins ─────────────────────────────────────────────────────
//
// `diff` carries its own copy of the pi-version guard because it is a standalone
// package with no dependency on `@pi-archimedes/core` (see the header of
// `pi-support.ts`). A copy is only safe if it is pinned twice: once here, and
// once in `packages/core/src/pi-support.test.ts`. The two ends of the contract
// that matters — the `Symbol.for` key and the entry shape — are asserted in both
// files, so the copies cannot drift apart silently and leave `diff`'s warning
// out of the suite's aggregated notice.

const host = vi.hoisted(() => ({ version: "1.2.0" }));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  get VERSION() {
    return host.version;
  },
}));

import { reportPiSupport, piSupportWarnings } from "./pi-support.js";

const WARNINGS_KEY = Symbol.for("archimedes:piSupportWarnings");
const globals = globalThis as Record<symbol, unknown>;

function wipeRegistry(): void {
  delete globals[WARNINGS_KEY];
}

beforeEach(() => {
  wipeRegistry();
  host.version = "1.2.0";
});

afterEach(() => {
  wipeRegistry();
});

describe("diff's pi-support guard", () => {
  it("says nothing on a supported host, at the floor or above", () => {
    host.version = "1.2.0";
    reportPiSupport("diff", "1.2.0");
    host.version = "1.10.0";
    reportPiSupport("diff", "1.2.0");
    expect(piSupportWarnings()).toEqual([]);
  });

  it("records the package, the floor and the running version below the floor", () => {
    host.version = "0.99.2";
    reportPiSupport("diff", "1.2.0");
    expect(piSupportWarnings()).toEqual([{ pkg: "diff", min: "1.2.0", actual: "0.99.2" }]);
  });

  it("orders by number, not by string (1.10.0 is not older than 1.2.0)", () => {
    host.version = "1.10.0";
    reportPiSupport("diff", "1.2.0");
    expect(piSupportWarnings()).toEqual([]);
  });

  it("is idempotent per package — session_start re-registers on /new and /reload", () => {
    host.version = "0.99.2";
    reportPiSupport("diff", "1.2.0");
    reportPiSupport("diff", "1.2.0");
    expect(piSupportWarnings()).toHaveLength(1);
  });

  it("never throws, whatever the host reports as its version", () => {
    // A guard that can throw can break registration, which is the one thing it
    // must never do.
    host.version = "nonsense";
    expect(() => reportPiSupport("diff", "1.2.0")).not.toThrow();
    delete (host as { version?: string }).version;
    expect(() => reportPiSupport("diff", "1.2.0")).not.toThrow();
  });

  it("writes nothing to the console, on either path", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    host.version = "1.2.0";
    reportPiSupport("diff", "1.2.0");
    host.version = "0.99.2";
    reportPiSupport("diff", "1.2.0");

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });
});

describe("the registry contract with @pi-archimedes/core", () => {
  it("writes into the same Symbol.for key and entry shape core reads", () => {
    host.version = "0.99.2";
    reportPiSupport("diff", "1.2.0");
    const registry = globals[WARNINGS_KEY] as Record<string, { pkg: string; min: string; actual: string }>;
    expect(registry).toBeTypeOf("object");
    // The exact shape `core/pi-support.ts` builds its aggregated notice from —
    // if this changes, meta stops naming `diff` and no test would notice
    // without this assertion.
    expect(registry["diff"]).toEqual({ pkg: "diff", min: "1.2.0", actual: "0.99.2" });
  });

  it("leaves entries written by another package alone (co-existence, not ownership)", () => {
    globals[WARNINGS_KEY] = { ui: { pkg: "ui", min: "1.2.0", actual: "0.99.2" } };
    host.version = "0.99.2";
    reportPiSupport("diff", "1.2.0");
    expect(piSupportWarnings().map((w) => w.pkg)).toEqual(["ui", "diff"]);
  });
});
