import { describe, expect, it, vi } from "vitest";
import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// The three clipboard readers are the seam: the dispatch under test decides
// *which* of them wins, and the real ones would shell out to wl-paste / xclip
// and open the X11 display during a unit test. `isImageFilePath` stays real —
// the no-double-attach case asserts its premise, so mocking it would be
// circular.
const { mockReadClipboardImage, mockReadClipboardFilePaths, mockReadClipboardText } = vi.hoisted(() => ({
  mockReadClipboardImage: vi.fn(),
  mockReadClipboardFilePaths: vi.fn(),
  mockReadClipboardText: vi.fn(),
}));

vi.mock("./clipboard.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./clipboard.js")>();
  return {
    ...real,
    readClipboardImage: mockReadClipboardImage,
    readClipboardFilePaths: mockReadClipboardFilePaths,
    readClipboardText: mockReadClipboardText,
  };
});

import { createImageQueue, dispatchClipboardPaste, type ImageQueue } from "./index.js";
import { isImageFilePath } from "./clipboard.js";

// ── The editor is real, not a stub ──────────────────────────────────────────
//
// `ctx.ui.pasteToEditor` is pi's bracketed-paste wiring verbatim
// (interactive-mode.js:2075: `this.editor.handleInput("\x1b[200~" + text +
// "\x1b[201~")`) and `getEditorText` is :2077 (`getExpandedText?.() ??
// getText()`), so the assertions below read the text a real pi-tui `Editor`
// ends up holding — including the editor's own paste handling (its leading
// space for `/`-leading pastes, its large-paste collapse marker), not a
// hand-written approximation of it. Only the renderer is faked: `Editor`
// touches `tui.requestRender()` and `tui.terminal.rows` and nothing else on
// this path.
interface Harness {
  ctx: ExtensionContext;
  queue: ImageQueue;
  editor: Editor;
  inserted: string[];
  notifications: Array<[string, string | undefined]>;
}

function createHarness(options?: { editorText?: string }): Harness {
  const editor = new Editor(
    { requestRender: () => {}, terminal: { rows: 40, cols: 120 } } as unknown as TUI,
    { borderColor: (s: string) => s, selectList: {} } as unknown as EditorTheme,
  );
  if (options?.editorText) {
    editor.setText(options.editorText);
  }

  const inserted: string[] = [];
  const notifications: Array<[string, string | undefined]> = [];
  const ctx = {
    hasUI: true,
    ui: {
      pasteToEditor: (text: string) => {
        inserted.push(text);
        editor.handleInput(`\x1b[200~${text}\x1b[201~`);
      },
      getEditorText: () => editor.getExpandedText?.() ?? editor.getText(),
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push([message, type]);
      },
    },
  } as unknown as ExtensionContext;

  return { ctx, queue: createImageQueue(), editor, inserted, notifications };
}

function editorText(h: Harness): string {
  return h.editor.getExpandedText?.() ?? h.editor.getText();
}

const PNG = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png" };

