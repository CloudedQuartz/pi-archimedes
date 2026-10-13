import { describe, it, expect } from "vitest";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth as tuiVisibleWidth } from "@earendil-works/pi-tui";
import {
  visibleWidth,
  padEnd,
  wrapText,
  hardTruncate,
  renderHeader,
  renderFooter,
  wrapWithBorder,
  borderContentWidth,
  OVERLAY_CHROME,
  type OverlayTheme,
} from "./overlay.js";

// Mock theme: fg returns its text argument untouched.
const mockTheme: OverlayTheme = {
  fg: (_color: string, text: string) => text,
};

// Mock theme that records the color token passed to fg.
function recordingTheme() {
  let lastColor: string | null = null;
  const theme: OverlayTheme = {
    fg: (color: string, text: string) => {
      lastColor = color;
      return text;
    },
  };
  return { theme, lastColor: () => lastColor };
}

// ── visibleWidth ─────────────────────────────────────────────────────────────

describe("visibleWidth", () => {
  it("counts a plain string", () => {
    expect(visibleWidth("hello")).toBe(5);
  });

  it("ignores ANSI SGR codes", () => {
    expect(visibleWidth("\x1b[31mred\x1b[0m")).toBe(3);
  });

  it("returns 0 for empty string", () => {
    expect(visibleWidth("")).toBe(0);
  });
});

// ── padEnd ───────────────────────────────────────────────────────────────────

describe("padEnd", () => {
  it("pads to width", () => {
    expect(padEnd("hi", 5)).toBe("hi   ");
  });

  it("leaves a line that already fits untouched", () => {
    expect(padEnd("hello", 5)).toBe("hello");
  });

  it("clips a line wider than the target instead of letting it overflow", () => {
    // The frame is a hard limit: a padded row must never measure past it, or
    // the closing border lands off-screen and the terminal hard-wraps the row.
    expect(visibleWidth(padEnd("toolong", 5))).toBe(5);
  });

  it("returns '' for width <= 0", () => {
    expect(padEnd("text", 0)).toBe("");
    expect(padEnd("text", -3)).toBe("");
  });
});

// ── wrapText ─────────────────────────────────────────────────────────────────

describe("wrapText", () => {
  it("wraps a long line to width", () => {
    expect(wrapText("aaa bbb ccc ddd", 8)).toEqual(["aaa bbb", "ccc ddd"]);
  });

  it("wraps long words to width", () => {
    expect(wrapText("hello world", 5)).toEqual(["hello", "world"]);
  });

  it("preserves empty paragraphs as blank lines", () => {
    expect(wrapText("one\n\ntwo", 10)).toEqual(["one", "", "two"]);
  });

  it("returns [] for width <= 0", () => {
    expect(wrapText("anything", 0)).toEqual([]);
  });
});

// ── hardTruncate ─────────────────────────────────────────────────────────────

describe("hardTruncate", () => {
  it("leaves short strings alone", () => {
    expect(hardTruncate("short", 10)).toBe("short");
  });

  it("truncates at the visible-width boundary", () => {
    // pi-tui closes any styling it cut into, so the visible text — not the raw
    // bytes — is the contract.
    expect(stripTerminalSequences(hardTruncate("hello world", 5))).toBe("hello");
    expect(visibleWidth(hardTruncate("hello world", 5))).toBe(5);
  });

  it("truncates an ANSI-colored string and appends a reset", () => {
    const result = hardTruncate("\x1b[31mhello world\x1b[0m", 5);
    expect(result).toBe("\x1b[31mhello\x1b[0m");
    expect(result).toContain("\x1b[0m");
  });
});

// ── Terminal-hostile content ────────────────────────────────────────────────
//
// Every measurement in this module used to be `.length` after stripping only
// `\x1b[…m`. That is wrong for the three things the real overlays actually
// print: pi's cursor marker (an APC sequence, zero columns wide), OSC 8
// hyperlinks (a URL is invisible but enormous), and east-asian text (two
// columns per character). Each case below is measured with pi-tui's own
// `visibleWidth`, i.e. what the terminal draws.

