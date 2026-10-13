/** Diff background color derivation from theme. */

import type { DiffBg } from "./codes.js";
import { BG_DEFAULT, DEFAULT_DIFF_BG, FG_RULE } from "./codes.js";

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------
//
// This parser is a deliberate sibling of `parseAnsiFgToRgb` in
// `packages/core/src/color.ts`; `pi-support.ts` is the one place that says what
// keeping such a copy costs and why it is worth it. The sibling is not reusable
// as-is for one reason: core is anchored to `^\x1b[38;` (foreground slot only),
// while this one reads `38|48` because it is fed **background** strings, straight
// from `theme.getBgAnsi(...)`.

interface RGB {
	r: number;
	g: number;
	b: number;
}

// xterm standard 16-color palette (ANSI indices 0..15), same table as core.
// Source: https://en.wikipedia.org/wiki/ANSI_escape_code#3-bit_and_4-bit
const XTERM_16: readonly RGB[] = [
	{ r: 0x00, g: 0x00, b: 0x00 }, // 0  black
	{ r: 0x80, g: 0x00, b: 0x00 }, // 1  maroon
	{ r: 0x00, g: 0x80, b: 0x00 }, // 2  green
	{ r: 0x80, g: 0x80, b: 0x00 }, // 3  olive
	{ r: 0x00, g: 0x00, b: 0x80 }, // 4  navy
	{ r: 0x80, g: 0x80, b: 0x80 }, // 5  purple
	{ r: 0x00, g: 0x80, b: 0x80 }, // 6  teal
	{ r: 0xc0, g: 0xc0, b: 0xc0 }, // 7  silver
	{ r: 0x80, g: 0x80, b: 0x80 }, // 8  grey
	{ r: 0xff, g: 0x00, b: 0x00 }, // 9  red
	{ r: 0x00, g: 0xff, b: 0x00 }, // 10 lime
	{ r: 0xff, g: 0xff, b: 0x00 }, // 11 yellow
	{ r: 0x00, g: 0x00, b: 0xff }, // 12 blue
	{ r: 0xff, g: 0x00, b: 0xff }, // 13 fuchsia
	{ r: 0x00, g: 0xff, b: 0xff }, // 14 aqua
	{ r: 0xff, g: 0xff, b: 0xff }, // 15 white
];

// 6x6x6 cube levels for ANSI 16..231; 232..255 are the gray ramp.
const CUBE_LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255];

const toByte = (value: number): number => Math.min(255, Math.max(0, Math.round(value)));

/** xterm-256 index → RGB, or null for an index out of range. */
function ansi256ToRgb(code: number): RGB | null {
	const c = Math.floor(code);
	if (!Number.isFinite(c) || c < 0 || c > 255) return null;
	if (c < 16) return { ...XTERM_16[c]! };
	if (c < 232) {
		const idx = c - 16;
		return {
			r: CUBE_LEVELS[Math.floor(idx / 36) % 6]!,
			g: CUBE_LEVELS[Math.floor(idx / 6) % 6]!,
			b: CUBE_LEVELS[idx % 6]!,
		};
	}
	const v = 8 + (c - 232) * 10;
	return { r: v, g: v, b: v };
}

/**
 * The escape sequences that mean *"the terminal's own color — paint nothing"*.
 * A pi theme token set to `""` (terminal default) reaches us as `\x1b[39m` /
 * `\x1b[49m` — truthy strings, so `|| FALLBACK` chains cannot see them. This is
 * a comparison against a known set, never a decode of the color. Mirrors
 * `isTerminalDefault` in `packages/core/src/chrome.ts`, duplicated for the same
 * standalone-package reason as the table above.
 */
const TERMINAL_DEFAULT_SEQUENCES: ReadonlySet<string> = new Set([
	"", // the answer itself, pre-0.99.0
	"\x1b[0m", // full reset: no color left set
	"\x1b[m", // …and its parameter-less form
	"\x1b[39m", // a foreground token set to ""
	"\x1b[49m", // a background token set to ""
]);

/** Does this theme answer mean "the terminal's own color", i.e. no color? */
export function isTerminalDefault(ansi: string | undefined): boolean {
	return ansi === undefined || TERMINAL_DEFAULT_SEQUENCES.has(ansi);
}

