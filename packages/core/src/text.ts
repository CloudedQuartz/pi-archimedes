import { stripTerminalSequences } from "@earendil-works/pi-tui";

// Inline stripSgr — narrow SGR-only strip (no trim) for char-level checks
const stripSgr = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Strip ALL ANSI escape sequences and trim. Covers:
 * - CSI: ESC [ ... letter (SGR, cursor movement, etc.)
 * - OSC: ESC ] ... ST (operating system commands, OSC 8 hyperlinks)
 * - DCS: ESC P ... ST (device control strings)
 * - APC: ESC _ ... ST (application program commands — pi's CURSOR_MARKER)
 * - SOS: ESC ^ ... ST (start of string)
 * - PM:  ESC \x5c ... ST (privacy message)
 * - Character set: ESC ( or ESC ) (DECSET/DECRST)
 *
 * This is a wrapper, not a delegation, and the **local pattern set is the
 * load-bearing half**. pi-tui's `stripTerminalSequences` leaves DCS, SOS, PM and
 * the charset designators in place and never trims, so delegating to it alone
 * would feed control bytes — and stray padding — to the startup section parser
 * (`ui/src/startup/sections.ts`) and the footer, both of which parse this
 * output. The `stripTerminalSequences` pass that follows is the backstop for the
 * sequences our patterns do *not* describe, chiefly the colon sub-parameter
 * form of SGR (`\x1b[38:2:R:G:Bm`) and other private CSI shapes, which would
 * otherwise survive into the parsed text.
 *
 * Trims whitespace. Use for text extraction.
 */
export function stripAnsi(s: string): string {
  const ours = s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")            // CSI
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, "")           // OSC
    .replace(/\x1b[P^_\x5c].*?(?:\x07|\x1b\\)/g, "")    // DCS, SOS, APC, PM
    .replace(/\x1b[()]/g, "");                          // character set
  return stripTerminalSequences(ours).trim();
}

// isParentBorder uses the narrow SGR-only strip (no trim) for char-level checks
export const isParentBorder = (s: string) => {
  const clean = stripSgr(s);
  return clean.length > 0 && clean[0] === "─";
};

export function formatKey(key: string | undefined): string {
  if (!key) return "that key";
  return key
    .split("+")
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "ctrl") return "Ctrl";
      if (lower === "alt") return "Alt";
      if (lower === "shift") return "Shift";
      if (lower === "cmd" || lower === "meta") return "Cmd";
      return part.length === 1
        ? part.toUpperCase()
        : part[0]!.toUpperCase() + part.slice(1);
    })
    .join("+");
}
