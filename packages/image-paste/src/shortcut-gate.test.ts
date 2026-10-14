import { beforeEach, describe, expect, it, vi } from "vitest";

// ── The shortcut gate: `archimedes.imagePaste.suppressNativePaste: false` ────
//
// ADR 0030's amendment promises that turning the flag off "hands the key back to
// pi". Removing our `app.clipboard.pasteImage` unbinding from
// ~/.pi/agent/keybindings.json is only half of that: pi 1.2.0 keeps an extension
// shortcut that collides with a NON-reserved built-in (`app.clipboard.pasteImage`
// is absent from `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS`, so
// `restrictOverride === false` and `ExtensionRunner.getShortcuts` prints
// "… Using <ext>" and keeps ours — `dist/core/extensions/runner.js:467-474`), and
// `CustomEditor.handleInput` consults `onExtensionShortcut` BEFORE its
// `app.clipboard.pasteImage` branch and returns (`dist/modes/interactive/
// components/custom-editor.js:63-70`). So while the shortcut is registered the
// restored native binding is unreachable and the flag buys nothing but a shortcut
// conflict line in `[Extension issues]`. The other half of the promise is
// therefore ours: with the flag off, `registerImagePaste` must not claim the key.
//
// The mock replaces the whole pi module (vitest requires every used export):
// `getAgentDir` for the settings read, `convertToPng` for clipboard.ts.
// `core/settings-io` captures `join(getAgentDir(), "settings.json")` at module
// load (settings-io.ts:6), hence one scratch dir for the whole file, rewritten
// per case.

