/**
 * Settings manager TUI component.
 * Center-screen overlay with 2 modes: List and Prompt (free-input field edit).
 *
 * The list is pi-tui's own `SettingsList` — the component behind pi's
 * `/settings` — wrapped in the shared overlay chrome from
 * `@pi-archimedes/core/overlay` (`wrapWithBorder`, `renderHeader`,
 * `renderFooter`) so `/archimedes` and `/plugins` look like every other
 * archimedes panel while the rows, their alignment, the selected-row
 * description and the change hint come from pi. The theme wiring below is
 * pi's `getSettingsListTheme()` (`pi-coding-agent`
 * `dist/modes/interactive/theme/theme.js:896`) re-anchored on the `Theme`
 * instance pi hands the overlay factory: accent for the selected label and the
 * cursor, accent/muted for the value, dim for description and hint. No escape
 * sequence is composed here (ADR 0029).
 *
 * Two pieces stay ours because pi's component does not offer them:
 *
 * - **Search.** `SettingsList`'s `enableSearch` shows a fuzzy filter box
 *   permanently, which would (a) swallow the `s` keystroke the panel needs for
 *   save, and (b) remove the `/`-arm / esc-clear the overlay has always had. So
 *   the row is ours — pi-tui's `Input` drawing it, our substring filter feeding
 *   the list — and `enableSearch` is left off.
 * - **← / → stepping.** `SettingsList` cycles a value on Enter/Space only and
 *   exposes no way to read which row it has selected, so the cursor index is
 *   mirrored here (`move()` drives the list with `selectItem`) and the arrows
 *   step against it. Enter/Space are forwarded untouched, which is what makes
 *   the free-input row work: an editable item carries a `submenu`, and pi's
 *   component opens whatever component that returns.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  SettingsList,
  decodeKittyPrintable,
  getKeybindings,
  matchesKey,
  type Component,
  type SettingItem,
  type SettingsListTheme,
} from "@earendil-works/pi-tui";
import {
  padEnd,
  renderHeader,
  renderFooter,
  wrapWithBorder,
  borderContentWidth,
  visibleWidth,
} from "@pi-archimedes/core/overlay";

// ── Public types ────────────────────────────────────────────────────────────

export interface PromptDescriptor {
  kind: "text" | "number";
  label: string;
  min?: number;
}

export interface SettingsManagerOptions {
  items: SettingItem[];
  /** Free-input fields keyed by item.id — Enter on these opens prompt mode. */
  prompts: Record<string, PromptDescriptor>;
  theme: Theme;
  onChange: (id: string, newValue: string) => void;
  onSave: () => void;
  onClose: () => void;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Visible rows. pi's root `/settings` list shows ten (`settings-selector.js:628`). */
const MAX_VISIBLE = 10;

const TITLE = " Settings ";
/**
 * The keys pi's own hint line under the list does not mention. It says
 * "Enter/Space to change · Esc to cancel", so those are not repeated here.
 */
