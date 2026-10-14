import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCore } from "./index.js";
import { registerBridge } from "./bridge/index.js";
import { registerSelfUsage } from "./bridge/self-usage.js";

vi.mock("./bridge/index.js", () => ({
  registerBridge: vi.fn(),
}));
vi.mock("./bridge/self-usage.js", () => ({
  registerSelfUsage: vi.fn(),
}));

describe("registerCore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers bridge and self-usage", () => {
    const pi = { events: { emit: vi.fn(), on: vi.fn() } } as unknown as ExtensionAPI;
    registerCore(pi);
    expect(registerBridge).toHaveBeenCalledWith(pi);
    expect(registerSelfUsage).toHaveBeenCalledWith(pi);
  });
});
