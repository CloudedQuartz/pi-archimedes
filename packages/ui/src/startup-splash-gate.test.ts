import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

// ── The gate: `archimedes.ui.startupSplash` × pi's `quietStartup` ──────────
//
// The suite's splash is opt-in. The maintainer's answer to "do we own the
// startup screen?" is that pi does, unless the user asks for the splash, so the
// whole 2×3 table is pinned here rather than left to be inferred from two
// independent settings:
//
//   startupSplash  | quietStartup | header installed            | splash timer
//   ---------------|--------------|-----------------------------|-------------
//   false (default)| false        | pi's own (setHeader(undef)) | none armed
//   false (default)| "header"     | pi's own (setHeader(undef)) | none armed
//   false (default)| true         | pi's own (setHeader(undef)) | none armed
//   true           | false        | ours (the splash factory)   | frame + reveal
//   true           | "header"     | ours (the splash factory)   | frame + reveal
//   true           | true         | pi's own (setHeader(undef)) | none armed
//
// `startupSplash: false` wins outright — pi's own startup, whatever
// `quietStartup` says, and pi's own setting then decides pi's own header and
// resource listing exactly as it does with no archimedes installed at all.
// `startupSplash: true` is today's behaviour, unchanged: `quietStartup` still
// decides whether pi's resource listing (and so the splash's model scope)
// shows, and `quietStartup: true` — where pi asked for no header at all — still
// gets the header handed back rather than an animation drawn over pi's silence.
//
// Nothing in `./startup/index.js` is stubbed here: "no timer is armed" is only
// evidence if the real animation module is the thing that could have armed one,
// so the frame/reveal timers are counted with fake timers rather than inferred
// from a mock call.

vi.mock("@pi-archimedes/core/settings-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pi-archimedes/core/settings-io")>();
  return {
    ...actual,
    loadConfig: vi.fn(),
    saveConfig: vi.fn(),
    removeConfig: vi.fn(),
  };
});

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return { ...actual, loadUIConfig: vi.fn() };
});

vi.mock("./thinking/patch.js", () => ({ patchThinkingRenderer: vi.fn() }));
vi.mock("./thinking/transform.js", () => ({ transformThinkingContent: vi.fn() }));
vi.mock("./migration.js", () => ({
  migrateCoreToUIConfig: vi.fn(),
  migrateCompactThinkingToStyle: vi.fn(),
  migrateRemovedToolPatch: vi.fn(),
  UI_CONFIG_KEYS: [],
}));
vi.mock("./bash/index.js", () => ({
  renderBashCall: vi.fn(),
  renderBashResult: vi.fn(),
}));
vi.mock("./codemode/index.js", () => ({
  renderCodemodeCall: vi.fn(),
  renderCodemodeResult: vi.fn(),
}));

// The one spy in this file, and it is a pass-through: it wraps the real
// `getShinedLogo` rather than replacing it, so the animation still runs and the
// timer counts above stay honest. It is here to answer "no logo work" directly —
// this is the function that builds the logo rows — with a control case in the
// `startupSplash: true` path proving the spy would have caught it.
vi.mock("./startup/logo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./startup/logo.js")>();
  return { ...actual, getShinedLogo: vi.fn(actual.getShinedLogo) };
});

import { VERSION } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "@pi-archimedes/core/text";
import { registerUI } from "./index.js";
import { loadUIConfig, DEFAULT_UI_CONFIG, type UIConfig } from "./config.js";
import { stopStartupListing } from "./startup/index.js";
import { getShinedLogo } from "./startup/logo.js";

// ── Harness ─────────────────────────────────────────────────────────────────

const MODEL_SCOPE = [{ model: { id: "claude-sonnet-4-5" } }];
const WIDTH = 80;
/** Long enough for the reveal debounce, the text ramp and the logo to finish. */
const SETTLE_MS = 5_000;

interface Header {
  /** Render the header that is installed, trimmed of padding. */
  lines(): string[];
  dispose(): void;
}

