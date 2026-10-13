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
import { renderHeader, patchStartupListing, settleHeader, CONTENT_ONLY_HEIGHT, type ListingRef } from "./startup/index.js";
import { patchConsoleLog, unpatchConsoleLog } from "./startup/capture.js";
import { patchThinkingRenderer } from "./thinking/patch.js";
import { transformThinkingContent } from "./thinking/transform.js";
import {
  loadUIConfig,
  saveUIConfig,
  DEFAULT_UI_CONFIG,
  ANIMATION_STYLES,
  normalizeThinkingStyle,
  normalizeToolStyle,
  type UIConfig,
  type CoreConfig,
} from "./config.js";
import { screenCapabilities, screenMode } from "@pi-archimedes/core/screen-mode";
import { reportPiSupport } from "@pi-archimedes/core/pi-support";
import { getUISettingsItems } from "./settings.js";
import { migrateCoreToUIConfig, migrateCompactThinkingToStyle, migrateRemovedToolPatch } from "./migration.js";
import { registerBashToolOverride, clearActiveBashIntervals } from "./bash/index.js";
import { registerCodemodeToolOverride, clearActiveCodemodeIntervals } from "./codemode/index.js";

// Re-exports
export { unpatchConsoleLog } from "./startup/capture.js";
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
// Stored renderer — the one ADR 0027 forbids, and the one entry in the
// guard's allow-list. It exists only for the shutdown un-patch below and goes
// away with that patch in Task 8.
let uiTui: TUI | undefined;

let spinFlag = false;
let spinInterval: ReturnType<typeof setInterval> | undefined;

function clearSpinInterval(): void {
  if (spinInterval) {
    clearInterval(spinInterval);
    spinInterval = undefined;
  }
}

