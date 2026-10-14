/**
 * Task 11 item 4 — the inline note's caret is pi-tui's fake cursor, not a
 * hand-rolled reverse video.
 *
 * What pi-tui does with each shape (read from `dist/tui.js`):
 *
 *   renderFakeCursor(text) = FAKE_CURSOR_START + text + FAKE_CURSOR_END
 *                          = "\x1b_pi:fc\x07" … "\x1b_pi:/fc\x07"
 *
 * Both are zero-width APC sequences. `TUI.resolveFakeCursors()` turns them into
 * `\x1b[7m`/`\x1b[27m` when it draws the frame — and, when
 * `showHardwareCursor` is on, it first drops a fake cursor that sits directly
 * after `CURSOR_MARKER` (`FOCUSED_FAKE_CURSOR = /(\x1b_pi:c\x07)\x1b_pi:fc\x07(.*?)(?:\x1b_pi:\/fc\x07|$)/s`,
 * replaced with `$1$2`), because the terminal is already drawing a cursor there.
 *
 * That is why the raw escapes were wrong: `\x1b[7m` is not inside fake-cursor
 * markers, so `resolveFakeCursors` cannot see it and the frame carried the
 * inverted block *and* the hardware cursor — two cursors. `CURSOR_MARKER` on its
 * own was still emitted, so `extractCursorPosition()` still positioned the real
 * cursor; only the block was redundant.
 *
 * The `CURSOR_MARKER` half is unchanged and still conditional
 * (`includeHardwareCursorMarker`), and it must stay immediately before the fake
 * cursor for that drop to fire. Issue #100 (`CURSOR_MARKER` lost when a prompt
 * row is truncated) is a separate, still-open defect about the truncation paths;
 * nothing here fixes or worsens it — the width assertions below pin that.
 */

import { describe, it, expect } from "vitest";
import { CURSOR_MARKER, renderFakeCursor, visibleWidth } from "@earendil-works/pi-tui";
import {
  INLINE_NOTE_WRAP_PADDING,
  buildOptionLabelWithInlineNote,
  buildWrappedOptionLabelWithInlineNote,
} from "./note.js";

/** pi-tui's own markers, derived from the exported helper rather than re-typed. */
const fakeCursorCell = renderFakeCursor("x");
const FAKE_CURSOR_START = fakeCursorCell.slice(0, fakeCursorCell.indexOf("x"));
const FAKE_CURSOR_END = fakeCursorCell.slice(fakeCursorCell.indexOf("x") + 1);

const SEP = " — note: ";

describe("editing inline note caret", () => {
  it("wraps the caret character in pi-tui's fake cursor, not raw reverse video", () => {
    const label = buildOptionLabelWithInlineNote("Option", "ab", true, undefined, 1, true);
    expect(label).toBe(`Option${SEP}a${CURSOR_MARKER}${renderFakeCursor("b")}`);
    expect(label).not.toContain("\x1b[7m");
    expect(label).not.toContain("\x1b[27m");
  });

  it("puts the hardware-cursor marker directly before the fake cursor, which is the adjacency resolveFakeCursors matches", () => {
    const label = buildOptionLabelWithInlineNote("Option", "abc", true, undefined, 1, true);
    expect(label).toContain(`${CURSOR_MARKER}${FAKE_CURSOR_START}b${FAKE_CURSOR_END}`);
  });

  it("drops the hardware-cursor marker when the caller does not want it, and keeps the fake cursor", () => {
    const label = buildOptionLabelWithInlineNote("Option", "ab", true, undefined, 1, false);
    expect(label).not.toContain(CURSOR_MARKER);
    expect(label).toContain(`${FAKE_CURSOR_START}b${FAKE_CURSOR_END}`);
  });

  it("clamps the caret to the end of the note (unchanged behaviour)", () => {
    const label = buildOptionLabelWithInlineNote("Option", "ab", true, undefined, 9, true);
    expect(label).toBe(`Option${SEP}ab${CURSOR_MARKER}${renderFakeCursor(" ")}`);
  });

  it("draws a space for a caret past an empty note (unchanged behaviour)", () => {
    const label = buildOptionLabelWithInlineNote("Option", "", true, undefined, 0, true);
    expect(label).toBe(`Option${SEP}${CURSOR_MARKER}${renderFakeCursor(" ")}`);
  });

  it("splits before/after the caret across control characters rather than hiding them (unchanged behaviour)", () => {
    const label = buildOptionLabelWithInlineNote("Option", "a\tb", true, undefined, 1, true);
    expect(label).toBe(`Option${SEP}a${CURSOR_MARKER}${renderFakeCursor(" ")}b`);
  });
});

describe("non-editing inline note", () => {
  it("stays plain text — no cursor of either kind", () => {
    const label = buildOptionLabelWithInlineNote("Option", "  typed  ", false);
    expect(label).toBe(`Option${SEP}typed`);
    expect(label).not.toContain(CURSOR_MARKER);
    expect(label).not.toContain(FAKE_CURSOR_START);
  });

  it("adds nothing at all for an empty note on an option that is not being edited", () => {
    expect(buildOptionLabelWithInlineNote("Option", "   ", false)).toBe("Option");
  });
});

describe("truncation and wrapping with the fake cursor", () => {
  it("keeps the caret cell whole when the label fits, and counts the markers as zero width", () => {
    const label = buildOptionLabelWithInlineNote("Option", "abc", true, 200, 1, true);
    expect(label).toContain(`${CURSOR_MARKER}${FAKE_CURSOR_START}b${FAKE_CURSOR_END}`);
    // "Option — note: abc" — 18 visible columns, marker bytes invisible.
    expect(visibleWidth(label)).toBe(visibleWidth(`Option${SEP}abc`));
  });

  it("truncates from the head while editing, so the caret stays on screen", () => {
    const long = "x".repeat(60);
    const label = buildOptionLabelWithInlineNote("Option", long, true, 30, 59, true);
    expect(label.startsWith("…")).toBe(true);
    // The caret is at the very end of the note, so it survives the head cut.
    expect(label).toContain(`${FAKE_CURSOR_START}x${FAKE_CURSOR_END}`);
  });

  it("wraps to the requested width and keeps exactly one caret cell across the lines", () => {
    const long = "note text that is long enough to need wrapping here";
    const lines = buildWrappedOptionLabelWithInlineNote(
      "Option",
      long,
      true,
      40,
      INLINE_NOTE_WRAP_PADDING,
      20,
      true,
    );
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    const joined = lines.join("\n");
    expect(joined.split(`${FAKE_CURSOR_START}`).length - 1).toBe(1);
    expect(joined).toContain(CURSOR_MARKER);
  });
});