interface Started {
  /** What pi was handed for the header slot: a factory, or `undefined`. */
  headerArg: unknown;
  setHeader: Mock;
  setEditorComponent: Mock;
  setWorkingVisible: Mock;
  /** Build the header pi was handed, on a renderer that counts redraws. */
  installHeader(): Header;
  /** How many times `pi.getSettings()` was consulted (the `quietStartup` read). */
  getSettingsCalls: number;
  /** How many times `ctx.scopedModels` was read. */
  scopedModelsReads: number;
}

/**
 * Register, start one session, and report what the header slot was given.
 * `uiConfig` is what the suite's own settings answer; `piSettings` is what pi's
 * effective settings answer (i.e. `quietStartup`).
 */
function startSession(args: {
  uiConfig?: Partial<UIConfig>;
  piSettings?: Record<string, unknown>;
  scopedModels?: unknown[];
} = {}): Started {
  vi.mocked(loadUIConfig).mockReturnValue({
    ...DEFAULT_UI_CONFIG,
    ...(args.uiConfig ?? {}),
  } as UIConfig);

  const listeners: Record<string, ((event: any, ctx: any) => void)[]> = {};
  const getSettings = vi.fn(() => args.piSettings ?? {});
  const pi = {
    on: vi.fn((event: string, handler: (event: any, ctx: any) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event]!.push(handler);
    }),
    registerTool: vi.fn(),
    registerToolRenderer: vi.fn(),
    getSettings,
  } as unknown as ExtensionAPI;

  const setHeader = vi.fn();
  const setEditorComponent = vi.fn();
  const setWorkingVisible = vi.fn();
  const theme = { fg: (_token: string, text: string) => text } as unknown as Theme;
  const ui = {
    setHeader,
    setEditorComponent,
    setWorkingVisible,
    setWorkingIndicator: vi.fn(),
    setHiddenThinkingLabel: vi.fn(),
    notify: vi.fn(),
    theme,
  };

  let scopedModelsReads = 0;
  const ctx: Record<string, unknown> = {
    hasUI: true,
    cwd: "/workspace/test-project",
    ui,
    isIdle: () => true,
    shutdown: vi.fn(),
  };
  // A counting getter, so "the splash is never built" can be told apart from
  // "the splash is built and then thrown away".
  Object.defineProperty(ctx, "scopedModels", {
    enumerable: true,
    get: () => {
      scopedModelsReads++;
      return args.scopedModels ?? MODEL_SCOPE;
    },
  });

  registerUI(pi);
  for (const handler of listeners["session_start"] ?? []) {
    handler(null, ctx as unknown as ExtensionContext);
  }

  const headerArg = setHeader.mock.calls[0]?.[0];

  return {
    headerArg,
    setHeader,
    setEditorComponent,
    setWorkingVisible,
    installHeader: () => {
      const factory = headerArg as (
        tui: TUI,
        theme: Theme,
      ) => { render(width: number): string[]; dispose(): void };
      const tui = {
        terminal: { rows: 24 },
        requestRender: vi.fn(),
      } as unknown as TUI;
      const comp = factory(tui, theme);
      return {
        lines: () => comp.render(WIDTH).map((l) => l.trim()),
        dispose: () => comp.dispose(),
      };
    },
    getSettingsCalls: getSettings.mock.calls.length,
    scopedModelsReads,
  };
}

const hasVersionRow = (lines: readonly string[]): boolean =>
  lines.some((l) => l.includes("[Version]")) && lines.some((l) => l.includes(`v${VERSION}`));

