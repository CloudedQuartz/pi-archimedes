import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { convertToPng } from "@earendil-works/pi-coding-agent";
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { diag } from "@pi-archimedes/core/log";

import type { ClipboardImage } from "./types.js";

const LIST_TYPES_TIMEOUT_MS = 1000;
const READ_TIMEOUT_MS = 5000;
/**
 * How long a read through the native clipboard helper may take before it counts
 * as failed — the same budget one CLI read gets, because a hung X11/Wayland
 * session blocks in exactly the same place a hung `wl-paste` does.
 *
 * The deadline cannot cancel the native call; what it bounds is how long the
 * keypress waits for it. That matters more than a slow read would suggest: the
 * `ctrl+v` handler in `index.ts` holds a `_pasting` mutex for the lifetime of a
 * dispatch, so an unbounded read that never settles leaves that mutex held and
 * every later `ctrl+v` a silent no-op until the session restarts.
 */
export const NATIVE_READ_TIMEOUT_MS = READ_TIMEOUT_MS;
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
] as const;

interface CommandResult {
  ok: boolean;
  stdout: Buffer;
  missingCommand: boolean;
}

export interface ClipboardReadResult {
  available: boolean;
  image: ClipboardImage | null;
  /** Set when a reader existed but did not answer inside the deadline. */
  timeout?: Error;
}

/** A native clipboard read that outlived {@link NATIVE_READ_TIMEOUT_MS}. */
class NativeReadTimeoutError extends Error {
  constructor(operation: string) {
    super(`${operation} timed out after ${NATIVE_READ_TIMEOUT_MS}ms`);
    this.name = "NativeReadTimeoutError";
  }
}

/**
 * Give a native clipboard read a deadline. `undefined` (no helper, no such
 * method) passes straight through; a rejection passes through unchanged, so a
 * transfer failure still reads as a failure rather than as an empty clipboard.
 */
async function withinNativeReadDeadline<T>(
  read: Promise<T> | undefined,
  operation: string,
): Promise<T | undefined> {
  if (read === undefined) {
    return undefined;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new NativeReadTimeoutError(operation)), NATIVE_READ_TIMEOUT_MS);
      read.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function isErrnoException(error: Error): error is NodeJS.ErrnoException {
  return "code" in error;
}

function hasGraphicalSession(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): boolean {
  return platform !== "linux" || Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
}

function isWaylandSession(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(environment.WAYLAND_DISPLAY) || environment.XDG_SESSION_TYPE === "wayland";
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

function selectPreferredImageMimeType(mimeTypes: readonly string[]): string | null {
  const normalized = mimeTypes
    .map((mimeType) => mimeType.trim())
    .filter((mimeType) => mimeType.length > 0)
    .map((mimeType) => ({ raw: mimeType, normalized: normalizeMimeType(mimeType) }));

  for (const preferredMimeType of SUPPORTED_IMAGE_MIME_TYPES) {
    const match = normalized.find((mimeType) => mimeType.normalized === preferredMimeType);
    if (match) {
      return match.raw;
    }
  }

  const firstImage = normalized.find((mimeType) => mimeType.normalized.startsWith("image/"));
  return firstImage?.raw ?? null;
}

export async function readClipboardImageViaNativeModule(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): Promise<ClipboardReadResult> {
  if (environment.TERMUX_VERSION || !hasGraphicalSession(platform, environment)) {
    return { available: false, image: null };
  }

  try {
    const native = getNativeClipboard();
    if (!native) {
      return { available: false, image: null };
    }

    const bytes = await withinNativeReadDeadline(
      native.getImage(),
      "Native clipboard image read",
    );
    if (!bytes || bytes.length === 0) {
      return { available: true, image: null };
    }

    const rawBytes = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);

    if (platform === "win32") {
      if (rawBytes.length >= 2 && rawBytes[0] === 0x42 && rawBytes[1] === 0x4d) {
        const png = await convertToPng(Buffer.from(rawBytes).toString("base64"), "image/bmp");
        if (png) {
          return {
            available: true,
            image: {
              bytes: Uint8Array.from(Buffer.from(png.data, "base64")),
              mimeType: png.mimeType,
            },
          };
        }
        return { available: false, image: null };
      }
    }

    return {
      available: true,
      image: {
        bytes: rawBytes,
        mimeType: "image/png",
      },
    };
  } catch (error) {
    // A read that never answered is not the same event as a reader that is not
    // installed, so it is carried out as a timeout rather than flattened into
    // "unavailable": the caller reports the deadline, not "install a clipboard
    // reader", and the keypress stops waiting.
    if (error instanceof NativeReadTimeoutError) {
      return { available: false, image: null, timeout: error };
    }
    return { available: false, image: null };
  }
}

