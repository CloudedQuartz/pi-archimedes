import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetImage, mockGetNativeClipboard, mockConvertToPng, mockSpawn, mockSpawnSync } = vi.hoisted(() => {
  return {
    mockGetImage: vi.fn(),
    mockGetNativeClipboard: vi.fn(),
    mockConvertToPng: vi.fn(),
    mockSpawn: vi.fn(),
    mockSpawnSync: vi.fn(),
  };
});

vi.mock("@earendil-works/pi-tui", () => ({
  getNativeClipboard: mockGetNativeClipboard,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  convertToPng: mockConvertToPng,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: mockSpawn,
    spawnSync: mockSpawnSync,
  };
});

// A clipboard reader has no UI handle, and the console is not a surface: the
// oversized-image report goes to the diagnostics sink (core/src/log.ts).
const mockDiag = vi.hoisted(() => vi.fn());
vi.mock("@pi-archimedes/core/log", async (importOriginal) => {
  const real = await importOriginal<typeof import("@pi-archimedes/core/log")>();
  return { ...real, diag: mockDiag };
});

import {
  buildPathInsertion,
  isImageFilePath,
  readClipboardFilePaths,
  readClipboardImage,
  readClipboardImageViaNativeModule,
  readClipboardText,
} from "./clipboard.js";

function createMockChildProcess(stdoutData = "", exitCode = 0) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  setTimeout(() => {
    if (stdoutData) {
      child.stdout.emit("data", Buffer.from(stdoutData));
    }
    child.emit("close", exitCode);
  }, 5);
  return child;
}