describe("dispatchClipboardPaste: precedence image → file paths → text", () => {
  it("attaches the image and never consults the path reader when both are on the clipboard", async () => {
    const h = createHarness();
    mockReadClipboardImage.mockResolvedValue(PNG);
    mockReadClipboardFilePaths.mockResolvedValue(["/tmp/also-on-clipboard.txt"]);
    mockReadClipboardText.mockResolvedValue("also text");

    await dispatchClipboardPaste(h.ctx, h.queue);

    // The image branch wins *first*: the path reader is not even reached.
    // This is the whole point of diverging from pi's native order, so the
    // assertion is on the call, not just on the visible outcome.
    expect(mockReadClipboardFilePaths).not.toHaveBeenCalled();
    expect(mockReadClipboardText).not.toHaveBeenCalled();
    expect(h.inserted).toEqual(["[Image #1] "]);
    expect(h.notifications).toEqual([["Image attached from clipboard.", "info"]]);
    expect(h.queue.images).toHaveLength(1);
    expect(editorText(h)).toBe("[Image #1] ");
  });

  it("inserts clipboard file paths with pi's spacing when there is no image", async () => {
    const h = createHarness({ editorText: "look at" });
    mockReadClipboardImage.mockResolvedValue(null);
    mockReadClipboardFilePaths.mockResolvedValue(["/tmp/report.pdf"]);
    mockReadClipboardText.mockResolvedValue("ignored text");

    await dispatchClipboardPaste(h.ctx, h.queue);

    // pi: character before the cursor is non-whitespace → one leading space;
    // nothing after it → no trailing space (interactive-mode.js:2507-2511).
    expect(h.inserted).toEqual([" /tmp/report.pdf"]);
    expect(editorText(h)).toBe("look at /tmp/report.pdf");
    expect(h.notifications).toEqual([]);
    expect(h.queue.images).toHaveLength(0);
  });

  it("inserts clipboard text when there is neither an image nor file paths", async () => {
    const h = createHarness({ editorText: "summarise " });
    mockReadClipboardImage.mockResolvedValue(null);
    mockReadClipboardFilePaths.mockResolvedValue(null);
    mockReadClipboardText.mockResolvedValue("the pasted paragraph");

    await dispatchClipboardPaste(h.ctx, h.queue);

    expect(h.inserted).toEqual(["the pasted paragraph"]);
    expect(editorText(h)).toBe("summarise the pasted paragraph");
    expect(h.notifications).toEqual([]);
  });

  it("adds no leading space when the draft ends in a newline (the cursor is on a fresh line)", async () => {
    const h = createHarness({ editorText: "look at\n" });
    mockReadClipboardImage.mockResolvedValue(null);
    mockReadClipboardFilePaths.mockResolvedValue(["/tmp/report.pdf"]);

    await dispatchClipboardPaste(h.ctx, h.queue);

    // pi reads the cursor's own line, and that line is empty (:2506-2509), so
    // the path lands bare on the second line — asserted against the real
    // editor, which is what actually splits the paste across lines.
    expect(h.inserted).toEqual(["/tmp/report.pdf"]);
    expect(editorText(h)).toBe("look at\n/tmp/report.pdf");
  });

  it("inserts nothing and notifies nothing when the clipboard holds nothing (pi is silent here)", async () => {
    const h = createHarness();
    mockReadClipboardImage.mockResolvedValue(null);
    mockReadClipboardFilePaths.mockResolvedValue(null);
    mockReadClipboardText.mockResolvedValue(null);

    await dispatchClipboardPaste(h.ctx, h.queue);

    expect(h.inserted).toEqual([]);
    expect(h.notifications).toEqual([]);
  });

  it("still pastes text when the image reader cannot run at all (no reader is not an empty clipboard)", async () => {
    const h = createHarness();
    mockReadClipboardImage.mockRejectedValue(
      new Error("Clipboard image paste requires a graphical desktop session with DISPLAY or WAYLAND_DISPLAY."),
    );
    mockReadClipboardFilePaths.mockResolvedValue(null);
    mockReadClipboardText.mockResolvedValue("text from a headless session");

    await dispatchClipboardPaste(h.ctx, h.queue);

    expect(h.inserted).toEqual(["text from a headless session"]);
    expect(h.notifications).toEqual([]);
  });

  it("reports the reader failure when nothing else was on the clipboard", async () => {
    const h = createHarness();
    mockReadClipboardImage.mockRejectedValue(new Error("no clipboard reader available"));
    mockReadClipboardFilePaths.mockResolvedValue(null);
    mockReadClipboardText.mockResolvedValue(null);

    await dispatchClipboardPaste(h.ctx, h.queue);

    expect(h.inserted).toEqual([]);
    expect(h.notifications).toEqual([["Clipboard paste failed: no clipboard reader available", "warning"]]);
  });

  it("keeps the size limit as a hard stop: an oversized image does not fall through to paths", async () => {
    const h = createHarness();
    mockReadClipboardImage.mockResolvedValue({
      bytes: new Uint8Array(20 * 1024 * 1024 + 1),
      mimeType: "image/png",
    });
    mockReadClipboardFilePaths.mockResolvedValue(["/tmp/report.pdf"]);

    await dispatchClipboardPaste(h.ctx, h.queue);

    expect(h.inserted).toEqual([]);
    expect(h.notifications[0]?.[0]).toMatch(/Image too large/);
    expect(h.notifications[0]?.[1]).toBe("warning");
  });
});

