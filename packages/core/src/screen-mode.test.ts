import { describe, it, expect } from "vitest";
import { screenMode, screenCapabilities } from "./screen-mode.js";

// The renderer identity check is pi-tui's (`isViewportTUI` reads a symbol
// marker on the instance). A viewport TUI cannot be fabricated in a test —
// `VIEWPORT_TUI` is not exported — which is why `screenCapabilities()` takes
// the mode rather than the renderer: the capability table stays testable, and
// `screenMode()` keeps a single, one-line delegation to pi.

describe("screenMode", () => {
  it("reports regular screen for a renderer without the viewport marker", () => {
    expect(screenMode({})).toBe("regular");
  });

  it("reports regular screen for a renderer-shaped object that is not a viewport TUI", () => {
    expect(screenMode({ terminal: { rows: 24 }, children: [] })).toBe("regular");
  });
});

describe("screenCapabilities", () => {
  it("forbids scrollback writes and requires frame fitting on fullscreen screen", () => {
    expect(screenCapabilities("fullscreen")).toEqual({
      transcriptWrite: false,
      frameBounded: true,
    });
  });

  it("allows scrollback writes and no frame fitting on regular screen", () => {
    expect(screenCapabilities("regular")).toEqual({
      transcriptWrite: true,
      frameBounded: false,
    });
  });

  it("exposes exactly the two capabilities that differ between screens", () => {
    expect(Object.keys(screenCapabilities("regular")).sort()).toEqual([
      "frameBounded",
      "transcriptWrite",
    ]);
  });

  it("resolves the two capabilities inversely for every mode", () => {
    for (const mode of ["regular", "fullscreen"] as const) {
      const caps = screenCapabilities(mode);
      expect(caps.transcriptWrite).not.toBe(caps.frameBounded);
    }
  });
});