function runCommand(
  command: string,
  args: string[],
  timeout: number,
): CommandResult {
  const result = spawnSync(command, args, {
    timeout,
    maxBuffer: MAX_BUFFER_BYTES,
  });

  if (result.error) {
    return {
      ok: false,
      stdout: Buffer.alloc(0),
      missingCommand: isErrnoException(result.error) && result.error.code === "ENOENT",
    };
  }

  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout ?? "", typeof result.stdout === "string" ? "utf8" : undefined);

  return {
    ok: result.status === 0,
    stdout,
    missingCommand: false,
  };
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function readClipboardImageViaPowerShell(): Promise<ClipboardReadResult> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) {
  return
}

$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $image) {
  return
}

$stream = New-Object System.IO.MemoryStream
try {
  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [System.Convert]::ToBase64String($stream.ToArray())
} finally {
  $stream.Dispose()
  $image.Dispose()
}
`;

  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-STA",
        "-EncodedCommand",
        encodePowerShell(script),
      ],
      {
        windowsHide: true,
      },
    );

    // Timeout guard
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ available: true, image: null });
    }, READ_TIMEOUT_MS);

    let stdout = "";
    let exceededMaxBuffer = false;
    child.stdout?.on("data", (data: Buffer) => {
      if (stdout.length + data.length > MAX_BUFFER_BYTES) {
        if (!exceededMaxBuffer) {
          exceededMaxBuffer = true;
          diag("image-paste", "[archimedes] Clipboard image exceeded maximum buffer size (50MB)");
        }
        return;
      }
      stdout += data.toString("utf8");
    });

    child.on("error", (err: Error) => {
      clearTimeout(timeout);
      resolve({
        available: !isErrnoException(err) || (err as NodeJS.ErrnoException).code !== "ENOENT",
        image: null,
      });
    });

    child.on("close", (status: number | null) => {
      clearTimeout(timeout);
      if (status !== 0 || exceededMaxBuffer) {
        resolve({ available: true, image: null });
        return;
      }

      const base64 = stdout.trim();
      if (!base64) {
        resolve({ available: true, image: null });
        return;
      }

      try {
        const bytes = Buffer.from(base64, "base64");
        if (bytes.length === 0) {
          resolve({ available: true, image: null });
          return;
        }
        resolve({
          available: true,
          image: {
            bytes: new Uint8Array(bytes),
            mimeType: "image/png",
          },
        });
      } catch {
        resolve({ available: true, image: null });
      }
    });
  });
}

function readClipboardImageViaWlPaste(): ClipboardReadResult {
  const listTypes = runCommand("wl-paste", ["--list-types"], LIST_TYPES_TIMEOUT_MS);
  if (listTypes.missingCommand) {
    return { available: false, image: null };
  }

  if (!listTypes.ok) {
    return { available: true, image: null };
  }

  const mimeTypes = listTypes.stdout
    .toString("utf8")
    .split(/\r?\n/)
    .map((mimeType) => mimeType.trim())
    .filter((mimeType) => mimeType.length > 0);

  const selectedMimeType = selectPreferredImageMimeType(mimeTypes);
  if (!selectedMimeType) {
    return { available: true, image: null };
  }

  const imageData = runCommand(
    "wl-paste",
    ["--type", selectedMimeType, "--no-newline"],
    READ_TIMEOUT_MS,
  );

  if (!imageData.ok || imageData.stdout.length === 0) {
    return { available: true, image: null };
  }

  return {
    available: true,
    image: {
      bytes: new Uint8Array(imageData.stdout),
      mimeType: normalizeMimeType(selectedMimeType),
    },
  };
}

function readClipboardImageViaXclip(): ClipboardReadResult {
  const targets = runCommand(
    "xclip",
    ["-selection", "clipboard", "-t", "TARGETS", "-o"],
    LIST_TYPES_TIMEOUT_MS,
  );

  if (targets.missingCommand) {
    return { available: false, image: null };
  }

  const advertisedMimeTypes = targets.ok
    ? targets.stdout
        .toString("utf8")
        .split(/\r?\n/)
        .map((mimeType) => mimeType.trim())
        .filter((mimeType) => mimeType.length > 0)
    : [];

  const preferredMimeType =
    advertisedMimeTypes.length > 0 ? selectPreferredImageMimeType(advertisedMimeTypes) : null;
  const mimeTypesToTry = preferredMimeType
    ? [preferredMimeType, ...SUPPORTED_IMAGE_MIME_TYPES]
    : [...SUPPORTED_IMAGE_MIME_TYPES];

  for (const mimeType of mimeTypesToTry) {
    const imageData = runCommand(
      "xclip",
      ["-selection", "clipboard", "-t", mimeType, "-o"],
      READ_TIMEOUT_MS,
    );

    if (imageData.ok && imageData.stdout.length > 0) {
      return {
        available: true,
        image: {
          bytes: new Uint8Array(imageData.stdout),
          mimeType: normalizeMimeType(mimeType),
        },
      };
    }
  }

  return { available: true, image: null };
}

function getUnavailableReaderMessage(platform: NodeJS.Platform): string {
  switch (platform) {
    case "linux":
      return "No Linux clipboard image reader is available. Install wl-clipboard or xclip, or ensure @earendil-works/pi-tui native clipboard or CLI tools are available.";
    case "darwin":
      return "No macOS clipboard image reader is available. Ensure @earendil-works/pi-tui native clipboard or CLI tools are available.";
    case "win32":
      return "No Windows clipboard image reader is available. Ensure PowerShell is available or @earendil-works/pi-tui native clipboard or CLI tools are available.";
    default:
      return `Clipboard image paste is not supported on platform: ${platform}`;
  }
}

export async function readClipboardImage(options?: {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
  const environment = options?.environment ?? process.env;
  const platform = options?.platform ?? process.platform;

  if (environment.TERMUX_VERSION) {
    return null;
  }

  if (!hasGraphicalSession(platform, environment)) {
    throw new Error("Clipboard image paste requires a graphical desktop session with DISPLAY or WAYLAND_DISPLAY.");
  }

  const readerResults: ClipboardReadResult[] = [];

  const recordResult = (result: ClipboardReadResult): ClipboardImage | null => {
    readerResults.push(result);
    return result.image;
  };

  if (platform === "win32") {
    const nativeImage = recordResult(await readClipboardImageViaNativeModule(platform, environment));
    if (nativeImage) {
      return nativeImage;
    }

    const powerShellImage = recordResult(await readClipboardImageViaPowerShell());
    if (powerShellImage) {
      return powerShellImage;
    }
  } else if (platform === "linux") {
    const sessionReaders = isWaylandSession(environment)
      ? [readClipboardImageViaWlPaste, readClipboardImageViaXclip]
      : [readClipboardImageViaXclip, readClipboardImageViaWlPaste];

    for (const reader of sessionReaders) {
      const image = recordResult(reader());
      if (image) {
        return image;
      }
    }

    const nativeImage = recordResult(await readClipboardImageViaNativeModule(platform, environment));
    if (nativeImage) {
      return nativeImage;
    }
  } else {
    const nativeImage = recordResult(await readClipboardImageViaNativeModule(platform, environment));
    if (nativeImage) {
      return nativeImage;
    }
  }

  if (readerResults.some((result) => result.available)) {
    return null;
  }

  // Nothing answered. If the reason is that a helper never replied, say that —
  // "install wl-clipboard or xclip" would be the wrong advice for a machine
  // that has one and is not answering.
  const timeout = readerResults.find((result) => result.timeout)?.timeout;
  if (timeout) {
    throw timeout;
  }

  throw new Error(getUnavailableReaderMessage(platform));
}

// ── Copied files on the clipboard ───────────────────────────────────────────

/**
 * Read copied file paths (a file manager's "Copy" on macOS/Windows) off the
 * clipboard — the same call pi makes, `getNativeClipboard()?.getFilePaths?.()`
 * (`dist/utils/clipboard.js:83-86`), on the same public accessor used for
 * images above.
 *
 * The optional call is load-bearing, not defensive noise: this package's peer
 * floor is pi/pi-tui `>=0.86.0`, `getFilePaths` arrived later than that, and it
 * is still optional in 1.2.0 (`pi-tui/dist/native-platform.d.ts:8`). Measured on
 * this Linux box with pi-tui 1.2.0 installed: the X11 helper has no
 * `getFilePaths` at all (`typeof helper.getFilePaths === "undefined"`), so this
 * returns `null` there and the caller falls through to text — which is exactly
 * what pi's own path branch does on Linux.
 *
 * A rejected transfer is *not* swallowed: pi lets it reach
 * `handleClipboardPaste`'s catch and show a failure, and the caller here does
 * the same, so a clipboard that failed to answer is distinguishable from one
 * that answered "no files". A read that never answered at all is the one
 * exception, and it is a deadline rather than a verdict — see
 * {@link NATIVE_READ_TIMEOUT_MS}.
 */
export async function readClipboardFilePaths(): Promise<string[] | null> {
  let paths: string[] | null | undefined;
  try {
    paths = await withinNativeReadDeadline(
      getNativeClipboard()?.getFilePaths?.(),
      "Clipboard file path read",
    );
  } catch (error) {
    if (error instanceof NativeReadTimeoutError) {
      // Unlike a transfer failure, which is passed up as pi passes it up, a read
      // that never answered falls through to the text branch: the caller's next
      // question ("is there text?") is independent of this one, and a hung path
      // read should not cost the user a text paste. pi is still sitting in this
      // call when we return.
      return null;
    }
    throw error;
  }
  return paths?.length ? paths : null;
}

// ── Clipboard text ──────────────────────────────────────────────────────────

interface TextReaderCommand {
  command: string;
  args: string[];
}

/**
 * The command candidates for a plain-text read, in pi's order
 * (`readClipboardText`, `dist/utils/clipboard.js:58-81`). pi's own function is
 * not reachable from here — the package exports are `"."` and `"./rpc-entry"`
 * and the root re-exports only `copyToClipboard` (`dist/index.d.ts:38`) — so
 * this is a faithful re-implementation over the command runner this module
 * already has, including the ordering reason: the native helper is the LAST
 * resort, because on Wayland/X11 the CLI tools answer instantly while the X11
 * helper can stall or fail on display auth. (Observed on this machine: the
 * helper loads, then every read fails with `Invalid MIT-MAGIC-COOKIE-1 key`,
 * while `wl-paste` returns text immediately.)
 *
 * No macOS/Windows candidates, deliberately: pi has none either — those
 * platforms go straight to the native helper, so adding `pbpaste` here would be
 * inventing a mechanism pi does not use.
 */
function textReaderCommands(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): TextReaderCommand[] {
  const commands: TextReaderCommand[] = [];
  // Termux reports platform "android", not "linux" (pi's note, clipboard.js:61).
  if (environment.TERMUX_VERSION) {
    commands.push({ command: "termux-clipboard-get", args: [] });
  }
  if (platform === "linux") {
    if (environment.WAYLAND_DISPLAY) {
      commands.push({ command: "wl-paste", args: ["--no-newline", "--type", "text"] });
    }
    if (environment.DISPLAY) {
      commands.push({ command: "xclip", args: ["-selection", "clipboard", "-out"] });
      commands.push({ command: "xsel", args: ["--clipboard", "--output"] });
    }
  }
  return commands;
}

/**
 * Read plain text from the clipboard, or `null` when there is none.
 *
 * pi's semantics, candidate for candidate: a candidate that cannot run (missing
 * binary, non-zero exit, timeout) is skipped, but the first one that exits
 * cleanly *answers* — even with empty output, which means "the clipboard holds
 * no text" and must not be retried somewhere else (pi:
 * `if (bytes !== undefined) return bytes.toString("utf8") || null`). The native
 * helper is the final fallback and its failures read as "no text".
 */
export async function readClipboardText(options?: {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<string | null> {
  const environment = options?.environment ?? process.env;
  const platform = options?.platform ?? process.platform;

  for (const candidate of textReaderCommands(platform, environment)) {
    const result = runCommand(candidate.command, candidate.args, READ_TIMEOUT_MS);
    if (!result.ok) {
      continue;
    }
    return result.stdout.toString("utf8") || null;
  }

  try {
    // Bounded for the same reason as the other two native reads: a helper that
    // stops answering must not hold the keypress (and the mutex) open. A
    // timeout reads as "no text" here, which is what the catch already means.
    const text = await withinNativeReadDeadline(
      getNativeClipboard()?.getText?.(),
      "Clipboard text read",
    );
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Clipboard text prepared for `ctx.ui.pasteToEditor`.
 *
 * `pasteToEditor` is not an insert: it is pi's bracketed-paste wiring,
 * `this.editor.handleInput("\x1b[200~" + text + "\x1b[201~")`
 * (`dist/modes/interactive/interactive-mode.js:2075`). pi-tui ends a paste at
 * the first `\x1b[201~` it finds and re-feeds the rest of the chunk to
 * `handleInput` as if it had been typed
 * (`pi-tui/dist/components/editor.js:569-590`), so an escape byte arriving
 * *from the clipboard* closes the paste early: measured, the payload
 * `"hi\u001b[201~!echo pwned\r"` left the draft holding `"hi\n"` — the rest of
 * the clipboard gone. pi's own text branch cannot lose it, because it writes
 * bytes with `insertTextAtCursor` (`interactive-mode.js:2528`), and the
 * extension API exposes no insert route — `pasteToEditor` is the only way in.
 *
 * So the framing byte is dropped from clipboard content and everything else
 * is preserved verbatim. The remaining control characters need no handling
 * here: pi-tui's paste filter already removes characters below 0x20 except
 * `\n` and normalises line endings (`editor.js:1069-1074`, `:953-955`), which
 * is the same treatment a paste typed at the terminal gets. (The divergence
 * from pi is that pi *stores* those bytes; measured, pi keeps
 * `"hi\u0000wo\u0007"` where this route gives `"hiwo"`.)
 */
export function clipboardTextForEditor(text: string): string {
  return text.includes("\u001b") ? text.replace(/\u001b/g, "") : text;
}

// ── pi's path-insertion spacing rule ────────────────────────────────────────

/** Where the editor cursor sits, in the same shape pi's `getCursor()` returns. */
export interface EditorCursor {
  line: number;
  col: number;
}

/**
 * pi's shell-quoting helper, verbatim from
 * `dist/modes/interactive/interactive-mode.js:166-171`:
 *
 * ```js
 * function quoteIfNeeded(value) {
 *     if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
 *         return value;
 *     }
 *     return `'${value.replace(/'/g, `'\\''`)}'`;
 * }
 * ```
 *
 * Re-implemented rather than imported because pi keeps it module-private in the
 * interactive-mode bundle (used at `:182` and `:2504`, exported nowhere), and
 * a shell-quoting divergence between the two implementations is worse than this
 * 5-line copy with the source quoted above.
 */
function quoteIfNeeded(value: string): string {
  if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The text to insert for a batch of clipboard file paths, built from pi's
 * `handleClipboardPaste` (`dist/modes/interactive/interactive-mode.js:2504-2511`),
 * quoted here so a future reader can diff it against pi rather than re-derive it:
 *
 * ```js
 * const paths = this.isBashMode ? filePaths.map(quoteIfNeeded).join(" ") : filePaths.join("\n");
 * const cursor = this.editor.getCursor?.();
 * const currentLine = cursor ? (this.editor.getText().split("\n")[cursor.line] ?? "") : "";
 * const characterBeforeCursor = cursor && cursor.col > 0 ? currentLine[cursor.col - 1] : "";
 * const characterAfterCursor = cursor ? currentLine[cursor.col] : "";
 * const leadingSpace = characterBeforeCursor && !/\s/.test(characterBeforeCursor) ? " " : "";
 * const trailingSpace = characterAfterCursor && !/\s/.test(characterAfterCursor) ? " " : "";
 * this.editor.insertTextAtCursor?.(`${leadingSpace}${paths}${trailingSpace}`);
 * ```
 *
 * `cursor` defaults to the end of the draft. That default is the honest limit
 * of this package, not a convenience: `ExtensionUIContext` exposes
 * `pasteToEditor`, `setEditorText` and `getEditorText`
 * (`dist/core/extensions/types.d.ts:132-137`) and no cursor accessor, and there
 * is no route to the live editor instance from an extension — so an extension
 * can read the draft but not where the caret is inside it. Everything the rule
 * can be asked for is exact (see the per-case tests); where the caret is not at
 * the end of the draft, pi's trailing space is the one thing we cannot know,
 * and the run-on it would prevent is pinned as a known limitation in
 * `paste-dispatch.test.ts` rather than hidden.
 *
 * pi's `isBashMode` is the draft's `!` prefix (`:2470`), so it is derived from
 * the same draft text here.
 */
export function buildPathInsertion(
  paths: readonly string[],
  editorText: string,
  cursor?: EditorCursor,
): string {
  const lines = editorText.split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  const at: EditorCursor = cursor ?? { line: lines.length - 1, col: lastLine.length };
  const isBashMode = editorText.trimStart().startsWith("!");
  const joined = isBashMode ? paths.map(quoteIfNeeded).join(" ") : paths.join("\n");

  const currentLine = lines[at.line] ?? "";
  const characterBeforeCursor = at.col > 0 ? currentLine[at.col - 1] : "";
  const characterAfterCursor = currentLine[at.col];
  const leadingSpace = characterBeforeCursor && !/\s/.test(characterBeforeCursor) ? " " : "";
  const trailingSpace = characterAfterCursor && !/\s/.test(characterAfterCursor) ? " " : "";
  return `${leadingSpace}${joined}${trailingSpace}`;
}

// ── File-based image reading ────────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export function isImageFilePath(path: string): boolean {
  const extension = path.toLowerCase().split(".").pop();
  // The set is dotted (".png"); `split(".").pop()` returns the extension bare
  // ("png"), so the dot has to be put back — comparing them as they were left
  // every path (including a .png) reading as "not an image".
  return extension !== undefined && IMAGE_EXTENSIONS.has(`.${extension}`);
}

export async function readFileAsImage(filePath: string): Promise<ClipboardImage | null> {
  if (!existsSync(filePath)) return null;
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  const mimeMap: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", gif: "image/gif", bmp: "image/bmp",
  };
  const mimeType = mimeMap[ext];
  if (!mimeType) return null;
  try {
    const bytes = await readFile(filePath);
    if (bytes.length === 0) return null;
    return { bytes: new Uint8Array(bytes), mimeType };
  } catch {
    return null;
  }
}
