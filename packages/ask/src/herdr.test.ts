import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emitBlocked, blockedLabel } from "./herdr.js";

// ── blockedLabel ────────────────────────────────────────────────────────────

describe("blockedLabel", () => {
	it("uses the first question, collapsed to a single line", () => {
		expect(blockedLabel([{ question: "  Which\n\tframework?  " }])).toBe("Which framework?");
	});

	it("truncates long questions at 80 chars with an ellipsis", () => {
		const label = blockedLabel([{ question: "a".repeat(120) }]);
		expect(label).toHaveLength(80);
		expect(label.endsWith("…")).toBe(true);
	});

	it("keeps 80-char questions intact", () => {
		const q = "a".repeat(80);
		expect(blockedLabel([{ question: q }])).toBe(q);
	});

	it("falls back to 'question' for a missing or blank first question", () => {
		expect(blockedLabel([])).toBe("question");
		expect(blockedLabel([{ question: "   " }])).toBe("question");
	});
});

// ── emitBlocked ─────────────────────────────────────────────────────────────

describe("emitBlocked", () => {
	it("emits 'herdr:blocked' on pi.events with the label only when active", () => {
		const emit = vi.fn();
		const pi = { events: { emit } } as unknown as ExtensionAPI;

		emitBlocked(pi, true, "Which?");
		emitBlocked(pi, false);

		expect(emit).toHaveBeenCalledTimes(2);
		expect(emit).toHaveBeenNthCalledWith(1, "herdr:blocked", { active: true, label: "Which?" });
		expect(emit).toHaveBeenNthCalledWith(2, "herdr:blocked", { active: false, label: undefined });
	});
});
