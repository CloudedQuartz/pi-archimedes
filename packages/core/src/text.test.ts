import { describe, it, expect } from "vitest";
import { stripAnsi, isParentBorder, formatKey } from "./text.js";

// ── stripAnsi ───────────────────────────────────────────────────────────────

describe("stripAnsi", () => {
  it("strips CSI sequences", () => {
    expect(stripAnsi("\x1b[31mhello\x1b[0m")).toBe("hello");
  });

  it("strips multiple CSI sequences", () => {
    expect(stripAnsi("\x1b[1;32mred\x1b[0m \x1b[33myellow\x1b[0m")).toBe(
      "red yellow"
    );
  });

  it("strips OSC sequences", () => {
    expect(stripAnsi("before\x1b]0;title\x07after")).toBe("beforeafter");
  });

  it("strips OSC with ST (ESC \\)", () => {
    expect(stripAnsi("before\x1b]0;title\x1b\\after")).toBe("beforeafter");
  });

  it("strips DCS sequences", () => {
    expect(stripAnsi("before\x1bPdata\x07after")).toBe("beforeafter");
  });

  it("strips SOS sequences", () => {
    expect(stripAnsi("before\x1b^data\x07after")).toBe("beforeafter");
  });

  it("strips APC sequences", () => {
    expect(stripAnsi("before\x1b_data\x07after")).toBe("beforeafter");
  });

  it("strips PM sequences", () => {
    expect(stripAnsi("before\x1b\\data\x07after")).toBe("beforeafter");
  });

  it("strips character set escapes (ESC ( / ESC ))", () => {
    // The regex strips ESC( and ESC) but not the following charset designator
    expect(stripAnsi("before\x1b(Bafter")).toBe("beforeBafter");
    expect(stripAnsi("before\x1b)Bafter")).toBe("beforeBafter");
  });

  it("handles nested escapes", () => {
    expect(stripAnsi("\x1b[1m\x1b[31mhello\x1b[0m\x1b[0m")).toBe("hello");
  });

  it("returns empty string for empty input", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("returns input unchanged for no-escape string", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });

  it("trims leading and trailing whitespace", () => {
    expect(stripAnsi("  \x1b[31mhello\x1b[0m  ")).toBe("hello");
  });
});

// ── stripAnsi regression fence ───────────────────────────────────────────────
//
// stripAnsi is a wrapper, not a delegation: the startup section parser and the
// footer both consume its output, and they depend on the *whole* pattern set
// (pi-tui's stripTerminalSequences leaves DCS / SOS / PM and the charset
// designators in place, and it never trims). These assertions are the fence
// that keeps the wrapper honest — they must read the same before and after the
// pi-tui migration, and the DCS/SOS/APC/PM/charset/trim cases below are the
// ones a pure delegation would break.

describe("stripAnsi (wrapper fence)", () => {
  it("strips a DCS string terminated by ST as well as by BEL", () => {
    expect(stripAnsi("before\x1bPq;status\x1b\\after")).toBe("beforeafter");
  });

  it("strips an APC string terminated by ST", () => {
    expect(stripAnsi("before\x1b_privacy\x1b\\after")).toBe("beforeafter");
  });

  it("strips a SOS string terminated by ST", () => {
    expect(stripAnsi("before\x1b^message\x1b\\after")).toBe("beforeafter");
  });

  it("strips both charset designators and keeps the designator byte it names", () => {
    // Same shape as the case above: the pattern drops `ESC (` / `ESC )` and
    // leaves the designator character, which is what the section parser saw
    // before the wrapper existed.
    expect(stripAnsi("\x1b(B\x1b)0plain")).toBe("B0plain");
  });

  it("strips pi's own control sequences, so callers see only what is drawn", () => {
    // A captured frame line: SGR + the cursor marker (APC) + an OSC 8 link.
    const line = `\x1b[38;2;9;9;9m  ${"日本語"}\x1b[0m\x1b_pi:c\x07`;
    expect(stripAnsi(line)).toBe("日本語");
  });

  it("trims the padding a surface left behind the styling", () => {
    expect(stripAnsi("\x1b[90m│\x1b[0m   \n")).toBe("│");
  });
});

// ── stripAnsi: what the pi-tui pass adds ────────────────────────────────────
//
// The only *new* coverage the wrapper buys: a CSI sequence whose parameters use
// the `:` sub-parameter form, which our `[0-9;?]*` run stops at. Before the
// wrapper such an escape survived into the section parser's input; it is not
// part of the fence above.

describe("stripAnsi (pi-tui pass)", () => {
  it("strips an SGR sequence whose parameters use the colon form", () => {
    expect(stripAnsi("\x1b[38:2:255:0:0mred\x1b[0m")).toBe("red");
  });

  it("strips a private-mode CSI our pattern does not describe", () => {
    expect(stripAnsi("\x1b[>4;2mhello\x1b[0m")).toBe("hello");
  });
});

// ── isParentBorder ──────────────────────────────────────────────────────────

describe("isParentBorder", () => {
  it("returns true for border char", () => {
    expect(isParentBorder("─")).toBe(true);
  });

  it("returns true for border with SGR", () => {
    expect(isParentBorder("\x1b[90m─\x1b[0m")).toBe(true);
  });

  it("returns false for non-border", () => {
    expect(isParentBorder("hello")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isParentBorder("")).toBe(false);
  });
});

// ── formatKey ───────────────────────────────────────────────────────────────

describe("formatKey", () => {
  it("formats ctrl+a", () => {
    expect(formatKey("ctrl+a")).toBe("Ctrl+A");
  });

  it("formats alt+shift+f", () => {
    expect(formatKey("alt+shift+f")).toBe("Alt+Shift+F");
  });

  it("formats cmd as Cmd", () => {
    expect(formatKey("cmd")).toBe("Cmd");
  });

  it("formats meta as Cmd", () => {
    expect(formatKey("meta")).toBe("Cmd");
  });

  it("uppercases single char", () => {
    expect(formatKey("a")).toBe("A");
    expect(formatKey("z")).toBe("Z");
  });

  it("capitalizes multi-word", () => {
    expect(formatKey("escape")).toBe("Escape");
    expect(formatKey("enter")).toBe("Enter");
  });

  it("returns that key for undefined", () => {
    expect(formatKey(undefined)).toBe("that key");
  });
});
