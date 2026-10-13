import { VERSION, type ScopedModel, type Theme } from "@earendil-works/pi-coding-agent";
import { getShinedLogo, LOGO_PAD, LOGO_SETTLE_FRAME } from "./logo.js";
import { loadUIConfig } from "../config.js";
import {
  formatColumns,
  RAMP_FRAMES,
  MAX_STAGGER,
  type ParsedSection,
} from "./sections.js";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";

// ── What this module owns ───────────────────────────────────────────────────
//
// The splash: the logo animation, the version row, and the text reveal that
// carries them in. That is all.
//
// It used to own pi's startup listing too — finding pi's resource container by
// child-order heuristics, intercepting `addChild`, swallowing pi's section
// components and re-rendering them here, plus a `console.log` patch that ate
// pi's `Model scope:` line. All of that is gone (pi 1.x alignment, Task 8): pi
// renders its own listing, `quietStartup` decides whether it shows, and
// `ctx.scopedModels` hands us the model scope directly, so there is nothing
// left to scrape and no reason to touch the console or pi's component tree.
// `ui/src/index.ts` decides *whether* to install this splash (quietStartup) and
// what sections to reveal (the model scope); this module animates them.

/**
 * Height to size the header against when there is no scrollback to pad into
 * (`renderHeader`'s `height`): the header renders exactly its own content.
 *
 * On regular screen the header is sized to the terminal because the splash is
 * about to be pushed through scrollback. A frame-bounded screen (fullscreen,
 * ADR 0027) allocates its own height, so padding to terminal rows would make
 * the header the whole viewport and leave the editor nothing.
 */
export const CONTENT_ONLY_HEIGHT = 0;

export interface ListingRef {
  sections: ParsedSection[];
  frame: number;
  revealed: boolean;
  revealedAt: number;
  scaffoldAt: number;
  settled: boolean;
  cachedLines?: string[];
  cachedWidth?: number;
  cachedHeight?: number;
}

// ── renderHeader() — composes logo + sections + padding ────────────────

export function renderHeader(theme: Theme, ref: ListingRef, width: number, height: number): string[] {
  const dim = (t: string) => theme.fg("dim", t);
  const cfg = loadUIConfig();
  const logoLines = getShinedLogo(ref.frame, cfg.animationStyle, cfg.colorfulLogo);

  // Use cached text lines if settled (no more animations)
  let listingLines: string[];

  if (ref.settled && ref.cachedLines && ref.cachedWidth === width && ref.cachedHeight === height) {
    listingLines = ref.cachedLines;
  } else {
    const sectionsToRender: ParsedSection[] = [];

    if (!ref.revealed) {
      // Logo only — sections appear together on reveal
    } else {
      // The version row is ours to state; pi owns its own update check
      // (`--update`, `/changelog`, `PI_SKIP_VERSION_CHECK`), so there is no
      // second `Latest:` here — that used to arrive from a registry fetch on
      // every start.
      sectionsToRender.push({ name: "Version", items: [`v${VERSION}`] });

      // Then whatever the caller revealed in. pi decides which of *its*
      // sections exist; we only ever carry the model scope. Empty sections are
      // "nothing loaded", skip them.
      for (const sec of ref.sections) {
        if (sec.items.length > 0) sectionsToRender.push(sec);
      }
    }

    const listingMaxW = Math.floor(width * 0.7);
    listingLines = formatColumns(sectionsToRender, theme, listingMaxW, ref);

    // Cache once text animations are done
    const textAge = ref.revealed ? ref.frame - ref.revealedAt : 0;
    const textDone = ref.revealed && textAge > RAMP_FRAMES + MAX_STAGGER;
    const logoDone = ref.frame >= LOGO_SETTLE_FRAME;

    if (textDone && logoDone) {
      ref.settled = true;
      ref.cachedLines = listingLines;
      ref.cachedWidth = width;
      ref.cachedHeight = height;
    }
  }

  // Build content: logo + separator + listing
  const contentLines: string[] = [];

  // Logo centered above listing (same center as listing text)
  const listingMaxW = Math.floor(width * 0.7);
  const listingLeftPad = Math.floor((width - listingMaxW) / 2);
  for (const logoRow of logoLines) {
    const pad = Math.floor((listingMaxW - visibleWidth(logoRow)) / 2);
    contentLines.push(" ".repeat(LOGO_PAD) + " ".repeat(listingLeftPad + pad) + logoRow);
  }

  // Separator
  contentLines.push("");

  // Listing
  for (const listRow of listingLines) {
    contentLines.push(" ".repeat(LOGO_PAD) + " ".repeat(listingLeftPad) + listRow);
  }

  // Pad top and bottom to fill height (+5 top bias for visual centering).
  // The bias only applies when there is something to distribute: with no
  // height left over (`CONTENT_ONLY_HEIGHT` on a frame-bounded screen) the
  // header is its own content and must not gain stray blank rows.
  const VERTICAL_CENTER_BIAS = 5; // Shift content slightly upward for visual balance
  const contentHeight = contentLines.length;
  const remaining = Math.max(0, height - contentHeight);
  const topPad = remaining > 0 ? Math.floor(remaining / 2) + VERTICAL_CENTER_BIAS : 0;
  const bottomPad = remaining - topPad;

  const result: string[] = [];
  for (let i = 0; i < topPad; i++) result.push("");
  for (const line of contentLines) result.push(line);
  for (let i = 0; i < bottomPad; i++) result.push("");

  return result;
}

