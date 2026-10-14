import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { KeyId } from "@earendil-works/pi-tui";

import {
  buildPathInsertion,
  clipboardTextForEditor,
  readClipboardFilePaths,
  readClipboardImage,
  readClipboardText,
} from "./clipboard.js";
import { registerImagePreview, sendPreviewMessage } from "./preview.js";
import type { ClipboardImage, PendingImage, ImageMarker } from "./types.js";

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

// ── Queue management ────────────────────────────────────────────

export interface ImageQueue {
  images: PendingImage[];
  markers: ImageMarker[];
  nextIndex: number;
}

export function createImageQueue(): ImageQueue {
  return { images: [], markers: [], nextIndex: 1 };
}

// Marker key: the visible text WITHOUT trailing space (e.g. "[Image #1]")
// This is used for both detection and replacement — consistent strategy.
function markerKey(marker: ImageMarker): string {
  return marker.text.trim();
}

function queueImage(
  queue: ImageQueue,
  image: ClipboardImage,
  ctx: ExtensionContext,
): ImageMarker {
  const id = randomUUID();
  const placeholder = `[Image #${queue.nextIndex}] `;

  const pending: PendingImage = {
    id,
    base64: Buffer.from(image.bytes).toString("base64"),
    mimeType: image.mimeType,
  };
  queue.images.push(pending);

  const marker: ImageMarker = {
    id,
    text: placeholder,
    index: queue.nextIndex,
  };
  queue.markers.push(marker);
  queue.nextIndex += 1;

  // Insert placeholder into editor
  ctx.ui.pasteToEditor(placeholder);
  return marker;
}

// ── The paste dispatch ──────────────────────────────────────────────────────

/**
 * One `ctrl+v`, one outcome, in this order: **image → file paths → text**.
 *
 * The order is deliberately NOT pi's. pi's native `handleClipboardPaste` asks
 * for paths first, then an image, then text
 * (`dist/modes/interactive/interactive-mode.js:2497-2531`). We took this key off
 * pi precisely in order to attach images, so an image has to win here —
 * otherwise copying a screenshot on macOS (whose pasteboard carries both the
 * file URL and the image bytes) would keep inserting a path and the one thing
 * this package adds would never fire. Do not "fix" this to match pi: ADR 0030
 * keeps the binding on the condition that this handler is a *superset* of pi's
 * action, and the superset is this branch order plus pi's other two branches.
 *
 * Beyond the order, each branch matches pi's behaviour: the path branch reuses
 * pi's own spacing rule (`buildPathInsertion`), the text branch reads the
 * clipboard the way pi does (`readClipboardText`), and an empty clipboard is
 * silent — pi has no `else` at `:2526-2530`, so neither do we. The genuinely
 * additive branch is the first one: attach, queue, preview.
 */