const TRUECOLOR_RE = /\x1b\[(?:38|48);2;(\d{1,3});(\d{1,3});(\d{1,3})m/;
const PALETTE_RE = /\x1b\[(?:38|48);5;(\d{1,3})m/;

/**
 * Parse a theme escape into RGB. Both slots are read (`38;…` and `48;…`) with
 * 24-bit and xterm-256 parameters, because a non-truecolor terminal — and
 * pi's generated `system` theme on a terminal that reported no colors — hands
 * out `38;5;n`/`48;5;n`. A terminal-default reset parses to *no color* (null),
 * never to a color we then mix.
 */
function parseAnsiRgb(ansi: string): RGB | null {
	if (!ansi || isTerminalDefault(ansi)) return null;
	const truecolor = TRUECOLOR_RE.exec(ansi);
	if (truecolor) {
		return {
			r: toByte(Number.parseInt(truecolor[1]!, 10)),
			g: toByte(Number.parseInt(truecolor[2]!, 10)),
			b: toByte(Number.parseInt(truecolor[3]!, 10)),
		};
	}
	const palette = PALETTE_RE.exec(ansi);
	if (palette) return ansi256ToRgb(Number.parseInt(palette[1]!, 10));
	return null;
}

/**
 * What one theme token says about color. `"none"` (terminal default) and
 * `"unknown"` (no such token, no accessor, or a value we cannot read) are
 * different answers: "none" is the theme declining to paint, "unknown" is the
 * theme not being a usable source at all.
 */
type TokenColor =
	| { kind: "color"; ansi: string; rgb: RGB }
	| { kind: "none" }
	| { kind: "unknown" };

function readThemeToken(read: (() => unknown) | undefined): TokenColor {
	if (!read) return { kind: "unknown" };
	let ansi: unknown;
	try {
		ansi = read(); // 1.x throws for an unknown token (`tokenAnsi`)
	} catch {
		return { kind: "unknown" };
	}
	if (typeof ansi !== "string") return { kind: "unknown" };
	if (isTerminalDefault(ansi)) return { kind: "none" };
	const rgb = parseAnsiRgb(ansi);
	return rgb ? { kind: "color", ansi, rgb } : { kind: "unknown" };
}

/** Mix an accent color into a base color at the given intensity (0.0–1.0). */
function mixBg(
	base: RGB,
	accent: RGB,
	intensity: number,
): string {
	const r = Math.round(base.r + (accent.r - base.r) * intensity);
	const g = Math.round(base.g + (accent.g - base.g) * intensity);
	const b = Math.round(base.b + (accent.b - base.b) * intensity);
	return `\x1b[48;2;${r};${g};${b}m`;
}

// ---------------------------------------------------------------------------
// Theme-aware diff colors
// ---------------------------------------------------------------------------

/** Auto-derive diff background colors from the pi theme's fg diff colors. */
export function deriveBgFromTheme(theme: any): DiffBg {
	// No theme object to ask: the hardcoded fallbacks are the honest answer,
	// which is the only place they still apply.
	if (!theme?.getFgAnsi) return { ...DEFAULT_DIFF_BG };
	try {
		const add = readThemeToken(() => theme.getFgAnsi("toolDiffAdded"));
		const del = readThemeToken(() => theme.getFgAnsi("toolDiffRemoved"));
		// Nothing readable to derive from — not a theme we can paint with.
		if (add.kind === "unknown" || del.kind === "unknown") return { ...DEFAULT_DIFF_BG };

		let addBase: RGB = { r: 0, g: 0, b: 0 };
		let delBase: RGB = addBase;
		let bgBase = BG_DEFAULT; // no base color: the terminal's own

		if (theme.getBgAnsi) {
			const success = readThemeToken(() => theme.getBgAnsi("toolSuccessBg"));
			// A terminal-default panel background is *no base color*: leave the
			// mix at its neutral start rather than inventing one.
			if (success.kind === "color") {
				addBase = success.rgb;
				delBase = success.rgb;
				bgBase = success.ansi;
			}
			const error = readThemeToken(() => theme.getBgAnsi("toolErrorBg"));
			if (error.kind === "color") delBase = error.rgb;
		}

		// A side whose accent token is terminal default gets no background at
		// all — used to be the hardcoded `DEFAULT_DIFF_BG` slab, which is why a
		// palette terminal showed fixed dark green/red whatever the theme said.
		const tint = (base: RGB, accent: TokenColor, intensity: number): string =>
			accent.kind === "color" ? mixBg(base, accent.rgb, intensity) : BG_DEFAULT;

		const rst = bgBase === BG_DEFAULT ? "\x1b[0m" : `\x1b[0m${bgBase}`;
		return {
			bgAdd: tint(addBase, add, 0.08),
			bgDel: tint(delBase, del, 0.1),
			bgAddW: tint(addBase, add, 0.2),
			bgDelW: tint(delBase, del, 0.22),
			bgGutterAdd: tint(addBase, add, 0.05),
			bgGutterDel: tint(delBase, del, 0.06),
			bgEmpty: bgBase,
			bgBase,
			rst,
			divider: `${FG_RULE}│${rst}`,
		};
	} catch {
		return { ...DEFAULT_DIFF_BG };
	}
}
