/**
 * The `/archimedes` / `/plugins` settings panel must not change height as the
 * cursor moves.
 *
 * The bug (maintainer-reported, with terminal screenshots): `SettingsList` draws
 * the *selected* row's description itself, wrapped to `width - 4`
 * (pi-tui@1.2.0 `dist/components/settings-list.js:103-111`), and this panel
 * frames `list.render()` in a border (`settings-manager.ts`, `wrapWithBorder`).
 * One row with a 1-line description and the next with a description that wraps
 * meant the frame grew by a row and the whole row list shifted up.
 *
 * So the panel takes the description away from `SettingsList` and draws the area
 * itself, sized to the longest description in the set the filter is showing.
 * These tests only ever look at the produced frame — `render(width).length` and
 * the drawn cells — so they constrain the behaviour, not the implementation.
 *
 * How the description area is measured from the outside: render a fixture, then
 * render the same fixture with the `description` field removed from every item.
 * The rows, the label column and the values are identical in both, so the only
 * thing that can account for a height difference is the description area. Where
 * that arithmetic needs to be exact, the fixture carries no prompt descriptors —
 * an editable row's description gains the "Enter to type a value" affordance,
 * which is itself part of what the area has to fit (and is tested as such).
 *
 * The wrapping oracle is pi-tui's own `wrapTextWithAnsi` — the function
 * `SettingsList` uses — so the expected line count is derived from the same
 * measurement the panel is expected to match, never from a hard-coded count.
 */
import { describe, it, expect, vi } from "vitest";
import { stripTerminalSequences, wrapTextWithAnsi, type SettingItem } from "@earendil-works/pi-tui";
import { borderContentWidth } from "@pi-archimedes/core/overlay";
import { createSettingsManager, type PromptDescriptor } from "./settings-manager.js";

// ── What the list is actually handed ────────────────────────────────────────
//
// `SettingsList` may only draw a description if a row carries one, so the fix
// has to be visible in the rows themselves, not just in what this panel prints.
// Recording the constructor arguments is the only way to see them: the rows are
// built inside the component. The subclass delegates everything to pi's own
// class, so every other behaviour under test is pi's, unchanged.
const spy = vi.hoisted(() => ({ handed: [] as Array<Array<Record<string, unknown>>> }));

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const SettingsList = actual.SettingsList as new (...args: unknown[]) => object;
  class RecordingSettingsList extends SettingsList {
    constructor(items: Array<Record<string, unknown>>, ...rest: unknown[]) {
      // Copied, because the panel mutates `currentValue` on these very objects.
      spy.handed.push(items.map((item) => ({ ...item })));
      super(items, ...rest);
    }
  }
  return { ...actual, SettingsList: RecordingSettingsList };
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  esc: "\x1b",
  ctrlC: "\x03",
};

/**
 * pi's own hint line under the rows (`addHintLine`, `settings-list.js:245-250`).
 * Matched by prefix: it is truncated to the frame width, so at a narrow frame
 * the tail of the sentence is cut off the line.
 */
const PI_HINT = "Enter/Space to change";

const SHORT = "One line only";
const MEDIUM = "A medium description that needs more than one line at a narrow frame";
const LONG =
  "A long description that needs several lines once the panel is narrow, which is the whole point of this fixture";

/** A frame narrow enough to wrap these descriptions, and the default panel width. */
const NARROW = 40;
const WIDE = 84;

/** Index of pi's hint line in the drawn cells, or -1 when the list is not drawn. */
function hintRow(cells: string[]): number {
  return cells.findIndex((line) => line.startsWith(PI_HINT));
}

/** The width `SettingsList` wraps a description to: `width - 4` (`settings-list.js:107`). */
function wrapWidth(frameWidth: number): number {
  return borderContentWidth(frameWidth) - 4;
}

/** The oracle: how many drawn lines a description takes at a frame width. */
function wrapped(text: string, frameWidth: number): string[] {
  return wrapTextWithAnsi(text, wrapWidth(frameWidth));
}

/** Distinct wrapped line counts across the descriptions of `items`. */
function distinctCounts(items: SettingItem[], frameWidth: number): number[] {
  return [
    ...new Set(
      items
        .map((item) => item.description)
        .filter((text): text is string => Boolean(text))
        .map((text) => wrapped(text, frameWidth).length),
    ),
  ];
}

