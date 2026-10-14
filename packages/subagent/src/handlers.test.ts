import { describe, it, expect } from "vitest";
import { extractArgsPreview } from "./handlers.js";

// ── extractArgsPreview ──────────────────────────────────────────────────────

describe("extractArgsPreview", () => {
  // The preview feeds a transcript row, and the row is what decides how much of
  // it fits (`RowBlock` cuts at the width pi renders at). A cap here is therefore
  // a second, invisible limit: cut it tighter than any terminal is wide and the
  // row stops short of the frame with no cut marker, which is the defect #108
  // set out to remove. pi's own bash row keeps the command whole for the same
  // reason. It stays bounded, because the preview is carried in the streamed
  // progress object for the life of the run.
  it("keeps enough of a long command for a wide frame to draw", () => {
    const long = "a".repeat(300);
    expect(extractArgsPreview(long)).toBe(long);
  });

  it("still bounds what it returns, since the preview is streamed", () => {
    const preview = extractArgsPreview("a".repeat(100_000));
    expect(preview.length).toBeLessThan(1_000);
  });

  it("bounds the serialised form of object args too", () => {
    const preview = extractArgsPreview({ a: "b".repeat(100_000), c: 1 });
    expect(preview.length).toBeLessThan(1_000);
    expect(preview.length).toBeGreaterThanOrEqual(300);
  });

  it("replaces newlines in string args", () => {
    expect(extractArgsPreview("hello\nworld")).toBe("hello world");
  });

  it("replaces newlines in single-key object value", () => {
    const args = { command: "cat file.txt\ngrep -A5 \"test\"" };
    const result = extractArgsPreview(args);
    expect(result).not.toContain("\n");
    expect(result).toBe("cat file.txt grep -A5 \"test\"");
  });

  it("replaces newlines in multi-key longest string value", () => {
    const args = { short: "x", long: "hello\nworld\nfoo" };
    expect(extractArgsPreview(args)).toBe("hello world foo");
  });

  it("handles number and boolean values", () => {
    expect(extractArgsPreview({ count: 42 })).toBe("42");
    expect(extractArgsPreview({ enabled: true })).toBe("true");
  });
});