describe("width maths on terminal-hostile content", () => {
  it("measures a line carrying the real CURSOR_MARKER at its visible width", () => {
    const line = `Search: plan${CURSOR_MARKER}`;
    expect(visibleWidth(line)).toBe("Search: plan".length);
    // The row this feeds must still land on exactly the target column: the
    // marker occupies no cells, so the padding has to make up all of them.
    expect(visibleWidth(padEnd(line, 20))).toBe(20);
  });

  it("returns an OSC 8 hyperlink that already fits byte-for-byte", () => {
    const url = `https://example.com/${"a".repeat(40)}`;
    const line = `\x1b]8;;${url}\x07docs\x1b]8;;\x07`;
    // 4 visible columns at a limit of 4: the no-cut path. pi-tui hands the input
    // straight back, which is what makes a fitting row render identically to the
    // old chrome. This is NOT the cutting case — see the next test.
    expect(visibleWidth(line)).toBe(4);
    expect(hardTruncate(line, 4)).toBe(line);
  });

  it("cuts inside an OSC 8 hyperlink without leaving a half-written sequence", () => {
    const url = `https://example.com/${"a".repeat(40)}`;
    const line = `\x1b]8;;${url}\x07documentation\x1b]8;;\x07`; // 13 visible columns
    expect(visibleWidth(line)).toBe(13);
    const cut = hardTruncate(line, 4);
    // The cut really happened: four columns of the linked text survive.
    expect(tuiVisibleWidth(cut)).toBe(4);
    expect(stripTerminalSequences(cut)).toBe("docu");
    // The URL stays inside its escape sequence and every OSC 8 opener is
    // terminated — a half-written OSC swallows the rest of the row, which is how
    // the old byte-walking truncator failed here (it produced the 3-column stub
    // "\x1b]8;" for this exact input, with no BEL and no closing sequence).
    const opens = cut.match(/\x1b\]8;;/g) ?? [];
    const terminated = cut.match(/\x1b\]8;;[^\x07]*\x07/g) ?? [];
    expect(opens.length).toBeGreaterThan(0);
    expect(terminated.length).toBe(opens.length);
    // And the cut emits an explicit hyperlink close plus a reset, so the styling
    // and the link target cannot bleed into the padding and the closing border.
    expect(cut).toContain("\x1b]8;;\x07");
    expect(cut.endsWith("\x1b[0m")).toBe(true);
  });

  it("wraps a CJK line at the right column", () => {
    const lines = wrapText("日本語のテキストです", 6);
    expect(lines).toEqual(["日本語", "のテキ", "ストで", "す"]);
    for (const line of lines) {
      expect(tuiVisibleWidth(line)).toBeLessThanOrEqual(6);
    }
  });

  it("keeps an SGR colour across a wrap", () => {
    const lines = wrapText("\x1b[31mred word and more words\x1b[0m", 8);
    expect(lines.map((l) => stripTerminalSequences(l))).toEqual([
      "red word",
      "and more",
      "words",
    ]);
    // Each continuation line re-opens the colour, so the wrap does not spill
    // red onto whatever the surface prints next.
    for (const line of lines) {
      expect(line).toContain("\x1b[31m");
      expect(tuiVisibleWidth(line)).toBeLessThanOrEqual(8);
    }
  });
});

// ── renderHeader / renderFooter ──────────────────────────────────────────────

describe("renderHeader", () => {
  it("pads to width and renders with the accent token", () => {
    const { theme, lastColor } = recordingTheme();
    const out = renderHeader(" Title ", 10, theme);
    expect(out).toBe(" Title    ");
    expect(lastColor()).toBe("accent");
  });
});

describe("renderFooter", () => {
  it("pads to width and renders with the dim token", () => {
    const { theme, lastColor } = recordingTheme();
    const out = renderFooter(" hint ", 10, theme);
    expect(out).toBe(" hint     ");
    expect(lastColor()).toBe("dim");
  });
});

// ── wrapWithBorder / borderContentWidth ──────────────────────────────────────

describe("borderContentWidth", () => {
  it("derives content width from outer width", () => {
    expect(borderContentWidth(84)).toBe(80);
  });

  it("floors at 1 for tiny widths", () => {
    expect(borderContentWidth(0)).toBe(1);
    expect(borderContentWidth(2)).toBe(1);
  });
});

describe("wrapWithBorder", () => {
  const W = 84;

  it("emits border rows with the correct shape", () => {
    const out = wrapWithBorder(["a", "b"], W, mockTheme);
    expect(out[0]).toBe("┌" + "─".repeat(W - 2) + "┐");
    expect(out[out.length - 1]).toBe("└" + "─".repeat(W - 2) + "┘");
    expect(out[1]).toBe("│ a" + " ".repeat(W - 4) + "│");
    expect(out[2]).toBe("│ b" + " ".repeat(W - 4) + "│");
  });

  it("emits exactly lines.length + 2 rows", () => {
    const out = wrapWithBorder(["a", "b", "c"], W, mockTheme);
    expect(out.length).toBe(5);
  });

  it("pads every row to exactly the outer width", () => {
    const out = wrapWithBorder(["x", "shorter", "y"], W, mockTheme);
    for (const line of out) {
      expect(visibleWidth(line)).toBe(W);
    }
  });

  it("hard-truncates content wider than the content width, without overflowing", () => {
    const long = "z".repeat(W + 10); // wider than the 80-col content area
    const out = wrapWithBorder([long], W, mockTheme);
    expect(out.length).toBe(3);
    for (const line of out) {
      expect(visibleWidth(line)).toBe(W);
    }
    // Asserted on visible text, not bytes: closing the truncation appends a
    // zero-width reset, which is what keeps the style from bleeding into the
    // padding and the closing border.
    expect(stripTerminalSequences(out[1]!)).toBe("│ " + "z".repeat(W - 4) + " │");
  });
});

