import { clampLine, stripAnsi } from "@pi-archimedes/core/text";
import { gray, rgb, extractRgb, lerp } from "@pi-archimedes/core/color";
import { TRUECOLOR } from "./logo.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

// ── Types ──────────────────────────────────────────────────────
//
// Pi owns the startup listing, so the set of sections is pi's to decide —
// 0.99.0 dropped `[Themes]`, 1.2.0 prints Context/Skills/Prompts/Extensions
// plus a model-scope line. Nothing in this module enumerates them: sections
// are detected by the shape of a header that leads the text, and rendered in
// the order they were captured.

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

// ── Section detection & parsing ────────────────────────────────

/**
 * A pi startup section header: a bracketed single Capitalised word
 * (`[Context]`, `[Extensions]`) **leading** the component's text.
 *
 * Two independent reasons the anchor is load-bearing:
 * - The shape keeps the diagnostics pi prints into the same container out of
 *   the splash (`[Skill conflicts]`, `[Extension issues]`, `[Prompt
 *   conflicts]`, `[Theme conflicts]` all carry a space in the title).
 * - Those diagnostics' *bodies* are arbitrary text from the failing resource
 *   (pi's `formatDiagnostics` prints the message verbatim), so a bracketed
 *   Capitalised word can appear inside one. Matched anywhere but the start,
 *   that warning becomes a "section", and the startup `addChild` patch then
 *   swallows the diagnostic — an error silently deleted from the user's view.
 *
 * Real sections always lead: pi builds each one as
 * `` `${sectionHeader(name)}\n${body()}` `` (`addLoadedSection`,
 * pi-coding-agent `dist/modes/interactive/interactive-mode.js`, unchanged
 * 0.87→1.2.0), and callers hand us `stripAnsi` output, which trims, so
 * leading indentation cannot hide a header either.
 */
const SECTION_HEADER = /^\[([A-Z][a-z]+)\]/;

export function detectSection(plain: string): string | undefined {
  return SECTION_HEADER.exec(plain)?.[1];
}

export function parseSectionText(plain: string): ParsedSection | undefined {
  const sectionName = detectSection(plain);
  if (!sectionName) return undefined;

  const names = extractItemsFromSection(plain, sectionName);
  const items = deduplicateItems(names);
  return { name: sectionName, items };
}

/**
 * Extract item names from a section's plain text.
 * Tracks source prefixes (npm:/git:) for Extensions/Skills sections.
 */
function extractItemsFromSection(plain: string, sectionName: string): string[] {
  const names: string[] = [];
  const lines = plain.split("\n");
  let currentSource = "";
  let sourceIndent = 0;
  const showSource = sectionName === "Extensions" || sectionName === "Skills";

  for (const line of lines) {
    const trimmed = line.trim();
    if (shouldSkipLine(trimmed, currentSource)) continue;

    const indent = line.length - line.trimStart().length;

    // Track package source headers (e.g. "git:github.com/...", "npm:@foo/bar")
    if (/^(git:|npm:)\S+\//.test(trimmed)) {
      currentSource = trimmed.startsWith("git:") ? "git:" : "npm:";
      sourceIndent = indent;
      const name = extractName(trimmed, sectionName);
      if (name && showSource) names.push(name);
      continue;
    }

    // Reset source prefix when indent returns to source level or shallower
    if (currentSource && indent <= sourceIndent) {
      currentSource = "";
      sourceIndent = 0;
    }

    const itemNames = extractNames(trimmed, sectionName);
    for (const n of itemNames) {
      names.push(showSource && currentSource ? currentSource + n : n);
    }
  }
  return names;
}

/**
 * Extract item name(s) from a line.
 *
 * Collapsed section bodies are a single comma-joined line ("a, b, c") —
 * split it so each name is its own item and the listing can wrap, instead
 * of one clamped line ending in "...". Expanded bodies are per-item path
 * lines; names never contain ", ", so splitting is safe.
 */
function extractNames(line: string, sectionName: string): string[] {
  const parts = line.includes(", ")
    ? line.split(", ").map(p => p.trim()).filter(Boolean)
    : [line];
  const out: string[] = [];
  for (const part of parts) {
    const name = extractName(part, sectionName);
    if (name) out.push(name);
  }
  return out;
}

