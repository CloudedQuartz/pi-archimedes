import { describe, it, expect, vi, afterEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

// pi-tui — Text/Spacer/Container must be real classes for the instanceof checks
vi.mock("@earendil-works/pi-tui", () => ({
	Text: class Text {
		render(): string[] {
			return ["rendered"];
		}
	},
	Spacer: class Spacer {},
	Container: class Container {
		children: unknown[] = [];
		addChild(c: unknown) {
			this.children.push(c);
			return this;
		}
		clear() {
			this.children = [];
			return this;
		}
	},
	truncateToWidth: (s: string, w: number) => s.slice(0, w),
	visibleWidth: (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length,
	// core/text's stripAnsi delegates the sequences its own patterns miss here;
	// the mock keeps the same SGR-only semantics as visibleWidth above.
	stripTerminalSequences: (s: string) => s.replace(/\x1b\[[0-9;]*m/g, ""),
}));

// version — no network in tests
vi.mock("./version.js", () => ({
	fetchLatestVersion: vi.fn().mockResolvedValue(undefined),
	compareVersions: () => 0,
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { Text, Container } from "@earendil-works/pi-tui";
import { stripAnsi } from "@pi-archimedes/core/text";
import { patchStartupListing, renderHeader, settleHeader, CONTENT_ONLY_HEIGHT, type ListingRef } from "./index.js";
import { LOGO, LOGO_SETTLE_FRAME } from "./logo.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeTui(): { tui: any; resources: any; header: any } {
	// pi ≥0.84 layout: documentContainer → [headerContainer, loadedResourcesContainer, chatContainer]
	const header = new Container();
	const resources = new Container();
	const chat = new Container();
	const doc = new Container();
	doc.children.push(header, resources, chat);
	const tui = {
		terminal: { rows: 24 },
		children: [doc],
		requestRender: vi.fn(),
	};
	return { tui, resources, header };
}

function makeRef(): ListingRef {
	return {
		sections: [],
		frame: 0,
		revealed: true, // skip the debounce timer path
		revealedAt: 0,
		scaffoldAt: 0,
		settled: false,
	};
}

/** Fake ExpandableText: render() returns whatever the current state yields. */
function makeSectionComponent(renderLines: string[], opts: { setExpanded?: ReturnType<typeof vi.fn>; getExpandedText?: () => string } = {}): any {
	const comp: any = new (Text as any)();
	comp.render = () => renderLines;
	if (opts.setExpanded) comp.setExpanded = opts.setExpanded;
	if (opts.getExpandedText) comp.getExpandedText = opts.getExpandedText;
	return comp;
}

const THEME = {
	fg: (_token: string, t: string) => t,
	getFgAnsi: (_token: string) => "",
} as any;

let lastResources: any;
const after = () => {
	// Stop the animation interval + any pending debounce timer
	const ANIM_INTERVAL = Symbol.for("splashscreen:animInterval");
	const DEBOUNCE_TIMER = Symbol.for("splashscreen:debounceTimer");
	if (lastResources?.[ANIM_INTERVAL]) clearInterval(lastResources[ANIM_INTERVAL]);
	if (lastResources?.[DEBOUNCE_TIMER]) clearTimeout(lastResources[DEBOUNCE_TIMER]);
	lastResources = undefined;
};
afterEach(after);

// ── patchStartupListing: section text extraction ─────────────────────────────

describe("patchStartupListing section parsing", () => {
	it("forces expansion via setExpanded when the getExpandedText method is absent (pi ≥0.99)", () => {
		const { tui, resources } = makeTui();
		lastResources = resources;
		const ref = makeRef();
		patchStartupListing(tui, THEME, ref);

		// pi ≥0.99 ExpandableText: text builders live in the constructor,
		// the component starts collapsed. render() after setExpanded(true)
		// returns the full per-item body.
		const setExpanded = vi.fn();
		const comp = makeSectionComponent(
			["[Skills]", "  /home/u/skills/alpha/SKILL.md", "  /home/u/skills/beta/SKILL.md"],
			{ setExpanded },
		);
		resources.addChild(comp);

		expect(setExpanded).toHaveBeenCalledWith(true);
		expect(ref.sections).toEqual([{ name: "Skills", items: ["alpha", "beta"] }]);
		// Section consumed by the splash — original component not added
		expect((resources as any).children.length).toBe(0);
	});

	it("prefers the getExpandedText method when present (older pi)", () => {
		const { tui, resources } = makeTui();
		lastResources = resources;
		const ref = makeRef();
		patchStartupListing(tui, THEME, ref);

		const setExpanded = vi.fn();
		const comp = makeSectionComponent(
			["[Skills]", "  collapsed-should-not-be-read"],
			{
				setExpanded,
				getExpandedText: () => "[Skills]\n  /home/u/skills/alpha/SKILL.md",
			},
		);
		resources.addChild(comp);

		expect(setExpanded).not.toHaveBeenCalled();
		expect(ref.sections).toEqual([{ name: "Skills", items: ["alpha"] }]);
	});

	it("splits a collapsed comma-joined body when no expansion API exists (safety net)", () => {
		const { tui, resources } = makeTui();
		lastResources = resources;
		const ref = makeRef();
		patchStartupListing(tui, THEME, ref);

		// No setExpanded, no getExpandedText — render() yields the collapsed body
		const comp = makeSectionComponent(["[Skills]", "  alpha, beta, gamma"]);
		resources.addChild(comp);

		expect(ref.sections).toEqual([{ name: "Skills", items: ["alpha", "beta", "gamma"] }]);
		expect((resources as any).children.length).toBe(0);
	});

	it("does not swallow a pi diagnostic whose body mentions a bracketed word", () => {
		const { tui, resources } = makeTui();
		lastResources = resources;
		const ref = makeRef();
		patchStartupListing(tui, THEME, ref);

		// pi's own `[Extension issues]` warning: its title is out of the
		// section shape, but its body is arbitrary text from the failing
		// extension. Reading "[Broken]" as a header here would hide the error.
		const comp = makeSectionComponent([
			"[Extension issues]",
			"  Cannot find module '/tmp/[Broken]/index.ts'",
		]);
		resources.addChild(comp);

		expect((resources as any).children).toContain(comp);
		expect(ref.sections).toEqual([]);
	});

	it("passes non-section text through to the original addChild", () => {
		const { tui, resources } = makeTui();
		lastResources = resources;
		const ref = makeRef();
		patchStartupListing(tui, THEME, ref);

		const comp = makeSectionComponent(["some random text"]);
		resources.addChild(comp);

		expect((resources as any).children).toContain(comp);
		expect(ref.sections).toEqual([]);
	});

	it("merges items from repeated section components", () => {
		const { tui, resources } = makeTui();
		lastResources = resources;
		const ref = makeRef();
		patchStartupListing(tui, THEME, ref);

		resources.addChild(makeSectionComponent(["[Skills]", "  alpha, beta"]));
		resources.addChild(makeSectionComponent(["[Skills]", "  beta, gamma"]));

		expect(ref.sections).toEqual([{ name: "Skills", items: ["alpha", "beta", "gamma"] }]);
	});
});

describe("renderHeader section set", () => {
	// The rendered set is whatever the addChild patch captured — pi decides
	// which sections exist, so nothing here may assert a fixed list.
	const linesFor = (sections: ListingRef["sections"]): string[] =>
		renderHeader(THEME, { ...makeRef(), sections }, 200, 60);

	it("renders captured sections in capture order", () => {
		// pi 1.2.0 emits Context, Skills, Prompts, Extensions — note Skills
		// before Prompts, which a hardcoded display order used to invert.
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

	it("renders nothing but the version block when no section was captured", () => {
		const lines = linesFor([]);
		for (const phantom of ["Models", "Context", "Prompts", "Skills", "Extensions", "Themes"]) {
			expect(lines.some((l) => l.includes(`[${phantom}]`))).toBe(false);
		}
	});

	it("skips a captured section whose item list is empty", () => {
		const lines = linesFor([
			{ name: "Skills", items: [] },
			{ name: "Context", items: ["AGENTS.md"] },
		]);
		expect(lines.some((l) => l.includes("[Skills]"))).toBe(false);
		expect(lines.some((l) => l.includes("[Context]"))).toBe(true);
	});
});

describe("settleHeader", () => {
	// The state a frame-bounded screen hands to renderHeader when the splash is
	// suppressed: nothing will animate it, so it must already be finished.
	it("leaves the ref where a completed splash would, not at frame 0", () => {
		const ref: ListingRef = {
			...makeRef(),
			frame: 3,
			sections: [{ name: "Skills", items: ["tdd"] }],
			cachedLines: ["stale"],
			cachedWidth: 80,
			cachedHeight: 24,
		};

		settleHeader(ref);

		expect(ref.frame).toBe(LOGO_SETTLE_FRAME);
		expect(ref.revealed).toBe(false);
		expect(ref.sections).toEqual([]);
		expect(ref.cachedLines).toBeUndefined();
	});

	it("renders the logo at rest with no listing and no stray blank rows", () => {
		const ref: ListingRef = { ...makeRef(), frame: 0, revealed: false };
		settleHeader(ref);

		const lines = renderHeader(THEME, ref, 200, CONTENT_ONLY_HEIGHT);

		// Logo rows plus their separator — and, unlike frame 0, actually drawn.
		// (Stripped: a truecolor logo colours each block character separately.)
		expect(lines).toHaveLength(LOGO.length + 1);
		expect(stripAnsi(lines.join("\n"))).toContain("████");
		expect(lines.filter((l) => l.includes("[") && l.includes("]"))).toEqual([]);
	});
});

describe("patchStartupListing animation timer", () => {
	afterEach(() => vi.useRealTimers());

	it("stops redrawing once the logo settles when no sections arrive (quietStartup)", () => {
		vi.useFakeTimers();
		const { tui, resources } = makeTui();
		lastResources = resources;
		patchStartupListing(tui, THEME, { ...makeRef(), revealed: false });

		vi.advanceTimersByTime(3_000);
		const renderCountAfterSettle = tui.requestRender.mock.calls.length;
		vi.advanceTimersByTime(3_000);
		expect(tui.requestRender.mock.calls.length).toBe(renderCountAfterSettle);
	});

	it("restarts the timer when sections are revealed after the logo settled", () => {
		vi.useFakeTimers();
		const { tui, resources } = makeTui();
		lastResources = resources;
		const ref: ListingRef = { ...makeRef(), revealed: false };
		// Real renders settle the listing, which is what stops the restarted timer
		tui.requestRender.mockImplementation(() => renderHeader(THEME, ref, 200, 60));
		patchStartupListing(tui, THEME, ref);
		vi.advanceTimersByTime(3_000);

		resources.addChild(makeSectionComponent(["[Skills]", "  tdd"]));
		vi.advanceTimersByTime(500);
		expect(ref.revealed).toBe(true);
		const renderCountAfterReveal = tui.requestRender.mock.calls.length;
		vi.advanceTimersByTime(200);
		expect(tui.requestRender.mock.calls.length).toBeGreaterThan(renderCountAfterReveal);

		vi.advanceTimersByTime(2_000); // past the text fade-in
		const renderCountAfterFade = tui.requestRender.mock.calls.length;
		vi.advanceTimersByTime(2_000);
		expect(tui.requestRender.mock.calls.length).toBe(renderCountAfterFade);
	});
});
