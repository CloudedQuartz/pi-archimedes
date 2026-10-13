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
// module lays them out.

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

// ── Column formatter ───────────────────────────────────────────

function pad(s: string, w: number): string {
  const vw = visibleWidth(s);
  return vw >= w ? s : s + " ".repeat(w - vw);
}

export function formatColumns(sections: RenderSection[], theme: Theme, maxW: number, ref: { frame: number; revealed: boolean; revealedAt: number; scaffoldAt: number; settled: boolean }): string[] {
  if (sections.length === 0) return [];

  const dim = (t: string) => theme.fg("dim", t);
  const muted = (t: string) => theme.fg("muted", t);

  const headerW = Math.max(...sections.map(s => s.name.length + 2)) + 2;

  const itemAge = ref.revealed ? ref.frame - ref.revealedAt : 0;
  const labelAge = ref.revealed ? ref.frame - ref.scaffoldAt : 0;

  // RGB endpoints for fade ramps (truecolor only)
  const fadeStartRgb: [number, number, number] = [20, 20, 20];
  let dimRgb: [number, number, number] | undefined;
  let mutedRgb: [number, number, number] | undefined;
  const labelRamping = TRUECOLOR && ref.revealed && labelAge < RAMP_FRAMES + MAX_STAGGER;
  const itemRamping = TRUECOLOR && ref.revealed && itemAge < RAMP_FRAMES + MAX_STAGGER;
  if (labelRamping || itemRamping) {
    dimRgb = extractRgb(theme.fg("dim", " "));
    mutedRgb = extractRgb(theme.fg("muted", " "));
  }

  const lines: string[] = [];

  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si]!;
    if (sec.items.length === 0) continue;

    const availableW = maxW - headerW - 1;

    // Label fade: near-invisible → dim (static dim when not revealed)
    const secLabelAge = Math.max(0, labelAge - BASE_FADE_DELAY - si * STAGGER_FRAMES);
    const wrapLabel = ref.revealed
      ? buildItemWrapper(secLabelAge, true, fadeStartRgb, dimRgb, dim)
      : dim;
    const header = wrapLabel(`[${sec.name}]`);
    const paddedHeader = header + " ".repeat(Math.max(0, headerW - sec.name.length - 2));

    // Item fade: near-invisible → muted
    const secItemAge = Math.max(0, itemAge - BASE_FADE_DELAY - si * STAGGER_FRAMES);
    const wrapItems = buildItemWrapper(secItemAge, ref.revealed, fadeStartRgb, mutedRgb, muted);

    // Style prefix (npm:/git:) dimmer than the name
    const styleItem = (raw: string): string => {
      const prefixMatch = raw.match(/^(npm:|git:)/);
      if (prefixMatch) {
        const pfx = prefixMatch[1]!;
        const name = raw.slice(pfx.length);
        return wrapLabel(pfx) + wrapItems(name);
      }
      return wrapItems(raw);
    };

    let currentLine = "";
    let currentStyled = "";
    let firstLine = true;

    for (const item of sec.items) {
      const itemW = visibleWidth(item);
      const currentW = visibleWidth(currentLine);

      if (currentLine && currentW + 2 + itemW > availableW) {
        const rawLine = firstLine ? `${paddedHeader} ${currentStyled}` : " ".repeat(headerW + 1) + currentStyled;
        lines.push(truncateToWidth(rawLine, maxW));
        currentLine = item;
        currentStyled = styleItem(item);
        firstLine = false;
      } else {
        currentLine = currentLine ? currentLine + "  " + item : item;
        currentStyled = currentStyled ? currentStyled + "  " + styleItem(item) : styleItem(item);
      }
    }
    if (currentLine) {
      const rawLine = firstLine ? `${paddedHeader} ${currentStyled}` : " ".repeat(headerW + 1) + currentStyled;
      lines.push(truncateToWidth(rawLine, maxW));
    }

    if (sec.name === "Version") {
      lines.push("");
    }
  }

  return lines;
}

export function buildItemWrapper(
  sectionAge: number,
  revealed: boolean,
  startRgb: [number, number, number] | undefined,
  mutedRgb: [number, number, number] | undefined,
  muted: (t: string) => string,
): (text: string) => string {
  if (!revealed) return (text) => text; // placeholders already styled

  // No truecolor or ramp done → static muted
  if (!startRgb || !mutedRgb || sectionAge >= RAMP_FRAMES) return muted;

  const t = Math.min(1, sectionAge / RAMP_FRAMES);
  const eased = 1 - (1 - t) * (1 - t);
  const r = lerp(startRgb[0], mutedRgb[0], eased);
  const g = lerp(startRgb[1], mutedRgb[1], eased);
  const b = lerp(startRgb[2], mutedRgb[2], eased);
  return (text) => rgb(r, g, b, text);
}