/** The longest description in the set, in wrapped lines, at a frame width. */
function longest(items: SettingItem[], frameWidth: number): string[] {
  let best: string[] = [];
  for (const item of items) {
    if (!item.description) continue;
    const lines = wrapped(item.description, frameWidth);
    if (lines.length > best.length) best = lines;
  }
  return best;
}

const items = (): SettingItem[] => [
  { id: "alpha", label: "Alpha", currentValue: "On", values: ["On", "Off"], description: SHORT },
  { id: "bravo", label: "Bravo", currentValue: "On", values: ["On", "Off"], description: LONG },
  // No description at all: it must not cost the area a line, either.
  { id: "charlie", label: "Charlie", currentValue: "On", values: ["On", "Off"] },
  { id: "delta", label: "Delta", currentValue: "On", values: ["On", "Off"], description: MEDIUM },
];

const withoutDescriptions = (source: SettingItem[]): SettingItem[] =>
  source.map((item) => {
    const { description: _description, ...rest } = item;
    return rest as SettingItem;
  });

/**
 * The real panel shape: 26 rows, so the list scrolls and draws its `(n/26)`
 * counter. `longAt` parks the only long description on one row and gives every
 * other row a 1-line one, which is the shape that tells a description area sized
 * by the whole filtered set apart from one sized by the visible window.
 */
function manyItems(count = 26, longAt?: number): SettingItem[] {
  return Array.from({ length: count }, (_unused, i): SettingItem => {
    const description =
      longAt === undefined
        ? i % 3 === 0
          ? LONG
          : i % 3 === 1
            ? SHORT
            : undefined
        : i === longAt
          ? LONG
          : SHORT;
    return {
      id: `item${i}`,
      label: `Setting ${i}`,
      currentValue: "On",
      values: ["On", "Off"],
      ...(description ? { description } : {}),
    };
  });
}

// ── Harness ─────────────────────────────────────────────────────────────────

interface Panel {
  render(width?: number): string[];
  /** Drawn cells: escapes and the border frame removed, each line trimmed. */
  cells(width?: number): string[];
  height(width?: number): number;
  to(index: number): Panel;
  press(...keys: string[]): Panel;
  readonly changes: Array<[string, string]>;
  readonly saves: number;
  readonly closes: number;
}

function panel(
  source: SettingItem[],
  prompts: Record<string, PromptDescriptor> = {},
): Panel {
  const changes: Array<[string, string]> = [];
  let saves = 0;
  let closes = 0;
  const m = createSettingsManager({
    items: source.map((item) => ({ ...item })),
    prompts,
    theme: { fg: (_token: string, text: string) => text, bold: (text: string) => text } as never,
    onChange: (id, newValue) => changes.push([id, newValue]),
    onSave: () => {
      saves += 1;
    },
    onClose: () => {
      closes += 1;
    },
  });
  const api: Panel = {
    render: (width = WIDE) => m.render(width),
    cells: (width = WIDE) =>
      m
        .render(width)
        .map((line) => stripTerminalSequences(line).replace(/[│┌└┐┘─]/g, "").trim()),
    height: (width = WIDE) => m.render(width).length,
    to: (index) => {
      for (let n = 0; n < index; n++) m.handleInput(KEY.down);
      return api;
    },
    press: (...keys) => {
      for (const key of keys) m.handleInput(key);
      return api;
    },
    get changes() {
      return changes;
    },
    get saves() {
      return saves;
    },
    get closes() {
      return closes;
    },
  };
  return api;
}

/**
 * Lines the description area occupies, including the blank line that precedes it
 * — or 0 when the set has no description at all. Measured by differencing two
 * frames of the same rows, one with descriptions and one without.
 */
function descriptionArea(source: SettingItem[], cursor: number, frameWidth: number): number {
  const withDescriptions = panel(source).to(cursor).height(frameWidth);
  const without = panel(withoutDescriptions(source)).to(cursor).height(frameWidth);
  return withDescriptions - without;
}

/** Every height the frame produced while the cursor walked the whole list. */
function heightsAtEveryIndex(source: SettingItem[], frameWidth: number, prompts = {}): number[] {
  const heights: number[] = [];
  for (let index = 0; index < source.length; index++) {
    // A fresh panel per index: the same one would carry value writes along.
    heights.push(panel(source, prompts).to(index).height(frameWidth));
  }
  return heights;
}

// ── The fixtures must actually be mixed-length, or nothing here proves anything ─

