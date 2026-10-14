import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The mutex lives in the shortcut handler in `index.ts` and the readers live in
// `clipboard.ts`, so this file deliberately mocks *neither*: the real dispatch
// runs against a faked clipboard helper and a faked command runner, which is the
// only way to ask the question that matters to a user — does `ctrl+v` come back?
const { mockGetNativeClipboard, mockSpawnSync } = vi.hoisted(() => ({
  mockGetNativeClipboard: vi.fn(),
  mockSpawnSync: vi.fn(),
}));

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const real = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return { ...real, getNativeClipboard: mockGetNativeClipboard };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: mockSpawnSync };
});

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { initImagePasteSession, registerImagePaste } from "./index.js";
import { NATIVE_READ_TIMEOUT_MS } from "./clipboard.js";

/** Every CLI candidate is missing, so the native helper is the only reader. */
function noCLITools(): void {
  mockSpawnSync.mockImplementation((_command: string, _args: string[]) => {
    const error = Object.assign(new Error("spawnSync ENOENT"), { code: "ENOENT" });
    return { error, status: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  });
}

interface Harness {
  ctx: ExtensionContext;
  press: () => Promise<void>;
  inserted: string[];
  notifications: Array<[string, string | undefined]>;
}

function createHarness(): Harness {
  const inserted: string[] = [];
  const notifications: Array<[string, string | undefined]> = [];
  const ctx = {
    hasUI: true,
    ui: {
      pasteToEditor: (text: string) => {
        inserted.push(text);
      },
      getEditorText: () => "",
      notify: (message: string, type?: "info" | "warning" | "error") => {
        notifications.push([message, type]);
      },
    },
  } as unknown as ExtensionContext;

  const handlers = new Map<string, (context: ExtensionContext) => Promise<void>>();
  const pi = {
    registerMessageRenderer: () => {},
    registerShortcut: (key: string, options: { handler: (context: ExtensionContext) => Promise<void> }) => {
      handlers.set(key, options.handler);
    },
    on: () => {},
  } as unknown as ExtensionAPI;

  registerImagePaste(pi);
  initImagePasteSession(ctx);
  const pressKey = handlers.get("ctrl+v")!;
  return { ctx, press: () => pressKey(ctx), inserted, notifications };
}

/** A helper whose every read is started and never answered. */
function hangingHelper(): {
  getImage: () => Promise<Uint8Array>;
  getText: () => Promise<string>;
  getFilePaths: () => Promise<string[]>;
} {
  return {
    getImage: () => new Promise<Uint8Array>(() => {}),
    getText: () => new Promise<string>(() => {}),
    getFilePaths: () => new Promise<string[]>(() => {}),
  };
}

describe("the ctrl+v mutex against a clipboard that never answers", () => {
  const savedWayland = process.env.WAYLAND_DISPLAY;
  const savedDisplay = process.env.DISPLAY;

  beforeEach(() => {
    vi.clearAllMocks();
    noCLITools();
    // A graphical session, so the readers are attempted rather than skipped.
    process.env.WAYLAND_DISPLAY = "wayland-1";
    delete process.env.DISPLAY;
  });

  afterAll(() => {
    process.env.WAYLAND_DISPLAY = savedWayland;
    process.env.DISPLAY = savedDisplay;
  });

  it("settles the keypress and releases the key when the helper never answers", async () => {
    vi.useFakeTimers();
    try {
      mockGetNativeClipboard.mockReturnValue(hangingHelper());
      const h = createHarness();

      const press = h.press();
      // Nothing to wait for but our own deadline.
      await vi.advanceTimersByTimeAsync(NATIVE_READ_TIMEOUT_MS / 2);
      expect(h.inserted).toEqual([]);

      // The user presses again while the first read is still outstanding: the
      // mutex is allowed to swallow this one, but not forever.
      const whileBusy = h.press();
      await vi.advanceTimersByTimeAsync(NATIVE_READ_TIMEOUT_MS / 2);
      await whileBusy;
      expect(h.inserted).toEqual([]);

      await vi.advanceTimersByTimeAsync(NATIVE_READ_TIMEOUT_MS * 3);
      // RED without a deadline on the native read: this await never finishes,
      // the promise stays pending, and every later press is dropped by the
      // `_pasting` mutex — `ctrl+v` is dead until the session restarts, with no
      // message saying so (measured live: first press still pending after
      // 7.1 s, both later presses silently swallowed, nothing notified).
      await expect(press).resolves.toBeUndefined();

      // And the key works again: the next press reaches the readers.
      mockGetNativeClipboard.mockReturnValue({
        getImage: async () => null,
        getText: async () => "text after the hang",
        getFilePaths: async () => undefined,
      });
      await h.press();
      expect(h.inserted).toEqual(["text after the hang"]);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("reports a bounded failure rather than silence when the image read times out and nothing else answers", async () => {
    vi.useFakeTimers();
    try {
      mockGetNativeClipboard.mockReturnValue(hangingHelper());
      const h = createHarness();

      const press = h.press();
      await vi.advanceTimersByTimeAsync(NATIVE_READ_TIMEOUT_MS * 3);
      await press;

      // pi's dispatcher would have sat in that call forever; ours finishes.
      // A helper that never answers is a failed read, not an empty clipboard,
      // so the user hears about it — and hears something truer than "install a
      // clipboard reader", which is what the missing-reader path says.
      expect(h.inserted).toEqual([]);
      expect(h.notifications).toHaveLength(1);
      expect(h.notifications[0]?.[0]).toMatch(/timed out/i);
      expect(h.notifications[0]?.[0]).not.toMatch(/No Linux clipboard image reader/);
      expect(h.notifications[0]?.[1]).toBe("warning");
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
