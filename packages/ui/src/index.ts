import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type {
  TUI,
  EditorTheme,
  Component,
} from "@earendil-works/pi-tui";

import { HephaestusEditor } from "./editor/index.js";
import {
  renderHeader,
  patchStartupListing,
  revealStartupListing,
  stopStartupListing,
  modelScopeSection,
  type ListingRef,
} from "./startup/index.js";
import type { ParsedSection } from "./startup/sections.js";
import { patchThinkingRenderer } from "./thinking/patch.js";
import { transformThinkingContent } from "./thinking/transform.js";
import {
  loadUIConfig,
  saveUIConfig,
  readQuietStartup,
  DEFAULT_UI_CONFIG,
  ANIMATION_STYLES,
  normalizeThinkingStyle,
  normalizeToolStyle,
  type UIConfig,
  type CoreConfig,
} from "./config.js";
import { reportPiSupport } from "@pi-archimedes/core/pi-support";
import { getUISettingsItems } from "./settings.js";
import { migrateCoreToUIConfig, migrateCompactThinkingToStyle, migrateRemovedToolPatch } from "./migration.js";
import { renderBashCall, renderBashResult } from "./bash/index.js";
import { renderCodemodeCall, renderCodemodeResult } from "./codemode/index.js";

// Re-exports
export { getUISettingsItems } from "./settings.js";
export {
  loadUIConfig,
  saveUIConfig,
  DEFAULT_UI_CONFIG,
  ANIMATION_STYLES,
  normalizeThinkingStyle,
  normalizeToolStyle,
  THINKING_STYLE_VALUES,
  TOOL_STYLE_VALUES,
  type UIConfig,
  type CoreConfig,
  type ThinkingStyle,
  type ToolStyle,
} from "./config.js";

// Module-level state for session lifecycle
let uiRef: ListingRef | undefined;
let uiCtx: ExtensionContext | undefined;

let spinFlag = false;
let spinInterval: ReturnType<typeof setInterval> | undefined;

/**
 * Which Archimedes tool rows the current session asks for, refreshed at every
 * `session_start` and read by the renderer resolver. The resolver itself is
 * registered once per extension load — pi keeps a list of resolvers per
 * extension, so registering it from `session_start` would stack a duplicate on
 * every `/reload` — which means the settings have to be read here rather than
 * inside the resolver: `renderCall`/`renderResult` run on every frame.
 */
let styledTools = { bash: false, codemode: false };

function clearSpinInterval(): void {
  if (spinInterval) {
    clearInterval(spinInterval);
    spinInterval = undefined;
  }
}

/**
 * Draw the bash row through pi's renderer resolution (ADR 0029).
 *
 * `registerToolRenderer()` was added in pi 1.0.1 precisely for presentation
 * overrides: it chooses how calls to a tool are drawn without registering the
 * tool, and `next()` hands the tool to the remaining resolvers and then to
 * whatever is registered. Off settings therefore give back pi's own row rather
 * than the previous arrangement — re-registering `bash` from
 * `createBashToolDefinition()` with our renderers bolted on — which also means
 * anything pi later adds to that tool cannot be silently dropped by us.
 */
function registerToolRenderers(pi: ExtensionAPI): void {
  // Capability check, not a version wish: on a host without the API there is
  // nothing to resolve through, and pi's own rows stand in.
  if (typeof pi.registerToolRenderer !== "function") return;

  pi.registerToolRenderer((toolName, next) => {
    // `next()` is spread first so that whatever the built-in definition
    // declares besides the two renderers — `renderShell` is the one that matters
    // today — survives resolution instead of being silently dropped by us.
    const ours =
      toolName === "bash" && styledTools.bash
        ? { renderCall: renderBashCall, renderResult: renderBashResult }
        : toolName === "codemode" && styledTools.codemode
          ? { renderCall: renderCodemodeCall, renderResult: renderCodemodeResult }
          : undefined;
    return ours ? { ...next(), ...ours } : next();
  });
}