describe("startupSplash: the 2×3 truth table", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopStartupListing();
    vi.useRealTimers();
  });

  interface Cell {
    label: string;
    /** `undefined` = the key is absent from settings.json, i.e. the default. */
    startupSplash: boolean | undefined;
    quietStartup: boolean | "header" | undefined;
    /** "pi" = the header slot is handed back; "ours" = our factory is installed. */
    header: "pi" | "ours";
    /** Whether a splash timer is armed once the header pi was handed is built. */
    timer: boolean;
    /** Whether the splash reveals the session's model scope. */
    models: boolean;
  }

  const CELLS: Cell[] = [
    { label: "off (default) × quietStartup absent (false)", startupSplash: undefined, quietStartup: undefined, header: "pi", timer: false, models: false },
    { label: "off (default) × quietStartup:\"header\"", startupSplash: undefined, quietStartup: "header", header: "pi", timer: false, models: false },
    { label: "off (default) × quietStartup:true", startupSplash: undefined, quietStartup: true, header: "pi", timer: false, models: false },
    { label: "on × quietStartup absent (false)", startupSplash: true, quietStartup: undefined, header: "ours", timer: true, models: true },
    { label: "on × quietStartup:\"header\"", startupSplash: true, quietStartup: "header", header: "ours", timer: true, models: false },
    { label: "on × quietStartup:true", startupSplash: true, quietStartup: true, header: "pi", timer: false, models: false },
  ];

  for (const cell of CELLS) {
    it(`${cell.label}: header = ${cell.header}, splash timer armed = ${cell.timer}`, () => {
      const started = startSession({
        uiConfig: cell.startupSplash === undefined ? {} : { startupSplash: cell.startupSplash },
        piSettings: cell.quietStartup === undefined ? {} : { quietStartup: cell.quietStartup },
      });

      // Which header is installed. `undefined` puts pi's own header back in its
      // slot (`setExtensionHeader(undefined)` restores `builtInHeader`,
      // interactive-mode.js:2006); a function is our splash factory.
      expect(started.setHeader).toHaveBeenCalledTimes(1);
      if (cell.header === "pi") {
        expect(started.headerArg).toBeUndefined();
      } else {
        expect(typeof started.headerArg).toBe("function");
      }

      // Whether a splash timer is armed. Building the header is what arms the
      // frame timer (`patchStartupListing`) and the reveal timer
      // (`revealStartupListing`) — two for a splash, zero for pi's own header,
      // which is already built and has no factory for us to invoke.
      const header = cell.header === "ours" ? started.installHeader() : undefined;
      expect(vi.getTimerCount()).toBe(cell.timer ? 2 : 0);

      // And the same after time has passed: a cell with no splash never starts
      // one, and a cell with one reveals its text.
      vi.advanceTimersByTime(SETTLE_MS);
      if (header) {
        const lines = header.lines();
        expect(hasVersionRow(lines)).toBe(true);
        expect(lines.some((l) => l.includes("[Models]"))).toBe(cell.models);
        if (cell.models) {
          expect(lines.some((l) => l.includes("claude-sonnet-4-5"))).toBe(true);
        }
      }
    });
  }

  it("the splash is off for the whole table when the setting is absent", () => {
    // The three off rows differ in nothing but pi's own setting, so the same
    // answer is expected for each — spelled out rather than assumed.
    for (const quietStartup of [undefined, false, "header", true] as const) {
      const started = startSession({
        piSettings: quietStartup === undefined ? {} : { quietStartup },
      });
      expect(started.setHeader, `quietStartup=${String(quietStartup)}`).toHaveBeenCalledWith(
        undefined,
      );
      expect(vi.getTimerCount(), `quietStartup=${String(quietStartup)}`).toBe(0);
      stopStartupListing();
    }
  });
});

// ── Default off costs nothing ──────────────────────────────────────────────
//
// "Default off" has to mean the splash is not merely hidden but never built:
// no header factory registered, no frame/reveal timer, no model-scope read off
// the context, and — because the gate comes first — not even a settings read to
// ask pi how quiet its startup should be.