export async function dispatchClipboardPaste(
  ctx: ExtensionContext,
  queue: ImageQueue,
): Promise<void> {
  try {
    // 1. Image bytes. A reader that cannot run at all is not the same as an
    //    empty clipboard, so the failure is kept aside: pi's dispatcher would
    //    have aborted here (its catch, `:2532-2534`), but on our key the paths
    //    and text branches are independent of the image reader, so they get
    //    their turn and the failure is only reported if nothing else answered.
    let imageReaderError: unknown = null;
    let image: ClipboardImage | null = null;
    try {
      image = await readClipboardImage();
    } catch (error) {
      imageReaderError = error;
    }

    if (image) {
      if (image.bytes.length > MAX_FILE_SIZE_BYTES) {
        ctx.ui.notify(
          `Image too large (${(image.bytes.length / 1024 / 1024).toFixed(1)}MB > 20MB).`,
          "warning",
        );
        return;
      }
      queueImage(queue, image, ctx);
      ctx.ui.notify("Image attached from clipboard.", "info");
      return;
    }

    // 2. Copied files. pi inserts the paths rather than attaching them, and so
    //    do we: a file copied in a file manager is a *path* on the clipboard,
    //    not image bytes, so a copied PNG is inserted as text and never read
    //    off disk. Exactly one branch runs per keypress, which is what keeps a
    //    path from ever attaching as well — nothing double-attaches.
    const filePaths = await readClipboardFilePaths();
    if (filePaths) {
      // pi's guard before inserting (`:2501-2503`).
      if (filePaths.some((filePath) => /\p{Cc}/u.test(filePath))) {
        throw new Error("Clipboard file path contains control characters");
      }
      // getEditorText is declared in 1.2.0 (types.d.ts:137); the peer floor is
      // 0.86.0, which this checkout cannot inspect, so the read is guarded and
      // degrades to pi's empty-draft case (no padding) instead of throwing.
      const editorText = ctx.ui.getEditorText?.() ?? "";
      ctx.ui.pasteToEditor(buildPathInsertion(filePaths, editorText));
      return;
    }

    // 3. Plain text, prepared for the bracketed-paste route `pasteToEditor`
    //    takes (see `clipboardTextForEditor`: an escape byte from the clipboard
    //    would otherwise end the paste and lose the rest of it).
    const text = await readClipboardText();
    if (text) {
      ctx.ui.pasteToEditor(clipboardTextForEditor(text));
      return;
    }

    // 4. Nothing to paste.
    if (imageReaderError) {
      throw imageReaderError instanceof Error
        ? imageReaderError
        : new Error(String(imageReaderError));
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    ctx.ui.notify(`Clipboard paste failed: ${msg}`, "warning");
  }
}

// ── Registration ────────────────────────────────────────────────

function getImagePasteShortcuts(): KeyId[] {
  if (process.platform === "win32") {
    return ["alt+v", "ctrl+alt+v"] as KeyId[];
  }
  return ["ctrl+v", "alt+v", "ctrl+alt+v"] as KeyId[];
}

// Module-level state — registered once, queue reset per session
let _ctx: ExtensionContext | null = null;
let _queue: ImageQueue | null = null;
let _pasting = false;

export function registerImagePaste(pi: ExtensionAPI): void {
  // Register preview renderer (once)
  registerImagePreview(pi);

  // Register shortcuts (once)
  const pasteFromClipboard = async (ctx: ExtensionContext): Promise<void> => {
    if (_pasting) return; // Mutex: prevent concurrent paste operations
    if (!_queue || !ctx.hasUI) return;
    _pasting = true;
    try {
      await dispatchClipboardPaste(ctx, _queue);
    } finally {
      _pasting = false;
    }
  };

  for (const shortcut of getImagePasteShortcuts()) {
    pi.registerShortcut(shortcut, {
      description: "Paste clipboard image, file paths, or text",
      handler: pasteFromClipboard,
    });
  }

  // Input event handler — attach images on submit (once)
  pi.on("input", async (event) => {
    if (event.source === "extension") {
      return { action: "continue" as const };
    }
    if (!_queue || !_queue.markers.length || !_ctx) {
      return { action: "continue" as const };
    }

    // ── Marker matching: use consistent key (trimmed text) ──
    let hasMarkers = false;
    for (const marker of _queue.markers) {
      if (event.text.includes(markerKey(marker))) {
        hasMarkers = true;
        break;
      }
    }

    if (!hasMarkers) {
      // No markers found — clear queue (user removed them)
      _queue.images.length = 0;
      _queue.markers.length = 0;
      _queue.nextIndex = 1;
      return { action: "continue" as const };
    }

    // Match markers to images using trimmed key
    const imagesToAttach: PendingImage[] = [];

    for (const marker of _queue.markers) {
      const key = markerKey(marker);
      if (event.text.includes(key)) {
        const pending = _queue.images.find((img) => img.id === marker.id);
        if (pending) {
          imagesToAttach.push(pending);
        }
      }
    }

    // Clear queue
    _queue.images.length = 0;
    _queue.markers.length = 0;
    _queue.nextIndex = 1;

    if (imagesToAttach.length === 0) {
      return { action: "continue" as const };
    }

    // Send preview message for TUI display (images are invisible in user messages)
    try {
      sendPreviewMessage(pi, imagesToAttach);
    } catch {
      // Preview is optional — don't fail the submit
    }

    return {
      action: "transform" as const,
      text: event.text,
      images: imagesToAttach.map((img) => ({
        type: "image" as const,
        data: img.base64,
        mimeType: img.mimeType,
      })),
    };
  });
}

// Called on session_start to initialize/reset the queue
export function initImagePasteSession(ctx: ExtensionContext): void {
  _ctx = ctx;
  _queue = createImageQueue();
}

// Called on session_shutdown to clear state
export function shutdownImagePaste(): void {
  _ctx = null;
  _queue = null;
  _pasting = false;
}

// ── Default export (for standalone pi.extensions loading) ─────────────────

// Pi's standalone loader requires a default export functioning as the
// extension factory. Meta imports the named exports directly (register
// + session lifecycle), so this default export is standalone-only.
export default function (pi: ExtensionAPI): void {
  registerImagePaste(pi);
  // Session lifecycle: pi requires per-session ctx for image pasting.
  pi.on("session_start", (_event, ctx) => {
    initImagePasteSession(ctx);
  });
  pi.on("session_shutdown", (_event, _ctx) => {
    shutdownImagePaste();
  });
}
