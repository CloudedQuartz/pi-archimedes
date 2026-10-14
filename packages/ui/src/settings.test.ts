import { describe, it, expect } from "vitest";
import { getUISettingsItems } from "./settings.js";
import { DEFAULT_UI_CONFIG, ANIMATION_STYLES, type UIConfig } from "./config.js";

describe("getUISettingsItems", () => {
  it("exposes all 16 UI setting items with correct defaults", () => {
    const items = getUISettingsItems(DEFAULT_UI_CONFIG);
    expect(items).toHaveLength(16);

    const ids = items.map((i) => i.id);
    expect(ids).toEqual([
      "bashToolStyling",
      "codemodeToolStyling",
      "mutedTheme",
      "autoCollapseThinking",
      "thinkingStyle",
      "toolStyle",
      "codeUnindent",
      "labelText",
      "labelColor",
      "startupSplash",
      "animationStyle",
      "colorfulLogo",
      "editorSpinBorder",
      "editorSpinSpeed",
      "editorSpinStyle",
      "editorSpinLabel",
    ]);

    expect(items.find((i) => i.id === "bashToolStyling")?.currentValue).toBe("On");
    expect(items.find((i) => i.id === "codemodeToolStyling")?.currentValue).toBe("On");
    expect(items.find((i) => i.id === "mutedTheme")?.currentValue).toBe("Off");
    expect(items.find((i) => i.id === "autoCollapseThinking")?.currentValue).toBe("Off");
    expect(items.find((i) => i.id === "thinkingStyle")?.currentValue).toBe("Full");
    expect(items.find((i) => i.id === "toolStyle")?.currentValue).toBe("Minimal");
    expect(items.find((i) => i.id === "codeUnindent")?.currentValue).toBe("On");
    expect(items.find((i) => i.id === "labelText")?.currentValue).toBe("Thinking...");
    expect(items.find((i) => i.id === "labelColor")?.currentValue).toBe("255,215,0");
    expect(items.find((i) => i.id === "startupSplash")?.currentValue).toBe("Off");
    expect(items.find((i) => i.id === "animationStyle")?.currentValue).toBe("vertical-up");
    expect(items.find((i) => i.id === "editorSpinBorder")?.currentValue).toBe("On");
    expect(items.find((i) => i.id === "editorSpinSpeed")?.currentValue).toBe("Normal");
    expect(items.find((i) => i.id === "editorSpinStyle")?.currentValue).toBe("Pendulum");
    expect(items.find((i) => i.id === "editorSpinLabel")?.currentValue).toBe("Working");
  });

  it("exposes bashToolStyling correctly when toggled off", () => {
    const items = getUISettingsItems({ ...DEFAULT_UI_CONFIG, bashToolStyling: false });
    const item = items.find((i) => i.id === "bashToolStyling");
    expect(item).toBeDefined();
    expect(item!.currentValue).toBe("Off");
    expect(item!.values).toEqual(["On", "Off"]);
  });

  it("exposes codemodeToolStyling correctly when toggled off", () => {
    const items = getUISettingsItems({ ...DEFAULT_UI_CONFIG, codemodeToolStyling: false });
    const item = items.find((i) => i.id === "codemodeToolStyling");
    expect(item).toBeDefined();
    expect(item!.currentValue).toBe("Off");
    expect(item!.values).toEqual(["On", "Off"]);
  });

  it("exposes thinkingStyle and toolStyle with their values and normalizes invalid values", () => {
    const items = getUISettingsItems({ ...DEFAULT_UI_CONFIG, thinkingStyle: "invalid" as never });
    const thinkingItem = items.find((i) => i.id === "thinkingStyle");
    expect(thinkingItem).toBeDefined();
    expect(thinkingItem!.currentValue).toBe("Full");
    expect(thinkingItem!.values).toEqual(["Full", "Compact"]);

    const toolItem = items.find((i) => i.id === "toolStyle");
    expect(toolItem).toBeDefined();
    expect(toolItem!.currentValue).toBe("Minimal");
    expect(toolItem!.values).toEqual(["Native", "Minimal"]);
  });

  it("normalizes legacy toolStyle values (Full → Minimal, Compact → Minimal)", () => {
    expect(
      getUISettingsItems({ ...DEFAULT_UI_CONFIG, toolStyle: "Full" as never })
        .find((i) => i.id === "toolStyle")?.currentValue,
    ).toBe("Minimal");
    expect(
      getUISettingsItems({ ...DEFAULT_UI_CONFIG, toolStyle: "Compact" as never })
        .find((i) => i.id === "toolStyle")?.currentValue,
    ).toBe("Minimal");
  });

  it("exposes animationStyle with ANIMATION_STYLES values", () => {
    const item = getUISettingsItems(DEFAULT_UI_CONFIG).find((i) => i.id === "animationStyle");
    expect(item?.values).toEqual([...ANIMATION_STYLES]);
  });

  // The splash is opt-in, so the row has to read as an opt-in to a human: a
  // label that names the splash, and an `Off` default matching the config.
  it("offers the startup splash as a human-readable On/Off row, off by default", () => {
    const off = getUISettingsItems(DEFAULT_UI_CONFIG).find((i) => i.id === "startupSplash");
    expect(off).toBeDefined();
    expect(off!.label).toBe("Startup Splash");
    expect(off!.description).toMatch(/splash/i);
    expect(off!.values).toEqual(["On", "Off"]);
    expect(off!.currentValue).toBe("Off");

    const on = getUISettingsItems({ ...DEFAULT_UI_CONFIG, startupSplash: true }).find(
      (i) => i.id === "startupSplash",
    );
    expect(on!.currentValue).toBe("On");
  });

  describe("robustness with hand-edited (corrupt) values", () => {
    it("an empty-string editorSpinSpeed projects to 'Normal'", () => {
      const items = getUISettingsItems({
        ...DEFAULT_UI_CONFIG,
        editorSpinSpeed: "" as never,
      });
      expect(items.find((i) => i.id === "editorSpinSpeed")?.currentValue).toBe("Normal");
    });

    it("a number editorSpinSpeed projects to 'Normal'", () => {
      const items = getUISettingsItems({
        ...DEFAULT_UI_CONFIG,
        editorSpinSpeed: 42 as never,
      });
      expect(items.find((i) => i.id === "editorSpinSpeed")?.currentValue).toBe("Normal");
    });

    it("a trailing-dash editorSpinStyle projects without throwing", () => {
      const items = getUISettingsItems({
        ...DEFAULT_UI_CONFIG,
        editorSpinStyle: "wave-" as never,
      });
      expect(items.find((i) => i.id === "editorSpinStyle")?.currentValue).toBe("Wave");
    });

    it("a null editorSpinStyle projects to 'Typing'", () => {
      const items = getUISettingsItems({
        ...DEFAULT_UI_CONFIG,
        editorSpinStyle: null as never,
      });
      expect(items.find((i) => i.id === "editorSpinStyle")?.currentValue).toBe("Typing");
    });

    // `startupSplash` is read strictly by the gate (`config.startupSplash === true`,
    // `index.ts`), so a hand-edited `"true"` or `1` means OFF on screen. The row
    // has to answer with the same reading — a row saying `On` over a session that
    // draws pi's own startup is the panel promising something that never arrives.
    it("a startupSplash that is not the literal true projects to 'Off', like the gate reads it", () => {
      for (const value of ["true", 1, "yes", {}, null]) {
        const items = getUISettingsItems({
          ...DEFAULT_UI_CONFIG,
          startupSplash: value as never,
        });
        expect(
          items.find((i) => i.id === "startupSplash")?.currentValue,
          `startupSplash=${String(value)}`,
        ).toBe("Off");
      }
    });
  });
});