const { tempDir, fs, join } = vi.hoisted(() => {
  const fs = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const { randomUUID } = require("node:crypto");
  const dir = join(tmpdir(), `image-paste-shortcut-gate-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return { tempDir: dir, fs, join };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => tempDir,
  convertToPng: () => undefined,
}));

const { registerImagePaste } = await import("./index.js");
const defaultExport = (await import("./index.js")).default;

// ── fixtures ────────────────────────────────────────────────────────────────

const NAMESPACE = "archimedes.imagePaste";

/** `getImagePasteShortcuts()` as it stands today, per platform. */
const ALL_PASTE_SHORTCUTS: string[] =
  process.platform === "win32" ? ["alt+v", "ctrl+alt+v"] : ["ctrl+v", "alt+v", "ctrl+alt+v"];

const settingsPath = (): string => join(tempDir, "settings.json");

function writeSettings(imagePaste: Record<string, unknown> | undefined): void {
  const settings: Record<string, unknown> = {};
  if (imagePaste !== undefined) settings[NAMESPACE] = imagePaste;
  fs.writeFileSync(settingsPath(), JSON.stringify(settings), "utf-8");
}

interface FakePi {
  on: ReturnType<typeof vi.fn>;
  registerShortcut: ReturnType<typeof vi.fn>;
  registerMessageRenderer: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}

function fakePi(): FakePi {
  return {
    on: vi.fn(),
    registerShortcut: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
  };
}

/** Every key `registerImagePaste` handed to `pi.registerShortcut`. */
function registeredKeys(pi: FakePi): string[] {
  return pi.registerShortcut.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  // No settings file at all is the "flag absent" default.
  try {
    fs.unlinkSync(settingsPath());
  } catch {
    // absent
  }
});

// ── the gate ────────────────────────────────────────────────────────────────

describe("image-paste shortcut registration is gated on suppressNativePaste", () => {
  it("registers NO shortcut at all when suppressNativePaste is false (the key goes back to pi)", () => {
    writeSettings({ suppressNativePaste: false });
    const pi = fakePi();

    registerImagePaste(pi as never);

    expect(registeredKeys(pi)).toEqual([]);
    expect(pi.registerShortcut).not.toHaveBeenCalled();
  });

  it("registers every paste shortcut when the setting is absent (today's behaviour, unchanged)", () => {
    const pi = fakePi();

    registerImagePaste(pi as never);

    expect(registeredKeys(pi).sort()).toEqual([...ALL_PASTE_SHORTCUTS].sort());
  });

  it("registers every paste shortcut when suppressNativePaste is true", () => {
    writeSettings({ suppressNativePaste: true });
    const pi = fakePi();

    registerImagePaste(pi as never);

    expect(registeredKeys(pi).sort()).toEqual([...ALL_PASTE_SHORTCUTS].sort());
  });

  it("treats a value that is not the boolean false as today's behaviour", () => {
    // Same strict-comparison rule as the restore: `"false"` and `0` are not
    // `false`, so they must not silently free the key.
    for (const value of ["false", 0, null, "", "no", {}]) {
      fs.rmSync(settingsPath(), { force: true });
      writeSettings({ suppressNativePaste: value });
      const pi = fakePi();

      registerImagePaste(pi as never);

      expect(registeredKeys(pi).sort(), `suppressNativePaste=${JSON.stringify(value)}`).toEqual(
        [...ALL_PASTE_SHORTCUTS].sort(),
      );
    }
  });

  it("re-reads the setting on EVERY registration (per-session gate, never a module-level flag)", () => {
    // pi caches the extension FACTORY (`extensionCache`, `dist/core/extensions/
    // loader.js:461-489`) but re-invokes it for each session, and the composed
    // suite calls `registerImagePaste` from its own `session_start` handler. So
    // the decision must be taken inside the function: a value computed once at
    // module scope (the `#106`-era bug) makes every later session inherit the
    // first session's answer. Each call below stands for one session start.
    writeSettings({ suppressNativePaste: false });
    const off = fakePi();
    registerImagePaste(off as never);
    expect(registeredKeys(off)).toEqual([]);

    writeSettings({ suppressNativePaste: true });
    const on = fakePi();
    registerImagePaste(on as never);
    expect(registeredKeys(on).sort(), "a later session must get the shortcuts back").toEqual(
      [...ALL_PASTE_SHORTCUTS].sort(),
    );

    writeSettings({ suppressNativePaste: false });
    const offAgain = fakePi();
    registerImagePaste(offAgain as never);
    expect(registeredKeys(offAgain), "and must give them up again").toEqual([]);
  });

  it("leaves no other route from a key or command to the paste path when the flag is off", () => {
    // "No half-states": nothing may still call our paste path on the freed key.
    // The only entry point the package has is `pi.registerShortcut`, so the
    // fence is (a) no shortcut for any of the paste keys and (b) no command
    // alias registered at all.
    writeSettings({ suppressNativePaste: false });
    const pi = fakePi();

    registerImagePaste(pi as never);

    for (const key of ALL_PASTE_SHORTCUTS) {
      const clash = pi.registerShortcut.mock.calls.filter((call) => call[0] === key);
      expect(clash, `ctrl+v-class key ${key} still registered`).toEqual([]);
    }
    expect(pi.registerCommand).not.toHaveBeenCalled();
  });

  it("keeps the rest of the feature registered while the key is handed back", () => {
    // The goal is the key, not deleting the feature: the submit-time marker
    // attachment and the preview renderer stay wired, and the per-session queue
    // lifecycle keeps running (no orphaned state left pointing at a key that no
    // longer exists).
    writeSettings({ suppressNativePaste: false });
    const pi = fakePi();

    registerImagePaste(pi as never);

    const events = pi.on.mock.calls.map((call) => String(call[0]));
    expect(events).toContain("input");
    expect(pi.registerMessageRenderer).toHaveBeenCalled();
  });
});

describe("image-paste standalone factory — same gate, same call site", () => {
  it("registers no shortcut from the default export when suppressNativePaste is false", () => {
    // A standalone install goes through the default export, which calls
    // `registerImagePaste`; gating only meta's call site would leave this path
    // claiming the key.
    writeSettings({ suppressNativePaste: false });
    const pi = fakePi();

    defaultExport(pi as never);

    expect(pi.registerShortcut).not.toHaveBeenCalled();
    expect(pi.registerMessageRenderer).toHaveBeenCalled();
    const events = pi.on.mock.calls.map((call) => String(call[0]));
    expect(events).toEqual(
      expect.arrayContaining(["input", "session_start", "session_shutdown"]),
    );
  });

  it("registers the shortcuts from the default export when the flag is absent", () => {
    const pi = fakePi();

    defaultExport(pi as never);

    expect(registeredKeys(pi).sort()).toEqual([...ALL_PASTE_SHORTCUTS].sort());
  });
});
