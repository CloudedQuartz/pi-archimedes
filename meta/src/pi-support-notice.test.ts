import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── The aggregated host-version notice (ADR 0026, Task 7) ──────────────────
//
// Packages report a below-floor host during their own `register()`; `meta` is
// the only place the suite shows it, as ONE message. This file pins the three
// things a user would notice if they broke:
//
//   * one message, not one per package;
//   * everything still registers on a below-floor host — refusing to load would
//     make /plugins report an enabled package that did nothing;
//   * the notice is not repeated on the next session_start, nor after a
//     `/reload` (which re-evaluates these modules but keeps the process, and
//     therefore the pi version, the same).
//
// The guard is driven through the real `core/pi-support` by reporting an
// impossible floor (`99.0.0`) — the same code path a genuinely old host takes,
// without monkey-patching the host's exported VERSION.

// ── settings-io: in-memory store (mirrors factory-lifecycle.test.ts) ────────

vi.mock("@pi-archimedes/core/settings-io", () => {
  const store: Record<string, unknown> = {};
  return {
    loadConfig: vi.fn(
      (ns: string, defaults: object) =>
        ({ ...defaults, ...((store[ns] as object) ?? {}) }),
    ),
    saveConfig: vi.fn((ns: string, config: object) => {
      store[ns] = config;
    }),
    removeConfig: vi.fn((ns: string) => {
      delete store[ns];
    }),
    isConfigEnabled: vi.fn((ns: string) => {
      const cfg = (store[ns] ?? {}) as Record<string, unknown>;
      return cfg.enabled !== false;
    }),
    setConfigEnabled: vi.fn(),
    __store: store,
  };
});

const settingsIo = await import("@pi-archimedes/core/settings-io");
const mockStore = (settingsIo as unknown as { __store: Record<string, unknown> }).__store;

// ── Every package the factory touches, so this stays a unit test ────────────