describe("dispatchClipboardPaste: pi's path branch details", () => {
  it("refuses a path containing control characters instead of inserting it", async () => {
    const h = createHarness();
    mockReadClipboardImage.mockResolvedValue(null);
    mockReadClipboardFilePaths.mockResolvedValue(["/tmp/ok.txt", "/tmp/bad\nname.txt"]);

    await dispatchClipboardPaste(h.ctx, h.queue);

    // interactive-mode.js:2501-2503 throws rather than inserting; the user
    // gets the failure, the editor gets nothing.
    expect(h.inserted).toEqual([]);
    expect(h.notifications).toEqual([
      ["Clipboard paste failed: Clipboard file path contains control characters", "warning"],
    ]);
  });

  it("inserts a copied image file as path text and attaches nothing (one branch per keypress)", async () => {
    // Premise, from this package's own predicate: the path IS an image path.
    expect(isImageFilePath("/tmp/screenshot.png")).toBe(true);

    const h = createHarness();
    mockReadClipboardImage.mockResolvedValue(null);
    mockReadClipboardFilePaths.mockResolvedValue(["/tmp/screenshot.png"]);

    await dispatchClipboardPaste(h.ctx, h.queue);

    // Intended behaviour (ADR 0030: the path branch matches pi): a file
    // copied in the file manager is a *path* on the clipboard, not image
    // bytes, so it is inserted as text and never read off disk. Because
    // exactly one branch runs per keypress, a path can never be attached as
    // well — nothing double-attaches, and the queue stays empty.
    expect(h.inserted).toEqual(["/tmp/screenshot.png"]);
    expect(editorText(h)).toBe("/tmp/screenshot.png");
    expect(h.queue.images).toHaveLength(0);
    expect(h.queue.markers).toHaveLength(0);
    expect(h.notifications).toEqual([]);
  });

  it("joins a multi-path clipboard with newlines and keeps pi's surrounding spaces", async () => {
    const h = createHarness({ editorText: "compare" });
    mockReadClipboardImage.mockResolvedValue(null);
    mockReadClipboardFilePaths.mockResolvedValue(["/tmp/one.txt", "/tmp/two.txt", "/tmp/three.txt"]);

    await dispatchClipboardPaste(h.ctx, h.queue);

    expect(h.inserted).toEqual([" /tmp/one.txt\n/tmp/two.txt\n/tmp/three.txt"]);
    expect(editorText(h)).toBe("compare /tmp/one.txt\n/tmp/two.txt\n/tmp/three.txt");
  });

  it("quotes and space-joins paths when the draft is a bash command (pi's isBashMode branch)", async () => {
    const h = createHarness({ editorText: "!ls " });
    mockReadClipboardImage.mockResolvedValue(null);
    mockReadClipboardFilePaths.mockResolvedValue(["/tmp/a file.txt", "/tmp/plain.txt"]);

    await dispatchClipboardPaste(h.ctx, h.queue);

    // interactive-mode.js:2504 quotes each path when the draft starts with "!"
    // and joins with spaces, so the shell sees two arguments.
    expect(h.inserted).toEqual(["'/tmp/a file.txt' /tmp/plain.txt"]);
    expect(editorText(h)).toBe("!ls '/tmp/a file.txt' /tmp/plain.txt");
  });

  it("pins what a large multi-path clipboard looks like: the editor's own paste collapse", async () => {
    // The one place where the available insertion mechanism differs from pi's.
    // pi writes `${leading}${paths}${trailing}` with insertTextAtCursor, which
    // it does not expose to extensions; `ctx.ui.pasteToEditor` is a bracketed
    // paste, and pi-tui's editor collapses a paste of more than 10 lines or
    // 1000 characters to a marker (components/editor.js:1094-1109). Measured,
    // not assumed: 12 paths render as `compare [paste #1 +12 lines]` and
    // `getExpandedText()` — what pi submits — returns all twelve paths, so the
    // draft the model receives is identical to pi's and only the display text
    // differs. 5 paths, under the threshold, are inserted literally.
    const h = createHarness({ editorText: "compare " });
    mockReadClipboardImage.mockResolvedValue(null);
    mockReadClipboardFilePaths.mockResolvedValue(
      Array.from({ length: 12 }, (_unused, index) => `/tmp/path-${index}.txt`),
    );

    await dispatchClipboardPaste(h.ctx, h.queue);

    // No leading space: the draft ends in whitespace, so pi's rule adds none.
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatch(/^\/tmp\/path-0\.txt\n/);
    expect(h.editor.getText()).toBe("compare [paste #1 +12 lines]");
    expect(editorText(h)).toBe(`compare ${h.inserted.join("")}`);
  });

  it("inserts a five-path clipboard literally, under the editor's collapse threshold", async () => {
    const h = createHarness({ editorText: "a" });
    mockReadClipboardImage.mockResolvedValue(null);
    mockReadClipboardFilePaths.mockResolvedValue(["/tmp/p0.txt", "/tmp/p1.txt", "/tmp/p2.txt", "/tmp/p3.txt", "/tmp/p4.txt"]);

    await dispatchClipboardPaste(h.ctx, h.queue);

    expect(editorText(h)).toBe("a /tmp/p0.txt\n/tmp/p1.txt\n/tmp/p2.txt\n/tmp/p3.txt\n/tmp/p4.txt");
  });

  it("pins the known cursor limitation: the extension API exposes no cursor, so a mid-line paste loses pi's trailing space", async () => {
    // A live check, and the honest record of the gap: `ExtensionUIContext`
    // offers pasteToEditor / getEditorText / setEditorText and no cursor
    // accessor (dist/core/extensions/types.d.ts:132-137), so the spacing rule
    // can only be computed against the end of the draft. Here the cursor sits
    // mid-line (after "alph"), where pi would also add a trailing space; we
    // cannot see it and produce the run-on "x.txta" where pi produces
    // "x.txt a". The rule itself is exact — see buildPathInsertion's
    // cursor-mid-line case in clipboard.test.ts, which passes the cursor.
    const h = createHarness({ editorText: "alpha" });
    // "alpha" typed one character at a time leaves the cursor after the "a";
    // move it back one grapheme so the paste lands mid-line.
    h.editor.handleInput("\x1b[D");
    mockReadClipboardImage.mockResolvedValue(null);
    mockReadClipboardFilePaths.mockResolvedValue(["/tmp/x.txt"]);

    await dispatchClipboardPaste(h.ctx, h.queue);

    expect(h.inserted).toEqual([" /tmp/x.txt"]);
    expect(editorText(h)).toBe("alph /tmp/x.txta");
  });
});