describe("the fixtures", () => {
  it("contains descriptions that wrap to different line counts at both widths", () => {
    const set = items();
    expect(distinctCounts(set, NARROW).length).toBeGreaterThan(1);
    expect(distinctCounts(set, WIDE).length).toBeGreaterThan(1);
    expect(distinctCounts(manyItems(), WIDE).length).toBeGreaterThan(1);
    // And the 1-line case really is 1 line, so the "grows by a row" claim bites.
    expect(wrapped(SHORT, NARROW).length).toBe(1);
    expect(wrapped(LONG, NARROW).length).toBeGreaterThanOrEqual(3);
  });
});

// ── The regression itself ───────────────────────────────────────────────────

describe("frame height against cursor position", () => {
  it("is the same with the cursor on a 1-line description and on a wrapping one", () => {
    const set = [items()[0]!, items()[1]!];
    const onShort = panel(set).to(0).height(NARROW);
    const onWrapping = panel(set).to(1).height(NARROW);
    expect(onWrapping).toBe(onShort);
    // …and the cursor moving back does not change it either.
    expect(panel(set).to(1).press(KEY.down).height(NARROW)).toBe(onShort);
  });

  it("is the same at every cursor index of a mixed-length list, at two widths", () => {
    for (const frameWidth of [NARROW, WIDE]) {
      const heights = heightsAtEveryIndex(items(), frameWidth);
      expect(new Set(heights).size, `heights at width ${frameWidth}: ${heights.join(", ")}`).toBe(1);
    }
  });

  it("is the same at every cursor index of the 26-row panel, at two widths", () => {
    for (const frameWidth of [NARROW, WIDE]) {
      const set = manyItems();
      const heights = heightsAtEveryIndex(set, frameWidth);
      expect(new Set(heights).size, `heights at width ${frameWidth}: ${heights.join(", ")}`).toBe(1);
    }
  });

  it("is unchanged when the scroll window moves past the one long description", () => {
    // Ten rows are on screen and there are 26, so the window slides as the cursor
    // walks. Here exactly one row — the twentieth — carries a description longer
    // than every other, and it starts off-screen. An area sized from the visible
    // window would grow the frame the moment the window reached it; an area sized
    // from the whole filtered set reserves that space from the first frame.
    const LONG_ROW = 20;
    const set = manyItems(26, LONG_ROW);
    for (const frameWidth of [NARROW, WIDE]) {
      const heights = heightsAtEveryIndex(set, frameWidth);
      expect(new Set(heights).size, `heights at width ${frameWidth}: ${heights.join(", ")}`).toBe(1);
    }
    // Tripwire that the walk above really crossed the boundary: the long row is
    // outside the drawn window at the start and inside it once the cursor gets
    // there, so the heights compared above were taken on either side of it.
    const atStart = panel(set).cells(WIDE).join("\n");
    const atTheLongRow = panel(set).to(LONG_ROW).cells(WIDE).join("\n");
    expect(atStart).not.toContain(`Setting ${LONG_ROW}`);
    expect(atTheLongRow).toContain(`Setting ${LONG_ROW}`);
    expect(atTheLongRow).toContain(LONG.split(" ").slice(0, 3).join(" "));
    // And with the cursor back on a 1-line row, the area is still the tall one.
    const backToStart = panel(set).to(LONG_ROW).press(KEY.up).cells(WIDE).join("\n");
    expect(backToStart).toContain(SHORT);
    expect(backToStart).not.toContain(LONG.split(" ").slice(0, 3).join(" "));
    expect(panel(set).to(LONG_ROW).press(KEY.up).height(WIDE)).toBe(panel(set).height(WIDE));
  });

  it("is the same whether or not the search row is open, per search state", () => {
    // The search row is a height change on purpose (it adds a row); what must not
    // move is the height *within* one search state as the cursor walks.
    const set = items();
    const armed = panel(set).press("/");
    const before = armed.height(NARROW);
    armed.to(2);
    expect(armed.height(NARROW)).toBe(before);
    const unarmed = panel(set);
    const unarmedBefore = unarmed.height(NARROW);
    unarmed.to(2);
    expect(unarmed.height(NARROW)).toBe(unarmedBefore);
    // And arming the search really does add a row, so the two states differ.
    expect(armed.height(NARROW)).toBeGreaterThan(unarmedBefore);
  });
});

// ── How the area is sized ───────────────────────────────────────────────────

