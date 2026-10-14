import { describe, it, expect, vi } from "vitest";

// The logo module decides TRUECOLOR once, at import time, from the environment.
// Pin it, so the rows below are the *finished* rows a truecolor terminal shows
// rather than whatever the machine running the suite happens to advertise.
vi.hoisted(() => {
  process.env.COLORTERM = "truecolor";
});

import { Theme, VERSION } from "@earendil-works/pi-coding-agent";
import { renderHeader, modelScopeSection, type ListingRef } from "./index.js";
import { LOGO } from "./logo.js";

// ── The intro has to read as one listing ────────────────────────────────────
//
// The splash header sits in pi's `headerContainer`, and pi's own startup listing
// (`[Context]`, `[Skills]`, `[Prompts]`, `[Extensions]`) is the container
// straight below it (`interactive-mode.js:389-390`), so the two are drawn one
// under the other. They used to look like two documents: our rows set their
// label in `dim` and their values in `muted`, indented to the centre column the
// logo is centred on, while pi writes its rows from `showLoadedResources()`:
//
//   const sectionHeader = (name, color = "mdHeading") => theme.fg(color, `[${name}]`);
//   ... theme.fg("dim", `  ${labels.join(", ")}`) ...       // :1335-1341
//
// — the bracketed name in `mdHeading` on its own line, the values `dim` on the
// line under it at a two-space indent, both at column 1 (`ExpandableText(…, 0, 0)`
// followed by `Spacer(1)`, :1345-1347). These tests are that recipe, asserted on
// the rendered lines of a real header, so the two halves of the intro are the
// same listing rather than two listings that happen to share a screen.
//
// A real `Theme` instance from pi does the colouring here — not a stub. Two
// reasons: the claim being tested is about *which token* each row asks for, and
// `Theme` throws `Unknown theme color: <token>` for a token it does not have
// (`theme.js:212-216`), so a token that does not exist on the host cannot pass
// unnoticed. The colours below are arbitrary labels; every assertion compares
// against what the same instance renders, never against a hardcoded escape.

/** Placeholder palette: two slots that must not be confused with each other. */
const FG: Record<string, string> = {
  accent: "#aa77ff",
  border: "#7788ff",
  borderAccent: "#ff77aa",
  borderMuted: "#556677",
  success: "#44cc88",
  error: "#ff5555",
  warning: "#ffcc44",
  muted: "#999999",
  dim: "#6c7086",
  text: "",
  thinkingText: "#888899",
  searchMatchText: "#999999",
  userMessageText: "#eeeeee",
  customMessageText: "#999999",
  customMessageLabel: "#aa77ff",
  toolTitle: "#eeeeee",
  toolOutput: "#999999",
  mdHeading: "#ff8700",
  mdLink: "#7788ff",
  mdLinkUrl: "#6c7086",
  mdCode: "#44cc88",
  mdCodeBlock: "#cccccc",
  mdCodeBlockBorder: "#556677",
  mdQuote: "#999999",
  mdQuoteBorder: "#556677",
  mdHr: "#556677",
  mdListBullet: "#ffcc44",
  toolDiffAdded: "#44cc88",
  toolDiffRemoved: "#ff5555",
  toolDiffContext: "#999999",
  syntaxComment: "#666677",
  syntaxKeyword: "#aa77ff",
  syntaxFunction: "#7788ff",
  syntaxVariable: "#cccccc",
  syntaxString: "#44cc88",
  syntaxNumber: "#ffcc44",
  syntaxType: "#7788ff",
  syntaxOperator: "#cccccc",
  syntaxPunctuation: "#999999",
  thinkingOff: "#666677",
  thinkingMinimal: "#666677",
  thinkingLow: "#7788ff",
  thinkingMedium: "#aa77ff",
  thinkingHigh: "#ff8700",
  thinkingXhigh: "#ff5555",
  bashMode: "#44cc88",
};

const BG: Record<string, string> = {
  selectedBg: "#1a2033",
  searchMatchBg: "#3a3020",
  userMessageBg: "#1a2033",
  customMessageBg: "#201a33",
  toolPendingBg: "#222233",
  toolSuccessBg: "#1a3322",
  toolErrorBg: "#331a1a",
};

const WIDTH = 100;

/** A real pi `Theme`, at rest: past every animation ramp, colours are the tokens'. */
const makeTheme = (): Theme => new Theme(FG as never, BG as never, "truecolor", { name: "test" });

/** The ref the splash leaves behind once the reveal and the ramps have finished. */
const atRest = (sections: ListingRef["sections"]): ListingRef => ({
  sections,
  frame: 400,
  revealed: true,
  revealedAt: 0,
  scaffoldAt: 0,
  settled: false,
});