vi.mock("@pi-archimedes/core/profiler", () => ({
  time: vi.fn(),
  print: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("@pi-archimedes/core/log", async (importOriginal) => {
  const real = await importOriginal<typeof import("@pi-archimedes/core/log")>();
  return { ...real, diag: vi.fn() };
});
import { diag } from "@pi-archimedes/core/log";
// NOTE: `@pi-archimedes/core/pi-support` is deliberately NOT mocked — the
// registry and the spend-once semantics under test are its own.
vi.mock("@pi-archimedes/core", () => ({ registerCore: vi.fn() }));
vi.mock("@pi-archimedes/ui", () => ({ registerUI: vi.fn() }));
vi.mock("@pi-archimedes/footer", () => ({ registerFooter: vi.fn() }));
vi.mock("@pi-archimedes/todo", () => ({ registerTodo: vi.fn() }));
vi.mock("@pi-archimedes/ask", () => ({ registerAsk: vi.fn() }));
vi.mock("@pi-archimedes/notify", () => ({ registerNotify: vi.fn() }));
vi.mock("@pi-archimedes/session-name", () => ({ registerSessionName: vi.fn() }));
vi.mock("@pi-archimedes/sudo", () => ({ registerSudo: vi.fn() }));
vi.mock("@pi-archimedes/diff", () => ({ registerDiffTools: vi.fn() }));
vi.mock("@pi-archimedes/image-paste", () => ({
  registerImagePaste: vi.fn(),
  shutdownImagePaste: vi.fn(),
  initImagePasteSession: vi.fn(),
}));
vi.mock("@pi-archimedes/image-paste/keybinding-offer", () => ({
  offerKeybindingFix: vi.fn(async () => false),
}));
vi.mock("@pi-archimedes/subagent", () => ({
  registerSubagent: vi.fn(),
  registerAgentsCommand: vi.fn(),
}));
vi.mock("@pi-archimedes/web", () => ({ registerWeb: vi.fn() }));

vi.mock("./config.js", () => ({ loadDiffConfig: vi.fn(() => ({})) }));
vi.mock("./settings.js", () => ({ openSettings: vi.fn() }));
vi.mock("./plugin-manager.js", () => ({ registerPluginsCommand: vi.fn() }));
vi.mock("./onboarding/index.js", () => ({ runOnboarding: vi.fn(async () => {}) }));

const { default: metaFactory } = await import("./index.js");
const { reportPiSupport, piSupportWarnings } = await import("@pi-archimedes/core/pi-support");
const registrations = await import("@pi-archimedes/ui");
const subagentReg = await import("@pi-archimedes/subagent");
const diffReg = await import("@pi-archimedes/diff");
const webReg = await import("@pi-archimedes/web");

// ── Harness ─────────────────────────────────────────────────────────────────

const WARNINGS_KEY = Symbol.for("archimedes:piSupportWarnings");
const NOTICED_KEY = Symbol.for("archimedes:piSupportNoticed");
const globals = globalThis as Record<symbol, unknown>;

interface Harness {
  startSession: (ctx: unknown) => Promise<unknown>;
}

function freshFactory(): Harness {
  const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
  const pi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      (handlers[event] ??= []).push(handler);
    },
    registerCommand: () => {},
    registerTool: () => {},
  };
  metaFactory(pi as never);
  const startRcs = handlers["session_start"] ?? [];
  expect(startRcs.length).toBeGreaterThan(0);
  // The LAST session_start handler is the lazy-load one — the same handler meta
  // prints the notice from, after every package has had its chance to report.
  const lazy = startRcs[startRcs.length - 1] as (...args: unknown[]) => unknown;
  return { startSession: (ctx: unknown) => lazy(undefined, ctx) as Promise<unknown> };
}

/** A ctx with a UI surface, i.e. what an interactive session hands us. */
function uiCtx() {
  return { hasUI: true, ui: { theme: {}, notify: vi.fn() }, cwd: "/tmp" };
}

beforeEach(() => {
  for (const key of Object.keys(mockStore)) delete mockStore[key];
  delete globals[WARNINGS_KEY];
  delete globals[NOTICED_KEY];
  vi.clearAllMocks();
});

afterEach(() => {
  delete globals[WARNINGS_KEY];
  delete globals[NOTICED_KEY];
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("aggregated pi-support notice", () => {
  it("stays silent on a supported host (nothing reported, nothing shown)", async () => {
    const { startSession } = freshFactory();
    const ctx = uiCtx();
    await startSession(ctx);

    expect(piSupportWarnings()).toEqual([]);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    // …and every package still registered, which is the baseline the next tests
    // compare against.
    expect(vi.mocked(registrations.registerUI)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(subagentReg.registerSubagent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(diffReg.registerDiffTools)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(webReg.registerWeb)).toHaveBeenCalledTimes(1);
  });

  it("shows ONE message naming every reporting package on a below-floor host, and still registers everything", async () => {
    // What the packages recorded during registration on an old host.
    reportPiSupport("ui", "99.0.0");
    reportPiSupport("diff", "99.0.0");
    reportPiSupport("subagent", "99.0.0");

    const { startSession } = freshFactory();
    const ctx = uiCtx();
    await startSession(ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    const [message, level] = ctx.ui.notify.mock.calls[0] as [string, string | undefined];
    expect(message).toContain("ui");
    expect(message).toContain("diff");
    expect(message).toContain("subagent");
    expect(message).toContain("99.0.0");
    expect(level).toBe("warning");

    // Warn and STILL register — the guard changes nothing about loading.
    expect(vi.mocked(registrations.registerUI)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(subagentReg.registerSubagent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(subagentReg.registerAgentsCommand)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(diffReg.registerDiffTools)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(webReg.registerWeb)).toHaveBeenCalledTimes(1);
  });

  it("does not repeat the notice on a later session_start (/new, /fork, /resume)", async () => {
    reportPiSupport("ui", "99.0.0");
    const { startSession } = freshFactory();

    const first = uiCtx();
    await startSession(first);
    expect(first.ui.notify).toHaveBeenCalledTimes(1);

    const second = uiCtx();
    await startSession(second);
    expect(second.ui.notify).not.toHaveBeenCalled();
  });

  it("survives a /reload: re-evaluated modules must not print the notice again", async () => {
    reportPiSupport("ui", "99.0.0");
    const first = uiCtx();
    await (await freshFactory()).startSession(first);
    expect(first.ui.notify).toHaveBeenCalledTimes(1);

    // Pi builds a fresh jiti/module registry when an extension is reloaded: same
    // process, same globalThis, brand-new module bindings — and every register()
    // runs again, so the packages report again. That is exactly the case a
    // module-level `let warned = false` would get wrong.
    vi.resetModules();
    const reloadedGuard = (await import("@pi-archimedes/core/pi-support")) as typeof import("@pi-archimedes/core/pi-support");
    const reloadedFactory = (await import("./index.js")).default as typeof metaFactory;
    // Non-vacuity: this really is a fresh module instance, i.e. the same shape
    // of event `/reload` produces.
    expect(reloadedGuard.reportPiSupport).not.toBe(reportPiSupport);

    const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
    reloadedFactory({
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        (handlers[event] ??= []).push(handler);
      },
      registerCommand: () => {},
      registerTool: () => {},
    } as never);
    // The packages re-report through the *reloaded* guard module.
    reloadedGuard.reportPiSupport("ui", "99.0.0");

    const second = uiCtx();
    const lazy = (handlers["session_start"] ?? []).at(-1) as (...args: unknown[]) => unknown;
    await lazy(undefined, second);

    // The registry still holds the one entry, and the notice stays spent.
    expect(reloadedGuard.piSupportWarnings()).toHaveLength(1);
    expect(reloadedGuard.takePiSupportNotice()).toBeUndefined();
    expect(second.ui.notify).not.toHaveBeenCalled();
  });

  it("still records the notice to the log sink when there is no UI to show it", async () => {
    reportPiSupport("ui", "99.0.0");
    const { startSession } = freshFactory();

    // A ctx without a UI surface (headless / print mode).
    await startSession({ hasUI: false, cwd: "/tmp" });

    const lines = vi.mocked(diag).mock.calls.map(([scope, message]) => `${scope} ${message}`);
    expect(lines.some((l) => l.startsWith("meta") && l.includes("99.0.0"))).toBe(true);
  });
});
