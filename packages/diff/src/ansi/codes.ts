/** ANSI escape codes, constants, and interfaces. */

import { deriveBgFromTheme } from "./colors.js";

// ---------------------------------------------------------------------------
// ANSI escape codes
// ---------------------------------------------------------------------------

export const RST = "\x1b[0m";
export const FG_RST = "\x1b[39m"; // reset foreground only — safe inside background-painted lines
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";

// Diff foregrounds — hardcoded fallbacks
export const FG_ADD = "\x1b[38;2;100;180;120m"; // desaturated green
export const FG_DEL = "\x1b[38;2;200;100;100m"; // desaturated red
export const FG_DIM = "\x1b[38;2;80;80;80m";
export const FG_LNUM = "\x1b[38;2;100;100;100m";
export const FG_RULE = "\x1b[38;2;50;50;50m";
export const FG_SAFE_MUTED = "\x1b[38;2;139;148;158m";
export const FG_STRIPE = "\x1b[38;2;40;40;40m"; // gray diagonal stripes

export const BORDER_BAR = "▌";
/** Reset to the terminal's own background — "no background color", not a color. */
export const BG_DEFAULT = "\x1b[49m";

// ---------------------------------------------------------------------------
// DiffBg — instance-scoped background colors derived from a theme
// ---------------------------------------------------------------------------

/** All background colors needed for diff rendering, derived from a theme. */
export interface DiffBg {
	bgAdd: string;
	bgDel: string;
	bgAddW: string; // word-level emphasis
	bgDelW: string;
	bgGutterAdd: string;
	bgGutterDel: string;
	bgEmpty: string;
	bgBase: string; // tool box base bg
	rst: string; // reset + base bg
	divider: string;
}

/** Hardcoded fallback backgrounds. */
export const DEFAULT_DIFF_BG: DiffBg = {
	bgAdd: "\x1b[48;2;22;38;32m",
	bgDel: "\x1b[48;2;45;25;25m",
	bgAddW: "\x1b[48;2;35;75;50m",
	bgDelW: "\x1b[48;2;80;35;35m",
	bgGutterAdd: "\x1b[48;2;18;32;26m",
	bgGutterDel: "\x1b[48;2;38;22;22m",
	bgEmpty: "\x1b[48;2;18;18;18m",
	bgBase: BG_DEFAULT,
	rst: "\x1b[0m",
	divider: `${FG_RULE}│\x1b[0m`,
};

// Theme cache key state — lives here since it's used by resolveDiffColors.
let _lastThemeKey: string | undefined;

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

const ESC_RE = "\u001b";
export const ANSI_RE = new RegExp(`${ESC_RE}\\[[0-9;]*m`, "g");
export const ANSI_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([^m]*)m`, "g");
export const ANSI_PARAM_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([0-9;]*)m`, "g");

// ---------------------------------------------------------------------------
// DiffColors — foreground colors for diff signs
// ---------------------------------------------------------------------------

export interface DiffColors {
	fgAdd: string;
	fgDel: string;
	fgCtx: string;
}

export const DEFAULT_DIFF_COLORS: DiffColors = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };

// ---------------------------------------------------------------------------
// Theme-aware color resolution
// ---------------------------------------------------------------------------

/** Reset auto-derived colors — call when theme changes. */
export function resetDiffColors(): void {
	_lastThemeKey = undefined;
}

export function themeCacheKey(theme?: any): string {
	if (!theme?.fg) return "no-theme";
	const fgKeys = [
		"toolTitle", "accent", "muted", "success", "error",
		"toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
	];
	const bgKeys = ["toolSuccessBg", "toolErrorBg"];
	const parts: string[] = [];
	for (const key of fgKeys) {
		try { parts.push(theme.fg(key, key)); } catch { parts.push(key); }
	}
	for (const key of bgKeys) {
		try { parts.push(theme.bg ? theme.bg(key, key) : key); } catch { parts.push(key); }
	}
	return parts.join("|");
}

export { deriveBgFromTheme };

/**
 * Read one foreground token from a theme, or undefined when the theme has no
 * answer for it.
 *
 * A terminal-default answer is returned as-is. Since 0.99.0 a token set to `""`
 * comes back as `\x1b[39m` — truthy — so a `getFgAnsi(…) || FG_*` chain could
 * never fire for it, while the `""` shape that *did* fire it substituted a
 * hardcoded color where the theme had said "the terminal's own". Both readings
 * agree: a terminal default is an answer, and the hardcoded `FG_*` constants are
 * only for a theme that cannot answer at all.
 */
function themeFgAnsi(theme: any, token: string): string | undefined {
	if (typeof theme?.getFgAnsi !== "function") return undefined;
	try {
		const ansi = theme.getFgAnsi(token);
		return typeof ansi === "string" ? ansi : undefined;
	} catch {
		return undefined; // unknown token: 1.x throws from `tokenAnsi`
	}
}

export function resolveDiffColors(theme?: any): DiffColors {
	const themeKey = themeCacheKey(theme);

	// Re-derive theme key cache (bg colors are now passed explicitly via DiffBg)
	if (themeKey !== _lastThemeKey) {
		_lastThemeKey = themeKey;
	}
	if (!theme?.getFgAnsi) return DEFAULT_DIFF_COLORS;
	// Per token, so one unknown token cannot drag the whole row back to the
	// hardcoded set.
	return {
		fgAdd: themeFgAnsi(theme, "toolDiffAdded") ?? FG_ADD,
		fgDel: themeFgAnsi(theme, "toolDiffRemoved") ?? FG_DEL,
		fgCtx: themeFgAnsi(theme, "toolDiffContext") ?? FG_DIM,
	};
}