export function registerUI(pi: ExtensionAPI): void {
  // Floor check before anything that can fail (ADR 0026): pi never installs or
  // solves peers, so the peer range below cannot warn anyone — the runtime
  // comparison against the host's own VERSION is the only thing that can. It
  // records a warning for meta to print once, aggregated; nothing here is
  // withheld on a below-floor host, because a `ui` that registered nothing
  // would make /plugins report an enabled package that did nothing.
  reportPiSupport("ui", "1.2.0");

  // One-time migration of any legacy core config to UI config
  migrateCoreToUIConfig();
  migrateCompactThinkingToStyle();
  // The toolStyle "Full" auto-expand patch was removed: drop any wrapper a
  // previous version left on the shared prototype (upgrade + /reload case).
  migrateRemovedToolPatch();

  // Patch pi's startup stdout for model scope capture
  patchConsoleLog();

  pi.on("message_end", (event, _ctx) => {
    if (loadUIConfig().codeUnindent) {
      transformThinkingContent(event.message as any);
    }
  });

  // session_shutdown handler (top-level to prevent accumulation on /reload)
  pi.on("session_shutdown", (_event, ctx) => {
    unpatchConsoleLog();
    clearActiveBashIntervals();
    clearActiveCodemodeIntervals();

    const targetCtx = ctx?.hasUI ? ctx : uiCtx;
    if (targetCtx?.hasUI) {
      targetCtx.ui.setWorkingVisible(true);
      targetCtx.ui.setEditorComponent(undefined);
    }
    clearSpinInterval();
    spinFlag = false;

    if (uiRef) {
      uiRef.settled = true;
    }

    const PATCHED_LISTING = Symbol.for("splashscreen:listingPatched");
    const ORIG_ADD_CHILD = Symbol.for("splashscreen:origAddChild");
    if (uiTui) {
      try {
        for (const child of uiTui.children) {
          const cc = child as any;
          if (cc[PATCHED_LISTING] && cc[ORIG_ADD_CHILD]) {
            cc.addChild = cc[ORIG_ADD_CHILD];
            cc[PATCHED_LISTING] = false;
            cc[ORIG_ADD_CHILD] = undefined;
          }
        }
        for (const topChild of uiTui.children) {
          const tc = topChild as any;
          if (!tc.children) continue;
          for (const child of tc.children) {
            const cc = child as any;
            if (cc[PATCHED_LISTING] && cc[ORIG_ADD_CHILD]) {
              cc.addChild = cc[ORIG_ADD_CHILD];
              cc[PATCHED_LISTING] = false;
              cc[ORIG_ADD_CHILD] = undefined;
            }
          }
        }

        const ANIM_INTERVAL = Symbol.for("splashscreen:animInterval");
        const DEBOUNCE_TIMER = Symbol.for("splashscreen:debounceTimer");
        for (const child of uiTui.children) {
          const cc = child as any;
          if (cc[ANIM_INTERVAL]) clearInterval(cc[ANIM_INTERVAL]);
          if (cc[DEBOUNCE_TIMER]) clearTimeout(cc[DEBOUNCE_TIMER]);
        }
        for (const topChild of uiTui.children) {
          const tc = topChild as any;
          if (!tc.children) continue;
          for (const child of tc.children) {
            const cc = child as any;
            if (cc[ANIM_INTERVAL]) clearInterval(cc[ANIM_INTERVAL]);
            if (cc[DEBOUNCE_TIMER]) clearTimeout(cc[DEBOUNCE_TIMER]);
          }
        }
      } catch {
        /* TUI structure may have changed — ignore */
      }
    }
  });

  // session_start handler
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    uiCtx = ctx;

    const config = loadUIConfig();
    const toolStyle = normalizeToolStyle(config.toolStyle);

    // Master gate: `Minimal` = archimedes tool styling (the per-tool
    // toggles fine-tune it); `Native` = no archimedes tool styling at all
    // — the overrides are not registered, so pi's native tool rendering
    // stands (and no built-in-takeover startup notice).
    if (toolStyle === "Minimal") {
      if (config.bashToolStyling !== false) {
        registerBashToolOverride(pi, ctx.cwd);
      }

      // The codemode override replaces pi's built-in codemode extension
      // (the same take-over the bash override does for the core bash
      // tool). It loads the native definition from the running CLI and
      // swaps in the Archimedes renderers; it is a no-op on pi versions
      // without the codemode extension.
      if (config.codemodeToolStyling !== false) {
        void registerCodemodeToolOverride(pi);
      }
    }

    if (ctx.hasUI) {
      spinFlag = config.editorSpinBorder;

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
      const headerFactory = (tui: TUI, theme: Theme): Component & { dispose?(): void } => {
        uiTui = tui;
        // The splash animation and the startup resource listing both append
        // into terminal scrollback, which fullscreen screen does not have —
        // so they install on regular screen only (ADR 0027). The question is
        // asked of the renderer we were just handed, every call: screen mode
        // is mutable mid-session (`switchTuiMode()` rebuilds the TUI and
        // re-invokes this factory), so caching the answer would keep the old
        // screen's policy. Header replacement itself stays on every screen.
        const caps = screenCapabilities(screenMode(tui));
        const comp: Component & { dispose?(): void } = {
          invalidate(): void {},
          render(width: number): string[] {
            // Regular screen: sized to the terminal the splash scrolls
            // through. Frame-bounded screen: the viewport owns the height, so
            // the header gets its content and nothing more — padded to the
            // terminal it would be the whole viewport, editor excluded.
            const height = caps.frameBounded ? CONTENT_ONLY_HEIGHT : tui.terminal.rows - 3;
            return renderHeader(theme, ref, width, height);
          },
        };
        if (caps.transcriptWrite) {
          patchStartupListing(tui, theme, ref);
        } else {
          // Suppressing the splash is not the same as leaving it mid-flight:
          // nothing here advances the ref, so start it where an animation
          // would have left it rather than at frame 0 (an invisible logo on a
          // truecolor terminal, no version rows, forever).
          settleHeader(ref);
        }
        return comp;
      };
      ctx.ui.setHeader(headerFactory);

      clearSpinInterval();
      ctx.ui.setWorkingVisible(!spinFlag);

      if (spinFlag) {
        // The border spinner lives in the editor frame, not in scrollback, so
        // it runs on either screen. The renderer is handed straight to the
        // editor and never kept by us, and idleness is read from `ctx` rather
        // than from the renderer, so a screen-mode switch cannot strand it.
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