/** Check if a line should be skipped during section parsing. */
function shouldSkipLine(trimmed: string, currentSource: string): boolean {
  if (!trimmed) return true;
  if (trimmed.startsWith("[")) return true;
  if (/^(user|project|path)$/.test(trimmed)) return true;
  if (/^(index\.(ts|js)|src|dist|out|build|lib|bin)$/i.test(trimmed)) return true;
  // Skip resolved file paths only under source headers
  if (currentSource) {
    if (/\/(src|dist|out|build|lib|bin)\//.test(trimmed)) return true;
    if (/\.(ts|js)$/.test(trimmed) && trimmed.includes("/") && !/SKILL\.(ts|js)$/i.test(trimmed)) return true;
  }
  return false;
}

/**
 * Deduplicate items by bare name (without prefix).
 * Prefers prefixed versions (npm:/git:) over bare names.
 */
function deduplicateItems(names: string[]): string[] {
  const seen = new Map<string, string>();
  for (const n of names) {
    if (/^(index|dist|src|out|lib|bin)$/i.test(n)) continue;
    const bare = n.replace(/^(npm:|git:)/, "");
    if (!seen.has(bare) || n.includes(":")) seen.set(bare, n);
  }
  return [...seen.values()];
}

export function parseModelScope(plain: string): ParsedSection | undefined {
  const m = plain.match(/Model scope:\s*(.+)/i);
  if (!m) return undefined;
  const raw = m[1]!.replace(/\s*\(Ctrl\+\w[\w\s]*\)/gi, "");
  const items = raw.split(",").map(s => s.trim()).filter(Boolean);
  return items.length > 0 ? { name: "Models", items } : undefined;
}

// ── Name extraction helpers ────────────────────────────────────

function detectOrigin(path: string): { prefix: string; clean: string } {
  if (/^npm:/.test(path)) return { prefix: "npm:", clean: path.slice(4) };
  if (/^git:/.test(path)) return { prefix: "git:", clean: path.slice(4) };
  if (/^https?:\/\//.test(path)) return { prefix: "git:", clean: path };
  return { prefix: "", clean: path };
}

function cleanName(name: string): string {
  return name.replace(/\.(ts|js|json|md|git)$/i, "");
}

type Extractor = (clean: string, prefix: string) => string;

const defaultExtract: Extractor = (clean, prefix) =>
  prefix + cleanName(clean.split("/").pop() ?? clean);

const sectionExtractors = new Map<string, Extractor>([
  // Models, Themes and any section pi adds later take `defaultExtract`.
  [
    "Prompts",
    (clean) => {
      const base = clean.split("/").pop() ?? clean;
      return cleanName(base) || clean;
    },
  ],
  ["Context", (clean) => clean.split("/").pop() ?? clean],
  [
    "Skills",
    (clean, prefix) => {
      if (!clean.includes("/")) return defaultExtract(clean, prefix);
      const parts = clean.split("/");
      const file = parts.pop() ?? "";
      if (/^SKILL\.(md|ts|js)$/i.test(file)) {
        return prefix + cleanName(parts.pop() ?? file);
      }
      return prefix + cleanName(file);
    },
  ],
  [
    "Extensions",
    (clean, prefix) => {
      const stripped = clean.replace(/^https?:\/\/[^/]+\//, "");
      const parts = stripped.split("/").filter(p => {
        const lower = p.toLowerCase();
        return p && !/^(index\.(ts|js)|src|dist|out|build|lib|bin)$/.test(lower);
      });
      if (parts.length > 0) return prefix + cleanName(parts.pop()!);
      return prefix + cleanName(clean);
    },
  ],
]);

export function extractName(path: string, section: string): string {
  const trimmed = path.trim();
  const { prefix, clean } = detectOrigin(trimmed);
  const extract = sectionExtractors.get(section) ?? defaultExtract;
  return extract(clean, prefix);
}

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
        lines.push(clampLine(rawLine, maxW));
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
      lines.push(clampLine(rawLine, maxW));
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
