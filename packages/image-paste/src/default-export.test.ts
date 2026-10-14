import { describe, expect, it, vi, beforeEach } from "vitest";

// The standalone session_start handler drives the native-paste restore, so the
// wiring test mocks that module (hermetic: nothing may touch the real
// ~/.pi/agent/keybindings.json from a unit test) and asserts the call.
vi.mock("./keybinding-offer.js", () => ({
  runNativePasteRestore: vi.fn(async () => ({ kind: "suppressed" })),
}));

const { runNativePasteRestore } = await import("./keybinding-offer.js");
const defaultExport = (await import("./index.js")).default;

describe("image-paste default export (standalone factory)", () => {
	it("is a function that registers paste + per-session lifecycle on the pi extension", () => {
		expect(typeof defaultExport).toBe("function");

		const on = vi.fn();
		const registerShortcut = vi.fn();
		const registerMessageRenderer = vi.fn();

		const pi = { on, registerShortcut, registerMessageRenderer } as any;

		defaultExport(pi);

		// registerImagePaste wires the preview renderer + shortcuts
		expect(registerMessageRenderer).toHaveBeenCalled();
		expect(registerShortcut).toHaveBeenCalled();

		// input handler (from registerImagePaste) + session lifecycle handlers
		const events = on.mock.calls.map((c: Array<unknown>) => c[0]);
		expect(events).toEqual(
			expect.arrayContaining(["input", "session_start", "session_shutdown"]),
		);
	});

	it("resets the per-session queue on session_start and clears it on shutdown", () => {
		const on = vi.fn();
		const pi = { on, registerShortcut: vi.fn(), registerMessageRenderer: vi.fn() } as any;
		defaultExport(pi);

		const startHandler = on.mock.calls.find((c: Array<unknown>) => c[0] === "session_start")?.[1];
		const shutdownHandler = on.mock.calls.find((c: Array<unknown>) => c[0] === "session_shutdown")?.[1];
		expect(typeof startHandler).toBe("function");
		expect(typeof shutdownHandler).toBe("function");

		// Must not throw when wired to a session context
		expect(() => (startHandler as (...a: unknown[]) => unknown)({}, { hasUI: true })).not.toThrow();
		expect(() => (shutdownHandler as (...a: unknown[]) => unknown)({}, {})).not.toThrow();
	});
});

// ── the standalone call site for restoreNativePaste (ADR 0030 amendment) ───
//
// A standalone install has no meta factory, so image-paste's OWN
// session_start registration is what hands ctrl+v back when
// archimedes.imagePaste.suppressNativePaste is false. The handler must be
// registered at the top level of the factory — a handler nested inside another
// session_start accumulates on /reload (AGENTS.md).
describe("image-paste default export — native-paste restore call site", () => {
	beforeEach(() => {
		vi.mocked(runNativePasteRestore).mockClear();
	});

	it("registers its session_start handler at the top level of the factory (never nested)", () => {
		const on = vi.fn();
		defaultExport({ on, registerShortcut: vi.fn(), registerMessageRenderer: vi.fn() } as any);

		// Registered during the factory call itself — before any session ran.
		const startRegistrations = on.mock.calls.filter((c: Array<unknown>) => c[0] === "session_start");
		expect(startRegistrations.length).toBeGreaterThanOrEqual(1);
	});

	it("runs the restore once per session_start with that session's ctx", async () => {
		const on = vi.fn();
		defaultExport({ on, registerShortcut: vi.fn(), registerMessageRenderer: vi.fn() } as any);

		const startHandler = on.mock.calls.find((c: Array<unknown>) => c[0] === "session_start")?.[1] as (
			event: unknown,
			ctx: unknown,
		) => unknown;
		const ctx = { hasUI: true, mode: "tui" };
		await startHandler({}, ctx);

		expect(runNativePasteRestore).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runNativePasteRestore).mock.calls[0]?.[0]).toBe(ctx);
	});

	it("session_start still resolves when the restore rejects (a broken keybindings.json must not kill the session)", async () => {
		vi.mocked(runNativePasteRestore).mockRejectedValueOnce(new Error("boom"));
		const on = vi.fn();
		defaultExport({ on, registerShortcut: vi.fn(), registerMessageRenderer: vi.fn() } as any);

		const startHandler = on.mock.calls.find((c: Array<unknown>) => c[0] === "session_start")?.[1] as (
			event: unknown,
			ctx: unknown,
		) => Promise<void>;

		let thrown: unknown = null;
		try {
			await startHandler({}, { hasUI: true });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeNull();
	});
});