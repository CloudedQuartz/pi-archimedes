/**
 * Frame-width audit for the `/agents` overlay.
 *
 * Automated stand-in for a `PI_TUI_WRITE_LOG` capture: drive the real panel
 * factory through every screen with hostile content, measure **every produced
 * line** with pi-tui's own `visibleWidth` (what the terminal draws), and require
 * it to fit the frame. A line wider than the frame is hard-wrapped by the
 * terminal, which pushes the closing border to the next row and shifts the whole
 * overlay — the exact failure the old `.length`-based width maths produced for
 * cursor markers, OSC 8 hyperlinks and east-asian text.
 */

import { describe, it, expect } from "vitest";
import {
  CURSOR_MARKER,
  stripTerminalSequences,
  visibleWidth as tuiVisibleWidth,
} from "@earendil-works/pi-tui";
import { createAgentPanel } from "./agent-panel.js";
import type { AgentConfig } from "./agents.js";

// One entry per failure mode of the deleted width maths.
const URL = `https://example.com/${"segment/".repeat(12)}`;

function agent(name: string, description: string, systemPrompt: string): AgentConfig {
  return {
    name,
    description,
    systemPrompt,
    model: "anthropic/claude-opus-4.5",
    tools: ["read", "bash"],
    source: "user",
    filePath: `/tmp/agents/${name}.md`,
  };
}

const AGENTS: AgentConfig[] = [
  agent("検証エージェント", "日本語の説明テキスト".repeat(8), "説".repeat(200)),
  agent(`\x1b]8;;${URL}\x07doc-link\x1b]8;;\x07`, `see \x1b]8;;${URL}\x07here\x1b]8;;\x07 for details`, "plain body"),
  agent("\x1b[31mred-name\x1b[0m", "\x1b[33mcoloured description\x1b[0m tail", "\x1b[32mgreen body line\x1b[0m\nsecond"),
  agent("wide-mixed", `説明 \x1b]8;;${URL}\x07link\x1b]8;;\x07 ${"語".repeat(120)}`, `${"文".repeat(90)}\nmore`),
];

/** A theme that actually colourises, so SGR sequences are in the measured lines. */
const theme = {
  fg: (token: string, text: string) =>
    `\x1b[38;2;120;160;200m${text}\x1b[0m`.replace("120;160;200", token === "accent" ? "80;120;255" : "120;160;200"),
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
};

const RAW = {
  enter: "\r",
  escape: "\x1b",
  slash: "/",
  n: "n",
  e: "e",
  d: "d",
  down: "\x1b[B",
};

function makePanel() {
  return createAgentPanel(
    AGENTS,
    [],
    [],
    null,
    "/tmp/agents",
    null,
    { requestRender: () => {} },
    theme,
    () => {},
    [{ id: "claude-opus-4.5", provider: "anthropic", fullId: "anthropic/claude-opus-4.5" }],
    [{ name: "read", description: "Read a file" }],
  );
}

interface Violation {
  screen: string;
  frameWidth: number;
  row: number;
  measured: number;
}

/** Every produced line of a bordered overlay must land on the frame exactly. */
function audit(screen: string, frameWidth: number, lines: string[]): Violation[] {
  const bad: Violation[] = [];
  lines.forEach((line, row) => {
    const measured = tuiVisibleWidth(line);
    if (measured !== frameWidth) bad.push({ screen, frameWidth, row, measured });
  });
  return bad;
}

// ── Capture content checks ───────────────────────────────────────────────────
//
// A width audit only proves something if the captured frame is the frame it
// means to measure. The panel's input gates are strict — list search and the name
// field accept printable ASCII only (`handleListInput` / `handleNameInput` test
// `data.length === 1 && data >= " " && data <= "~"`), and in list mode `n`, `c`
// and `d` are commands even while filtering — so a keystroke can be silently
// dropped and leave the capture showing a placeholder instead of typed content.
// Every capture therefore declares the content it expects, and a capture that
// does not contain it fails instead of auditing the wrong frame.

/** Drawn text of the list's search bar, or undefined when there is no bar. */
function searchRow(raw: string[]): string | undefined {
  return raw.map((l) => stripTerminalSequences(l)).find((l) => l.includes("◎"));
}

function hasMarker(raw: string[]): boolean {
  return raw.some((l) => l.includes(CURSOR_MARKER));
}

function drawnIncludes(raw: string[], needle: string): boolean {
  return raw.some((l) => stripTerminalSequences(l).includes(needle));
}