const LIST_KEYS = " [↑↓] move  [←→] value  [/] search  [s] save ";
const PROMPT_KEYS = " [enter] confirm  [esc] cancel ";
/** Affordance for a row that takes typed text rather than cycling values. */
const EDITABLE_HINT = "Enter to type a value";
/** Shown when the search filters everything out (the wording the panel has always used). */
const NO_MATCHES = "No matching settings";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * ASCII printable — the list SEARCH input, as it has always been: a wide
 * search query is not reachable from the keyboard (the free-input field is, and
 * pi-tui's `Input` accepts the whole range there).
 */
function isAsciiPrintable(data: string): boolean {
  return data.length === 1 && data >= " " && data <= "~";
}

/**
 * Single non-control code point — a keystroke that would *insert* text, so a
 * number field can reject it. Accented/Cyrillic/CJK count; DEL and C1 do not.
 */
function isInsertChar(data: string): boolean {
  if (data.length !== 1) return false;
  const cp = data.codePointAt(0);
  if (cp === undefined || cp < 0x20 || cp === 0x7f) return false;
  if (cp >= 0x80 && cp <= 0x9f) return false;
  return true;
}

// ── Component ───────────────────────────────────────────────────────────────

export function createSettingsManager(opts: SettingsManagerOptions): {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  dispose(): void;
} {
  const theme = opts.theme;
  const kb = getKeybindings();

  // pi's getSettingsListTheme(), token for token.
  const listTheme: SettingsListTheme = {
    label: (text, selected) => (selected ? theme.fg("accent", text) : text),
    value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
    description: (text) => theme.fg("dim", text),
    cursor: theme.fg("accent", "→ "),
    hint: (text) => theme.fg("dim", text),
  };

  /**
   * Label column, in drawn cells. `SettingsList` sizes it from the rows it is
   * handed (`min(36, widest label)`) and this panel hands it a filtered subset,
   * so labels are padded to the width the whole set implies — otherwise the
   * value column slides left every time the search narrows.
   */
  const labelColumn = Math.max(
    1,
    Math.min(
      36,
      opts.items.reduce((max, item) => Math.max(max, visibleWidth(item.label)), 0),
    ),
  );

  /** The caller's own label per row, so the search matches what the item is called. */
  const labels = new Map<string, string>();

  /**
   * Rows as the list sees them: one per caller item, kept here so a write
   * survives a filter rebuild and the caller's own item objects are never
   * touched. Descriptions gain the editable affordance; editable rows gain the
   * submenu that opens the field.
   */
  const rows: SettingItem[] = opts.items.map((item) => {
    const descriptor = opts.prompts[item.id];
    labels.set(item.id, item.label);
    const row: SettingItem = {
      id: item.id,
      label: padEnd(item.label, labelColumn),
      currentValue: item.currentValue,
    };
    if (item.description !== undefined) row.description = item.description;
    if (item.values !== undefined) row.values = item.values;
    if (!descriptor) return row;
    row.description = row.description ? `${row.description} · ${EDITABLE_HINT}` : EDITABLE_HINT;
    row.submenu = (currentValue, done) => openField(descriptor, currentValue, done);
    return row;
  });

  const searchInput = new Input({ prompt: "Search: " });
  // This overlay is the focused component whenever it is drawn, so the field it
  // shows owns the hardware cursor marker.
  searchInput.focused = true;

  let list = buildList("");
  let searchArmed = false;
  /** Index into the rows the list is showing; kept in step with `list`. */
  let cursor = 0;
  /** True while a free-input field is open (the list's submenu). */
  let promptOpen = false;

  function visibleRows(query: string): SettingItem[] {
    if (!query) return rows;
    const q = query.toLowerCase();
    // Matched on the caller's own label, never on the padded copy.
    return rows.filter((row) => (labels.get(row.id) ?? row.label).toLowerCase().includes(q));
  }

  function buildList(query: string): SettingsList {
    return new SettingsList(
      visibleRows(query),
      MAX_VISIBLE,
      listTheme,
      // `SettingsList` has already written `currentValue` on the row object.
      (id, newValue) => writeValue(id, newValue),
      () => opts.onClose(),
      { enableSearch: false },
    );
  }

  /** The one write path: never report a change for an item the caller dropped. */
  function writeValue(id: string, newValue: string): void {
    if (!opts.items.some((item) => item.id === id)) return;
    opts.onChange(id, newValue);
  }

  function shownRows(): SettingItem[] {
    return visibleRows(searchInput.getValue());
  }

  // ── Prompt mode (a `SettingsList` submenu) ────────────────────────────────

  function openField(
    descriptor: PromptDescriptor,
    seed: string,
    done: (selectedValue?: string) => void,
  ): Component {
    const field = new Input({ prompt: "" });
    field.focused = true;
    // Seed through pi-tui's own paste path: `setValue` parks the caret at 0 (so
    // the first Backspace would eat nothing and the first character land in
    // front of the value), and pasting cannot split a grapheme.
    field.handleInput(`\x1b[200~${seed}\x1b[201~`);
    let error: string | null = null;
    promptOpen = true;

    const close = (selectedValue?: string): void => {
      promptOpen = false;
      done(selectedValue);
    };

    const commit = (): void => {
      const typed = field.getValue();
      if (descriptor.kind === "number") {
        const n = parseInt(typed, 10);
        if (!Number.isFinite(n) || n < (descriptor.min ?? 0)) {
          error = `must be >= ${descriptor.min ?? 0}`;
          return; // stay in the field, exactly as before
        }
        close(String(n));
        return;
      }
      close(typed);
    };

    return {
      render(width: number): string[] {
        const lines: string[] = [];
        lines.push(theme.fg("dim", `  ${descriptor.label}`));
        const inner = Math.max(1, width - 2);
        lines.push(padEnd(`  ${field.render(inner)[0] ?? ""}`, width));
        lines.push(padEnd("", width));
        if (error) lines.push(theme.fg("error", `  ${error}`));
        return lines;
      },

      handleInput(data: string): void {
        if (kb.matches(data, "tui.input.submit") || data === "\n") {
          commit();
          return;
        }
        if (kb.matches(data, "tui.select.cancel")) {
          // Discard the typed value: nothing is written, the row keeps its own.
          close();
          return;
        }
        if (descriptor.kind === "number") {
          // Digits only, as the field has always been: a keystroke that would
          // insert something else is swallowed before it reaches the field.
          const kitty = decodeKittyPrintable(data);
          if (kitty !== undefined ? !/^\d$/.test(kitty) : isInsertChar(data) && !/\d/.test(data)) return;
          // …and no paste.
          if (data.includes("\x1b[200~")) return;
        }
        field.handleInput(data);
        error = null;
      },

      invalidate(): void {
        field.invalidate();
      },
    };
  }

  // ── List-mode input ───────────────────────────────────────────────────────

  function refilter(): void {
    cursor = 0;
    list = buildList(searchInput.getValue());
  }

  function move(delta: number): void {
    const items = shownRows();
    if (items.length === 0) return;
    cursor = (cursor + delta + items.length) % items.length;
    const target = items[cursor];
    // The list owns the visible window, so the mirror is pushed into it.
    if (target) list.selectItem(target.id);
  }

  function stepValue(direction: 1 | -1): void {
    const item = shownRows()[cursor];
    if (!item || !item.values || item.values.length <= 1) return;
    const values = item.values;
    const currentIdx = Math.max(0, values.indexOf(item.currentValue));
    const nextIndex = (currentIdx + direction + values.length) % values.length;
    const next = values[nextIndex];
    if (next === undefined) return;
    item.currentValue = next;
    writeValue(item.id, next);
  }

  function handleListInput(data: string): void {
    if (kb.matches(data, "tui.select.cancel") && searchArmed) {
      // esc clears an armed search before it means "close".
      searchInput.setValue("");
      searchArmed = false;
      refilter();
      return;
    }
    if (kb.matches(data, "tui.select.up")) {
      move(-1);
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      move(1);
      return;
    }
    // Value stepping is the arrow keys and only the arrow keys. The editor
    // actions `tui.editor.cursorLeft` / `cursorRight` also carry ctrl+b and
    // ctrl+f, and a keystroke typed out of editor habit must not change a
    // setting — in `/plugins` that write reaches the disk immediately. The
    // footer advertises `[←→] value` and `SettingsList` has no left/right of its
    // own to inherit, so the arrows are the whole contract; matching them by
    // name keeps a Kitty CSI-u terminal's arrows working.
    if (matchesKey(data, Key.left)) {
      stepValue(-1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      stepValue(1);
      return;
    }
    // `matchesKey`, not `data === "/"`: a terminal with the Kitty keyboard
    // protocol enabled sends printable keys as CSI-u (`/` arrives as `\x1b[47u`).
    if (matchesKey(data, "/")) {
      // Re-pressing while active is a no-op, not a character.
      searchArmed = true;
      return;
    }
    if (searchArmed) {
      if (kb.matches(data, "tui.editor.deleteCharBackward")) {
        searchInput.handleInput(data);
        refilter();
        return;
      }
      // Decoded first, so the query is typeable on a CSI-u terminal too (a bare
      // comparison saw `\x1b[115u` as nothing at all, so nothing could be typed).
      const typed = decodeKittyPrintable(data) ?? data;
      if (isAsciiPrintable(typed)) {
        searchInput.handleInput(typed);
        refilter();
        return;
      }
    }
    if (matchesKey(data, "s") && !searchArmed) {
      opts.onSave();
      return;
    }
    // Enter / Space belong to pi's component: cycle the value, or open the
    // field an editable row carries. esc arrives here too, as onCancel.
    list.handleInput(data);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  /**
   * The list, or the empty-filter message. The filter is ours, so an empty
   * result is ours to report — handed an empty item set `SettingsList` would
   * say "No settings available", which is about a panel with no settings at all.
   */
  function listBody(contentWidth: number): string[] {
    if (searchInput.getValue() && shownRows().length === 0) {
      return [theme.fg("dim", `  ${NO_MATCHES}`)];
    }
    return list.render(contentWidth);
  }

  function render(width: number): string[] {
    const contentWidth = borderContentWidth(width);
    const lines: string[] = [renderHeader(TITLE, contentWidth, theme), padEnd("", contentWidth)];

    if (searchArmed && !promptOpen) {
      lines.push(padEnd(searchInput.render(contentWidth)[0] ?? "", contentWidth));
    }
    lines.push(padEnd("", contentWidth));

    lines.push(...listBody(contentWidth));

    // The list ends on its own hint line; the field needs a gap before the keys.
    if (promptOpen) lines.push(padEnd("", contentWidth));
    lines.push(renderFooter(promptOpen ? PROMPT_KEYS : LIST_KEYS, contentWidth, theme));

    return wrapWithBorder(lines, width, theme);
  }

  return {
    render,
    handleInput(data: string): void {
      // While a field is open the list forwards every keystroke to it.
      if (promptOpen) {
        list.handleInput(data);
      } else {
        handleListInput(data);
      }
    },

    invalidate(): void {
      list.invalidate();
      searchInput.invalidate();
    },

    dispose(): void {
      // No timers or subscriptions to clean up.
    },
  };
}
