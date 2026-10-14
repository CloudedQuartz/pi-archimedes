import { describe, it, expect, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Force TRUECOLOR=false so formatColumns output is deterministic across envs
vi.mock("./logo.js", async (importOriginal) => ({ ...(await importOriginal()), TRUECOLOR: false }));

// Mock pi-tui — visibleWidth and truncateToWidth
vi.mock("@earendil-works/pi-tui", () => ({
	visibleWidth: (s: string) => s.length,
	truncateToWidth: (s: string, w: number) => s.slice(0, w),
}));

// ── Imports ──────────────────────────────────────────────────────────────────
//
// The layout half only. The detection/parsing half of this module (`detectSection`,
// `parseSectionText`, `parseModelScope`, `extractName`) existed to read pi's
// scraped startup sections back out of component text; Task 8 deleted the
// scrape, and with it the reason for those functions — pi renders its own
// listing and `ctx.scopedModels` supplies the model scope, so nothing in the
// suite parses pi's text any more.

import { formatColumns, buildItemWrapper, RAMP_FRAMES } from "./sections.js";

// ── formatColumns ────────────────────────────────────────────────────────────

describe("formatColumns", () => {
	const mockTheme = {
		fg: (token: string, text: string) => text,
		getFgAnsi: (token: string) => "",
	} as any;

	const mockRef = {
		frame: 100,
		revealed: true,
		revealedAt: 0,
		scaffoldAt: 0,
		settled: true,
	};

	it("returns empty array for empty sections", () => {
		expect(formatColumns([], mockTheme, 80, mockRef)).toEqual([]);
	});

	it("returns empty array for sections with no items", () => {
		const sections = [{ name: "Models" as const, items: [] }];
		expect(formatColumns(sections, mockTheme, 80, mockRef)).toEqual([]);
	});

	it("formats a single section with items", () => {
		const sections = [{ name: "Models" as const, items: ["claude-sonnet", "gpt-4"] }];
		const result = formatColumns(sections, mockTheme, 80, mockRef);
		expect(result.length).toBeGreaterThan(0);
		// Should contain the section header
		expect(result.some(line => line.includes("[Models]"))).toBe(true);
	});

	it("formats multiple sections", () => {
		const sections = [
			{ name: "Models" as const, items: ["claude"] },
			{ name: "Themes" as const, items: ["dark"] },
		];
		const result = formatColumns(sections, mockTheme, 80, mockRef);
		expect(result.some(line => line.includes("[Models]"))).toBe(true);
		expect(result.some(line => line.includes("[Themes]"))).toBe(true);
	});

	it("separates two sections with one blank row, the way pi's Spacer(1) does", () => {
		const sections = [
			{ name: "Version" as const, items: ["1.0.0"] },
			{ name: "Models" as const, items: ["gpt-5"] },
		];
		expect(formatColumns(sections, mockTheme, 80, mockRef)).toEqual([
			"[Version]",
			"  1.0.0",
			"",
			"[Models]",
			"  gpt-5",
		]);
	});

	it("adds no blank row after the last section: pi supplies the gap below the header", () => {
		// pi brackets the header container with a Spacer and opens its resource
		// listing with another, so a trailing blank here is a double gap.
		const sections = [{ name: "Version" as const, items: ["1.0.0"] }];
		expect(formatColumns(sections, mockTheme, 80, mockRef)).toEqual(["[Version]", "  1.0.0"]);
	});

	it("wraps items to new lines when exceeding width", () => {
		const longItems = Array.from({ length: 20 }, (_, i) => `model-${i}`);
		const sections = [{ name: "Models" as const, items: longItems }];
		const result = formatColumns(sections, mockTheme, 40, mockRef);
		// With narrow width, items should wrap to multiple lines
		expect(result.length).toBeGreaterThan(1);
	});

	it("handles unrevealed state", () => {
		const sections = [{ name: "Models" as const, items: ["test"] }];
		const unrevealedRef = { ...mockRef, revealed: false };
		const result = formatColumns(sections, mockTheme, 80, unrevealedRef);
		expect(result.length).toBeGreaterThan(0);
	});
});

// ── buildItemWrapper ─────────────────────────────────────────────────────────

describe("buildItemWrapper", () => {
	const muted = (t: string) => `\x1b[90m${t}\x1b[0m`;

	it("returns identity function when not revealed", () => {
		const wrapper = buildItemWrapper(0, false, undefined, undefined, muted);
		expect(wrapper("hello")).toBe("hello");
	});

	it("returns muted function when no RGB data", () => {
		const wrapper = buildItemWrapper(10, true, undefined, undefined, muted);
		expect(wrapper("hello")).toBe(muted("hello"));
	});

	it("returns muted function when ramp is complete", () => {
		const startRgb = [20, 20, 20] as [number, number, number];
		const mutedRgb = [100, 100, 100] as [number, number, number];
		const wrapper = buildItemWrapper(RAMP_FRAMES, true, startRgb, mutedRgb, muted);
		expect(wrapper("hello")).toBe(muted("hello"));
	});

	it("returns rgb-colored function during ramp", () => {
		const startRgb = [20, 20, 20] as [number, number, number];
		const mutedRgb = [200, 200, 200] as [number, number, number];
		const wrapper = buildItemWrapper(1, true, startRgb, mutedRgb, muted);
		const result = wrapper("hello");
		// Should be a truecolor ANSI escape, not the muted fallback
		expect(result).toMatch(/\x1b\[38;2;\d+;\d+;\d+mhello\x1b\[0m/);
		expect(result).not.toContain("\x1b[90m");
	});

	it("lerps colors correctly at midpoint", () => {
		const startRgb = [0, 0, 0] as [number, number, number];
		const endRgb = [200, 200, 200] as [number, number, number];
		// At exactly RAMP_FRAMES / 2, t = 0.5, eased = 0.75
		const midAge = Math.floor(RAMP_FRAMES / 2);
		const wrapper = buildItemWrapper(midAge, true, startRgb, endRgb, muted);
		const result = wrapper("x");
		// eased = 1 - (1-0.5)^2 = 0.75
		// lerp(0, 200, 0.75) = 150
		expect(result).toContain("\x1b[38;2;150;150;150mx\x1b[0m");
	});

	it("returns muted when mutedRgb is undefined", () => {
		const startRgb = [20, 20, 20] as [number, number, number];
		const wrapper = buildItemWrapper(5, true, startRgb, undefined, muted);
		expect(wrapper("hello")).toBe(muted("hello"));
	});
});
