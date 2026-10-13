import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { TUI, EditorTheme, Component } from "@earendil-works/pi-tui";

// ── Mock modules ─────────────────────────────────────────────────────────────

// Real `readEffectiveSettings`, so the harness's `pi.getSettings()` is what the
// splash's `quietStartup` read actually goes through; the namespace helpers are
// stubbed because every other settings read in these tests is about `ui`'s own
// config.
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
  return {
    ...actual,
    loadUIConfig: vi.fn(),
  };
});

vi.mock("./thinking/patch.js", () => ({
  patchThinkingRenderer: vi.fn(),
}));

vi.mock("./thinking/transform.js", () => ({
  transformThinkingContent: vi.fn(),
}));

vi.mock("./startup/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./startup/index.js")>();
  return {
    ...actual,
    renderHeader: vi.fn(() => ["header line"]),
    patchStartupListing: vi.fn(),
    revealStartupListing: vi.fn(),
    stopStartupListing: vi.fn(),
  };
});

vi.mock("./migration.js", () => ({
  migrateCoreToUIConfig: vi.fn(),
  migrateCompactThinkingToStyle: vi.fn(),
  migrateRemovedToolPatch: vi.fn(),
  UI_CONFIG_KEYS: [],
}));

vi.mock("./bash/index.js", () => ({
  registerBashToolOverride: vi.fn(),
  clearActiveBashIntervals: vi.fn(),
}));

vi.mock("./codemode/index.js", () => ({
  registerCodemodeToolOverride: vi.fn(async () => true),
  clearActiveCodemodeIntervals: vi.fn(),
}));

import defaultExport, {
  registerUI,
  getUISettingsItems,
  loadUIConfig,
  saveUIConfig,
  DEFAULT_UI_CONFIG,
  ANIMATION_STYLES,
} from "./index.js";
import { migrateCoreToUIConfig } from "./migration.js";
import { registerBashToolOverride, clearActiveBashIntervals } from "./bash/index.js";
import { registerCodemodeToolOverride, clearActiveCodemodeIntervals } from "./codemode/index.js";
import { patchThinkingRenderer } from "./thinking/patch.js";
import { transformThinkingContent } from "./thinking/transform.js";
import {
  renderHeader,
  patchStartupListing,
  revealStartupListing,
  stopStartupListing,
} from "./startup/index.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

interface UiSpies {
  setHeader: ReturnType<typeof vi.fn>;
  setEditorComponent: ReturnType<typeof vi.fn>;
  setWorkingVisible: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
}

function makeCtx(hasUI = true): { ctx: ExtensionContext; ui: UiSpies } {
  const ui: UiSpies = {
    setHeader: vi.fn(),
    setEditorComponent: vi.fn(),
    setWorkingVisible: vi.fn(),
    notify: vi.fn(),
  };
  const ctx = {
    hasUI,
    cwd: "/workspace/test-project",
    ui: { ...ui, theme: {} as Theme },
    isIdle: vi.fn(() => true),
    shutdown: vi.fn(),
    scopedModels: [],
  } as unknown as ExtensionContext;
  return { ctx, ui };
}

/** A `pi` handle whose `getSettings()` answers what pi would apply. */
function makePi(settings: Record<string, unknown> = {}): {
  pi: ExtensionAPI;
  listeners: Record<string, ((event: any, ctx: any) => void)[]>;
} {
  const listeners: Record<string, ((event: any, ctx: any) => void)[]> = {};
  const pi = {
    on: vi.fn((event: string, handler: (event: any, ctx: any) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event]!.push(handler);
    }),
    registerTool: vi.fn(),
    getSettings: vi.fn(() => settings),
  } as unknown as ExtensionAPI;
  return { pi, listeners };
}

function setupHarness(
  settings: Record<string, unknown> = {},
): {
  pi: ExtensionAPI;
  triggerStart: (ctx: ExtensionContext) => void;
  triggerShutdown: (ctx: ExtensionContext) => void;
  triggerMessageEnd: (msg: unknown) => void;
} {
  const { pi, listeners } = makePi(settings);

  registerUI(pi);

  return {
    pi,
    triggerStart: (ctx: ExtensionContext) => {
      for (const h of listeners["session_start"] ?? []) {
        h(null, ctx);
      }
    },
    triggerShutdown: (ctx: ExtensionContext) => {
      for (const h of listeners["session_shutdown"] ?? []) {
        h(null, ctx);
      }
    },
    triggerMessageEnd: (msg: unknown) => {
      for (const h of listeners["message_end"] ?? []) {
        h({ message: msg }, {} as any);
      }
    },
  };
}