describe("the description area", () => {
  it("is as tall as the longest description in the set, not the one under the cursor", () => {
    for (const frameWidth of [NARROW, WIDE]) {
      const set = items();
      const longestLines = longest(set, frameWidth).length;
      for (let cursor = 0; cursor < set.length; cursor++) {
        expect(descriptionArea(set, cursor, frameWidth), `cursor ${cursor} at ${frameWidth}`).toBe(
          longestLines + 1,
        );
      }
    }
  });

  it("draws the whole of a long description, truncated by nothing", () => {
    const set = items();
    const expected = longest(set, NARROW);
    const bravo = set.findIndex((item) => item.description === LONG);
    const cells = panel(set).to(bravo).cells(NARROW);
    const hint = hintRow(cells);
    expect(hint, "pi's hint line was not drawn").toBeGreaterThan(0);
    // The slot sits directly above the blank line that precedes pi's hint.
    const drawn = cells.slice(hint - 1 - expected.length, hint - 1);
    expect(drawn).toEqual(expected.map((line) => line.trim()));
  });

  it("pads with blank lines when the selected description is the short one", () => {
    const set = items();
    const longestLines = longest(set, NARROW).length;
    const cells = panel(set).to(0).cells(NARROW);
    const hint = hintRow(cells);
    expect(hint).toBeGreaterThan(0);
    // pi's own blank line sits directly above its hint; above that, the padding
    // that fills the area out to the longest description.
    expect(cells[hint - 1]).toBe("");
    let above = hint - 2;
    let padding = 0;
    while (above >= 0 && cells[above] === "") {
      padding += 1;
      above -= 1;
    }
    expect(cells[above]).toBe(SHORT);
    // The area holds `longestLines` lines and `SHORT` takes one of them, so the
    // rest of the area is padding.
    expect(padding).toBe(longestLines - wrapped(SHORT, NARROW).length);
  });

  it("counts the editable row's affordance as part of its description", () => {
    const set: SettingItem[] = [
      { id: "plain", label: "Plain", currentValue: "On", values: ["On", "Off"], description: SHORT },
      { id: "typed", label: "Typed", currentValue: "40", description: "Type the value this row holds" },
    ];
    const prompts: Record<string, PromptDescriptor> = { typed: { kind: "text", label: "Typed value" } };
    const composed = "Type the value this row holds · Enter to type a value";
    // The area has to fit the composed text, so a plain row carrying that very
    // text is the fixture it must match — same labels, same values, and no
    // prompt descriptor to compose anything.
    const equivalent: SettingItem[] = [set[0]!, { ...set[1]!, description: composed }];
    expect(wrapped(composed, NARROW).length).toBeGreaterThan(wrapped(SHORT, NARROW).length);
    for (let cursor = 0; cursor < set.length; cursor++) {
      // The area fits the composed text even while the cursor sits on the 1-line
      // row, so the frame does not move — and it is the same frame the plain
      // fixture produces, which is what "fits the composed text" has to mean.
      expect(panel(set, prompts).to(cursor).height(NARROW), `cursor ${cursor}`).toBe(
        panel(set, prompts).height(NARROW),
      );
      expect(panel(set, prompts).to(cursor).height(NARROW), `cursor ${cursor}`).toBe(
        panel(equivalent).to(cursor).height(NARROW),
      );
    }
    // And the selected editable row shows the whole composed text.
    const drawn = panel(set, prompts).to(1).cells(NARROW).join("\n");
    expect(drawn.replace(/\s+/g, " ")).toContain(composed.replace(/\s+/g, " "));
  });

  it("shrinks when a search narrows the set to shorter descriptions", () => {
    const set = items();
    const full = descriptionArea(set, 1, NARROW);
    const narrowed = panel(set).press("/").press(..."alpha".split(""));
    const alphaLines = wrapped(SHORT, NARROW).length;
    expect(narrowed.cells().join("\n")).toContain("Alpha");
    expect(narrowed.cells().join("\n")).not.toContain("Bravo");
    expect(narrowed.height(NARROW)).toBeLessThan(panel(set).height(NARROW));
    // The narrowed area is the narrowed set's longest, and it does not move.
    const before = narrowed.height(NARROW);
    narrowed.press(KEY.down).press(KEY.up);
    expect(narrowed.height(NARROW)).toBe(before);
    expect(full).toBeGreaterThan(alphaLines + 1);
  });

  it("takes no line at all when nothing in the set has a description", () => {
    const set = withoutDescriptions(items());
    // Not a text line, not even a reserved blank one.
    expect(descriptionArea(set, 0, NARROW)).toBe(0);
    expect(descriptionArea(set, 2, NARROW)).toBe(0);
    const heights = heightsAtEveryIndex(set, NARROW);
    expect(new Set(heights).size).toBe(1);
    // Exactly the lines the described set adds: one blank + the longest one.
    const described = items();
    for (const frameWidth of [NARROW, WIDE]) {
      const delta =
        panel(described).to(0).height(frameWidth) - panel(set).to(0).height(frameWidth);
      expect(delta).toBe(longest(described, frameWidth).length + 1);
    }
  });

  it("draws only the selected row's description", () => {
    const cells = panel(items()).to(0).cells(NARROW).join("\n");
    expect(cells).toContain(SHORT);
    expect(cells).not.toContain("long description");
    expect(cells).not.toContain("medium description");
  });

  it("holds its height across an empty filter without crashing", () => {
    const empty = panel(items()).press("/").press(..."zzzz".split(""));
    expect(empty.cells().join("\n")).toContain("No matching settings");
    const before = empty.height(NARROW);
    // Every key the list still honours with nothing to show.
    empty.press(KEY.down).press(KEY.up).press(KEY.enter).press(" ").press(KEY.right);
    expect(empty.height(NARROW)).toBe(before);
    expect(empty.changes).toEqual([]);
    // Clearing the query restores the whole-set height — the empty result is not
    // holding on to a description area of its own.
    empty.press(KEY.esc);
    expect(empty.cells().join("\n")).toContain("Bravo");
    expect(empty.height(NARROW)).toBe(panel(items()).height(NARROW));
  });

  it("holds its height while a free-input field is open", () => {
    const set: SettingItem[] = [
      { id: "typed", label: "Typed", currentValue: "40", description: LONG },
      { id: "plain", label: "Plain", currentValue: "On", values: ["On", "Off"], description: SHORT },
    ];
    const prompts: Record<string, PromptDescriptor> = { typed: { kind: "text", label: "Typed value" } };
    const field = panel(set, prompts).to(0).press(KEY.enter);
    const before = field.height(NARROW);
    // The field replaces the list, so the slot is not part of that frame at all.
    expect(field.cells().join("\n")).toContain("Typed value");
    expect(field.cells().join("\n")).not.toContain(PI_HINT);
    field.press("x", "\x7f");
    expect(field.height(NARROW)).toBe(before);
    field.press(KEY.enter);
    // Back to the list, and the cursor moved without moving the frame.
    const listed = field.height(NARROW);
    field.press(KEY.down).press(KEY.up);
    expect(field.height(NARROW)).toBe(listed);
  });
});