describe("readClipboardImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("macOS path", () => {
    it("returns PNG image when getNativeClipboard() returns PNG bytes", async () => {
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      mockGetImage.mockResolvedValue(pngBytes);
      mockGetNativeClipboard.mockReturnValue({ getImage: mockGetImage });

      const result = await readClipboardImage({ platform: "darwin", environment: {} });

      expect(mockGetNativeClipboard).toHaveBeenCalled();
      expect(mockGetImage).toHaveBeenCalled();
      expect(result).toEqual({
        bytes: pngBytes,
        mimeType: "image/png",
      });
    });

    it("returns null when getNativeClipboard() returns empty (null)", async () => {
      mockGetImage.mockResolvedValue(null);
      mockGetNativeClipboard.mockReturnValue({ getImage: mockGetImage });

      const result = await readClipboardImage({ platform: "darwin", environment: {} });

      expect(mockGetNativeClipboard).toHaveBeenCalled();
      expect(mockGetImage).toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("returns null when getNativeClipboard() returns empty Uint8Array", async () => {
      mockGetImage.mockResolvedValue(new Uint8Array(0));
      mockGetNativeClipboard.mockReturnValue({ getImage: mockGetImage });

      const result = await readClipboardImage({ platform: "darwin", environment: {} });

      expect(mockGetNativeClipboard).toHaveBeenCalled();
      expect(mockGetImage).toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });

  describe("Windows path", () => {
    it("converts BMP bytes to PNG via convertToPng and returns { bytes, mimeType }", async () => {
      const bmpBytes = new Uint8Array([0x42, 0x4d, 0x10, 0x20, 0x30]);
      mockGetImage.mockResolvedValue(bmpBytes);
      mockGetNativeClipboard.mockReturnValue({ getImage: mockGetImage });

      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const base64Png = Buffer.from(pngBytes).toString("base64");
      mockConvertToPng.mockResolvedValue({ data: base64Png, mimeType: "image/png" });

      const result = await readClipboardImage({ platform: "win32", environment: {} });

      expect(mockGetNativeClipboard).toHaveBeenCalled();
      expect(mockGetImage).toHaveBeenCalled();
      expect(mockConvertToPng).toHaveBeenCalledWith(
        Buffer.from(bmpBytes).toString("base64"),
        "image/bmp",
      );
      expect(result).toEqual({
        bytes: pngBytes,
        mimeType: "image/png",
      });
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("returns non-BMP bytes directly as image/png without convertToPng", async () => {
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      mockGetImage.mockResolvedValue(pngBytes);
      mockGetNativeClipboard.mockReturnValue({ getImage: mockGetImage });

      const result = await readClipboardImage({ platform: "win32", environment: {} });

      expect(mockConvertToPng).not.toHaveBeenCalled();
      expect(result).toEqual({
        bytes: pngBytes,
        mimeType: "image/png",
      });
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("falls back to PowerShell when convertToPng returns null", async () => {
      const bmpBytes = new Uint8Array([0x42, 0x4d, 0x10, 0x20]);
      mockGetImage.mockResolvedValue(bmpBytes);
      mockGetNativeClipboard.mockReturnValue({ getImage: mockGetImage });
      mockConvertToPng.mockResolvedValue(null);

      const fallbackBytes = new Uint8Array([1, 2, 3, 4]);
      mockSpawn.mockImplementation(() =>
        createMockChildProcess(Buffer.from(fallbackBytes).toString("base64"), 0),
      );

      const result = await readClipboardImage({ platform: "win32", environment: {} });

      expect(mockConvertToPng).toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalled();
      expect(result).toEqual({
        bytes: fallbackBytes,
        mimeType: "image/png",
      });
    });

    it("falls back to PowerShell when native.getImage() throws", async () => {
      mockGetImage.mockRejectedValue(new Error("Native failure"));
      mockGetNativeClipboard.mockReturnValue({ getImage: mockGetImage });

      const fallbackBytes = new Uint8Array([5, 6, 7, 8]);
      mockSpawn.mockImplementation(() =>
        createMockChildProcess(Buffer.from(fallbackBytes).toString("base64"), 0),
      );

      const result = await readClipboardImage({ platform: "win32", environment: {} });

      expect(mockSpawn).toHaveBeenCalled();
      expect(result).toEqual({
        bytes: fallbackBytes,
        mimeType: "image/png",
      });
    });

    it("falls back to PowerShell when getNativeClipboard() returns undefined", async () => {
      mockGetNativeClipboard.mockReturnValue(undefined);

      const fallbackBytes = new Uint8Array([9, 10, 11]);
      mockSpawn.mockImplementation(() =>
        createMockChildProcess(Buffer.from(fallbackBytes).toString("base64"), 0),
      );

      const result = await readClipboardImage({ platform: "win32", environment: {} });

      expect(mockSpawn).toHaveBeenCalled();
      expect(result).toEqual({
        bytes: fallbackBytes,
        mimeType: "image/png",
      });
    });

    it("diagnoses the log when PowerShell stdout exceeds MAX_BUFFER_BYTES", async () => {
      mockGetNativeClipboard.mockReturnValue(undefined);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.kill = vi.fn();
      mockSpawn.mockImplementation(() => {
        setTimeout(() => {
          child.stdout.emit("data", Buffer.alloc(50 * 1024 * 1024 + 1));
          child.emit("close", 0);
        }, 5);
        return child;
      });

      const result = await readClipboardImage({ platform: "win32", environment: {} });

      expect(mockDiag).toHaveBeenCalledWith(
        "image-paste",
        "[archimedes] Clipboard image exceeded maximum buffer size (50MB)",
      );
      expect(warnSpy).not.toHaveBeenCalled();
      expect(result).toBeNull();
      warnSpy.mockRestore();
    });
  });

  describe("Unavailable reader error messages", () => {
    it("reports pi-tui native clipboard or CLI tools instead of @mariozechner/clipboard on darwin", async () => {
      mockGetNativeClipboard.mockReturnValue(undefined);

      await expect(
        readClipboardImage({ platform: "darwin", environment: {} }),
      ).rejects.toThrow(/@earendil-works\/pi-tui native clipboard or CLI tools/);
    });

    it("reports pi-tui native clipboard or CLI tools instead of @mariozechner/clipboard on win32", async () => {
      mockGetNativeClipboard.mockReturnValue(undefined);
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.kill = vi.fn();
      mockSpawn.mockImplementation(() => {
        setTimeout(() => {
          const err = new Error("Command not found") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          child.emit("error", err);
        }, 5);
        return child;
      });

      await expect(
        readClipboardImage({ platform: "win32", environment: {} }),
      ).rejects.toThrow(/@earendil-works\/pi-tui native clipboard or CLI tools/);
    });
  });

  describe("Linux paths", () => {
    it("prefers Wayland (wl-paste attempted first) when WAYLAND_DISPLAY is set", async () => {
      mockSpawnSync.mockImplementation((command: string, args: string[]) => {
        if (command === "wl-paste" && args[0] === "--list-types") {
          return { status: 0, stdout: Buffer.from("image/png\n"), error: undefined };
        }
        if (command === "wl-paste" && args[0] === "--type") {
          return { status: 0, stdout: Buffer.from([1, 2, 3, 4]), error: undefined };
        }
        return { status: 1, stdout: Buffer.alloc(0), error: undefined };
      });

      const result = await readClipboardImage({
        platform: "linux",
        environment: { WAYLAND_DISPLAY: "wayland-0" },
      });

      expect(mockSpawnSync).toHaveBeenCalled();
      expect(mockSpawnSync.mock.calls[0]![0]).toBe("wl-paste");
      expect(result).toEqual({
        bytes: new Uint8Array([1, 2, 3, 4]),
        mimeType: "image/png",
      });
    });

    it("prefers X11 (xclip attempted first) when DISPLAY is set without Wayland", async () => {
      mockSpawnSync.mockImplementation((command: string, args: string[]) => {
        if (command === "xclip" && args.includes("TARGETS")) {
          return { status: 0, stdout: Buffer.from("image/png\n"), error: undefined };
        }
        if (command === "xclip" && args.includes("image/png")) {
          return { status: 0, stdout: Buffer.from([5, 6, 7]), error: undefined };
        }
        return { status: 1, stdout: Buffer.alloc(0), error: undefined };
      });

      const result = await readClipboardImage({
        platform: "linux",
        environment: { DISPLAY: ":0" },
      });

      expect(mockSpawnSync).toHaveBeenCalled();
      expect(mockSpawnSync.mock.calls[0]![0]).toBe("xclip");
      expect(result).toEqual({
        bytes: new Uint8Array([5, 6, 7]),
        mimeType: "image/png",
      });
    });

    it("throws appropriate graphical session error when DISPLAY and WAYLAND_DISPLAY are missing", async () => {
      await expect(
        readClipboardImage({ platform: "linux", environment: {} }),
      ).rejects.toThrow(
        "Clipboard image paste requires a graphical desktop session with DISPLAY or WAYLAND_DISPLAY.",
      );
    });

    it("TERMUX_VERSION returns { available: false, image: null } from native module and null from readClipboardImage", async () => {
      const nativeResult = await readClipboardImageViaNativeModule("linux", {
        TERMUX_VERSION: "0.118.0",
        DISPLAY: ":0",
      });
      expect(nativeResult).toEqual({ available: false, image: null });

      const result = await readClipboardImage({
        platform: "linux",
        environment: { TERMUX_VERSION: "0.118.0", DISPLAY: ":0" },
      });
      expect(result).toBeNull();
    });
  });
});

// ── File paths on the clipboard (pi's "paste files" branch) ─────────────────
//
// pi reads them with `getNativeClipboard()?.getFilePaths?.()`
// (`dist/utils/clipboard.js:83-86`). The optional call is load-bearing for
// this package: the peer floor is pi/pi-tui `>=0.86.0` and `getFilePaths` is
// newer than that, and it is absent on the Linux helper even in 1.2.0
// (measured on this machine: `typeof getNativeClipboard().getFilePaths ===
// "undefined"`, `dist/native-platform.d.ts:8` declares it optional).

describe("readClipboardFilePaths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the helper's paths verbatim", async () => {
    mockGetNativeClipboard.mockReturnValue({ getFilePaths: vi.fn().mockResolvedValue(["/tmp/a.txt", "/tmp/b.txt"]) });

    await expect(readClipboardFilePaths()).resolves.toEqual(["/tmp/a.txt", "/tmp/b.txt"]);
  });

  it("returns null on a helper without getFilePaths (the Linux 1.2.0 shape) instead of throwing", async () => {
    mockGetNativeClipboard.mockReturnValue({});

    await expect(readClipboardFilePaths()).resolves.toBeNull();
  });

  it("returns null when no clipboard helper loads at all", async () => {
    mockGetNativeClipboard.mockReturnValue(undefined);

    await expect(readClipboardFilePaths()).resolves.toBeNull();
  });

  it.each([[null], [undefined], [[]]])("normalises an empty file list (%p) to null", async (returnValue) => {
    mockGetNativeClipboard.mockReturnValue({ getFilePaths: vi.fn().mockResolvedValue(returnValue) });

    await expect(readClipboardFilePaths()).resolves.toBeNull();
  });

  it("lets a transfer failure reach the caller, as pi does", async () => {
    mockGetNativeClipboard.mockReturnValue({
      getFilePaths: vi.fn().mockRejectedValue(new Error("clipboard transfer failed")),
    });

    // pi does not catch here either — `handleClipboardPaste`'s own try/catch
    // turns it into the failure notice, and so does ours.
    await expect(readClipboardFilePaths()).rejects.toThrow("clipboard transfer failed");
  });
});

// ── Clipboard text (pi's fallback branch) ──────────────────────────────────
//
// Mirrors `readClipboardText()` in pi's `dist/utils/clipboard.js:58-81`, which
// is not reachable from a package (pi's exports are "." and "./rpc-entry";
// `dist/index.d.ts:38` re-exports only `copyToClipboard`). The candidate order
// is pi's and it is not decoration: on this Wayland machine the X11 helper
// loads but every read fails on `Invalid MIT-MAGIC-COOKIE-1 key`, so a
// native-first reader would lose text that `wl-paste` returns instantly.

describe("readClipboardText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function textCommands(): string[] {
    return mockSpawnSync.mock.calls.map((call) => String(call[0]));
  }

  it("reads Wayland text through wl-paste --no-newline --type text", async () => {
    mockSpawnSync.mockImplementation((command: string) => ({
      status: command === "wl-paste" ? 0 : 1,
      stdout: Buffer.from("wayland text"),
      error: undefined,
    }));

    const result = await readClipboardText({ platform: "linux", environment: { WAYLAND_DISPLAY: "wayland-0" } });

    expect(mockSpawnSync.mock.calls[0]?.slice(0, 2)).toEqual(["wl-paste", ["--no-newline", "--type", "text"]]);
    expect(result).toBe("wayland text");
  });

  it("tries xclip then xsel on X11, in pi's order", async () => {
    mockSpawnSync.mockImplementation((command: string) => ({
      status: command === "xclip" ? 1 : 0,
      stdout: Buffer.from("xsel text"),
      error: undefined,
    }));

    const result = await readClipboardText({ platform: "linux", environment: { DISPLAY: ":0" } });

    expect(textCommands()).toEqual(["xclip", "xsel"]);
    expect(mockSpawnSync.mock.calls[0]?.slice(0, 2)).toEqual(["xclip", ["-selection", "clipboard", "-out"]]);
    expect(mockSpawnSync.mock.calls[1]?.slice(0, 2)).toEqual(["xsel", ["--clipboard", "--output"]]);
    expect(result).toBe("xsel text");
  });

  it("prefers termux-clipboard-get under Termux", async () => {
    mockSpawnSync.mockImplementation(() => ({ status: 0, stdout: Buffer.from("termux text"), error: undefined }));

    const result = await readClipboardText({
      platform: "android",
      environment: { TERMUX_VERSION: "0.118.0" },
    });

    expect(textCommands()).toEqual(["termux-clipboard-get"]);
    expect(result).toBe("termux text");
  });

  it("shells out nothing on macOS and reads through the native helper", async () => {
    const getText = vi.fn().mockResolvedValue("native text");
    mockGetNativeClipboard.mockReturnValue({ getText });

    const result = await readClipboardText({ platform: "darwin", environment: {} });

    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(getText).toHaveBeenCalled();
    expect(result).toBe("native text");
  });

  it("stops at a command that succeeded with empty output instead of falling through to the helper", async () => {
    // pi returns `bytes.toString("utf8") || null` for the first command that
    // ran cleanly: an empty text/plain is an answer, not a failure to retry
    // somewhere else (an empty clipboard must stay empty).
    mockSpawnSync.mockImplementation(() => ({ status: 0, stdout: Buffer.alloc(0), error: undefined }));
    const getText = vi.fn().mockResolvedValue("stale native image text");
    mockGetNativeClipboard.mockReturnValue({ getText });

    const result = await readClipboardText({ platform: "linux", environment: { WAYLAND_DISPLAY: "wayland-0" } });

    expect(result).toBeNull();
    expect(getText).not.toHaveBeenCalled();
  });

  it("falls through a candidate that exited non-zero, then to the native helper", async () => {
    mockSpawnSync.mockImplementation(() => ({ status: 1, stdout: Buffer.alloc(0), error: undefined }));
    const getText = vi.fn().mockResolvedValue("native fallback");
    mockGetNativeClipboard.mockReturnValue({ getText });

    const result = await readClipboardText({ platform: "linux", environment: { DISPLAY: ":0" } });

    expect(textCommands()).toEqual(["xclip", "xsel"]);
    expect(result).toBe("native fallback");
  });

  it("falls through a missing command (ENOENT) rather than reporting empty text", async () => {
    mockSpawnSync.mockImplementation(() => ({
      status: null,
      stdout: Buffer.alloc(0),
      error: Object.assign(new Error("spawn xclip ENOENT"), { code: "ENOENT" }),
    }));
    const getText = vi.fn().mockResolvedValue("native fallback");
    mockGetNativeClipboard.mockReturnValue({ getText });

    const result = await readClipboardText({ platform: "linux", environment: { DISPLAY: ":0" } });

    expect(textCommands()).toEqual(["xclip", "xsel"]);
    expect(result).toBe("native fallback");
  });

  it("returns null when the native helper has no text, is absent, or throws", async () => {
    mockGetNativeClipboard.mockReturnValue({ getText: vi.fn().mockResolvedValue(null) });
    await expect(readClipboardText({ platform: "darwin", environment: {} })).resolves.toBeNull();

    mockGetNativeClipboard.mockReturnValue({ getText: vi.fn().mockRejectedValue(new Error("no display")) });
    await expect(readClipboardText({ platform: "darwin", environment: {} })).resolves.toBeNull();

    mockGetNativeClipboard.mockReturnValue(undefined);
    await expect(readClipboardText({ platform: "darwin", environment: {} })).resolves.toBeNull();
  });

  it("treats an empty string from the native helper as no text", async () => {
    mockGetNativeClipboard.mockReturnValue({ getText: vi.fn().mockResolvedValue("") });

    await expect(readClipboardText({ platform: "darwin", environment: {} })).resolves.toBeNull();
  });
});

// ── pi's path-insertion spacing rule, mirrored ─────────────────────────────
//
// Quoted from pi 1.2.0 `dist/modes/interactive/interactive-mode.js`:
//
//   2504  const paths = this.isBashMode ? filePaths.map(quoteIfNeeded).join(" ") : filePaths.join("\n");
//   2505  const cursor = this.editor.getCursor?.();
//   2506  const currentLine = cursor ? (this.editor.getText().split("\n")[cursor.line] ?? "") : "";
//   2507  const characterBeforeCursor = cursor && cursor.col > 0 ? currentLine[cursor.col - 1] : "";
//   2508  const characterAfterCursor = cursor ? currentLine[cursor.col] : "";
//   2509  const leadingSpace = characterBeforeCursor && !/\s/.test(characterBeforeCursor) ? " " : "";
//   2510  const trailingSpace = characterAfterCursor && !/\s/.test(characterAfterCursor) ? " " : "";
//   2511  this.editor.insertTextAtCursor?.(`${leadingSpace}${paths}${trailingSpace}`);
//
// `buildPathInsertion` is that block, with the editor read replaced by
// arguments so it can be asserted per case. `applyPathInsertion` in the test
// is the `insertTextAtCursor` half: text before the cursor + insertion + text
// after it.

function applyPathInsertion(editorText: string, insertion: string, cursor: { line: number; col: number }): string {
  const lines = editorText.split("\n");
  const line = lines[cursor.line] ?? "";
  lines[cursor.line] = line.slice(0, cursor.col) + insertion + line.slice(cursor.col);
  return lines.join("\n");
}

const endOf = (editorText: string): { line: number; col: number } => {
  const lines = editorText.split("\n");
  return { line: lines.length - 1, col: lines[lines.length - 1]!.length };
};

describe("isImageFilePath", () => {
  // The predicate a "should this path be read as an image?" decision would
  // make. Its first caller is a test (see the no-double-attach case in
  // paste-dispatch.test.ts), because the dispatch deliberately never reads an
  // image off disk — but the check still has to answer correctly, and once did
  // not: the extension set is dotted (".png") while `split(".").pop()` returns
  // the extension bare ("png"), so every path came back false.
  it.each([["/tmp/screenshot.png"], ["/tmp/Photo.JPG"], ["./capture.jpeg"], ["image.gif"]])(
    "recognises %s", (filePath) => {
      expect(isImageFilePath(filePath)).toBe(true);
    },
  );

  it.each([["/tmp/report.pdf"], ["/tmp/script.ts"], ["/tmp/no-extension"], ["archive.tar"]])(
    "rejects %s",
    (filePath) => {
      expect(isImageFilePath(filePath)).toBe(false);
    },
  );
});

describe("buildPathInsertion: pi's spacing rule (interactive-mode.js:2504-2511)", () => {
  it("empty editor: the path alone, no padding", () => {
    const insertion = buildPathInsertion(["/tmp/a.txt"], "");

    expect(insertion).toBe("/tmp/a.txt");
    expect(applyPathInsertion("", insertion, endOf(""))).toBe("/tmp/a.txt");
  });

  it("draft ending in a word: one leading space, no trailing space", () => {
    const insertion = buildPathInsertion(["/tmp/a.txt"], "look at");

    expect(insertion).toBe(" /tmp/a.txt");
    expect(applyPathInsertion("look at", insertion, endOf("look at"))).toBe("look at /tmp/a.txt");
  });

  it("draft ending in a newline: no padding at all (the cursor is on an empty line)", () => {
    const insertion = buildPathInsertion(["/tmp/a.txt"], "look at\n");

    expect(insertion).toBe("/tmp/a.txt");
    expect(applyPathInsertion("look at\n", insertion, endOf("look at\n"))).toBe("look at\n/tmp/a.txt");
  });

  it("cursor mid-line between word characters: spaces on both sides", () => {
    const editorText = "alpha";
    const cursor = { line: 0, col: 4 };

    const insertion = buildPathInsertion(["/tmp/a.txt"], editorText, cursor);

    expect(insertion).toBe(" /tmp/a.txt ");
    expect(applyPathInsertion(editorText, insertion, cursor)).toBe("alph /tmp/a.txt a");
  });

  it("cursor after a space and before a word: no leading space, trailing space kept", () => {
    const editorText = "a b";
    const cursor = { line: 0, col: 2 };

    expect(buildPathInsertion(["/tmp/a.txt"], editorText, cursor)).toBe("/tmp/a.txt ");
  });

  it("cursor at the start of a line whose predecessor ends in a word: no leading space (the rule is per line)", () => {
    const editorText = "one\ntwo";
    const cursor = { line: 1, col: 0 };

    // No leading space: the character before the cursor is *nothing on this
    // line*, not the 'e' on the line above — pi reads currentLine, not the
    // whole text (:2506-2507). The trailing space does appear, because the
    // text after the cursor on this line ('t') is not whitespace (:2510).
    expect(buildPathInsertion(["/tmp/a.txt"], editorText, cursor)).toBe("/tmp/a.txt ");
    expect(applyPathInsertion(editorText, buildPathInsertion(["/tmp/a.txt"], editorText, cursor), cursor)).toBe(
      "one\n/tmp/a.txt two",
    );
  });

  it("multi-path clipboard: newline-joined inside one pair of spaces", () => {
    const editorText = "compare";
    const cursor = { line: 0, col: 3 };

    const insertion = buildPathInsertion(["/tmp/one.txt", "/tmp/two.txt"], editorText, cursor);

    expect(insertion).toBe(" /tmp/one.txt\n/tmp/two.txt ");
    expect(applyPathInsertion(editorText, insertion, cursor)).toBe("com /tmp/one.txt\n/tmp/two.txt pare");
  });

  it("bash draft: shell-quoted paths joined with spaces (pi's isBashMode branch)", () => {
    const editorText = "!ls ";

    // interactive-mode.js:2504 — `filePaths.map(quoteIfNeeded).join(" ")`, and
    // pi's isBashMode is the draft's `!` prefix (:2470).
    expect(buildPathInsertion(["/tmp/a file.txt", "/tmp/plain.txt"], editorText)).toBe(
      "'/tmp/a file.txt' /tmp/plain.txt",
    );
  });

  it("bash draft escapes an embedded single quote exactly as quoteIfNeeded does", () => {
    // interactive-mode.js:170 — `'${value.replace(/'/g, `'\\''`)}'`: every '
    // becomes '\'' and the whole thing is wrapped in single quotes.
    expect(buildPathInsertion(["'/q'"], "!echo ")).toBe("''\\''/q'\\'''");
  });

  it("bash draft quotes an empty path and leaves safe characters bare", () => {
    // quoteIfNeeded requires length > 0 to skip quoting, so "" becomes ''.
    expect(buildPathInsertion([""], "!echo ")).toBe("''");
    expect(buildPathInsertion(["a-zA-Z0-9_-.@~:/"], "!echo ")).toBe("a-zA-Z0-9_-.@~:/");
  });

  it("defaults to the end of the draft, which is all the extension API can observe", () => {
    const editorText = "one\ntwo";

    // Same answer as asking for the end-of-text cursor explicitly: pi's rule
    // applied at the only position ctx.ui exposes (no cursor accessor exists).
    expect(buildPathInsertion(["/tmp/a.txt"], editorText)).toBe(
      buildPathInsertion(["/tmp/a.txt"], editorText, endOf(editorText)),
    );
  });
});