// ── OVERLAY_CHROME ───────────────────────────────────────────────────────────

describe("OVERLAY_CHROME", () => {
  it("matches the /agents overlay options", () => {
    expect(OVERLAY_CHROME).toEqual({
      anchor: "center",
      width: 84,
      maxHeight: "80%",
    });
  });
});

// ── Frame-width audit ────────────────────────────────────────────────────────
//
// The automated stand-in for a `PI_TUI_WRITE_LOG` capture: render the chrome the
// way the overlay surfaces do, measure every produced line with pi-tui's own
// `visibleWidth` (what the terminal actually draws), and require it to fit the
// frame. A line wider than the frame is not a cosmetic defect — the terminal
// hard-wraps it, which shoves the closing border onto the next row and shifts
// every row below it.
//
// The same audit runs per surface where that surface lives (the agents panel in
// @pi-archimedes/subagent, the settings/onboarding overlays in meta), so the
// numbers below are the chrome's share of the measurement.

/** Hostile content, one entry per failure mode of the old `.length` maths. */
function hostileLines(theme: OverlayTheme): string[] {
  const url = `https://example.com/${"segment/".repeat(12)}`;
  return [
    // real pi cursor marker (APC: ESC _ … BEL) — zero columns wide
    `Search: wide-query${CURSOR_MARKER}`,
    // OSC 8 hyperlink — long invisible payload, short visible text
    `docs: \x1b]8;;${url}\x07readme\x1b]8;;\x07 tail`,
    // east-asian text — two columns per code unit
    "設定パネルの横幅の測定を検証するための日本語テキスト",
    // SGR-coloured runs
    theme.fg("accent", "accent run ") + theme.fg("dim", "dim run ") + "tail",
    // all three at once, wider than any frame
    theme.fg("error", "✗ " + "失敗".repeat(40)) + `\x1b]8;;${url}\x07link\x1b]8;;\x07` + CURSOR_MARKER,
  ];
}

interface AuditViolation {
  surface: string;
  frameWidth: number;
  row: number;
  measured: number;
}

/**
 * Measure every produced line against the frame. Returns one entry per line
 * that overflows (or, for a bordered frame, fails to land on it exactly).
 */
function auditFrameWidth(
  surface: string,
  frameWidth: number,
  lines: string[],
  bordered: boolean,
): AuditViolation[] {
  const violations: AuditViolation[] = [];
  lines.forEach((line, row) => {
    const measured = tuiVisibleWidth(line);
    const bad = bordered ? measured !== frameWidth : measured > frameWidth;
    if (bad) violations.push({ surface, frameWidth, row, measured });
  });
  return violations;
}

describe("frame-width audit (overlay chrome)", () => {
  const FRAME_WIDTHS = [40, 60, 84, 100];

  it("renders chrome inside the frame at every width, for hostile content", () => {
    const violations: AuditViolation[] = [];
    const content = hostileLines(mockTheme);

    for (const frameWidth of FRAME_WIDTHS) {
      const contentWidth = borderContentWidth(frameWidth);
      // Composed the way the real surfaces compose it: header + padded body
      // rows (some wrapped) + footer, then the border.
      const body = content.flatMap((line) => wrapText(line, contentWidth));
      const lines = [
        renderHeader(" Settings ", contentWidth, mockTheme),
        ...body.map((line) => padEnd(line, contentWidth)),
        renderFooter(" [esc] close ", contentWidth, mockTheme),
      ];
      violations.push(
        ...auditFrameWidth("chrome", frameWidth, wrapWithBorder(lines, frameWidth, mockTheme), true),
      );
    }

    expect(
      violations,
      `${violations.length} chrome line(s) overflow the frame: ` +
        violations.slice(0, 8).map((v) => `w=${v.frameWidth} row=${v.row} measured=${v.measured}`).join(", "),
    ).toEqual([]);
  });
});