// ── The section the splash is allowed to know about ───────────────────────

/**
 * The session's model scope, in the shape the splash renders — the same set
 * `ctx.scopedModels` reports and `/scoped-models` lists, formatted the way pi's
 * own `Model scope:` line does (`id`, plus `:thinkingLevel` when the pattern
 * carried one).
 *
 * The alternative it replaces was a `console.log` patch watching for pi to
 * print that line, which both hid the line (the patch consumed it) and had no
 * answer for a session where pi prints nothing.
 *
 * Returns `undefined` for no scope, so the section is simply absent: an empty
 * `[Models]` header is pi's "nothing scoped" case, and there pi offers every
 * model. A host without the property answers the same way.
 */
export function modelScopeSection(
  scopedModels: readonly ScopedModel[] | undefined,
): ParsedSection | undefined {
  if (!Array.isArray(scopedModels)) return undefined;

  const items: string[] = [];
  for (const scoped of scopedModels) {
    const id = scoped?.model?.id;
    if (typeof id !== "string" || id === "") continue;
    items.push(scoped.thinkingLevel ? `${id}:${scoped.thinkingLevel}` : id);
  }
  return items.length > 0 ? { name: "Models", items } : undefined;
}

// ── The animation ───────────────────────────────────────────────────────────

/**
 * Sections wait this long after the header is built before they appear, so the
 * logo gets its reveal frames first. The old value, kept: it is the interval
 * pi's own section components used to arrive inside, and the splash looks the
 * same either way.
 */
const REVEAL_DEBOUNCE_MS = 150;
const FRAME_INTERVAL_MS = 16;

// One splash is on screen at a time. pi disposes the previous header before it
// builds the next one (`setExtensionHeader()` — a new session, `/reload`, or any
// `setHeader()` call), so a module pair of timers cannot leak a second
// animation — and holds no renderer: each timer closes over the `tui` it was
// started with, and the one running is the one the current header factory was
// handed (ADR 0027).
let frameTimer: ReturnType<typeof setInterval> | undefined;
let revealTimer: ReturnType<typeof setTimeout> | undefined;

/** Stop both halves of the animation (header disposed, session ended). */
export function stopStartupListing(): void {
  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = undefined;
  }
  if (revealTimer) {
    clearTimeout(revealTimer);
    revealTimer = undefined;
  }
}

function startFrameTimer(tui: TUI, ref: ListingRef): void {
  if (frameTimer) clearInterval(frameTimer);
  frameTimer = setInterval(() => {
    ref.frame++;
    // Logo done and either the listing settled, or nothing is revealed and
    // none is on its way — the state a quiet start leaves behind. Idle frames
    // cost a full viewport redraw on fullscreen screen, so stop here rather
    // than repaint forever (#92).
    const nothingToAnimate = ref.settled || (!ref.revealed && !revealTimer);
    if (nothingToAnimate && ref.frame >= LOGO_SETTLE_FRAME) {
      clearInterval(frameTimer);
      frameTimer = undefined;
      return;
    }
    tui.requestRender();
  }, FRAME_INTERVAL_MS);
}

/**
 * Install the splash for the header we were just handed: reset the animation
 * ref and start the frame timer. Re-installing (a new session, `/reload`, or
 * any other `setHeader()` replacement, each of which pi disposes the old header
 * before it calls the factory) restarts the animation on the renderer now in
 * hand and stops the previous one — a stale renderer must not keep being asked
 * for frames.
 *
 * Sections are not passed here: call {@link revealStartupListing} with them
 * (or not at all, which leaves the splash as logo + version).
 */
export function patchStartupListing(tui: TUI, ref: ListingRef): void {
  stopStartupListing();
  ref.frame = 0;
  ref.revealed = false;
  ref.revealedAt = 0;
  ref.scaffoldAt = 0;
  ref.settled = false;
  delete ref.cachedLines;
  delete ref.cachedWidth;
  delete ref.cachedHeight;

  startFrameTimer(tui, ref);
}

/**
 * Reveal the splash's text half — the version row always comes with the
 * header, `sections` is whatever the caller decided to show next (see
 * {@link modelScopeSection}).
 *
 * Debounced so the logo keeps its frames, and it restarts the frame timer when
 * the logo already settled before anything arrived: without the restart the
 * text would be revealed into a stopped animation and fade in over frames
 * nobody draws.
 */
export function revealStartupListing(
  tui: TUI,
  ref: ListingRef,
  sections: ParsedSection[],
): void {
  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    revealTimer = undefined;
    ref.sections = sections;
    ref.revealed = true;
    ref.revealedAt = ref.frame;
    ref.scaffoldAt = ref.frame;
    ref.settled = false;
    delete ref.cachedLines;
    delete ref.cachedWidth;
    delete ref.cachedHeight;
    tui.requestRender();
    if (!frameTimer) startFrameTimer(tui, ref);
  }, REVEAL_DEBOUNCE_MS);
}