describe("the default path costs nothing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopStartupListing();
    vi.useRealTimers();
  });

  it("hands the header to pi with no factory, and arms no timer", () => {
    const started = startSession({ scopedModels: MODEL_SCOPE });

    // `undefined` — pi's own header, not a splash we installed and dimmed.
    expect(started.setHeader).toHaveBeenCalledTimes(1);
    expect(started.setHeader).toHaveBeenCalledWith(undefined);
    expect(vi.getTimerCount()).toBe(0);

    // Nothing was installed, so nothing can animate: time passes and still no
    // timer exists.
    vi.advanceTimersByTime(10_000);
    expect(vi.getTimerCount()).toBe(0);

    // And no logo work happened — the frame builder was never asked for a row.
    expect(getShinedLogo).not.toHaveBeenCalled();
  });

  it("reads neither ctx.scopedModels nor pi's quietStartup when the splash is off", () => {
    const started = startSession({ piSettings: { quietStartup: false } });

    expect(started.headerArg).toBeUndefined();
    // The model scope exists only to fill the splash's `[Models]` row; with no
    // splash there is nothing to fill, so the context is not even asked.
    expect(started.scopedModelsReads).toBe(0);
    // And the gate runs before `readQuietStartup`, so pi's effective settings
    // are not consulted for the header at all.
    expect(started.getSettingsCalls).toBe(0);
  });

  it("does the rest of the UI anyway — the gate is the splash, not the package", () => {
    const started = startSession({});

    // The border spinner still owns the editor, and pi's working row is still
    // hidden for it (`editorSpinBorder` defaults to on). Turning the splash off
    // must not take the rest of the package with it.
    expect(started.setEditorComponent).toHaveBeenCalledTimes(1);
    expect(started.setWorkingVisible).toHaveBeenCalledWith(false);
    expect(started.setHeader).toHaveBeenCalledWith(undefined);
  });
});

// ── The flag is read off the config, whatever its shape ────────────────────
//
// A hand-edited settings.json is the other way this arrives: the flag is read
// from the merged config every session, so `true` turns the splash on and
// anything else — including a corrupt value — leaves pi's startup alone.