describe("dispatchClipboardPaste: screen-mode independence", () => {
  // The paste path is screen-mode independent because it never holds or
  // touches a renderer: the only surfaces it uses are the three screen-safe
  // extension UI methods. This is the mechanical statement of that claim —
  // anything reaching for `tui`, an overlay or a component fails it, and the
  // suite-wide renderer-hoarding guard (core/src/screen-mode-discipline.test.ts)
  // covers the stored-reference half.
  //
  // What is under test is what the dispatch *reads*, so `ctx.ui` is replaced
  // with a Proxy that records every property access and throws on any name
  // outside the allow-list. (An earlier version asserted `Object.keys(ctx.ui)`
  // — the shape of this harness, which the dispatch cannot widen, so a dispatch
  // that started calling `ctx.ui.setWidget` passed it. Greptile on PR #123;
  // the mutation `(ctx.ui as …).setStatus?.("k", "v")` in the dispatch turns
  // these red and left that assertion green.)
  const SCREEN_SAFE_SURFACES = ["getEditorText", "notify", "pasteToEditor"];

  /** Replace `h.ctx.ui` with a recorder/guard and return the access log. */
  function guardUiSurfaces(h: Harness): string[] {
    const accessed: string[] = [];
    const inner = h.ctx.ui as unknown as Record<string, unknown>;
    (h.ctx as unknown as { ui: unknown }).ui = new Proxy(inner, {
      get(target, property: string | symbol): unknown {
        if (typeof property !== "string") return undefined;
        accessed.push(property);
        if (!SCREEN_SAFE_SURFACES.includes(property)) {
          throw new Error(`ctx.ui.${property} is not a screen-safe surface`);
        }
        return target[property];
      },
    });
    return accessed;
  }

  function surfacesUsed(accessed: string[]): string[] {
    return [...new Set(accessed)].sort();
  }

  function assertNoGuardTrip(h: Harness): void {
    // A tripped guard is swallowed by the dispatch's own catch and reported as
    // a paste failure, so a clean run is part of the assertion.
    expect(h.notifications.filter(([message]) => message.startsWith("Clipboard paste failed"))).toEqual([]);
  }

  it("reads only pasteToEditor and notify on the image branch", async () => {
    const h = createHarness();
    const accessed = guardUiSurfaces(h);
    mockReadClipboardImage.mockResolvedValue(PNG);

    await dispatchClipboardPaste(h.ctx, h.queue);

    expect(surfacesUsed(accessed)).toEqual(["notify", "pasteToEditor"]);
    assertNoGuardTrip(h);
  });

  it("reads only getEditorText and pasteToEditor on the file-path branch", async () => {
    const h = createHarness({ editorText: "compare" });
    const accessed = guardUiSurfaces(h);
    mockReadClipboardImage.mockResolvedValue(null);
    mockReadClipboardFilePaths.mockResolvedValue(["/tmp/one.txt"]);

    await dispatchClipboardPaste(h.ctx, h.queue);

    expect(surfacesUsed(accessed)).toEqual(["getEditorText", "pasteToEditor"]);
    assertNoGuardTrip(h);
  });

  it("reads only pasteToEditor on the text branch", async () => {
    const h = createHarness();
    const accessed = guardUiSurfaces(h);
    mockReadClipboardImage.mockResolvedValue(null);
    mockReadClipboardFilePaths.mockResolvedValue(null);
    mockReadClipboardText.mockResolvedValue("plain text");

    await dispatchClipboardPaste(h.ctx, h.queue);

    expect(surfacesUsed(accessed)).toEqual(["pasteToEditor"]);
    assertNoGuardTrip(h);
  });

  it("reads no UI surface at all when the clipboard holds nothing", async () => {
    const h = createHarness();
    const accessed = guardUiSurfaces(h);
    mockReadClipboardImage.mockResolvedValue(null);
    mockReadClipboardFilePaths.mockResolvedValue(null);
    mockReadClipboardText.mockResolvedValue(null);

    await dispatchClipboardPaste(h.ctx, h.queue);

    expect(accessed).toEqual([]);
    assertNoGuardTrip(h);
  });
});
