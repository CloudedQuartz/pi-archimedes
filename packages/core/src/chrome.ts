import type { Theme, ThemeAppearance, ThemeColor } from "@earendil-works/pi-coding-agent";

// ── ANSI constants ───────────────────────────────────────────────────────────

export const RESET = "\x1b[0m";

// ── Editor chrome ────────────────────────────────────────────────────────────

export const PI_STR = "> ";
export const PI_WIDTH = PI_STR.length;
export const PI_SYMBOL_COL = 2;

export const AUTOCOMPLETE_CURSOR = "›";
export const HINT_MARGIN_RIGHT = 3;
export const PAD_X = 1;

// ── Fallback ANSI codes (no-theme-object path only) ─────────────────────────

// A palette is only ever built without a theme in tests and headless runs, so
// these constants stay hardcoded — but they still respect a light appearance
// when one can be read, because a near-black slab on a light terminal is the
// bug this file used to ship.
const PANEL_FALLBACK: Readonly<Record<ThemeAppearance, PanelColor>> = {
  dark: { panelBg: "\x1b[48;2;16;16;16m", panelEdge: "\x1b[38;2;16;16;16m" },
  light: { panelBg: "\x1b[48;2;238;238;238m", panelEdge: "\x1b[38;2;238;238;238m" },
};

const FALLBACK_FG = "\x1b[38;2;74;74;74m"; // #4a4a4a structural gray

// ── Palette ──────────────────────────────────────────────────────────────────

export type ThemeBg = "selectedBg" | "userMessageBg" | "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

export interface PanePalette {
  panelBg: string;
  panelEdge: string;
  frame(text: string): string;
  prefix(text: string): string;
  spin(text: string): string;
  time(text: string): string;
  hint(text: string): string;
}

function tryGetBgAnsi(theme: Theme, key: ThemeBg): string | undefined {
  try {
    return theme.getBgAnsi(key);
  } catch {
    // Unknown token (`tokenAnsi` throws in 1.x), or no theme object at all.
    return undefined;
  }
}

function tryGetFgAnsi(theme: Theme, key: ThemeColor): string | undefined {
  try {
    return theme.getFgAnsi(key);
  } catch {
    return undefined;
  }
}

/** `Theme.appearance` exists from pi 0.99.0; older hosts report nothing. */
function themeAppearance(theme: Theme | undefined): ThemeAppearance | undefined {
  return (theme as { appearance?: ThemeAppearance } | undefined)?.appearance;
}

function tryFg(theme: Theme, key: ThemeColor, text: string): string | undefined {
  try {
    return theme.fg(key, text);
  } catch {
    return undefined;
  }
}

function safeThemeColor(theme: Theme, keys: ThemeColor[], text: string): string {
  for (const k of keys) {
    const res = tryFg(theme, k, text);
    if (res !== undefined) return res;
  }
  return fgWrap(FALLBACK_FG, text);
}

// ── Terminal-default tokens: "no color", not "some color" ──────────────────

/**
 * The escape sequences that mean *paint nothing, use the terminal's own
 * color*. Since pi 0.99.0 a theme token is allowed to be `""` (terminal
 * default), and `Theme.getBgAnsi()` / `getFgAnsi()` render that as `\x1b[49m` /
 * `\x1b[39m` — **truthy** strings, so a `getBgAnsi(…) ?? FALLBACK` chain never
 * reaches the fallback and a `… || HARD_COLOR` chain never fires. Measured on
 * pi 1.2.0: a theme with `userMessageBg: ""` answers `"\x1b[49m"`, and one with
 * `borderMuted: ""` answers `"\x1b[39m"`.
 *
 * Membership here is a *comparison*, never a decode: nothing in this file reads
 * the color an escape happens to encode. Suite rule — decide color from the
 * theme, never by parsing an escape sequence.
 */
const TERMINAL_DEFAULT_SEQUENCES: ReadonlySet<string> = new Set([
  "", // the answer itself, pre-0.99.0
  RESET, // "\x1b[0m": a full reset leaves no colour set
  "\x1b[m", // …and its parameter-less form
  "\x1b[39m", // a foreground token set to ""
  "\x1b[49m", // a background token set to ""
]);

/** Does this theme answer mean "the terminal's own color", i.e. no color? */
export function isTerminalDefault(ansi: string | undefined): boolean {
  return ansi === undefined || TERMINAL_DEFAULT_SEQUENCES.has(ansi);
}

// ── Panel tint and edge ─────────────────────────────────────────────────────

interface PanelColor {
  /** Opening background escape for the panel body, or "" for no tint. */
  panelBg: string;
  /** Opening foreground escape for the edge slabs, or "" for no edge. */
  panelEdge: string;
}

/** No color at all: panel and edges render in the terminal's own. */
const NO_PANEL_COLOR: PanelColor = { panelBg: "", panelEdge: "" };

/** Queried in order; the first answer wins — a terminal default included. */
const PANEL_BG_TOKENS: readonly ThemeBg[] = ["userMessageBg", "customMessageBg"];

/** The slab seals a tinted panel, so it is a border, not a background. */
const PANEL_EDGE_TOKENS: readonly ThemeColor[] = ["borderMuted", "border"];

function panelBgToken(theme: Theme): string | undefined {
  for (const key of PANEL_BG_TOKENS) {
    const ansi = tryGetBgAnsi(theme, key);
    if (ansi !== undefined) return ansi;
  }
  return undefined;
}

function panelEdgeToken(theme: Theme): string | undefined {
  for (const key of PANEL_EDGE_TOKENS) {
    const ansi = tryGetFgAnsi(theme, key);
    if (ansi !== undefined && !isTerminalDefault(ansi)) return ansi;
  }
  return undefined;
}

/**
 * Panel tint and edge, decided by theme tokens alone: the panel is painted with
 * whatever the theme's own panel background token says (passed through, not
 * re-emitted), and the edge slabs with whatever its own border token says.
 *
 * Nothing is derived *from* an escape sequence any more. The old
 * background-to-foreground helper matched `48;2;`/`48;5;` inside the background
 * string and answered everything else — notably the `\x1b[49m` a
 * terminal-default token produces — with near-black `#101010`, which is how an
 * untinted panel ended up with black borders on a light terminal.
 */
function resolvePanelColor(theme: Theme): PanelColor {
  const bg = panelBgToken(theme);
  if (bg === undefined) {
    // Nothing to ask: no theme object, or one with no panel token at all.
    return PANEL_FALLBACK[themeAppearance(theme) ?? "dark"];
  }
  if (isTerminalDefault(bg)) return NO_PANEL_COLOR;
  return { panelBg: bg, panelEdge: panelEdgeToken(theme) ?? "" };
}

function fgWrap(ansi: string, text: string): string {
  return `${ansi}${text}${RESET}`;
}

export function resolvePalette(theme: Theme): PanePalette {
  const { panelBg, panelEdge } = resolvePanelColor(theme);

  return {
    panelBg,
    panelEdge,
    frame: (t) => safeThemeColor(theme, ["borderMuted", "border"], t),
    prefix: (t) => safeThemeColor(theme, ["borderMuted", "border"], t),
    spin: (t) => safeThemeColor(theme, ["accent", "borderMuted"], t),
    time: (t) => safeThemeColor(theme, ["muted", "accent"], t),
    hint: (t) => safeThemeColor(theme, ["dim", "muted"], t),
  };
}