export function registerUI(pi: ExtensionAPI): void {
  // Floor check before anything that can fail (ADR 0026): pi never installs or
  // solves peers, so the peer range below cannot warn anyone — the runtime
  // comparison against the host's own VERSION is the only thing that can. It
  // records a warning for meta to print once, aggregated; nothing here is
  // withheld on a below-floor host, because a `ui` that registered nothing
  // would make /plugins report an enabled package that did nothing.
  reportPiSupport("ui", "1.2.0");

  // Registered once per extension load, before any session exists (ADR 0029).
  registerToolRenderers(pi);

  // One-time migration of any legacy core config to UI config
  migrateCoreToUIConfig();
  migrateCompactThinkingToStyle();
  // The toolStyle "Full" auto-expand patch was removed: drop any wrapper a
  // previous version left on the shared prototype (upgrade + /reload case).
  migrateRemovedToolPatch();

  pi.on("message_end", (event, _ctx) => {
    if (loadUIConfig().codeUnindent) {
      transformThinkingContent(event.message as any);
    }
  });

  // session_shutdown handler (top-level to prevent accumulation on /reload)
  pi.on("session_shutdown", (_event, ctx) => {
    const targetCtx = ctx?.hasUI ? ctx : uiCtx;
    if (targetCtx?.hasUI) {
      // Give the working row back whichever way we left it: a session that
      // started with the border spinner on had hidden it (`setWorkingVisible(false)`).
      targetCtx.ui.setWorkingVisible(true);
      // Give back everything the session borrowed: pi's animated indicator and
      // its own hidden-thinking wording, so a session that starts after this
      // one (or after `/reload` with the plugin off) sees pi's defaults.
      targetCtx.ui.setWorkingIndicator(undefined);
      targetCtx.ui.setHiddenThinkingLabel(undefined);
      targetCtx.ui.setEditorComponent(undefined);
    }
    clearSpinInterval();
    spinFlag = false;

    // The splash: stop the frame/reveal timers, then freeze the ref so a late
    // render of a header still on screen cannot restart the animation. Nothing
    // else to undo — the startup listing interception and the console.log patch
    // this used to un-install are gone (pi 1.x alignment, Task 8).
    stopStartupListing();
    if (uiRef) {
      uiRef.settled = true;
    }
  });

  // session_start handler
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    uiCtx = ctx;

    const config = loadUIConfig();
    const toolStyle = normalizeToolStyle(config.toolStyle);
    const minimal = toolStyle === "Minimal";

    // What the resolver answers with for this session (see `styledTools`).
    // `Minimal` = archimedes tool styling (the per-tool toggles fine-tune it);
    // `Native` = none of it, so pi's own rows stand everywhere.
    styledTools = {
      bash: minimal && config.bashToolStyling !== false,
      codemode: minimal && config.codemodeToolStyling !== false,
    };

    if (ctx.hasUI) {
      spinFlag = config.editorSpinBorder;

      // pi 1.x owns the startup screen, and the suite's splash is opt-in
      // (`archimedes.ui.startupSplash`, default off — the maintainer's call: keep
      // the code, flip the default). `ctx.scopedModels` is the model scope pi
      // would otherwise have printed, so nothing here scrapes pi's stdout or its
      // component tree any more (that was `startup/capture.ts` plus the
      // `addChild` interception in `patchStartupListing`, both removed here).
      //
      // The two settings are independent knobs, so their combination is stated
      // in full. `quietStartup` is pi's own (`false` = header + details,
      // `"header"` = header alone, `true` = nothing);
      // `startupSplash` is ours (off = we never install a header).
      //
      //   startupSplash   quietStartup   what the header slot gets      timers
      //   -------------   ------------   ----------------------------   ------
      //   false (default) false          pi's own header                none
      //   false (default) "header"       pi's own header                none
      //   false (default) true           pi's own (empty) header        none
      //   true            false          our splash (+ `[Models]` if    armed
      //                                   any model is scoped)
      //   true            "header"       our splash, no scope           armed
      //   true            true           pi's own (empty) header        none
      //
      // Off wins outright: with the splash off we hand the header back to pi
      // whatever `quietStartup` says, and pi's own setting then decides what pi
      // draws — its header and resource listing, its header alone, or its empty
      // `Text("", 0, 0)` — exactly as it does with no archimedes loaded. Handing
      // it back through `setHeader(undefined)` rather than simply doing nothing
      // is what makes a splash left installed by an earlier session in the same
      // process (`/reload` after turning it off) give way: pi puts its
      // `builtInHeader` back in the slot (`setExtensionHeader()`,
      // interactive-mode.js:2006-2011).
      //
      // On means today's behaviour, unchanged. `startupSplash: true` with
      // `quietStartup: true` is the one row worth naming: pi asked for no header
      // at all, so the splash stands down and pi's silence stands — opting in to
      // the splash is not an instruction to overrule pi's own quiet startup, and
      // `quietStartup` keeps deciding whether the resource listing (and so our
      // `[Models]` row) shows. Pinned cell by cell in
      // `startup-splash-gate.test.ts`.
      //
      // `startupSplash` is ours, and read strictly: anything that is not the
      // literal `true` — a hand-edited `"true"`, a `1` — means off, the same way
      // core's `isConfigEnabled` refuses to guess at a boolean.
      const startupSplash = config.startupSplash === true;
      // pi's own answer, asked only when the splash is on: with it off we install
      // no header, so there is nothing for `quietStartup` to decide.
      const quietStartup = startupSplash ? readQuietStartup(pi) : undefined;

      if (!startupSplash) {
        ctx.ui.setHeader(undefined);
        uiRef = undefined;
      } else if (quietStartup === true) {
        // pi's own header is an empty component in this mode. Handing ours back
        // is what keeps that silence: a splash left installed from an earlier
        // session in the same process (`/reload` after a settings change) would
        // otherwise animate over it.
        ctx.ui.setHeader(undefined);
        uiRef = undefined;
      } else {
        // What the splash reveals after the logo. The version row belongs to
        // the header itself; the model scope is a startup *detail*, so it
        // follows pi's own rule for the `Model scope:` line and the resource
        // listing: visible only when `quietStartup` is `false`.
        const sections: ParsedSection[] = [];
        const models = quietStartup === false ? modelScopeSection(ctx.scopedModels) : undefined;
        if (models) sections.push(models);

        // Set animated header
        uiRef = {
          sections: [],
          frame: 0,
          revealed: false,
          revealedAt: 0,
          scaffoldAt: 0,
          settled: false,
        };
        const ref = uiRef;
        const headerFactory = (tui: TUI, theme: Theme): Component & { dispose(): void } => {
          // Nothing here is sized by the screen: pi calls this factory again
          // whenever the header is replaced — a new session, `/reload` (which
          // goes through `resetExtensionUI()`), or any `setHeader()` — and never
          // for a `tuiMode` switch (`switchTuiMode()` re-mounts the components it
          // already has), so a per-screen measurement taken here would be the
          // measurement the header kept until the next replacement. The header
          // does not need one: it renders its own content on either screen
          // (`renderHeader`), which is both what keeps a frame-bounded viewport
          // usable (ADR 0027) and what leaves pi's listing directly below it.
          const comp: Component & { dispose(): void } = {
            // pi invalidates the component tree on every theme change
            // (`onThemeChange()` → `ui.invalidate()`) and from the theme file
            // watcher, and the splash's cached lines carry the theme's colours
            // — so this is the hook that keeps a finished splash from rendering
            // yesterday's palette for the rest of the session. The cache key is
            // the width it was drawn at, which a theme switch leaves alone.
            // Only the memo goes: this is a repaint, not an animation restart.
            invalidate(): void {
              delete ref.cachedLines;
              delete ref.cachedWidth;
            },
            render(width: number): string[] {
              return renderHeader(theme, ref, width);
            },
            // pi disposes the header it is replacing before it builds the next
            // one (`setExtensionHeader()` disposes, then calls the factory), so
            // this is where the splash's timers die on a `setHeader()`
            // replacement or a session restart — no stored renderer needed. A
            // `tuiMode` switch does not dispose: it re-mounts this same
            // component, whose timers then run until they settle themselves.
            dispose(): void {
              stopStartupListing();
            },
          };
          patchStartupListing(tui, ref);
          revealStartupListing(tui, ref, sections);
          return comp;
        };
        ctx.ui.setHeader(headerFactory);
      }

      clearSpinInterval();
      // One announcement, in one place. pi's working row writes "Working" above
      // the editor and our border spinner writes its label — `editorSpinLabel`
      // defaults to "Working" as well — into the editor's own top border, so with
      // both on screen the word appeared twice. The border is ours, so the row is
      // handed pi's own switch: hidden while the spinner runs, given back when it
      // does not.
      //
      // `setWorkingVisible()` is official API (`types.d.ts:88`), and hiding the
      // row is what makes the indicator configuration `#106` needed redundant:
      // pi's `setWorkingVisible(false)` clears the working status indicator
      // outright and its `turn_start` handler honours the flag
      // (`interactive-mode.js:1819-1828`, `:2762-2769`), so there is no row left
      // for a `frames: []` to silence. The indicator is still handed back to pi
      // unconditionally, so the row a user *does* see is pi's default down to its
      // spinner.
      //
      // Read per session rather than remembered: `editorSpinBorder` can change
      // between sessions, and pi puts the row back on whenever it replaces the
      // session (`resetExtensionUI()` → `workingVisible = true`, `:1921`). The
      // toggle needs no keying on the `pi` handle the way a registration does —
      // it is one idempotent setter call inside the `session_start` handler, and
      // every handle gets its own handler.
      ctx.ui.setWorkingVisible(!spinFlag);
      ctx.ui.setWorkingIndicator(undefined);

      // The word a collapsed thinking block shows is pi's own row, so the
      // setting is handed to pi rather than rebuilt here. An empty setting
      // hands the label back to pi's default.
      ctx.ui.setHiddenThinkingLabel(config.labelText.trim() || undefined);

      if (spinFlag) {
        // The border spinner lives in the editor frame, not in scrollback, so
        // it runs on either screen. The renderer is handed straight to the
        // editor and never kept by us, and idleness is read from `ctx` rather
        // than from the renderer, so a screen-mode switch cannot strand it.
        //
        // `ctx.isIdle()` is false from `before_agent_start` onward — i.e. from
        // the moment a run begins, not from the first token — which is exactly
        // the *Busy episode* boundary in `CONTEXT.md` (idle → working → idle),
        // so the spinner starting on the run's first tick is the behaviour the
        // term defines, not an early start.
        ctx.ui.setEditorComponent(
          (tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => {
            const theme = ctx.ui.theme;
            return new HephaestusEditor(tui, editorTheme, keybindings, {
              getTheme: () => theme,
              isIdle: () => ctx.isIdle(),
              shutdown: () => ctx.shutdown(),
              spin: true,
              spinSpeed: config.editorSpinSpeed,
              spinStyle: config.editorSpinStyle,
              spinLabel: config.editorSpinLabel,
              onSpinInterval: (i) => {
                spinInterval = i;
              },
            });
          },
        );
      }

      patchThinkingRenderer(
        () => ctx.ui.theme,
        {
          labelText: config.labelText,
          labelColor: config.labelColor,
          autoCollapseThinking: config.autoCollapseThinking,
          thinkingStyle: normalizeThinkingStyle(config.thinkingStyle),
        },
        // The patch's one user-visible diagnostic (a skipped patch) goes to the
        // notification surface — the console is not a surface on either screen
        // mode, and a subagent child discards it.
        (message) => ctx.ui.notify(message, "warning"),
      );
    }
  });
}

export default function (pi: ExtensionAPI): void {
  registerUI(pi);
}