describe("/agents frame-width audit", () => {
  const FRAME_WIDTHS = [40, 60, 84, 100];

  it("keeps every produced line on the frame, on every screen", () => {
    const violations: Violation[] = [];
    const over: Violation[] = [];

    for (const frameWidth of FRAME_WIDTHS) {
      // Each screen is reached through the panel's own input handler, so the
      // captured frames are what the user would see on that screen. `expect`
      // runs before the width measurement: measure the frame we claim to measure.
      const capture = (
        screen: string,
        drive: (panel: ReturnType<typeof makePanel>) => void,
        expectContent?: (raw: string[]) => string | null,
      ) => {
        const panel = makePanel();
        drive(panel);
        const lines = panel.render(frameWidth);
        const problem = expectContent?.(lines);
        expect(problem ?? null, `${screen}@${frameWidth} is not the capture this audit measures`).toBeNull();
        const bad = audit(screen, frameWidth, lines);
        violations.push(...bad);
        over.push(...bad.filter((v) => v.measured > frameWidth));
      };

      capture("list", () => {});

      // The row that carries the cursor marker: `/` opens the search bar with the
      // placeholder, and the wide keystrokes that follow are dropped by the
      // ASCII gate.
      capture(
        "list:searching",
        (p) => {
          p.handleInput(RAW.slash);
          for (const ch of "検証") p.handleInput(ch);
        },
        (raw) => {
          // Tripwire for that gate: if list search ever accepts wide input, this
          // capture has to feed the wide query — otherwise a CJK search row goes
          // unmeasured and the frame-width claim goes stale again.
          if (!hasMarker(raw)) return "search bar (and its CURSOR_MARKER) not rendered";
          const row = searchRow(raw);
          if (!row?.includes("type to filter..."))
            return `search bar is not the empty-query placeholder: ${JSON.stringify(row?.trim())}`;
          return null;
        },
      );

      // A populated search row with a filtered result set. `k` is printable ASCII
      // (so the gate accepts it) and is not a list command, unlike `doc` / `link`
      // / `new`, whose first letter switches screen before it reaches the query.
      capture(
        "list:filter",
        (p) => {
          p.handleInput(RAW.slash);
          for (const ch of "k") p.handleInput(ch);
        },
        (raw) => {
          const row = searchRow(raw);
          if (!row?.includes("◎ k")) return `search bar does not show the query: ${JSON.stringify(row?.trim())}`;
          if (row.includes("type to filter...")) return "search bar still shows the placeholder";
          if (!drawnIncludes(raw, "doc-link")) return "filtered list lost the OSC 8 fixture row";
          if (drawnIncludes(raw, "検証エージェント")) return "filter did not narrow the list";
          if (drawnIncludes(raw, "No agents found")) return "query matched nothing, so the populated row is unmeasured";
          return null;
        },
      );

      // The empty-state rows a live filter can produce.
      capture(
        "list:no-matches",
        (p) => {
          p.handleInput(RAW.slash);
          for (const ch of "zzq") p.handleInput(ch);
        },
        (raw) => {
          if (!drawnIncludes(raw, "◎ zzq")) return "search bar does not show the query";
          if (!drawnIncludes(raw, "No agents found")) return "empty-state row missing: the query filtered nothing";
          return null;
        },
      );

      // The name field takes ASCII too, so the echo has to be asserted with ASCII.
      capture(
        "name-input",
        (p) => {
          p.handleInput(RAW.n);
          for (const ch of "new-agent") p.handleInput(ch);
        },
        (raw) => {
          if (!hasMarker(raw)) return "name input box (and its CURSOR_MARKER) not rendered";
          if (!drawnIncludes(raw, "new-agent")) return "typed name not echoed into the input box";
          return null;
        },
      );

      capture(
        "detail",
        (p) => {
          p.handleInput(RAW.enter);
          p.handleInput(RAW.down);
          p.handleInput(RAW.enter);
        },
        (raw) => (drawnIncludes(raw, "Agent:") ? null : "detail screen not rendered"),
      );

      capture(
        "edit",
        (p) => {
          p.handleInput(RAW.enter);
          p.handleInput(RAW.e);
        },
        (raw) => (drawnIncludes(raw, "Edit:") ? null : "edit screen not rendered"),
      );

      capture(
        "confirm-delete",
        (p) => {
          p.handleInput(RAW.d);
        },
        (raw) => (drawnIncludes(raw, "Delete") ? null : "confirm-delete screen not rendered"),
      );
    }

    // The marker line is the shape that used to measure ten columns too wide;
    // assert one is actually in the captured frames, so a passing audit cannot
    // mean the fixtures silently stopped containing one.
    const probe = makePanel();
    probe.handleInput(RAW.slash);
    expect(probe.render(84).some((line) => line.includes(CURSOR_MARKER))).toBe(true);

    const summary = (list: Violation[]) =>
      list.slice(0, 6).map((v) => `${v.screen}@${v.frameWidth}:row${v.row}=${v.measured}`).join(", ");
    expect(
      over,
      `${over.length}/${violations.length} off-frame line(s) [wider than the frame]: ${summary(over)}`,
    ).toEqual([]);
    expect(violations, `${violations.length} off-frame line(s) total: ${summary(violations)}`).toEqual([]);
  });
});
