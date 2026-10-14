import { describe, expect, it, vi } from "vitest";
import defaultExport from "./index.js";

describe("ask default export (standalone factory)", () => {
	it("is a function that registers the ask extension (registerAsk subscribes its own session events)", () => {
		expect(typeof defaultExport).toBe("function");

		const on = vi.fn();
		const registerTool = vi.fn();
		// `events` is the host handle the relay subscribes its ASK_REQUEST
		// listener on — required on every pi this package declares support for.
		const subscribe = vi.fn(() => () => {});
		const pi = { on, registerTool, events: { emit: vi.fn(), on: subscribe } } as any;

		defaultExport(pi);

		// ask tool registered
		expect(registerTool).toHaveBeenCalled();
		// the subagent ask relay subscribed on the host handle
		expect(subscribe).toHaveBeenCalledWith("archimedes:ask_request", expect.any(Function));

		// registerAsk wires its own session lifecycle internally
		const events = on.mock.calls.map((c: Array<unknown>) => c[0]);
		expect(events).toEqual(
			expect.arrayContaining(["session_start", "turn_start", "session_shutdown"]),
		);
	});
});