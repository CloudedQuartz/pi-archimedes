import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@pi-archimedes/core/settings-io", () => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  readEffectiveSettings: vi.fn(),
}));

import {
  loadUIConfig,
  saveUIConfig,
  readQuietStartup,
  DEFAULT_UI_CONFIG,
  ANIMATION_STYLES,
  THINKING_STYLE_VALUES,
  TOOL_STYLE_VALUES,
  SPINNER_STYLES,
  normalizeThinkingStyle,
  normalizeToolStyle,
  SPIN_SPEED_MULT,
} from "./config.js";
import { loadConfig, saveConfig, readEffectiveSettings } from "@pi-archimedes/core/settings-io";

describe("loadUIConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses correct namespace archimedes.ui", () => {
    vi.mocked(loadConfig).mockReturnValue(DEFAULT_UI_CONFIG);
    loadUIConfig();
    expect(loadConfig).toHaveBeenCalledWith("archimedes.ui", DEFAULT_UI_CONFIG);
  });

  it("returns default config when no settings exist", () => {
    vi.mocked(loadConfig).mockReturnValue(DEFAULT_UI_CONFIG);
    const result = loadUIConfig();
    expect(result).toEqual({
      bashToolStyling: true,
      codemodeToolStyling: true,
      mutedTheme: false,
      autoCollapseThinking: false,
      thinkingStyle: "Full",
      toolStyle: "Minimal",
      codeUnindent: true,
      labelText: "Thinking...",
      labelColor: "255,215,0",
      startupSplash: false,
      animationStyle: "vertical-up",
      colorfulLogo: false,
      editorSpinBorder: true,
      editorSpinSpeed: "normal",
      editorSpinLabel: "Working",
      editorSpinStyle: "pendulum",
    });
  });

  it("passes through merged config from settings-io", () => {
    const merged = { ...DEFAULT_UI_CONFIG, bashToolStyling: false };
    vi.mocked(loadConfig).mockReturnValue(merged);
    const result = loadUIConfig();
    expect(result).toEqual(merged);
  });
});

describe("saveUIConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves with correct namespace archimedes.ui", () => {
    saveUIConfig(DEFAULT_UI_CONFIG);
    expect(saveConfig).toHaveBeenCalledWith("archimedes.ui", DEFAULT_UI_CONFIG);
  });

  it("passes config through unchanged", () => {
    const config = { ...DEFAULT_UI_CONFIG, bashToolStyling: false };
    saveUIConfig(config);
    expect(saveConfig).toHaveBeenCalledWith("archimedes.ui", config);
  });

  // The splash toggle is saved by the same whole-object write as every other UI
  // key, so `/archimedes` turning it on reaches settings.json as
  // `archimedes.ui.startupSplash` — nothing strips an unknown key on the way.
  it("persists startupSplash under archimedes.ui", () => {
    const config = { ...DEFAULT_UI_CONFIG, startupSplash: true };
    saveUIConfig(config);
    expect(saveConfig).toHaveBeenCalledWith(
      "archimedes.ui",
      expect.objectContaining({ startupSplash: true }),
    );
  });
});

describe("DEFAULT_UI_CONFIG", () => {
  it("has bashToolStyling and codemodeToolStyling enabled by default along with core defaults", () => {
    expect(DEFAULT_UI_CONFIG).toEqual({
      bashToolStyling: true,
      codemodeToolStyling: true,
      mutedTheme: false,
      autoCollapseThinking: false,
      thinkingStyle: "Full",
      toolStyle: "Minimal",
      codeUnindent: true,
      labelText: "Thinking...",
      labelColor: "255,215,0",
      startupSplash: false,
      animationStyle: "vertical-up",
      colorfulLogo: false,
      editorSpinBorder: true,
      editorSpinSpeed: "normal",
      editorSpinLabel: "Working",
      editorSpinStyle: "pendulum",
    });
  });

  // The maintainer's call on the startup splash: keep the code, flip the
  // default. pi's own startup is what a fresh install sees.
  it("leaves the startup splash off, so pi's own startup is the default", () => {
    expect(DEFAULT_UI_CONFIG.startupSplash).toBe(false);
  });

  it("exposes a speed→multiplier map (slow/normal/fast = 1.5/1/0.6)", () => {
    expect(SPIN_SPEED_MULT).toEqual({ slow: 1.5, normal: 1, fast: 0.6 });
  });
});

describe("ANIMATION_STYLES", () => {
  it("contains all expected styles", () => {
    expect(ANIMATION_STYLES).toEqual([
      "diagonal",
      "top-right",
      "bottom-left",
      "bottom-right",
      "center-out",
      "wave",
      "horizontal",
      "vertical",
      "vertical-up",
    ]);
  });
});

