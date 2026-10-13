import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import { deriveBgFromTheme, isTerminalDefault } from "./colors.js";
import { DEFAULT_DIFF_BG, FG_RULE } from "./codes.js";

// The escape that means "paint nothing": the terminal's own background. A theme
// token set to "" (terminal default) reaches us as `\x1b[39m` / `\x1b[49m`, and
// `\x1b[49m` is exactly what `bgBase` already uses when there is no base colour,
// so "no colour" needs no new colour value — it needs a fallthrough that stops
// inventing one.
const BG_NONE = "\x1b[49m";

// ── deriveBgFromTheme ───────────────────────────────────────────────────────

describe("deriveBgFromTheme", () => {
	it("returns DEFAULT_DIFF_BG when theme is null", () => {
		const result = deriveBgFromTheme(null);
		expect(result).toEqual(DEFAULT_DIFF_BG);
	});

	it("returns DEFAULT_DIFF_BG when theme is undefined", () => {
		const result = deriveBgFromTheme(undefined);
		expect(result).toEqual(DEFAULT_DIFF_BG);
	});

	it("returns DEFAULT_DIFF_BG when theme lacks getFgAnsi", () => {
		const result = deriveBgFromTheme({});
		expect(result).toEqual(DEFAULT_DIFF_BG);
	});

	it("returns DEFAULT_DIFF_BG when getFgAnsi returns non-parseable values", () => {
		const theme = {
			getFgAnsi: () => "not-an-ansi-code",
		};
		const result = deriveBgFromTheme(theme);
		expect(result).toEqual(DEFAULT_DIFF_BG);
	});

	it("derives colors from theme with valid getFgAnsi", () => {
		const theme = {
			getFgAnsi: (token: string) => {
				if (token === "toolDiffAdded") return "\x1b[38;2;100;200;150m";
				if (token === "toolDiffRemoved") return "\x1b[38;2;200;100;100m";
				return "";
			},
		};
		const result = deriveBgFromTheme(theme);
		// bgAdd should be a mix of black (base) + green accent at 0.08 intensity
		expect(result.bgAdd).toMatch(/\x1b\[48;2;\d+;\d+;\d+m/);
		expect(result.bgDel).toMatch(/\x1b\[48;2;\d+;\d+;\d+m/);
		// Should differ from defaults since we have a theme
		expect(result.bgAdd).not.toBe(DEFAULT_DIFF_BG.bgAdd);
	});

	it("uses bgBase from theme when getBgAnsi is available", () => {
		const theme = {
			getFgAnsi: (token: string) => {
				if (token === "toolDiffAdded") return "\x1b[38;2;100;200;150m";
				if (token === "toolDiffRemoved") return "\x1b[38;2;200;100;100m";
				return "";
			},
			getBgAnsi: (token: string) => {
				if (token === "toolSuccessBg") return "\x1b[48;2;20;40;30m";
				if (token === "toolErrorBg") return "\x1b[48;2;40;20;20m";
				return "";
			},
		};
		const result = deriveBgFromTheme(theme);
		// bgBase should come from the theme's success bg
		expect(result.bgBase).toBe("\x1b[48;2;20;40;30m");
		// bgEmpty should equal bgBase
		expect(result.bgEmpty).toBe(result.bgBase);
	});

	it("returns DiffBg with all required fields", () => {
		const theme = {
			getFgAnsi: (token: string) => {
				if (token === "toolDiffAdded") return "\x1b[38;2;100;200;150m";
				if (token === "toolDiffRemoved") return "\x1b[38;2;200;100;100m";
				return "";
			},
		};
		const result = deriveBgFromTheme(theme);
		expect(typeof result.bgAdd).toBe("string");
		expect(typeof result.bgDel).toBe("string");
		expect(typeof result.bgAddW).toBe("string");
		expect(typeof result.bgDelW).toBe("string");
		expect(typeof result.bgGutterAdd).toBe("string");
		expect(typeof result.bgGutterDel).toBe("string");
		expect(typeof result.bgEmpty).toBe("string");
		expect(typeof result.bgBase).toBe("string");
		expect(typeof result.rst).toBe("string");
		expect(typeof result.divider).toBe("string");
	});

	it("bg colors are ANSI truecolor escapes (48;2;r;g;b format)", () => {
		const theme = {
			getFgAnsi: (token: string) => {
				if (token === "toolDiffAdded") return "\x1b[38;2;100;200;150m";
				if (token === "toolDiffRemoved") return "\x1b[38;2;200;100;100m";
				return "";
			},
		};
		const result = deriveBgFromTheme(theme);
		const bgFields = [
			result.bgAdd,
			result.bgDel,
			result.bgAddW,
			result.bgDelW,
			result.bgGutterAdd,
			result.bgGutterDel,
		];
		for (const bg of bgFields) {
			expect(bg).toMatch(/\x1b\[48;2;\d+;\d+;\d+m/);
		}
	});

	it("divider contains FG_RULE character", () => {
		const theme = {
			getFgAnsi: (token: string) => {
				if (token === "toolDiffAdded") return "\x1b[38;2;100;200;150m";
				if (token === "toolDiffRemoved") return "\x1b[38;2;200;100;100m";
				return "";
			},
		};
		const result = deriveBgFromTheme(theme);
		expect(result.divider).toContain(FG_RULE);
	});

	it("rst is reset when no bgBase from theme", () => {
		const theme = {
			getFgAnsi: (token: string) => {
				if (token === "toolDiffAdded") return "\x1b[38;2;100;200;150m";
				if (token === "toolDiffRemoved") return "\x1b[38;2;200;100;100m";
				return "";
			},
		};
		const result = deriveBgFromTheme(theme);
		// Without getBgAnsi, bgBase is \x1b[49m, so rst is just \x1b[0m
		expect(result.rst).toBe("\x1b[0m");
	});

	it("rst includes bgBase reset when theme provides getBgAnsi", () => {
		const theme = {
			getFgAnsi: (token: string) => {
				if (token === "toolDiffAdded") return "\x1b[38;2;100;200;150m";
				if (token === "toolDiffRemoved") return "\x1b[38;2;200;100;100m";
				return "";
			},
			getBgAnsi: (token: string) => {
				if (token === "toolSuccessBg") return "\x1b[48;2;20;40;30m";
				return "";
			},
		};
		const result = deriveBgFromTheme(theme);
		// With getBgAnsi, rst should be \x1b[0m + bgBase
		expect(result.rst).toBe("\x1b[0m\x1b[48;2;20;40;30m");
	});

	it("handles getFgAnsi that throws gracefully", () => {
		const theme = {
			getFgAnsi: () => {
				throw new Error("theme error");
			},
		};
		const result = deriveBgFromTheme(theme);
		expect(result).toEqual(DEFAULT_DIFF_BG);
	});

	it("handles getBgAnsi that throws gracefully", () => {
		const theme = {
			getFgAnsi: (token: string) => {
				if (token === "toolDiffAdded") return "\x1b[38;2;100;200;150m";
				if (token === "toolDiffRemoved") return "\x1b[38;2;200;100;100m";
				return "";
			},
			getBgAnsi: () => {
				throw new Error("bg error");
			},
		};
		const result = deriveBgFromTheme(theme);
		// Should still produce valid output, falling back to default bgBase
		expect(result.bgBase).toBe("\x1b[49m");
		expect(result.rst).toBe("\x1b[0m");
	});

	it("property: rst always contains reset escape", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(
						fc.constant("toolDiffAdded"),
						fc.string({ maxLength: 20 }),
					),
					{ minLength: 0, maxLength: 5 },
				),
				(pairs) => {
					const map = new Map(pairs);
					const theme = {
						getFgAnsi: (token: any) => map.get(token) || "",
					};
					const result = deriveBgFromTheme(theme);
					return result.rst.includes("\x1b[0m");
				},
			),
		);
	});

	it("property: all bg fields are valid truecolor bg escapes, the terminal default, or defaults", () => {
		fc.assert(
			fc.property(
				fc.string({ maxLength: 50 }),
				(addColor) => {
					const theme = {
						getFgAnsi: (token: string) => {
							if (token === "toolDiffAdded") return addColor;
							if (token === "toolDiffRemoved") return addColor;
							return "";
						},
					};
					const result = deriveBgFromTheme(theme);
					// Three legal answers: a derived truecolour bg, "no colour" (a
					// terminal-default token), or the no-theme-object fallback.
					const isLegal = (s: string) =>
						/\x1b\[48;2;\d+;\d+;\d+m/.test(s) || s === BG_NONE;
					const allLegal = [
						result.bgAdd,
						result.bgDel,
						result.bgAddW,
						result.bgDelW,
						result.bgGutterAdd,
						result.bgGutterDel,
					].every(isLegal);
					const isDefault = result === DEFAULT_DIFF_BG || result.bgAdd === DEFAULT_DIFF_BG.bgAdd;
					return allLegal || isDefault;
				},
			),
		);
	});

	// ── Palette tokens and terminal-default tokens ───────────────────────────
	//
	// The parser used to match only `38|48;2;r;g;b`. Every other token — the
	// `38;5;n`/`48;5;n` sequences a non-truecolour terminal produces, and the
	// indexed tokens pi's generated `system` theme uses when the terminal
	// reports nothing — fell through to the hardcoded `DEFAULT_DIFF_BG` slabs,
	// so the diff showed fixed dark green/red no matter what the theme said.

	it("resolves a 38;5;n diff colour through the xterm-256 table", () => {
		// Index 2 is (0,128,0) in the same table `core/src/color.ts` uses, so the
		// added-line background is that accent mixed into the base at 0.08.
		const theme = {
			getFgAnsi: (token: string) => {
				if (token === "toolDiffAdded") return "\x1b[38;5;2m";
				if (token === "toolDiffRemoved") return "\x1b[38;5;1m";
				return "\x1b[38;5;7m";
			},
		};
		const result = deriveBgFromTheme(theme);
		expect(result.bgAdd).toBe("\x1b[48;2;0;10;0m");
		expect(result.bgDel).toBe("\x1b[48;2;13;0;0m");
		expect(result.bgAddW).toBe("\x1b[48;2;0;26;0m");
		expect(result.bgGutterDel).toBe("\x1b[48;2;8;0;0m");
		// Not the hardcoded slab any more — the theme's own palette drove it.
		expect(result.bgAdd).not.toBe(DEFAULT_DIFF_BG.bgAdd);
	});

	it("resolves a 48;5;n base background through the same table", () => {
		// The asymmetry that makes core's helper insufficient on its own: this
		// parser is fed background strings too (`theme.getBgAnsi(...)`), so 48;5;
		// must resolve, not just 38;5;. 236 is the gray ramp at (48,48,48).
		const theme = {
			getFgAnsi: (token: string) => {
				if (token === "toolDiffAdded") return "\x1b[38;5;2m";
				if (token === "toolDiffRemoved") return "\x1b[38;5;1m";
				return "\x1b[38;5;7m";
			},
			getBgAnsi: (token: string) => {
				if (token === "toolSuccessBg") return "\x1b[48;5;236m";
				if (token === "toolErrorBg") return "\x1b[48;5;237m";
				return BG_NONE;
			},
		};
		const result = deriveBgFromTheme(theme);
		// The token itself is the base — passed through, not reparsed into a
		// truecolour equivalent — and it is what the mix starts from.
		expect(result.bgBase).toBe("\x1b[48;5;236m");
		expect(result.bgEmpty).toBe("\x1b[48;5;236m");
		expect(result.bgAdd).toBe("\x1b[48;2;44;54;44m");
		expect(result.bgDel).toBe("\x1b[48;2;65;52;52m");
	});

	it("treats a terminal-default diff colour as no colour, not as DEFAULT_DIFF_BG", () => {
		for (const token of ["", "\x1b[39m", "\x1b[0m"]) {
			const theme = { getFgAnsi: () => token };
			const result = deriveBgFromTheme(theme);
			expect(JSON.stringify(token)).not.toBe("undefined");
			for (const field of [
				result.bgAdd,
				result.bgDel,
				result.bgAddW,
				result.bgDelW,
				result.bgGutterAdd,
				result.bgGutterDel,
				result.bgEmpty,
			] as const) {
				expect(field, `token ${JSON.stringify(token)}`).toBe(BG_NONE);
			}
			expect(result).not.toEqual(DEFAULT_DIFF_BG);
			expect(result.bgAdd).not.toBe(DEFAULT_DIFF_BG.bgAdd);
			// The reset still closes whatever state the line opened.
			expect(result.rst).toContain("\x1b[0m");
		}
	});

	it("keeps the side that has a colour tinted when only the other side declines one", () => {
		const theme = {
			getFgAnsi: (token: string) =>
				token === "toolDiffAdded" ? "\x1b[38;2;0;255;0m" : "\x1b[39m",
		};
		const result = deriveBgFromTheme(theme);
		expect(result.bgAdd).toBe("\x1b[48;2;0;20;0m");
		expect(result.bgDel).toBe(BG_NONE);
		expect(result.bgDelW).toBe(BG_NONE);
		expect(result.bgGutterDel).toBe(BG_NONE);
	});

	it("treats a terminal-default base background as no base colour, keeping the accent tint", () => {
		// `toolSuccessBg`/`toolErrorBg` are panel tokens: pi's generated system
		// theme gives panels no background, so they arrive as `\x1b[49m`. That
		// must not be read as a colour, and it must not discard the accent tint.
		const theme = {
			getFgAnsi: (token: string) => {
				if (token === "toolDiffAdded") return "\x1b[38;2;0;255;0m";
				if (token === "toolDiffRemoved") return "\x1b[38;2;255;0;0m";
				return "\x1b[38;5;7m";
			},
			getBgAnsi: () => BG_NONE,
		};
		const result = deriveBgFromTheme(theme);
		expect(result.bgBase).toBe(BG_NONE);
		expect(result.bgAdd).toBe("\x1b[48;2;0;20;0m");
	});

	// ── Real pi 1.2.0 Theme objects ──────────────────────────────────
	//
	// The fixtures above hand-build escape strings. These build the real thing,
	// because the whole point is that the shape of the incoming token is pi's
	// business, not ours.

	/**
	 * A real pi 1.2.0 `Theme`. Every token that another token falls back to
	 * (`scrollbarTrack`→`muted`, `scrollbarThumb`/`searchMatchText`→`text`,
	 * `searchMatchBg`→`selectedBg`, `thinkingMax`→`thinkingXhigh`) has to be
	 * present, because the constructor resolves the fallbacks eagerly.
	 */
	function realPiTheme(
		tokens: Record<string, string | number>,
		options: { appearance: "light" | "dark"; mode?: "truecolor" | "256color" },
	): PiTheme {
		const base: Record<string, string | number> = {
			text: "#d8d8d8",
			muted: "#8a8a8a",
			selectedBg: "#213b49",
			thinkingXhigh: "#c586c0",
			...tokens,
		};
		return new PiTheme(
			base as never,
			base as never,
			options.mode ?? "truecolor",
			options,
		) as PiTheme;
	}

	it("derives from an indexed (38;5;n) theme token on a real pi Theme", () => {
		// What pi does when the terminal reports no colours: the system theme
		// hands out ANSI indices, and the escape comes back as `38;5;n` even in
		// truecolour mode because the *token* is indexed.
		const theme = realPiTheme(
			{ toolDiffAdded: 2, toolDiffRemoved: 1, toolDiffContext: 7 },
			{ appearance: "dark" },
		);
		expect(theme.getFgAnsi("toolDiffAdded")).toBe("\x1b[38;5;2m");
		const result = deriveBgFromTheme(theme);
		expect(result.bgAdd).toBe("\x1b[48;2;0;10;0m");
		expect(result.bgAdd).not.toBe(DEFAULT_DIFF_BG.bgAdd);
	});

	it("paints no background for a real pi Theme whose diff tokens are terminal default", () => {
		const theme = realPiTheme(
			{ toolDiffAdded: "", toolDiffRemoved: "", toolDiffContext: "" },
			{ appearance: "light" },
		);
		expect(theme.getFgAnsi("toolDiffAdded")).toBe("\x1b[39m");
		const result = deriveBgFromTheme(theme);
		expect(result.bgAdd).toBe(BG_NONE);
		expect(result.bgDel).toBe(BG_NONE);
		expect(result).not.toEqual(DEFAULT_DIFF_BG);
	});

	it("classifies terminal-default sequences without cracking them open", () => {
		expect(isTerminalDefault("")).toBe(true);
		expect(isTerminalDefault("\x1b[39m")).toBe(true);
		expect(isTerminalDefault("\x1b[49m")).toBe(true);
		expect(isTerminalDefault("\x1b[0m")).toBe(true);
		expect(isTerminalDefault("\x1b[m")).toBe(true);
		expect(isTerminalDefault(undefined)).toBe(true);
		expect(isTerminalDefault("\x1b[38;5;2m")).toBe(false);
		expect(isTerminalDefault("\x1b[48;2;18;32;26m")).toBe(false);
	});

	it("property: divider always contains the rule character", () => {
		fc.assert(
			fc.property(
				fc.string({ maxLength: 100 }),
				(rawColor) => {
					const theme = {
						getFgAnsi: () => rawColor,
					};
					const result = deriveBgFromTheme(theme);
					return result.divider.includes(FG_RULE);
				},
			),
		);
	});
});