// ── The rows handed to pi ───────────────────────────────────────────────────

describe("the rows handed to SettingsList", () => {
  it("carry no description key, so pi cannot add a variable block back", () => {
    spy.handed.length = 0;
    panel(items());
    const handed = spy.handed.at(-1);
    expect(handed, "the panel never built a SettingsList").toBeDefined();
    expect(handed!.length).toBe(items().length);
    const withDescription = handed!.filter((row) => "description" in row);
    expect(withDescription.map((row) => String(row.id))).toEqual([]);
    // The rows are otherwise the panel's own: labels and values are there.
    expect(handed!.map((row) => String(row.id).trim())).toEqual(["alpha", "bravo", "charlie", "delta"]);
    // …and a rebuild for a filter hands the narrowed rows over the same way.
    spy.handed.length = 0;
    panel(items()).press("/").press(..."alpha".split(""));
    const filtered = spy.handed.at(-1)!;
    expect(filtered.map((row) => String(row.id).trim())).toEqual(["alpha"]);
    expect(filtered.filter((row) => "description" in row)).toEqual([]);
  });
});

// ── Behaviour the fix must not disturb ──────────────────────────────────────
//
// Covered in depth by `settings-manager.test.ts` (the Kitty CSI-u keys, the
// armed-search esc-clear, the ←/→ mirror, Enter/Space cycling, ctrl+b/ctrl+f
// inertness). These are the two the height tests could plausibly break.

describe("behaviour that survives the slot", () => {
  it("draws pi's scroll counter over the 26-row panel", () => {
    const cells = panel(manyItems()).to(12).cells(WIDE);
    expect(cells.some((line) => /^\(\d+\/26\)$/.test(line))).toBe(true);
  });

  it("still closes on ctrl+c", () => {
    const closed = panel(items()).press(KEY.ctrlC);
    expect(closed.closes).toBe(1);
    expect(closed.changes).toEqual([]);
  });

  it("still steps the row under the cursor", () => {
    const stepped = panel(items()).to(1).press(KEY.right);
    expect(stepped.changes).toEqual([["bravo", "Off"]]);
  });
});