describe("packages/ui lifecycle and registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadUIConfig).mockReturnValue({ ...DEFAULT_UI_CONFIG });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("exports", () => {
    it("re-exports expected functions and constants", () => {
      expect(typeof getUISettingsItems).toBe("function");
      expect(typeof loadUIConfig).toBe("function");
      expect(typeof saveUIConfig).toBe("function");
      expect(DEFAULT_UI_CONFIG).toBeDefined();
      expect(ANIMATION_STYLES).toBeDefined();
      expect(typeof defaultExport).toBe("function");
    });

    it("default export delegates to registerUI", () => {
      const pi = { on: vi.fn(), getSettings: vi.fn(() => ({})) } as unknown as ExtensionAPI;
      defaultExport(pi);
      expect(migrateCoreToUIConfig).toHaveBeenCalled();
    });
  });

  describe("registerUI initialization", () => {
    it("calls migrateCoreToUIConfig and leaves the console alone", () => {
      const { pi } = setupHarness();
      expect(migrateCoreToUIConfig).toHaveBeenCalledTimes(1);
      // Nobody may wrap console.log to watch pi's startup output: the scrape is
      // gone, and a wrapped log both smears the frame and hides pi's own line.
      expect(console.log.name).toBe("log");
      expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
      expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    });
  });

  describe("session_start with interactive UI (hasUI: true)", () => {
    it("configures bash tool override, codemode tool override, header, editor, and thinking renderer", () => {
      const { triggerStart } = setupHarness();
      const { ctx, ui } = makeCtx(true);

      triggerStart(ctx);

      // Bash tool override
      expect(registerBashToolOverride).toHaveBeenCalledWith(expect.anything(), "/workspace/test-project");

      // Codemode tool override (fire-and-forget)
      expect(registerCodemodeToolOverride).toHaveBeenCalledWith(expect.anything());

      // Header installation
      expect(ui.setHeader).toHaveBeenCalledTimes(1);
      const headerFactory = ui.setHeader.mock.calls[0]![0];
      const fakeTui = { terminal: { rows: 24 } } as TUI;
      const fakeTheme = {} as Theme;
      const comp = headerFactory(fakeTui, fakeTheme);
      expect(typeof comp.render).toBe("function");
      comp.render(80);
      expect(renderHeader).toHaveBeenCalledWith(fakeTheme, expect.any(Object), 80, 21);
      expect(patchStartupListing).toHaveBeenCalledWith(fakeTui, expect.any(Object));

      // Working visibility and Editor component
      expect(ui.setWorkingVisible).toHaveBeenCalledWith(false); // spinFlag is true by default
      expect(ui.setEditorComponent).toHaveBeenCalledTimes(1);
      const editorFactory = ui.setEditorComponent.mock.calls[0]![0];
      const editorInstance = editorFactory(fakeTui, { borderColor: (s: string) => s } as EditorTheme, {} as KeybindingsManager);
      expect(editorInstance).toBeDefined();
      (editorInstance as any).dispose?.();

      // Thinking renderer
      expect(patchThinkingRenderer).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          labelText: "Thinking...",
          labelColor: "255,215,0",
          autoCollapseThinking: false,
          thinkingStyle: "Full",
        }),
        // The user-facing surface is injected: `patch.ts` has no ctx of its
        // own, and a skipped patch must not be a silent feature loss.
        expect.any(Function),
      );
      const patchNotify = vi.mocked(patchThinkingRenderer).mock.calls[0]![2] as (m: string) => void;
      patchNotify("patch skipped");
      expect(ui.notify).toHaveBeenCalledWith("patch skipped", "warning");

      // Master gate (default toolStyle is Minimal): both overrides registered
      expect(registerBashToolOverride).toHaveBeenCalled();
      expect(registerCodemodeToolOverride).toHaveBeenCalled();
    });

    it("skips the tool overrides entirely when toolStyle is Native", () => {
      vi.mocked(loadUIConfig).mockReturnValue({
        ...DEFAULT_UI_CONFIG,
        toolStyle: "Native",
      });

      const { triggerStart } = setupHarness();
      const { ctx, ui } = makeCtx(true);

      triggerStart(ctx);

      // Native = no archimedes tool styling: neither override is registered
      // (pi's native rendering stands, no built-in-takeover notice).
      expect(registerBashToolOverride).not.toHaveBeenCalled();
      expect(registerCodemodeToolOverride).not.toHaveBeenCalled();
      // The rest of the UI still comes up.
      expect(ui.setHeader).toHaveBeenCalledTimes(1);
    });

    it("respects editorSpinBorder: false by leaving workingVisible=true and not installing editor component", () => {
      vi.mocked(loadUIConfig).mockReturnValue({
        ...DEFAULT_UI_CONFIG,
        editorSpinBorder: false,
      });

      const { triggerStart } = setupHarness();
      const { ctx, ui } = makeCtx(true);

      triggerStart(ctx);

      expect(ui.setWorkingVisible).toHaveBeenCalledWith(true);
      expect(ui.setEditorComponent).not.toHaveBeenCalled();
    });

    it("skips bashToolOverride when bashToolStyling is false", () => {
      vi.mocked(loadUIConfig).mockReturnValue({
        ...DEFAULT_UI_CONFIG,
        bashToolStyling: false,
      });

      const { triggerStart } = setupHarness();
      const { ctx } = makeCtx(true);

      triggerStart(ctx);

      expect(registerBashToolOverride).not.toHaveBeenCalled();
    });

    it("skips the codemode tool override when codemodeToolStyling is false", () => {
      vi.mocked(loadUIConfig).mockReturnValue({
        ...DEFAULT_UI_CONFIG,
        codemodeToolStyling: false,
      });

      const { triggerStart } = setupHarness();
      const { ctx } = makeCtx(true);

      triggerStart(ctx);

      expect(registerCodemodeToolOverride).not.toHaveBeenCalled();
    });

    it("does not accumulate message_end listeners on repeated session_start (simulating /reload)", () => {
      vi.mocked(loadUIConfig).mockReturnValue({
        ...DEFAULT_UI_CONFIG,
        codeUnindent: true,
      });

      const { triggerStart, triggerMessageEnd } = setupHarness();
      const { ctx } = makeCtx(true);

      triggerStart(ctx);
      triggerStart(ctx); // Simulate second session_start

      const msg = { role: "assistant", content: [] };
      triggerMessageEnd(msg);

      expect(transformThinkingContent).toHaveBeenCalledTimes(1);
    });

    it("skips transformThinkingContent on message_end if codeUnindent is false", () => {
      vi.mocked(loadUIConfig).mockReturnValue({
        ...DEFAULT_UI_CONFIG,
        codeUnindent: false,
      });

      const { triggerStart, triggerMessageEnd } = setupHarness();
      const { ctx } = makeCtx(true);

      triggerStart(ctx);

      const msg = { role: "assistant", content: [] };
      triggerMessageEnd(msg);

      expect(transformThinkingContent).not.toHaveBeenCalled();
    });
  });

  describe("session_start in non-interactive mode (hasUI: false)", () => {
    it("still registers bashToolOverride but skips UI setup", () => {
      const { triggerStart } = setupHarness();
      const { ctx, ui } = makeCtx(false);

      triggerStart(ctx);

      expect(registerBashToolOverride).toHaveBeenCalledWith(expect.anything(), "/workspace/test-project");
      expect(ui.setHeader).not.toHaveBeenCalled();
      expect(ui.setEditorComponent).not.toHaveBeenCalled();
      expect(patchThinkingRenderer).not.toHaveBeenCalled();
    });
  });

  describe("startup header: quietStartup and ctx.scopedModels", () => {
    // pi 1.x owns the startup screen: `quietStartup` (`false` / `"header"` /
    // `true`) decides what is shown, and `ctx.scopedModels` is the session's
    // model scope — the same set `/scoped-models` lists. Both are read, neither
    // is scraped any more.
    const scopedModels = [
      { model: { id: "claude-sonnet-4-5" } },
      { model: { id: "gpt-5" }, thinkingLevel: "high" },
    ];
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as never);
      vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    /** Register, start a session and invoke the header factory pi was given. */
    function startHeader(settings: Record<string, unknown>, models: unknown[] = scopedModels) {
      const { triggerStart } = setupHarness(settings);
      const { ctx, ui } = makeCtx(true);
      (ctx as unknown as { scopedModels: unknown[] }).scopedModels = models;

      triggerStart(ctx);
      const headerFactory = ui.setHeader.mock.calls[0]![0];
      const tui = { terminal: { rows: 24 }, requestRender: vi.fn() } as unknown as TUI;
      headerFactory(tui, {} as Theme);
      return { ui, tui };
    }

    it("reveals the model scope from ctx.scopedModels with console.log untouched", () => {
      const { tui } = startHeader({});

      expect(revealStartupListing).toHaveBeenCalledTimes(1);
      expect(revealStartupListing).toHaveBeenCalledWith(tui, expect.any(Object), [
        { name: "Models", items: ["claude-sonnet-4-5", "gpt-5:high"] },
      ]);
      expect(console.log.name).toBe("log");
    });

    it('quietStartup: "header" keeps the splash and drops the model scope', () => {
      startHeader({ quietStartup: "header" });

      // The header is ours (the splash stays), but the details half is not.
      expect(revealStartupListing).toHaveBeenCalledTimes(1);
      expect(revealStartupListing).toHaveBeenCalledWith(expect.anything(), expect.any(Object), []);
    });

    it("quietStartup: true hands the header back to pi and starts no splash", () => {
      const { triggerStart } = setupHarness({ quietStartup: true });
      const { ctx, ui } = makeCtx(true);

      triggerStart(ctx);

      // pi replaces its own header with an empty component for a quiet start;
      // restoring ours is what leaves that silence in place.
      expect(ui.setHeader).toHaveBeenCalledWith(undefined);
      expect(patchStartupListing).not.toHaveBeenCalled();
      expect(revealStartupListing).not.toHaveBeenCalled();
    });

    it("reveals nothing but the version block when the session has no model scope", () => {
      startHeader({}, []);

      expect(revealStartupListing).toHaveBeenCalledWith(expect.anything(), expect.any(Object), []);
    });

    it("asks the network nothing at startup", () => {
      startHeader({});
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("session_shutdown teardown", () => {
    it("stops the splash, restores workingVisible, and clears editor component", () => {
      const { triggerStart, triggerShutdown } = setupHarness();
      const { ctx, ui } = makeCtx(true);

      triggerStart(ctx);

      // Verify startup
      expect(ui.setWorkingVisible).toHaveBeenCalledWith(false);

      // Now trigger shutdown
      triggerShutdown(ctx);

      expect(stopStartupListing).toHaveBeenCalledTimes(1);
      expect(clearActiveBashIntervals).toHaveBeenCalledTimes(1);
      expect(clearActiveCodemodeIntervals).toHaveBeenCalledTimes(1);
      expect(ui.setWorkingVisible).toHaveBeenLastCalledWith(true);
      expect(ui.setEditorComponent).toHaveBeenLastCalledWith(undefined);
    });

    it("stops the splash when pi disposes the header (header replaced, session restart)", () => {
      const { triggerStart, triggerShutdown } = setupHarness();
      const { ctx, ui } = makeCtx(true);

      triggerStart(ctx);
      const headerFactory = ui.setHeader.mock.calls[0]![0];
      const comp = headerFactory({ terminal: { rows: 24 } } as TUI, {} as Theme);

      expect(typeof comp.dispose).toBe("function");
      comp.dispose!();
      expect(stopStartupListing).toHaveBeenCalledTimes(1);

      triggerShutdown(ctx);
    });
  });

  // The header component's own contract with pi, independent of lifecycle: pi
  // tells a component to drop cached rendering state by calling
  // `invalidate()` — `onThemeChange()` does it for the whole tree
  // (`interactive-mode.js:792`), as does the theme file watcher — and the
  // splash caches its finished lines, which carry the theme's colours.
  describe("header component contract", () => {
    it("drops the cached header lines when pi invalidates it (theme change)", () => {
      const { triggerStart } = setupHarness();
      const { ctx, ui } = makeCtx(true);

      triggerStart(ctx);
      const headerFactory = ui.setHeader.mock.calls[0]![0];
      const comp = headerFactory({ terminal: { rows: 24 } } as TUI, {} as Theme);

      comp.render(80);
      const ref = vi.mocked(renderHeader).mock.calls.at(-1)![1] as {
        settled: boolean;
        cachedLines?: string[];
      };
      // The state a finished splash leaves behind (the mocked `renderHeader`
      // does not fill it in, so the test does what the real one would).
      ref.settled = true;
      ref.cachedLines = ["\x1b[90mv1.2.0\x1b[0m"];

      comp.invalidate();

      expect(ref.cachedLines).toBeUndefined();
    });
  });
});
