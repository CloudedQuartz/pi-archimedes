import { isViewportTUI } from "@earendil-works/pi-tui";

// ── Screen mode (ADR 0027) ──────────────────────────────────────────────────
//
// Pi 1.0.0 made fullscreen screen the default `tuiMode`: components render
// into a clipped, height-allocated, wheel-routed viewport instead of terminal
// scrollback. Screen mode is also mutable mid-session — `switchTuiMode()`
// stops the running TUI, builds a new one and re-mounts every child — so the
// only trustworthy answer is the renderer instance currently in hand. Nothing
// here holds on to one.

export type ScreenMode = "regular" | "fullscreen";

/**
 * Which screen the given renderer draws into.
 *
 * Ask the renderer we were just handed. Never store the result or the `tui`:
 * a retained renderer is a stopped renderer after a `tuiMode` switch, and it
 * accepts every write without throwing.
 */
export function screenMode(tui: object): ScreenMode {
  return isViewportTUI(tui as never) ? "fullscreen" : "regular";
}

export interface ScreenCapabilities {
  /** May append into terminal scrollback. Off on fullscreen screen. */
  transcriptWrite: boolean;
  /** Must fit an allocated, wheel-routed viewport. On fullscreen screen. */
  frameBounded: boolean;
}

/**
 * The policy a screen mode implies. Takes the mode, not the renderer, so the
 * table is unit-testable: pi-tui does not export the viewport marker, so a
 * test cannot fabricate a viewport TUI to ask.
 *
 * These two are the only capabilities that differ between the screens today —
 * add one here when a second real difference shows up, never ad hoc in a
 * component.
 */
export function screenCapabilities(mode: ScreenMode): ScreenCapabilities {
  return mode === "fullscreen"
    ? { transcriptWrite: false, frameBounded: true }
    : { transcriptWrite: true, frameBounded: false };
}