/** The rows with the escape sequences taken back off. */
const plain = (row: string): string => row.replace(/\x1b\[[0-9;]*m/g, "");

const models = (): ListingRef["sections"] => [
  modelScopeSection([
    { model: { id: "claude-sonnet-4-5" }, thinkingLevel: "high" },
    { model: { id: "gpt-5" } },
  ] as never)!,
];

describe("the intro rows follow pi's own listing recipe", () => {
  const theme = makeTheme();
  const lines = (sections: ListingRef["sections"]): string[] =>
    renderHeader(theme, atRest(sections), WIDTH);

  it("paints the bracketed name in the theme's mdHeading token, at column 1", () => {
    const rows = lines(models());
    // `theme.fg()` throws for a token the host does not define, so this
    // assertion doubles as the claim that pi 1.2.0 has `mdHeading`.
    expect(rows).toContain(theme.fg("mdHeading", "[Version]"));
    expect(rows).toContain(theme.fg("mdHeading", "[Models]"));
    for (const row of rows.filter((l) => plain(l).includes("["))) {
      expect(row.startsWith(" ")).toBe(false);
    }
  });

  it("takes every listing colour from the theme, not from an escape it wrote itself", () => {
    // ADR 0029: the header may not paste an escape it worked out on its own,
    // because that is a colour the theme cannot change. So each coloured listing
    // row has to open with an escape this very Theme emits for one of its own
    // foreground tokens.
    const openers = new Set(Object.keys(FG).map((token) => theme.getFgAnsi(token as never)));
    const listing = lines(models()).slice(LOGO.length + 1);
    for (const row of listing) {
      if (plain(row) === "") continue;
      const open = row.match(/^\x1b\[[0-9;]*m/)?.[0];
      expect(open, `row is not theme-coloured: ${JSON.stringify(row)}`).toBeDefined();
      expect(openers.has(open!), `escape ${JSON.stringify(open)} is nobody's token`).toBe(true);
    }
  });

  it("paints the values in the dim token on the row under the name, at pi's two-space indent", () => {
    const rows = lines(models());
    expect(rows).toContain(theme.fg("dim", `  v${VERSION}`));
    expect(rows).toContain(theme.fg("dim", "  claude-sonnet-4-5:high, gpt-5"));

    // The name and the value are different tokens in pi's recipe; if both rows
    // asked for the same one the listing would read flat.
    expect(theme.fg("mdHeading", "[Version]")).not.toBe(theme.fg("dim", "[Version]"));
  });

  it("gives each value its own row rather than laying the listing out in columns", () => {
    // pi writes `${sectionHeader(name)}\n${body}` — the body always starts on
    // the next row, so a section is two rows minimum and the name never shares
    // a row with a value.
    const rows = lines(models());
    for (const name of ["Version", "Models"]) {
      const at = rows.indexOf(theme.fg("mdHeading", `[${name}]`));
      expect(at, `[${name}] header missing`).toBeGreaterThanOrEqual(0);
      expect(plain(rows[at + 1]!)).toMatch(/^ {2}\S/);
    }
  });

  it("puts one blank row between our own sections, the way pi's Spacer(1) does", () => {
    const rows = lines(models());
    const version = rows.indexOf(theme.fg("mdHeading", "[Version]"));
    const modelsAt = rows.indexOf(theme.fg("mdHeading", "[Models]"));
    expect(rows.slice(version + 2, modelsAt)).toEqual([""]);
  });

  it("ends on its last content row, because pi's own listing supplies the gap below it", () => {
    // pi brackets the header container with `Spacer(1)` on both sides
    // (`interactive-mode.js:764-766`) and the resource listing opens with one
    // more, so padding our block with a trailing blank would double the gap
    // pi already draws — the vertical gap the intro is criticised for.
    const rows = lines(models());
    expect(rows.at(-1)).toBe(theme.fg("dim", "  claude-sonnet-4-5:high, gpt-5"));
  });

  it("adds no padding rows: the block is exactly the logo, a separator and the listing", () => {
    const rows = lines([]);
    expect(rows).toHaveLength(LOGO.length + 1 + 2);
    // The only blank is the separator under the logo — no top/bottom padding.
    expect(rows.filter((l) => l.trim() === "")).toHaveLength(1);
    expect(rows[0]!.trim()).not.toBe("");
    expect(rows.at(-1)).toBe(theme.fg("dim", `  v${VERSION}`));
  });

  it("keeps the logo centred above the listing, and the listing at column 1", () => {
    const rows = lines([]);
    const logoRow = rows[0]!;
    const indent = logoRow.length - logoRow.trimStart().length;
    // Centred means half the leftover on each side of the logo's own width.
    expect(indent).toBe(Math.floor((WIDTH - plain(LOGO[0]!).length) / 2));
    // The listing below it is not centred with it — pi writes its rows at column 1.
    expect(rows[LOGO.length + 1]).toBe(theme.fg("mdHeading", "[Version]"));
    expect(plain(rows[LOGO.length + 1]!)).toBe("[Version]");
  });
});