describe("startupSplash values", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopStartupListing();
    vi.useRealTimers();
  });

  /** Start one session with a raw `startupSplash` value and report the header. */
  const headerFor = (startupSplash: unknown): unknown => {
    // Passed through the merge, exactly the way a hand-edited settings.json
    // reaches it: `loadConfig` spreads the stored namespace over the defaults,
    // so whatever the file says lands here verbatim.
    const started = startSession({ uiConfig: { startupSplash } as unknown as Partial<UIConfig> });
    return started.headerArg;
  };

  it("installs the splash for `true`", () => {
    expect(typeof headerFor(true)).toBe("function");
    stopStartupListing();
  });

  it("leaves pi's header alone for `false`, and for anything unusable", () => {
    for (const value of [false, undefined, null, "true", 1, {}]) {
      expect(headerFor(value), `startupSplash=${String(value)}`).toBeUndefined();
      expect(vi.getTimerCount(), `startupSplash=${String(value)}`).toBe(0);
      stopStartupListing();
    }
  });

  it("re-reads the setting every session, so it can be turned off between sessions", () => {
    expect(typeof headerFor(true)).toBe("function");
    stopStartupListing();
    expect(headerFor(false)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── Turning it off in a process that already drew a splash ─────────────────
//
// The gate's comment in `index.ts` claims more than "the next session gets no
// header": handing the slot back is also what ends a splash that an earlier
// session in THIS process left animating (`/reload` after turning the setting
// off). `startSession()` above cannot show that — it registers afresh for every
// value and never builds a header, so no animation is running when the gated
// session starts. This block registers ONCE, drives both sessions through the
// same handler, and models pi's header slot rather than a bare spy:
// `setExtensionHeader()` disposes the component it is replacing and only then
// restores `builtInHeader` (`interactive-mode.js:1979-1988` and `:1911` for the
// session restart). Nothing here calls `stopStartupListing()` by hand, so the
// handback is the only thing that could stop the timers.

describe("turning the splash off in a process that already drew one", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopStartupListing();
    vi.useRealTimers();
  });

  it("the handback ends the animation the previous session left running", () => {
    const listeners: Record<string, ((event: any, ctx: any) => void)[]> = {};
    const pi = {
      on: vi.fn((event: string, handler: (event: any, ctx: any) => void) => {
        listeners[event] = listeners[event] ?? [];
        listeners[event]!.push(handler);
      }),
      registerTool: vi.fn(),
      registerToolRenderer: vi.fn(),
      getSettings: vi.fn(() => ({})),
    } as unknown as ExtensionAPI;

    // pi's header slot: a replacement disposes what it is replacing, then either
    // builds the new header or puts pi's own back.
    let installed: { render(width: number): string[]; dispose(): void } | undefined;
    let slot: "pi" | "ours" = "pi";
    const requestRender = vi.fn();
    const tui = { terminal: { rows: 24 }, requestRender } as unknown as TUI;
    const theme = { fg: (_token: string, text: string) => text } as unknown as Theme;
    const setHeader = vi.fn((factory?: unknown) => {
      installed?.dispose();
      installed =
        typeof factory === "function"
          ? (factory as (t: TUI, th: Theme) => typeof installed)(tui, theme)
          : undefined;
      slot = installed ? "ours" : "pi";
    });

    const ctx = {
      hasUI: true,
      cwd: "/workspace/test-project",
      isIdle: () => true,
      shutdown: vi.fn(),
      scopedModels: MODEL_SCOPE,
      ui: {
        setHeader,
        setEditorComponent: vi.fn(),
        setWorkingVisible: vi.fn(),
        setWorkingIndicator: vi.fn(),
        setHiddenThinkingLabel: vi.fn(),
        notify: vi.fn(),
        theme,
      },
    } as unknown as ExtensionContext;

    const session = (uiConfig: Partial<UIConfig>): void => {
      vi.mocked(loadUIConfig).mockReturnValue({
        ...DEFAULT_UI_CONFIG,
        ...uiConfig,
      } as UIConfig);
      for (const handler of listeners["session_start"] ?? []) {
        handler(null, ctx);
      }
    };

    registerUI(pi);

    // Session 1: the splash is on, so pi's slot holds our animated header and
    // the real animation module has its frame and reveal timers armed.
    session({ startupSplash: true });
    expect(slot).toBe("ours");
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(200);
    const renders = requestRender.mock.calls.length;
    expect(renders).toBeGreaterThan(0);

    // Session 2, same process, same registration: the setting is off now. The
    // slot is pi's again and the animation that came with the old header is
    // gone — no timer left armed, nothing left asking the renderer for frames.
    session({ startupSplash: false });
    expect(slot).toBe("pi");
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(SETTLE_MS);
    expect(requestRender.mock.calls.length).toBe(renders);
  });
});

// ── A splash that is on is still the same splash ───────────────────────────
//
// The flag must not change what the splash is, only whether it appears: with it
// on, the header is the animated block (logo + `[Version]`), drawn as its own
// content, animating on the renderer it was handed and settling by itself.

describe("startupSplash: true installs the same splash as before", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopStartupListing();
    vi.useRealTimers();
  });

  it("draws the logo and the version row, and stops animating once settled", () => {
    const started = startSession({ uiConfig: { startupSplash: true } });
    const factory = started.headerArg as (
      tui: TUI,
      theme: Theme,
    ) => { render(width: number): string[]; dispose(): void };
    const requestRender = vi.fn();
    const tui = { terminal: { rows: 24 }, requestRender } as unknown as TUI;
    const comp = factory(tui, { fg: (_t: string, s: string) => s } as unknown as Theme);

    vi.advanceTimersByTime(SETTLE_MS);
    const lines = comp.render(WIDTH).map((l) => l.trim());
    expect(hasVersionRow(lines)).toBe(true);
    expect(stripAnsi(lines.join("\n"))).toContain("████");
    // The control for the zero-cost test's `getShinedLogo` assertion: the spy is
    // live, so its absence on the default path means something.
    expect(vi.mocked(getShinedLogo)).toHaveBeenCalled();

    // At rest: the frame timer stopped, so no more redraws.
    const renders = requestRender.mock.calls.length;
    expect(renders).toBeGreaterThan(0);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(requestRender.mock.calls.length).toBe(renders);
  });
});