describe("DEFAULT_UI_CONFIG styles", () => {
  it("defaults thinkingStyle to Full and toolStyle to Minimal", () => {
    expect(DEFAULT_UI_CONFIG.thinkingStyle).toBe("Full");
    expect(DEFAULT_UI_CONFIG.toolStyle).toBe("Minimal");
  });
});

describe("style value lists", () => {
  it("exports the thinking and tool style values", () => {
    expect(THINKING_STYLE_VALUES).toEqual(["Full", "Compact"]);
    expect(TOOL_STYLE_VALUES).toEqual(["Native", "Minimal"]);
  });
});

describe("SPINNER_STYLES", () => {
  it("contains the 10 editorSpinStyle values in order", () => {
    expect(SPINNER_STYLES).toEqual([
      "typing",
      "pulse",
      "rain",
      "cascade",
      "columns",
      "wave-rows",
      "diagonal-swipe",
      "sparkle",
      "pendulum",
      "marquee",
    ]);
  });
});

describe("normalizeThinkingStyle", () => {
  it("normalizes current values as-is", () => {
    expect(normalizeThinkingStyle("Full")).toBe("Full");
    expect(normalizeThinkingStyle("Compact")).toBe("Compact");
  });

  it("maps legacy Off to Full", () => {
    expect(normalizeThinkingStyle("Off")).toBe("Full");
  });

  it("maps legacy N-lines values to Compact", () => {
    expect(normalizeThinkingStyle("1 line")).toBe("Compact");
    expect(normalizeThinkingStyle("3 lines")).toBe("Compact");
    expect(normalizeThinkingStyle("5 lines")).toBe("Compact");
  });

  it("normalizes invalid / unknown / non-string values to Full", () => {
    expect(normalizeThinkingStyle(undefined)).toBe("Full");
    expect(normalizeThinkingStyle(null)).toBe("Full");
    expect(normalizeThinkingStyle("")).toBe("Full");
    expect(normalizeThinkingStyle(123)).toBe("Full");
    expect(normalizeThinkingStyle(true)).toBe("Full");
    expect(normalizeThinkingStyle("off")).toBe("Full");
    expect(normalizeThinkingStyle("2 lines")).toBe("Full");
  });
});

describe("normalizeToolStyle", () => {
  it("normalizes current values as-is", () => {
    expect(normalizeToolStyle("Native")).toBe("Native");
    expect(normalizeToolStyle("Minimal")).toBe("Minimal");
  });

  it("maps legacy Full (dropped auto-expand) to Minimal", () => {
    expect(normalizeToolStyle("Full")).toBe("Minimal");
  });

  it("maps legacy Compact to Minimal (the upgrade keeps styling)", () => {
    expect(normalizeToolStyle("Compact")).toBe("Minimal");
  });

  it("normalizes invalid / unknown / non-string values to Minimal", () => {
    expect(normalizeToolStyle(undefined)).toBe("Minimal");
    expect(normalizeToolStyle(null)).toBe("Minimal");
    expect(normalizeToolStyle("")).toBe("Minimal");
    expect(normalizeToolStyle(123)).toBe("Minimal");
    expect(normalizeToolStyle(true)).toBe("Minimal");
  });
});

// ── readQuietStartup ─────────────────────────────────────────────────
//
// pi 1.x's `quietStartup` is what decides how much of the startup screen the
// splash may draw: `false` = header + details, `"header"` = header alone,
// `true` = nothing. These are pi's own semantics, mirrored — a value that is
// not one of the three (including an absent key, whose pi default is `false`)
// reads as `false`.

describe("readQuietStartup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const answering = (settings: unknown) => {
    vi.mocked(readEffectiveSettings).mockReturnValue(settings as Record<string, unknown>);
    return readQuietStartup({});
  };

  it("reads each of the three values pi accepts", () => {
    expect(answering({ quietStartup: false })).toBe(false);
    expect(answering({ quietStartup: true })).toBe(true);
    expect(answering({ quietStartup: "header" })).toBe("header");
  });

  it("reads false when the key is absent or unusable", () => {
    expect(answering({})).toBe(false);
    expect(answering({ quietStartup: "false" })).toBe(false);
    expect(answering({ quietStartup: 0 })).toBe(false);
    expect(answering({ quietStartup: null })).toBe(false);
  });

  it("passes the pi handle through — getSettings() lives on ExtensionAPI, not the context", () => {
    const pi = {};
    vi.mocked(readEffectiveSettings).mockReturnValue({});
    readQuietStartup(pi);
    expect(readEffectiveSettings).toHaveBeenCalledWith(pi);
  });
});
