/**
 * Shared overlay chrome — border wrapping, text width math, header/footer
 * rendering. Used by the /agents manager (subagent), the /archimedes settings
 * overlay and the /plugins + onboarding overlays (meta) so all of them look
 * identical.
 *
 * All terminal-width maths here is delegated to `@earendil-works/pi-tui`:
 * `visibleWidth` for measurement, `truncateToWidth` for cutting and padding,
 * `wrapTextWithAnsi` for word wrapping. `docs/tui.md` asks for exactly that,
 * and a local re-implementation cannot be right: measuring `.length` after
 * stripping only `\x1b[…m` counts pi's `CURSOR_MARKER` (an APC sequence) as
 * seven drawn columns, counts an OSC 8 hyperlink's URL as drawn text, and
 * counts a CJK glyph as one column when the terminal draws two. The exported
 * names below are the shared surface; only their bodies changed.
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Minimal structural theme — anything with `fg` satisfies it (the real pi-coding-agent Theme, agent-manager's local interface, or a test mock). */
export interface OverlayTheme {
  fg(token: string, text: string): string;
}

/**
 * Visible terminal columns of a string. pi-tui's measurement, re-exported so
 * every consumer shares one implementation: it ignores SGR, OSC (hyperlinks,
 * prompt titles) and APC (pi's cursor marker) and honours east-asian widths.
 */
export { visibleWidth };

/**
 * Word-wrap `text` to `width` visible columns, preserving ANSI styling across
 * the break. Delegates to pi-tui's `wrapTextWithAnsi`, so the break point is
 * chosen by drawn columns — wide characters count as two, escapes as zero — and
 * a word that cannot fit is broken rather than allowed to overflow.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  return wrapTextWithAnsi(text, width);
}

/**
 * Make `text` exactly `width` columns wide: pad with spaces when short, cut
 * when long. Delegates to `truncateToWidth` with an empty ellipsis, so a line
 * that was too long lands on the frame instead of hanging off it (the row is
 * never longer than `width`, which is what keeps the closing border on-screen).
 */
export function padEnd(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width, "", true);
}

export function renderHeader(text: string, width: number, theme: OverlayTheme): string {
  return theme.fg("accent", padEnd(text, width));
}

export function renderFooter(text: string, width: number, theme: OverlayTheme): string {
  return theme.fg("dim", padEnd(text, width));
}

/** Content width available inside wrapWithBorder at a given outer width.
 *  inner = max(1, width - 2); content = max(1, inner - 2). */
export function borderContentWidth(width: number): number {
  const innerWidth = Math.max(1, width - 2);
  return Math.max(1, innerWidth - 2);
}

/** Shared overlay options so /agents and /archimedes never drift. */
export const OVERLAY_CHROME = { anchor: "center", width: 84, maxHeight: "80%" } as const;

// ── Border wrapper ────────────────────────────────────────────────────────────

/**
 * Hard-truncate to `maxVisible` columns — no "..." suffix. pi-tui walks the
 * string by grapheme, so a cursor marker, an OSC 8 hyperlink or a wide glyph is
 * never cut in half; any styling the cut landed inside is closed, which also
 * stops it bleeding into the padding and the border.
 */
export function hardTruncate(text: string, maxVisible: number): string {
  return truncateToWidth(text, maxVisible, "");
}

export function wrapWithBorder(lines: string[], width: number, theme: OverlayTheme): string[] {
  const innerWidth = Math.max(1, width - 2);
  const contentWidth = Math.max(1, innerWidth - 2); // minus 1 space padding each side
  const left = theme.fg("dim", "│");
  const right = theme.fg("dim", "│");
  const top = theme.fg("dim", `┌${"─".repeat(innerWidth)}┐`);
  const bottom = theme.fg("dim", `└${"─".repeat(innerWidth)}┘`);
  const result: string[] = [top];
  for (const line of lines) {
    // One measured call truncates and pads, so the cell is exactly contentWidth
    // columns and every row lands on the frame width.
    const padded = padEnd(line, contentWidth);
    result.push(left + " " + padded + " " + right);
  }
  result.push(bottom);
  return result;
}
