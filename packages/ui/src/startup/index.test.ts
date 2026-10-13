import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

// The splash no longer reads pi's component tree, so the only pi-tui surface
// these tests need is the width arithmetic `sections.ts` wraps text with. The
// mock keeps the same SGR-only semantics core/text's `stripAnsi` falls back to.
vi.mock("@earendil-works/pi-tui", () => ({
	truncateToWidth: (s: string, w: number) => s.slice(0, w),
	visibleWidth: (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length,
	stripTerminalSequences: (s: string) => s.replace(/\x1b\[[0-9;]*m/g, ""),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { VERSION } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "@pi-archimedes/core/text";
import {
	patchStartupListing,
	revealStartupListing,
	stopStartupListing,
	renderHeader,
	modelScopeSection,
	CONTENT_ONLY_HEIGHT,
	type ListingRef,
} from "./index.js";
import { LOGO, LOGO_SETTLE_FRAME } from "./logo.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeTui(): { tui: any; requestRender: ReturnType<typeof vi.fn> } {
	const requestRender = vi.fn();
	return { tui: { terminal: { rows: 24 }, requestRender }, requestRender };
}

function makeRef(): ListingRef {
	return {
		sections: [],
		frame: 0,
		revealed: true, // skip the reveal debounce path
		revealedAt: 0,
		scaffoldAt: 0,
		settled: false,
	};
}

const THEME = {
	fg: (_token: string, t: string) => t,
	getFgAnsi: (_token: string) => "",
} as any;

afterEach(() => {
	// The splash owns two module-level timers; never leak one into a test.
	stopStartupListing();
});

// ── renderHeader: the section set it draws ───────────────────────────────────

describe("renderHeader section set", () => {
	// The rendered set is whatever the caller revealed into the ref — pi decides
	// which of its own sections exist, so nothing here may assert a fixed list.
	const linesFor = (sections: ListingRef["sections"]): string[] =>
		renderHeader(THEME, { ...makeRef(), sections }, 200, 60);

	it("renders revealed sections in the order they were given", () => {
		const lines = linesFor([
			{ name: "Context", items: ["AGENTS.md"] },
			{ name: "Skills", items: ["tdd"] },
			{ name: "Prompts", items: ["/commit"] },
			{ name: "Extensions", items: ["archimedes"] },
		]);
		const at = (name: string) => lines.findIndex((l) => l.includes(`[${name}]`));
		expect(at("Context")).toBeGreaterThanOrEqual(0);
		expect(at("Context")).toBeLessThan(at("Skills"));
		expect(at("Skills")).toBeLessThan(at("Prompts"));
		expect(at("Prompts")).toBeLessThan(at("Extensions"));
	});

	it("renders a section name the suite has never seen before", () => {
		const lines = linesFor([{ name: "Widgets", items: ["gauge"] }]);
		expect(lines.some((l) => l.includes("[Widgets]"))).toBe(true);
		expect(lines.some((l) => l.includes("gauge"))).toBe(true);
	});

	it("renders nothing but the version block when no section was revealed", () => {
		const lines = linesFor([]);
		for (const phantom of ["Models", "Context", "Prompts", "Skills", "Extensions", "Themes"]) {
			expect(lines.some((l) => l.includes(`[${phantom}]`))).toBe(false);
		}
		expect(lines.some((l) => l.includes("[Version]"))).toBe(true);
	});

	it("skips a revealed section whose item list is empty", () => {
		const lines = linesFor([
			{ name: "Skills", items: [] },
			{ name: "Context", items: ["AGENTS.md"] },
		]);
		expect(lines.some((l) => l.includes("[Skills]"))).toBe(false);
		expect(lines.some((l) => l.includes("[Context]"))).toBe(true);
	});
});

// ── The version block: pi's own version, no update check ─────────────────────
//
// The second row used to be `Latest: v…`, filled in by a
// `registry.npmjs.org` fetch the splash kicked off on every start. pi has its
// own update check (`--update`, `/changelog`, `PI_SKIP_VERSION_CHECK`), so ours
// is gone: the block states the running version and nothing else. Nothing here
// may reach the network — a startup that blocks on a socket is a startup that
// blocks.

describe("renderHeader version block", () => {
	it("states the running pi version", () => {
		const lines = renderHeader(THEME, makeRef(), 200, 60);
		expect(lines.some((l) => l.includes("[Version]"))).toBe(true);
		expect(lines.some((l) => l.includes(`v${VERSION}`))).toBe(true);
	});

	it("has no Latest row and asks no update question", () => {
		const lines = renderHeader(THEME, makeRef(), 200, 60);
		expect(lines.join("\n")).not.toContain("Latest");
		expect(lines.join("\n")).not.toContain("Local:");
	});
});

// ── The model scope, from ctx.scopedModels ───────────────────────────────────
//
// This section used to be scraped: a `console.log` patch watched for pi's
// `Model scope:` line, and pi's own resource components were intercepted out of
// its container. Both predate `ctx.scopedModels` — the same set the
// `/scoped-models` command lists — which is handed to us on the context.

describe("modelScopeSection", () => {
	it("lists the scoped models the way /scoped-models does", () => {
		const section = modelScopeSection([
			{ model: { id: "claude-sonnet-4-5" } },
			{ model: { id: "gpt-5" }, thinkingLevel: "high" },
		] as never);

		expect(section).toEqual({
			name: "Models",
			items: ["claude-sonnet-4-5", "gpt-5:high"],
		});
	});

	it("is absent when the session has no model scope", () => {
		expect(modelScopeSection([])).toBeUndefined();
		// A host without the property (older pi) is the same answer as no scope.
		expect(modelScopeSection(undefined)).toBeUndefined();
	});

	it("ignores an entry with no model behind it", () => {
		expect(modelScopeSection([{ thinkingLevel: "low" }] as never)).toBeUndefined();
		expect(
			modelScopeSection([{ model: { id: "gpt-5" } }, { thinkingLevel: "low" }] as never),
		).toEqual({ name: "Models", items: ["gpt-5"] });
	});
});

// ── The animation timer ──────────────────────────────────────────────────────

describe("patchStartupListing animation timer", () => {
	afterEach(() => vi.useRealTimers());

	it("stops redrawing once the logo settles when no sections arrive (quietStartup)", () => {
		vi.useFakeTimers();
		const { tui, requestRender } = makeTui();
		patchStartupListing(tui, { ...makeRef(), revealed: false });

		vi.advanceTimersByTime(3_000);
		const renderCountAfterSettle = requestRender.mock.calls.length;
		vi.advanceTimersByTime(3_000);
		expect(requestRender.mock.calls.length).toBe(renderCountAfterSettle);
	});

	it("restarts the timer when sections are revealed after the logo settled", () => {
		vi.useFakeTimers();
		const { tui, requestRender } = makeTui();
		const ref: ListingRef = { ...makeRef(), revealed: false };
		// Real renders settle the listing, which is what stops the restarted timer
		requestRender.mockImplementation(() => renderHeader(THEME, ref, 200, 60));
		patchStartupListing(tui, ref);
		vi.advanceTimersByTime(3_000);

		revealStartupListing(tui, ref, [{ name: "Models", items: ["claude-sonnet-4-5"] }]);
		vi.advanceTimersByTime(500);
		expect(ref.revealed).toBe(true);
		const renderCountAfterReveal = requestRender.mock.calls.length;
		vi.advanceTimersByTime(200);
		expect(requestRender.mock.calls.length).toBeGreaterThan(renderCountAfterReveal);

		vi.advanceTimersByTime(2_000); // past the text fade-in
		const renderCountAfterFade = requestRender.mock.calls.length;
		vi.advanceTimersByTime(2_000);
		expect(requestRender.mock.calls.length).toBe(renderCountAfterFade);
	});

	it("restarts from scratch when the header is rebuilt (new session, /reload)", () => {
		vi.useFakeTimers();
		const { tui } = makeTui();
		const ref: ListingRef = { ...makeRef(), revealed: false };
		patchStartupListing(tui, ref);
		vi.advanceTimersByTime(100);
		const frameMidAnimation = ref.frame;
		expect(frameMidAnimation).toBeGreaterThan(0);

		// The header factory is re-invoked with a fresh renderer and ref — what
		// a new session, `/reload` or any other `setHeader()` replacement does.
		// A `tuiMode` switch is not one of those: pi re-mounts the header it
		// already has, which is why nothing here may hold on to a renderer.
		const firstRenders = tui.requestRender.mock.calls.length;
		expect(firstRenders).toBe(frameMidAnimation);

		const second = makeTui();
		const ref2: ListingRef = { ...makeRef(), revealed: false };
		patchStartupListing(second.tui, ref2);
		vi.advanceTimersByTime(100);

		expect(ref2.frame).toBeGreaterThan(0);
		// The first splash stopped with its own renderer: only the second one is
		// requesting frames now.
		expect(tui.requestRender.mock.calls.length).toBe(firstRenders);
	});

	it("stopStartupListing stops both the frame timer and a pending reveal", () => {
		vi.useFakeTimers();
		const { tui, requestRender } = makeTui();
		const ref: ListingRef = { ...makeRef(), revealed: false };
		patchStartupListing(tui, ref);
		revealStartupListing(tui, ref, [{ name: "Models", items: ["m"] }]);

		stopStartupListing();
		const renders = requestRender.mock.calls.length;
		vi.advanceTimersByTime(3_000);

		expect(requestRender.mock.calls.length).toBe(renders);
		expect(ref.revealed).toBe(false);
	});
});

// ── Nothing else happens on the splash path ──────────────────────────────────

describe("startup splash side effects", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) }) as never));
		// Nothing may print: on fullscreen a console write lands inside the frame,
		// and the whole reason the scrape died is that writing to stdout was the
		// only way to learn what pi had loaded.
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("makes no network request and leaves the console alone", async () => {
		const { tui } = makeTui();
		const ref = makeRef();
		patchStartupListing(tui, ref);
		revealStartupListing(tui, ref, [{ name: "Models", items: ["m"] }]);
		renderHeader(THEME, ref, 200, CONTENT_ONLY_HEIGHT);
		await Promise.resolve();

		expect(fetch).not.toHaveBeenCalled();
		// Patched by anyone? `console.log.name` reads "log" only for the original.
		expect(console.log.name).toBe("log");
		expect(process.stdout.write).not.toHaveBeenCalled();
	});
});

// ── The header renders finished content with no reveal pending ───────────────

describe("renderHeader at rest", () => {
	it("renders the logo at rest with no listing and no stray blank rows", () => {
		const ref: ListingRef = { ...makeRef(), frame: LOGO_SETTLE_FRAME, revealed: false };

		const lines = renderHeader(THEME, ref, 200, CONTENT_ONLY_HEIGHT);

		// Logo rows plus their separator — and, unlike frame 0, actually drawn.
		// (Stripped: a truecolor logo colours each block character separately.)
		expect(lines).toHaveLength(LOGO.length + 1);
		expect(stripAnsi(lines.join("\n"))).toContain("████");
		expect(lines.filter((l) => l.includes("[") && l.includes("]"))).toEqual([]);
	});
});
