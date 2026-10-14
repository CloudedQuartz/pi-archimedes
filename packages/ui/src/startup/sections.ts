import { rgb, extractRgb, lerp } from "@pi-archimedes/core/color";
import { TRUECOLOR } from "./logo.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Types ──────────────────────────────────────────────────────
//
// One of these is a block the splash renders: a bracketed label and the items
// under it. pi 1.x owns its own startup listing, so nothing here detects or
// parses pi's sections any more (that was the scrape Task 8 removed) — the
// caller builds these from `ctx.scopedModels` plus the version row, and this
// module lays them out *in pi's own shape*, because the listing it sits above
// is pi's: see `formatColumns` for the recipe.

export interface ParsedSection {
  name: string;
  items: string[];
}

interface RenderSection {
  name: string;
  items: string[];
}

// ── Animation constants ────────────────────────────────────────

export const RAMP_FRAMES = 22;
export const STAGGER_FRAMES = 0;
export const BASE_FADE_DELAY = 3;
export const MAX_STAGGER = BASE_FADE_DELAY + 5 * STAGGER_FRAMES;

/** pi's compact body indent: `theme.fg("dim", `  ${labels.join(", ")}`)`. */
const BODY_INDENT = "  ";

// ── Section formatter ──────────────────────────────────────────

/**
 * Lay the sections out the way pi lays its own startup listing out, because
 * pi's listing is drawn immediately below ours (its `loadedResourcesContainer`
 * is the container after the header's) and any difference in shape reads as a
 * second document. pi's recipe, from `showLoadedResources()` in 1.2.0
 * (`interactive-mode.js:1335-1347`):
 *
 * ```ts
 * const sectionHeader = (name, color = "mdHeading") => theme.fg(color, `[${name}]`);
 * const formatCompactList = (items) => theme.fg("dim", `  ${labels.join(", ")}`);
 * new ExpandableText(() => `${sectionHeader(name)}\n${collapsedBody()}`, …, 0, 0)
 * container.addChild(section); container.addChild(new Spacer(1));
 * ```
 *
 * So: the bracketed name in `mdHeading` on its own row, the values `dim` on the
 * row under it at a two-space indent, both at column 1, one blank row between
 * sections. Two deliberate differences, both of which pi cannot show and we
 * must:
 *
 * - no trailing blank row. pi puts a `Spacer(1)` above *and* below the header
 *   container (`:764-766`) and opens the listing with another, so the gap below
 *   the header is already pi's to draw; a blank row here would double it.
 * - long value lists are broken across rows. pi writes one long row and lets
 *   its own expander deal with it; our header is a plain component, and a row
 *   wider than the frame is a row the terminal wraps under us.
 */
export function formatColumns(sections: RenderSection[], theme: Theme, maxW: number, ref: { frame: number; revealed: boolean; revealedAt: number; scaffoldAt: number; settled: boolean }): string[] {
  if (sections.length === 0) return [];

  // Colour comes from the theme's tokens, never from an escape we compose
  // ourselves (ADR 0029) — the same two tokens pi's section rows use.
  const heading = (t: string) => theme.fg("mdHeading", t);
  const body = (t: string) => theme.fg("dim", t);

  const itemAge = ref.revealed ? ref.frame - ref.revealedAt : 0;
  const labelAge = ref.revealed ? ref.frame - ref.scaffoldAt : 0;

  // RGB endpoints for fade ramps (truecolor only): each row ramps to the colour
  // pi paints it with at rest.
  const fadeStartRgb: [number, number, number] = [20, 20, 20];
  let headingRgb: [number, number, number] | undefined;
  let bodyRgb: [number, number, number] | undefined;
  const labelRamping = TRUECOLOR && ref.revealed && labelAge < RAMP_FRAMES + MAX_STAGGER;
  const itemRamping = TRUECOLOR && ref.revealed && itemAge < RAMP_FRAMES + MAX_STAGGER;
  if (labelRamping || itemRamping) {
    headingRgb = extractRgb(theme.fg("mdHeading", " "));
    bodyRgb = extractRgb(theme.fg("dim", " "));
  }

  const lines: string[] = [];
  let firstSection = true;

  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si]!;
    if (sec.items.length === 0) continue;

    // The blank row between sections, which is pi's `Spacer(1)`.
    if (!firstSection) lines.push("");
    firstSection = false;

    // Label fade: near-invisible → the heading colour (static when not revealed)
    const secLabelAge = Math.max(0, labelAge - BASE_FADE_DELAY - si * STAGGER_FRAMES);
    const wrapLabel = ref.revealed
      ? buildItemWrapper(secLabelAge, true, fadeStartRgb, headingRgb, heading)
      : heading;
    lines.push(truncateToWidth(wrapLabel(`[${sec.name}]`), maxW));

    // Item fade: near-invisible → the body colour
    const secItemAge = Math.max(0, itemAge - BASE_FADE_DELAY - si * STAGGER_FRAMES);
    const wrapItems = buildItemWrapper(secItemAge, ref.revealed, fadeStartRgb, bodyRgb, body);

    // pi's compact body is one `dim` row of `, `-joined labels at a two-space
    // indent — one colour over the whole row, the indent inside it (there is no
    // token fainter than `dim` to set a prefix behind, and pi does not try).
    // The row is broken across rows only when it will not fit the frame, which
    // pi's own expander handles and a plain component does not.
    const bodyW = Math.max(1, maxW - BODY_INDENT.length);
    let rawRun = "";
    for (const item of sec.items) {
      const candidate = rawRun ? `${rawRun}, ${item}` : item;
      if (rawRun && visibleWidth(candidate) > bodyW) {
        lines.push(truncateToWidth(wrapItems(BODY_INDENT + rawRun), maxW));
        rawRun = item;
      } else {
        rawRun = candidate;
      }
    }
    if (rawRun) lines.push(truncateToWidth(wrapItems(BODY_INDENT + rawRun), maxW));
  }

  return lines;
}

/**
 * The wrapper a row is drawn with: the ramped truecolor mix while the reveal is
 * running, `atRest` once it is over (or where the terminal has no truecolor to
 * ramp through).
 */
export function buildItemWrapper(
  sectionAge: number,
  revealed: boolean,
  startRgb: [number, number, number] | undefined,
  atRestRgb: [number, number, number] | undefined,
  atRest: (t: string) => string,
): (text: string) => string {
  if (!revealed) return (text) => text; // placeholders already styled

  // No truecolor or ramp done → the theme's own colour for the row
  if (!startRgb || !atRestRgb || sectionAge >= RAMP_FRAMES) return atRest;

  const t = Math.min(1, sectionAge / RAMP_FRAMES);
  const eased = 1 - (1 - t) * (1 - t);
  const r = lerp(startRgb[0], atRestRgb[0], eased);
  const g = lerp(startRgb[1], atRestRgb[1], eased);
  const b = lerp(startRgb[2], atRestRgb[2], eased);
  return (text) => rgb(r, g, b, text);
}
