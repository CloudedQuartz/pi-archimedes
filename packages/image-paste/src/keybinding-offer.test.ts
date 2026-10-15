import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ── hoisted: must use require() since vi.hoisted runs before imports ────────

const { tempDir, fs, join, existsSyncSpy } = vi.hoisted(() => {
  const fs = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const { randomUUID } = require("node:crypto");
  const dir = join(tmpdir(), `keybinding-offer-test-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  // Pass-through by default; specific tests re-target it (the concurrent-file
  // case needs keybindings.json to appear between gate 4 and the pre-rename
  // re-check).
  const existsSyncSpy = vi.fn((p: unknown) => fs.existsSync(String(p)));
  return { tempDir: dir, fs, join, existsSyncSpy };
});

// ── mocks: registered before the module under test is first imported ─────────
// The mock MUST be registered before keybinding-offer.js (and the settings-io
// it pulls in) is loaded: module-scope path constants capture getAgentDir() at
// load time (settings-io.ts:5).

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => tempDir,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: existsSyncSpy };
});

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Identical to the package's ExtensionMode (dist types:208-209), which is not
// re-exported from the package root.
type Mode = "tui" | "rpc" | "json" | "print";

const {
  offerKeybindingFix,
  restoreNativePaste,
  runNativePasteRestore,
  suiteMayClaimPasteKey,
  CREATED_NOTIFY,
  CREATED_RELOAD_HINT,
  RESTORED_NOTIFY,
  RESTORED_RELOAD_HINT,
} = await import("./keybinding-offer.js");

import type {
  NativePasteRestoreOutcome,
  RestoreNativePasteStatus,
  UntouchedReason,
} from "./keybinding-offer.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const NAMESPACE = "archimedes.imagePaste";
/** The exact snippet from packages/image-paste/README.md → "Paste shortcuts". */
const SNIPPET =
  '{ "$schema": "https://pi.dev/schemas/keybindings.schema.json", "app.clipboard.pasteImage": [] }';
/** What a concurrent process writes into keybindings.json at rename time. */
const CONCURRENT_CONTENT = '{ "app.clipboard.pasteImage": ["ctrl+v"] }';


const settingsPath = (): string => join(tempDir, "settings.json");
/** The title the offer passes to `ctx.ui.confirm` (title first, per Pi API). */
const CONFIRM_TITLE_FOR_TEST = "First run";
const keybindingsPath = (): string => join(tempDir, "keybindings.json");
const tmpPath = (): string => `${keybindingsPath()}.${process.pid}.tmp`;

function writeSettings(obj: object): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(obj), "utf-8");
}

function readSettings(): Record<string, unknown> {
  if (!fs.existsSync(settingsPath())) return {};
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readFlag(): boolean {
  const ns = readSettings()[NAMESPACE] as Record<string, unknown> | undefined;
  return ns?.keybindingsPromptDone === true;
}

function cleanupArtifacts(): void {
  for (const p of [
    settingsPath(),
    settingsPath() + ".tmp",
    keybindingsPath(),
    `${keybindingsPath()}.tmp`,
    tmpPath(),
  ]) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function makeCtx(mode: Mode, opts?: { withReload?: boolean; hasUI?: boolean }) {
  const confirm = vi.fn();
  const notify = vi.fn();
  // Intentionally mirrors the base ExtensionContext the real session_start
  // handler receives: no command-only methods like `reload`. Measured on Pi
  // 1.2.0 in a real session — the notify the restore produced was the
  // "run /reload to apply" hint, i.e. the event ctx had no `reload` (it is
  // attached to the command context only, `runner.js` `createCommandContext`).
  // The auto-reload branch is covered separately by passing { withReload: true },
  // which simulates a future Pi version that puts reload() on the event ctx.
  const reload = opts?.withReload ? vi.fn(async () => {}) : undefined;
  const ctx = {
    mode,
    hasUI: opts?.hasUI ?? true,
    ui: { confirm, notify },
    ...(reload ? { reload } : {}),
  } as unknown as ExtensionContext;
  return { ctx, confirm, notify, reload };
}

function callArgs(m: ReturnType<typeof vi.fn>): unknown[][] {
  return m.mock.calls as unknown[][];
}

beforeEach(() => {
  cleanupArtifacts();
  existsSyncSpy.mockReset();
  existsSyncSpy.mockImplementation((p: unknown) => fs.existsSync(String(p)));
});

afterAll(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ── gate matrix ──────────────────────────────────────────────────────────────
// isConfigEnabled × {t,f} × ctx.mode ∈ {tui, rpc, json, print} × file {absent,
// present} × flag {unset, set} × confirm outcome {yes, no, cancel-resolves-false}
// (Esc/timeout: `confirm` resolves `false` either way → counts as decline).

interface Case {
  enabled: boolean;
  mode: Mode;
  file: "absent" | "present";
  flag: "unset" | "set";
  outcome: "yes" | "no" | "cancel-resolves-false";
}

const CASES: Case[] = (() => {
  const cases: Case[] = [];
  for (const enabled of [false, true]) {
    for (const mode of ["tui", "rpc", "json", "print"] as Mode[]) {
      for (const file of ["absent", "present"] as const) {
        for (const flag of ["unset", "set"] as const) {
          for (const outcome of ["yes", "no", "cancel-resolves-false"] as const) {
            cases.push({ enabled, mode, file, flag, outcome });
          }
        }
      }
    }
  }
  return cases;
})();

describe("offerKeybindingFix — gate matrix", () => {
  it.each(CASES)(
    "$enabled/$mode/$file/$flag → $outcome",
    async ({ enabled, mode, file, flag, outcome }) => {
      // ── setup ──
      const ns: Record<string, unknown> = {};
      if (enabled === false) ns.enabled = false;
      if (flag === "set") ns.keybindingsPromptDone = true;
      const settingsBefore = { ...ns };
      if (Object.keys(settingsBefore).length > 0) {
        writeSettings({ [NAMESPACE]: settingsBefore });
      }
      const settingsBeforeJson = readSettings();

      if (file === "present") {
        fs.writeFileSync(keybindingsPath(), CONCURRENT_CONTENT, "utf-8");
      }

      const { ctx, confirm, notify } = makeCtx(mode);
      if (outcome === "yes") confirm.mockResolvedValue(true);
      else confirm.mockResolvedValue(false); // no + cancel: confirm resolves false

      // All matrix rows use a base-shape ctx (no reload), so the offer
      // resolves `false` — the `true` contract is covered by the
      // auto-reload branch tests below.
      const result = await offerKeybindingFix(ctx);
      expect(result).toBe(false);

      const shouldAsk =
        enabled === true &&
        mode === "tui" &&
        flag === "unset" &&
        file === "absent";

      // ── gate behavior ──
      expect(confirm).toHaveBeenCalledTimes(shouldAsk ? 1 : 0);
      // never fires when the plugin is disabled
      if (enabled === false) expect(confirm).not.toHaveBeenCalled();
      // never fires when the file already exists
      if (file === "present") expect(confirm).not.toHaveBeenCalled();
      // never fires when the flag is already consumed
      if (flag === "set") expect(confirm).not.toHaveBeenCalled();
      // never fires in non-TUI modes
      if (mode !== "tui") expect(confirm).not.toHaveBeenCalled();

      if (shouldAsk) {
        // confirm is called with the TITLE FIRST (docs/extensions.md:165)
        const [title, message] = callArgs(confirm)[0] as [string, string];
        expect(title).toBe("First run");
        expect(typeof message).toBe("string");
        expect(message).toContain("keybindings.json");
      }

      // ── file effects ──
      const kbExists = fs.existsSync(keybindingsPath());
      if (shouldAsk && outcome === "yes") {
        // yes → file written with the exact snippet content
        expect(kbExists).toBe(true);
        expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(SNIPPET);
      } else {
        // never written when the offer never fires; the pre-existing file is never
        // clobbered
        expect(kbExists).toBe(file === "present");
      }

      // ── flag effects ──
      if (shouldAsk) {
        // offer fires once and sets the flag on every outcome (yes, no, cancel → decline)
        expect(readFlag()).toBe(true);
      } else {
        // non-TUI / non-offer rows never consume the flag — settings byte-identical
        expect(readSettings()).toEqual(settingsBeforeJson);
        expect(readFlag()).toBe(flag === "set");
      }

      // ── notifications ──
      if (shouldAsk && outcome === "yes") {
        // Base-shape ctx has no reload, so the offer emits the /reload hint
        expect(
          callArgs(notify).some(
            (c) => c[0] === CREATED_RELOAD_HINT && c[1] === "info",
          ),
        ).toBe(true);
      } else {
        expect(notify).not.toHaveBeenCalled();
      }
    },
  );
});

// ── flag persistence regression: load-modify-save preserves other keys ──────
// saveConfig REPLACES the namespace object (settings-io.ts:29-33), so a bare
// saveConfig(ns, { keybindingsPromptDone: true }) would erase other keys under
// archimedes.imagePaste.

describe("flag write preserves existing settings", () => {
  async function run(outcome: "yes" | "no") {
    writeSettings({
      [NAMESPACE]: { enabled: true, someOtherKey: 42, nested: { a: 1 } },
      "other.ns": { z: 1 },
    });
    const { ctx, confirm } = makeCtx("tui");
    confirm.mockResolvedValue(outcome === "yes");
    // Base-shape ctx (no reload) → resolves `false` on both outcomes.
    expect(await offerKeybindingFix(ctx)).toBe(false);
  }

  it("yes: snippet file written; other archimedes.imagePaste keys survive the flag set", async () => {
    await run("yes");
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(SNIPPET);
    const data = readSettings();
    const ns = data[NAMESPACE] as Record<string, unknown>;
    expect(ns).toEqual({
      enabled: true,
      someOtherKey: 42,
      nested: { a: 1 },
      keybindingsPromptDone: true,
    });
    expect(data["other.ns"]).toEqual({ z: 1 });
  });

  it("no: decline sets the flag via load-modify-save; keys survive, file untouched", async () => {
    await run("no");
    expect(fs.existsSync(keybindingsPath())).toBe(false);
    const ns = readSettings()[NAMESPACE] as Record<string, unknown>;
    expect(ns).toEqual({
      enabled: true,
      someOtherKey: 42,
      nested: { a: 1 },
      keybindingsPromptDone: true,
    });
  });
});

// ── error paths ──────────────────────────────────────────────────────────────

describe("file write throws → flag stays false (self-heals next session)", () => {
  it("yes with an unwritable tmp target: no file, flag unset, error notified, no throw", async () => {
    // Make the (pid-predictable) tmp path unwritable: a directory.
    fs.mkdirSync(tmpPath(), { recursive: true });

    const { ctx, confirm, notify } = makeCtx("tui");
    confirm.mockResolvedValue(true);

    // Write failed → the offer never reloaded → `false`.
    await expect(offerKeybindingFix(ctx)).resolves.toBe(false);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(keybindingsPath())).toBe(false);
    expect(readFlag()).toBe(false);
    expect(
      readSettings()[NAMESPACE] ?? {},
    ).toEqual({}); // nothing persisted to settings

    expect(notify).toHaveBeenCalledTimes(1);
    const [msg, type] = notify.mock.calls[0] as [string, string];
    expect(type).toBe("warning");
    expect(msg.length).toBeGreaterThan(0);
  });
});

describe("the offer text tells the truth about the clash", () => {
  it("does not promise a double-fire: with both bindings live Pi runs ONLY the extension shortcut", async () => {
    // Measured on Pi 1.2.0 in a scratch agent dir with a stubbed clipboard
    // (`keybindings.json` = `{}`, i.e. the built-in live, our shortcut
    // registered): one `ctrl+v` produced exactly one insertion — ours
    // (`[Image #1]` + "Image attached from clipboard.", no `pi-clipboard-*.png`
    // temp file) — plus the `[Extension issues]` line "… Using <ext>".
    // `CustomEditor.handleInput` consults `onExtensionShortcut` and returns
    // before its `app.clipboard.pasteImage` branch (`custom-editor.js:63-70`),
    // so nothing ever double-fired and the dialog must not say it does.
    const { ctx, confirm } = makeCtx("tui");
    confirm.mockResolvedValue(false);

    await offerKeybindingFix(ctx);

    expect(confirm).toHaveBeenCalledTimes(1);
    const [title, message] = confirm.mock.calls[0] as [string, string];
    expect(title).toBe(CONFIRM_TITLE_FOR_TEST);
    expect(message).not.toMatch(/double-?fir/i);
    expect(message).toMatch(/never runs its own action/i);
    expect(message).toContain("Extension issues");
  });
});

describe("flag write throws → notify, no crash (file write already succeeded)", () => {
  it("yes with an unwritable settings target: file kept, flag unset, both notifies, no throw", async () => {
    // Make settings.json an unwritable target: a directory (rename + direct
    // write onto it both fail with EISDIR).
    fs.mkdirSync(settingsPath(), { recursive: true });

    const { ctx, confirm, notify } = makeCtx("tui");
    confirm.mockResolvedValue(true);

    // Base-shape ctx (no reload) → `false`, even though the file was written.
    await expect(offerKeybindingFix(ctx)).resolves.toBe(false);

    // The file write strictly precedes the flag set and survived:
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(SNIPPET);
    // Flag persistence failed: settings.json is still the directory, no flag
    expect(fs.statSync(settingsPath()).isDirectory()).toBe(true);
    expect(readFlag()).toBe(false);
    // Gate 4 blocks the re-offer anyway (file now exists) — by design

    const args = callArgs(notify);
    expect(
      args.some((c) => c[0] === CREATED_RELOAD_HINT && c[1] === "info"),
    ).toBe(true); // the file WAS created (base-shape ctx → /reload hint)
    expect(args.some((c) => c[1] === "warning" && String(c[0]).length > 0)).toBe(true); // flag save error: non-empty warning message
  });
});

// ── accept with base-shape ctx (no reload — Pi 0.85.1 event ctx) ──────────
// The real session_start ctx has no reload property (Pi 0.85.1 attaches it
// to the command context only), so the offer must fall back to a /reload
// hint instead of claiming it reloaded.

describe("accept with base-shape ctx (no reload)", () => {
  it("yes: fallback /reload hint notified, file written, flag persisted, no throw", async () => {
    const { ctx, confirm, notify } = makeCtx("tui");
    confirm.mockResolvedValue(true);

    // No reload on this ctx → the user is told to run /reload manually,
    // so the offer did NOT trigger a reload → `false`.
    await expect(offerKeybindingFix(ctx)).resolves.toBe(false);

    // File written with the exact snippet
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(SNIPPET);
    // Flag persisted
    expect(readFlag()).toBe(true);
    // The truthful fallback message — no "reloading now" claim
    expect(
      callArgs(notify).some(
        (c) => c[0] === CREATED_RELOAD_HINT && c[1] === "info",
      ),
    ).toBe(true);
    expect(callArgs(notify).some((c) => c[0] === CREATED_NOTIFY)).toBe(false);
  });

  it("no path: no created notification at all", async () => {
    const { ctx, confirm, notify } = makeCtx("tui");
    confirm.mockResolvedValue(false);
    await offerKeybindingFix(ctx);
    expect(
      callArgs(notify).some(
        (c) => c[0] === CREATED_NOTIFY || c[0] === CREATED_RELOAD_HINT,
      ),
    ).toBe(false);
  });
});

// ── auto-reload branch: simulates a future Pi version that puts ────────────
// reload() on the event ctx. A reload-carrying ctx (makeCtx with
// { withReload: true }) covers that branch; the base-shape tests above
// cover current Pi.

describe("auto-reload branch (future Pi with reload on the event ctx)", () => {
  it("yes path: reload called exactly once after flag is persisted and CREATED_NOTIFY emitted", async () => {
    // Track invocation order so we can assert flag is persisted before reload.
    const order: string[] = [];
    const { ctx, confirm, notify, reload } = makeCtx("tui", { withReload: true });
    confirm.mockResolvedValue(true);
    // Wrap the reload spy to record when it's called relative to flag write.
    reload!.mockImplementation(async () => {
      // At this point the flag must already be persisted to disk.
      order.push(readFlag() ? "flag-then-reload" : "reload-before-flag");
    });
    notify.mockImplementation((...args: unknown[]) => {
      if ((args[0] as string) === CREATED_NOTIFY) order.push("notify");
    });

    const result = await offerKeybindingFix(ctx);

    // The successful accept + reload() path resolves `true`
    expect(result).toBe(true);
    // reload called exactly once
    expect(reload).toHaveBeenCalledTimes(1);
    // flag was already set when reload ran
    expect(order).toContain("flag-then-reload");
    expect(order).not.toContain("reload-before-flag");
    // CREATED_NOTIFY emitted before reload
    const notifyIdx = order.indexOf("notify");
    const reloadIdx = order.indexOf("flag-then-reload");
    expect(notifyIdx).toBeGreaterThanOrEqual(0);
    expect(reloadIdx).toBeGreaterThan(notifyIdx);
    // File written
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(SNIPPET);
    // CREATED_NOTIFY contains "reloading now"
    expect(CREATED_NOTIFY).toContain("reloading now");
  });

  it("no path: reload NOT called", async () => {
    const { ctx, confirm, reload } = makeCtx("tui", { withReload: true });
    confirm.mockResolvedValue(false);
    // Decline: no reload → `false`.
    expect(await offerKeybindingFix(ctx)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("cancel (resolves false) path: reload NOT called", async () => {
    const { ctx, confirm, reload } = makeCtx("tui", { withReload: true });
    confirm.mockResolvedValue(false); // Esc/timeout: same as no
    expect(await offerKeybindingFix(ctx)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("file-write-fails path: reload NOT called", async () => {
    // Block the file write by making the tmp path a directory
    fs.mkdirSync(tmpPath(), { recursive: true });
    const { ctx, confirm, reload } = makeCtx("tui", { withReload: true });
    confirm.mockResolvedValue(true);
    expect(await offerKeybindingFix(ctx)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("TOCTOU path: reload NOT called (file appeared before the rename)", async () => {
    // Same spy materialization as the concurrent-creation test: the file
    // appears between gate 4 and the pre-rename re-check, so the offer ends
    // before the reload step is ever reached.
    let kbHits = 0;
    existsSyncSpy.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s === keybindingsPath()) {
        kbHits += 1;
        if (kbHits >= 2) {
          if (!fs.existsSync(s)) fs.writeFileSync(s, CONCURRENT_CONTENT, "utf-8");
          return true;
        }
      }
      return fs.existsSync(s);
    });

    const { ctx, confirm, reload } = makeCtx("tui", { withReload: true });
    confirm.mockResolvedValue(true);
    expect(await offerKeybindingFix(ctx)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reload rejects: offer still resolves (false), flag persisted, file present, CREATED_NOTIFY emitted", async () => {
    const { ctx, confirm, notify, reload } = makeCtx("tui", { withReload: true });
    confirm.mockResolvedValue(true);
    reload!.mockRejectedValue(new Error("Reload failed"));

    // The reload FAILED: the TUI shows its own "Reload failed" status and the
    // session continues on the (still-valid) ctx, so the offer reports `false`
    // — the onboarding still runs on this session.
    await expect(offerKeybindingFix(ctx)).resolves.toBe(false);

    // File must have been written
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(SNIPPET);
    // Flag must have been set (reload runs after flag)
    expect(readFlag()).toBe(true);
    // CREATED_NOTIFY must have been emitted (fires before reload)
    expect(
      (notify.mock.calls as unknown[][]).some(
        (c) => c[0] === CREATED_NOTIFY && c[1] === "info",
      ),
    ).toBe(true);
    // reload was still attempted once
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("concurrent creation is never clobbered", () => {
  it("file created between gate 4 and the pre-rename re-check: left intact, flag set", async () => {
    // Simulate: the first keybindings.json check (gate 4) sees nothing; the
    // second (pre-rename re-check) sees a file that a concurrent process just
    // created — the spy materializes it on that hit.
    let kbHits = 0;
    existsSyncSpy.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s === keybindingsPath()) {
        kbHits += 1;
        // NOTE: coupled to the module's two existsSync calls — gate-4 check,
        // then the pre-rename re-check (keybinding-offer.ts). If the module
        // de-duplicates or adds an existence check, update kbHits accordingly.
        if (kbHits >= 2) {
          if (!fs.existsSync(s)) {
            fs.writeFileSync(s, CONCURRENT_CONTENT, "utf-8");
          }
          return true;
        }
      }
      return fs.existsSync(s);
    });

    const { ctx, confirm, notify } = makeCtx("tui");
    confirm.mockResolvedValue(true);

    // The offer ended before the reload step → `false`.
    await expect(offerKeybindingFix(ctx)).resolves.toBe(false);

    // The concurrently created file is never clobbered by the snippet
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(CONCURRENT_CONTENT);
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).not.toBe(SNIPPET);
    // The tmp file is cleaned up
    expect(fs.existsSync(tmpPath())).toBe(false);
    // The offer ends: the offer was made and the fix is in force (file exists)
    expect(readFlag()).toBe(true);
    // We did not create the file, so we do not claim to — and the offer
    // ends before any reload step (no "reloading now" / /reload-hint
    // notification either)
    expect(
      callArgs(notify).some(
        (c) => c[0] === CREATED_NOTIFY || c[0] === CREATED_RELOAD_HINT,
      ),
    ).toBe(false);
  });
});

// ── the $schema line in the generated artefact ───────────────────────────
//
// What the file is FOR, not just that it was written. `$schema` points at pi's
// published schema (https://pi.dev/schemas/keybindings.schema.json, which
// declares `"$schema": { "type": "string" }` and an `$id` of the same URL), so
// an editor or a standalone validator can check the file. It is
// forward-compatibility and tooling, NOT startup validation: pi 1.2.0 validates
// *themes* at startup (`setThemeJsonValidator`, dist/main.js:452) and ships
// `KeybindingsSchema` (dist/core/keybindings-schema.js:13) with nothing
// importing it. pi's own loader skips `$schema` outright
// (`if (key === "$schema") continue;`, dist/core/keybindings.js:247-248), which
// is what makes the extra key safe to write: the unbinding still applies.

describe("generated snippet carries pi's published $schema", () => {
  it("the written file parses to $schema plus the unbinding, and nothing else", async () => {
    writeSettings({ [NAMESPACE]: { enabled: true } });
    const { ctx, confirm } = makeCtx("tui");
    confirm.mockResolvedValue(true);

    await offerKeybindingFix(ctx);

    const raw = fs.readFileSync(keybindingsPath(), "utf-8");
    expect(JSON.parse(raw)).toEqual({
      $schema: "https://pi.dev/schemas/keybindings.schema.json",
      "app.clipboard.pasteImage": [],
    });
    // Byte-exact, because the README quotes this line verbatim and a reader
    // copy-pasting it should get exactly what the suite writes.
    expect(raw).toBe(SNIPPET);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// restoreNativePaste() — ADR 0030's Amendment (2026-10-13)
// ══════════════════════════════════════════════════════════════════════════
//
// The user who accepted the first-run offer holds a keybindings.json that
// leaves pi's native `app.clipboard.pasteImage` UNBOUND. `suppressNativePaste:
// false` has to give the key back, which means deleting our own unbinding from
// a file that already exists — the narrow exception to gate 4's "never rewrite
// an existing user keybindings file" rule.
//
// ACCEPT-SET DECISION, recorded here in the test names (the amendment demands an
// explicit choice): the accept-set is exactly the two artefacts this suite has
// ever written, and nothing else —
//   * pre-#123:  { "app.clipboard.pasteImage": [] }
//   * since #123: { "$schema": "https://pi.dev/schemas/keybindings.schema.json",
//                   "app.clipboard.pasteImage": [] }
// `$schema` counts as ours ONLY when it carries pi's published URL (that is
// literally what the suite writes); any other second key is foreign. The set is
// never widened to "any object containing app.clipboard.pasteImage: []".

const UNBIND_KEY = "app.clipboard.pasteImage";
const SCHEMA_URL = "https://pi.dev/schemas/keybindings.schema.json";
/** What the suite wrote before PR #123 added `$schema`. */
const ARTEFACT_PRE_123 = `{ "${UNBIND_KEY}": [] }`;
/** Byte-for-byte what `offerKeybindingFix` writes today (SNIPPET above). */
const ARTEFACT_POST_123 = `{ "$schema": "${SCHEMA_URL}", "${UNBIND_KEY}": [] }`;

/** The `globalThis` guard key the surfacing rule mandates (contract clause 5). */
const NOTICE_KEY = Symbol.for("pi-archimedes:image-paste:restore-notified");

function clearNoticeGuard(): void {
  delete (globalThis as Record<symbol, unknown>)[NOTICE_KEY];
}

/** Ask for the key back: `suppressNativePaste: false`. */
function askForNativePaste(): void {
  writeSettings({ [NAMESPACE]: { suppressNativePaste: false } });
}

function writeKeybindings(content: string): void {
  fs.writeFileSync(keybindingsPath(), content, "utf-8");
}

/** Narrow a status, failing loudly with the kind actually seen. */
function asUntouched(s: RestoreNativePasteStatus | NativePasteRestoreOutcome) {
  if (s.kind !== "untouched") {
    return expect.fail(`expected status "untouched", got "${s.kind}"`);
  }
  return s as Extract<RestoreNativePasteStatus, { kind: "untouched" }>;
}

describe("restoreNativePaste — the accept-set (only our own artefact is rewritten)", () => {
  beforeEach(clearNoticeGuard);

  it("accept-set INCLUDES the pre-#123 artefact { app.clipboard.pasteImage: [] }: rewritten to {} and a reload is required", () => {
    writeKeybindings(ARTEFACT_PRE_123);

    const status = restoreNativePaste();

    expect(status.kind).toBe("restored");
    expect(status.path).toBe(keybindingsPath());
    // The rewrite only ever REMOVES the key: the file is left as an empty object.
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe("{}");
    // Nothing asked for yet — the caller owns the reload, so the status is what
    // tells it that pi must re-read keybindings.json.
    expect(
      (status as Extract<RestoreNativePasteStatus, { kind: "restored" }>)
        .reloadRequired,
    ).toBe(true);
  });

  it("accept-set INCLUDES the $schema + app.clipboard.pasteImage: [] pair — byte-for-byte what the suite writes since PR #123", () => {
    // The decision the amendment asks for explicitly: `$schema` is OUR key when
    // it points at pi's published schema, because that is the file we wrote.
    writeKeybindings(ARTEFACT_POST_123);

    const status = restoreNativePaste();

    expect(status.kind).toBe("restored");
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe("{}");
  });

  it("accept-set does NOT widen: a $schema carrying any other URL is a foreign key, so the file is untouched byte-for-byte", () => {
    const foreign = `{ "$schema": "https://example.com/keybindings.schema.json", "${UNBIND_KEY}": [] }`;
    writeKeybindings(foreign);

    const status = asUntouched(restoreNativePaste());

    expect(status.reason).toBe("extra-key");
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(foreign);
  });

  it("accept-set does NOT widen to 'any object containing app.clipboard.pasteImage: []': an extra user key means untouched, and the status carries the path plus the one-line manual edit", () => {
    const foreign = `{ "$schema": "${SCHEMA_URL}", "${UNBIND_KEY}": [], "app.editor.newLine": ["ctrl+enter"] }`;
    writeKeybindings(foreign);

    const status = asUntouched(restoreNativePaste());

    // The status is actionable on its own: path + the exact edit to make.
    expect(status.path).toBe(keybindingsPath());
    expect(status.manualEdit).toContain(keybindingsPath());
    expect(status.manualEdit).toContain(UNBIND_KEY);
    expect(status.manualEdit).not.toContain("\n");
    // Byte-for-byte untouched — no rewrite, no reformatting, no trailing newline.
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(foreign);
    // And the never-touch path leaves no write artefact behind.
    expect(fs.existsSync(`${keybindingsPath()}.tmp`)).toBe(false);
  });

  it("a non-empty app.clipboard.pasteImage value is the user's binding, not our artefact: untouched", () => {
    const owned = `{ "${UNBIND_KEY}": ["ctrl+v"] }`;
    writeKeybindings(owned);

    const status = asUntouched(restoreNativePaste());

    expect(status.reason).toBe("binding-not-empty");
    expect(status.manualEdit).toContain(UNBIND_KEY);
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(owned);
  });

  it("content that does not parse is left byte-for-byte alone and never throws", () => {
    const raw = `{ "${UNBIND_KEY}": [] // hand-edited, not valid JSON`;
    writeKeybindings(raw);

    let status: RestoreNativePasteStatus | undefined;
    expect(() => {
      status = restoreNativePaste();
    }).not.toThrow();

    expect(asUntouched(status!).reason).toBe("unparsable");
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(raw);
  });

  it("JSON that is not an object (an array) is not our artefact: untouched", () => {
    const raw = `["${UNBIND_KEY}"]`;
    writeKeybindings(raw);

    expect(asUntouched(restoreNativePaste()).reason).toBe("not-an-object");
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(raw);
  });

  it("a missing keybindings.json is a no-op: nothing written, status 'missing'", () => {
    expect(fs.existsSync(keybindingsPath())).toBe(false);

    const status = restoreNativePaste();

    expect(status.kind).toBe("missing");
    expect(fs.existsSync(keybindingsPath())).toBe(false);
  });

  it("a keybindings.json that cannot be read (a directory where the file should be) is 'untouched (unreadable)', never a throw", () => {
    // The one branch the contract did not name: the extension must not crash on
    // it and must not try to write over it.
    fs.mkdirSync(keybindingsPath(), { recursive: true });

    let status: RestoreNativePasteStatus | undefined;
    expect(() => {
      status = restoreNativePaste();
    }).not.toThrow();

    const untouched = asUntouched(status!);
    expect(untouched.reason).toBe("unreadable");
    // Issue #127: the file could not be read, so nothing in it can be named.
    // The guidance names the file and hands the reading back to the user — it
    // does not order them to delete an entry we never saw.
    expect(untouched.manualEdit).toContain(keybindingsPath());
    expect(untouched.manualEdit).not.toContain(UNBIND_KEY);
    expect(untouched.manualEdit).not.toMatch(/remove|delete/i);
    expect(fs.statSync(keybindingsPath()).isDirectory()).toBe(true);
  });

  it("restoreNativePaste is silent by itself — it takes no ctx (nothing to notify with) and writes no log line", () => {
    // Contract clause 2: "It returns a status; it never logs or notifies
    // itself." Surfacing belongs to the caller, so one session cannot produce
    // two messages and a headless caller stays silent on its own.
    expect(restoreNativePaste.length).toBe(0);

    const logFile = join(tempDir, `diag-${process.pid}-silent.log`);
    writeKeybindings(ARTEFACT_POST_123);
    process.env.PI_ARCHIMEDES_LOG = logFile;
    let status: RestoreNativePasteStatus | undefined;
    try {
      status = restoreNativePaste();
    } finally {
      delete process.env.PI_ARCHIMEDES_LOG;
    }

    // It did the work …
    expect(status!.kind).toBe("restored");
    // … and recorded nothing: the log sink stays untouched (it is never created).
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it("a file already reading {} is 'already-restored' and is NOT rewritten — bytes and mtime both untouched", () => {
    // Deliberately NOT the bytes we would write, so a rewrite that produces the
    // same *value* is still caught, and a fixed old mtime catches a rewrite that
    // would produce identical bytes.
    const raw = "{\n}\n";
    writeKeybindings(raw);
    const stamp = new Date("2020-01-01T12:00:00.000Z");
    fs.utimesSync(keybindingsPath(), stamp, stamp);

    const status = restoreNativePaste();

    expect(status.kind).toBe("already-restored");
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(raw);
    expect(fs.statSync(keybindingsPath()).mtimeMs).toBe(stamp.getTime());
  });

  it("a symlinked keybindings.json stays a symlink: the link survives, its target is replaced atomically (new inode, {} content), and no tmp file lands beside the link", () => {
    // The amendment's consequence: the write must go through
    // writeAtomicPreservingSymlinks, not the offer's plain tmp+rename-onto-path
    // (which would replace the link with a regular file in the agent dir) and
    // not a plain writeFileSync (which would write in place, same inode).
    const realDir = join(tempDir, `link-target-${process.pid}`);
    const realPath = join(realDir, "keybindings.json");
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(realPath, ARTEFACT_POST_123, "utf-8");
    fs.symlinkSync(realPath, keybindingsPath());
    const inodeBefore = fs.statSync(realPath).ino;

    const status = restoreNativePaste();

    expect(status.kind).toBe("restored");
    // Still a symlink, still pointing where the user pointed it.
    expect(fs.lstatSync(keybindingsPath()).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(keybindingsPath())).toBe(realPath);
    // The content change landed on the TARGET, and via rename (a new inode),
    // i.e. atomically — not as an in-place write.
    expect(fs.readFileSync(realPath, "utf-8")).toBe("{}");
    expect(fs.statSync(realPath).ino).not.toBe(inodeBefore);
    expect(fs.existsSync(`${realPath}.tmp`)).toBe(false);
    expect(fs.existsSync(`${keybindingsPath()}.tmp`)).toBe(false);
  });

  it("a write that fails yields 'failed' with the path and the manual edit, never throws, and leaves nothing behind", () => {
    writeKeybindings(ARTEFACT_POST_123);
    // Deterministic write failure, for every uid: a DIRECTORY sits where the
    // atomic writer puts its temp file, so `writeFileSync(tmp)` throws EISDIR,
    // the rename is never attempted, and the live file must survive.
    //
    // This replaced `chmodSync(tempDir, 0o555)`, which is uid-dependent: a root
    // process ignores the mode bit (CAP_DAC_OVERRIDE), so under root the write
    // SUCCEEDED and this test failed against correct code with
    // `expected status "failed", got "restored"` — reproduced by neutralising
    // the chmod to 0o755 and watching exactly that failure.
    const blockedTmp = `${keybindingsPath()}.tmp`;
    fs.mkdirSync(blockedTmp, { recursive: true });
    let status: RestoreNativePasteStatus | undefined;
    try {
      expect(() => {
        status = restoreNativePaste();
      }).not.toThrow();
    } finally {
      fs.rmSync(blockedTmp, { recursive: true, force: true });
    }

    const failed = status!;
    if (failed.kind !== "failed") {
      return expect.fail(`expected status "failed", got "${failed.kind}"`);
    }
    expect(failed.path).toBe(keybindingsPath());
    expect(failed.error.length).toBeGreaterThan(0);
    expect(failed.manualEdit).toContain(keybindingsPath());
    expect(failed.manualEdit).toContain(UNBIND_KEY);
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(ARTEFACT_POST_123);
  });
});

// ── the accept-set, probed at its edges ─────────────────────────────────────
//
// These are the inputs an adversarial (or merely hand-editing) user can put in
// front of the restore. Each was measured, not reasoned about: the accept-set is
// a parse-based test, so the questions are what the parse yields and what the
// bytes look like afterwards.

describe("restoreNativePaste — accept-set edges (measured)", () => {
  beforeEach(clearNoticeGuard);

  it("the $schema URL is compared exactly: a different case, scheme or trailing slash is a foreign key", () => {
    for (const url of [
      "HTTPS://PI.DEV/schemas/keybindings.schema.json",
      "http://pi.dev/schemas/keybindings.schema.json",
      `${SCHEMA_URL}/`,
      `${SCHEMA_URL}?v=2`,
    ]) {
      const foreign = `{ "$schema": "${url}", "${UNBIND_KEY}": [] }`;
      writeKeybindings(foreign);

      expect(asUntouched(restoreNativePaste()).reason, url).toBe("extra-key");
      expect(fs.readFileSync(keybindingsPath(), "utf-8"), url).toBe(foreign);
    }
  });

  it("a differently-cased $Schema key is not our key either", () => {
    const foreign = `{ "$Schema": "${SCHEMA_URL}", "${UNBIND_KEY}": [] }`;
    writeKeybindings(foreign);

    expect(asUntouched(restoreNativePaste()).reason).toBe("extra-key");
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(foreign);
  });

  it("a nested object as the second key is foreign, however innocent it looks", () => {
    const foreign = `{ "${UNBIND_KEY}": [], "nested": { "a": { "b": 1 } } }`;
    writeKeybindings(foreign);

    expect(asUntouched(restoreNativePaste()).reason).toBe("extra-key");
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(foreign);
  });

  it("a $schema with no binding at all is not an artefact (pi's paste is already live)", () => {
    const onlySchema = `{ "$schema": "${SCHEMA_URL}" }`;
    writeKeybindings(onlySchema);

    expect(asUntouched(restoreNativePaste()).reason).toBe("extra-key");
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(onlySchema);
  });

  it("a UTF-8 BOM leaves the file untouched: JSON.parse rejects it, so the restore is STRICTER than pi", () => {
    // Worth naming the divergence: pi strips a BOM before parsing
    // (`stripBom`, dist/core/keybindings.js `loadRawConfig`), so to PI this
    // file is a live unbinding — but the restore will not act on bytes it did
    // not write. The safe direction: never delete what we cannot identify.
    const bommed = `\uFEFF${ARTEFACT_POST_123}`;
    writeKeybindings(bommed);

    const status = asUntouched(restoreNativePaste());

    expect(status.reason).toBe("unparsable");
    // Same as the unreadable case (issue #127): bytes that do not parse cannot
    // tell us what the key is bound to, so the guidance says "check this file"
    // rather than naming a line to delete.
    expect(status.manualEdit).toContain(keybindingsPath());
    expect(status.manualEdit).not.toContain(UNBIND_KEY);
    expect(status.manualEdit).not.toMatch(/remove|delete/i);
    // Byte-for-byte, BOM included.
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(bommed);
  });

  it("JSON that parses to null / false / 0 / a string is 'not-an-object' and is never rewritten", () => {
    for (const raw of ["null", "false", "0", `"${UNBIND_KEY}"`, "[[]]"]) {
      writeKeybindings(raw);

      expect(asUntouched(restoreNativePaste()).reason, raw).toBe("not-an-object");
      expect(fs.readFileSync(keybindingsPath(), "utf-8"), raw).toBe(raw);
    }
  });

  it("a __proto__ key is foreign and is not treated as a prototype (no mutation, no rewrite)", () => {
    const weird = `{ "__proto__": [], "${UNBIND_KEY}": [] }`;
    writeKeybindings(weird);

    expect(asUntouched(restoreNativePaste()).reason).toBe("extra-key");
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(weird);
    expect(({} as Record<string, unknown>)[UNBIND_KEY]).toBeUndefined();
  });

  it("the accept-set is parse-based, so whitespace, layout and duplicate keys still count as ours", () => {
    // JSON.parse takes the LAST duplicate, which is exactly what pi's own
    // loader sees, so acting on the parsed value is consistent with pi.
    const spaced = `{ "$schema": "${SCHEMA_URL}", "${UNBIND_KEY}": [   ] }   \n\n`;
    writeKeybindings(spaced);
    expect(restoreNativePaste().kind).toBe("restored");

    writeKeybindings(`{\n  "$schema": "${SCHEMA_URL}",\n  "${UNBIND_KEY}": [\n  ]\n}\n`);
    expect(restoreNativePaste().kind).toBe("restored");

    writeKeybindings(`{ "$schema": "${SCHEMA_URL}", "${UNBIND_KEY}": [], "${UNBIND_KEY}": [] }`);
    expect(restoreNativePaste().kind).toBe("restored");
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe("{}");
  });

  it("the one sharp edge of a parse-based accept-set: a duplicate key carrying a real binding is shadowed, and pi reads it the same way", () => {
    // `{ pasteImage: ["ctrl+v"], pasteImage: [] }` parses to `[]` for US and
    // for PI alike (last duplicate wins), so the `ctrl+v` in the raw bytes is
    // already dead before we run: rewriting to `{}` removes a binding pi was
    // never going to honour. Documented here because it is the only case where
    // bytes containing a non-empty binding are replaced.
    const shadowed = `{ "${UNBIND_KEY}": ["ctrl+v"], "${UNBIND_KEY}": [] }`;
    writeKeybindings(shadowed);

    expect(restoreNativePaste().kind).toBe("restored");
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe("{}");
  });

  it("a keybindings.json symlinked OUTSIDE the agent dir stays a symlink and the target is replaced atomically", () => {
    // The dotfiles-checkout case: `~/.pi/agent/keybindings.json ->
    // ~/dotfiles/pi/keybindings.json`, a path with nothing to do with the agent
    // dir. The link must survive and the write must land on the target.
    const dotfiles = join(tempDir, `..-dotfiles-${process.pid}`);
    const realPath = join(dotfiles, "keybindings.json");
    fs.mkdirSync(dotfiles, { recursive: true });
    try {
      fs.writeFileSync(realPath, ARTEFACT_POST_123, "utf-8");
      fs.symlinkSync(realPath, keybindingsPath());
      const inodeBefore = fs.statSync(realPath).ino;

      const status = restoreNativePaste();

      expect(status.kind).toBe("restored");
      expect(fs.lstatSync(keybindingsPath()).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(keybindingsPath())).toBe(realPath);
      expect(fs.readFileSync(realPath, "utf-8")).toBe("{}");
      // Written beside the target and renamed onto it — not in the agent dir.
      expect(fs.statSync(realPath).ino).not.toBe(inodeBefore);
      expect(fs.existsSync(`${realPath}.tmp`)).toBe(false);
      expect(fs.existsSync(`${keybindingsPath()}.tmp`)).toBe(false);
      // No stray file was created in the agent dir either.
      expect(fs.readdirSync(tempDir).filter((f: string) => f.startsWith("keybindings"))).toEqual([
        "keybindings.json",
      ]);
    } finally {
      fs.rmSync(dotfiles, { recursive: true, force: true });
    }
  });

  it("a DANGLING symlink is 'missing': nothing is written through the link and the link is left alone", () => {
    // `existsSync` follows the link, so an unresolvable target — including a
    // symlink LOOP — is `missing`, not `failed` and not a write-through.
    const outside = join(tempDir, `dangling-${process.pid}`);
    const target = join(outside, "keybindings.json");
    fs.mkdirSync(outside, { recursive: true });
    try {
      fs.symlinkSync(target, keybindingsPath());

      const status = restoreNativePaste();

      expect(status.kind).toBe("missing");
      expect(status.path).toBe(keybindingsPath());
      expect(fs.lstatSync(keybindingsPath()).isSymbolicLink()).toBe(true);
      // The restore must not resurrect a file the user's link points at.
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(keybindingsPath(), { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a symlink to a DIRECTORY is 'unreadable' and the directory is left alone", () => {
    const dir = join(tempDir, `kb-is-dir-${process.pid}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.symlinkSync(dir, keybindingsPath());

      expect(asUntouched(restoreNativePaste()).reason).toBe("unreadable");
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(keybindingsPath(), { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runNativePasteRestore — the caller surfaces the outcome (once per process, reload-stable)", () => {
  beforeEach(clearNoticeGuard);

  it("the DEFAULT (suppressNativePaste absent) path writes nothing and notifies nothing", async () => {
    writeKeybindings(ARTEFACT_POST_123);
    const { ctx, notify } = makeCtx("tui", { withReload: true });

    const outcome = await runNativePasteRestore(ctx);

    expect(outcome.kind).toBe("suppressed");
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(ARTEFACT_POST_123);
    expect(notify).not.toHaveBeenCalled();
  });

  it("an explicit suppressNativePaste: true behaves exactly like the default", async () => {
    writeSettings({ [NAMESPACE]: { suppressNativePaste: true } });
    writeKeybindings(ARTEFACT_POST_123);
    const { ctx, notify } = makeCtx("tui", { withReload: true });

    const outcome = await runNativePasteRestore(ctx);

    expect(outcome.kind).toBe("suppressed");
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(ARTEFACT_POST_123);
    expect(notify).not.toHaveBeenCalled();
  });

  it("the suppressed path does not even READ keybindings.json — a directory in its place is still 'suppressed'", async () => {
    // Bytes-plus-mtime can only prove "no write". This proves "no read": if the
    // suppressed path opened the path at all it would hit EISDIR and report
    // `untouched (unreadable)`; reporting `suppressed` means the settings check
    // returned before any filesystem access, so a default install never touches
    // the user's keybinding file, in any shape it happens to be in.
    fs.mkdirSync(keybindingsPath(), { recursive: true });
    const { ctx, notify } = makeCtx("tui", { withReload: true });

    const outcome = await runNativePasteRestore(ctx);

    expect(outcome.kind).toBe("suppressed");
    expect(notify).not.toHaveBeenCalled();
    expect(fs.statSync(keybindingsPath()).isDirectory()).toBe(true);
    fs.rmSync(keybindingsPath(), { recursive: true, force: true });
  });

  it("a value that is not strictly false does not ask for the key back (\"false\", 0, null, \"off\")", async () => {
    // Same rule as `isConfigEnabled`: strict comparison, so a stringified
    // "false" from a hand-edited settings.json keeps the default behaviour.
    for (const value of ["false", 0, null, "off"]) {
      writeSettings({ [NAMESPACE]: { suppressNativePaste: value } });
      writeKeybindings(ARTEFACT_POST_123);
      const stamp = new Date("2020-06-07T08:09:10.000Z");
      fs.utimesSync(keybindingsPath(), stamp, stamp);
      const { ctx, notify } = makeCtx("tui", { withReload: true });

      const outcome = await runNativePasteRestore(ctx);

      expect(outcome.kind, JSON.stringify(value)).toBe("suppressed");
      expect(notify, JSON.stringify(value)).not.toHaveBeenCalled();
      expect(fs.readFileSync(keybindingsPath(), "utf-8"), JSON.stringify(value)).toBe(
        ARTEFACT_POST_123,
      );
      expect(fs.statSync(keybindingsPath()).mtimeMs, JSON.stringify(value)).toBe(stamp.getTime());
    }
  });

  it("the suite-owned artefact becomes {} and a reload is requested (reload on the ctx → reload() runs and the status no longer requires /reload)", async () => {
    askForNativePaste();
    writeKeybindings(ARTEFACT_POST_123);
    const { ctx, notify, reload } = makeCtx("tui", { withReload: true });

    const outcome = await runNativePasteRestore(ctx);

    expect(outcome.kind).toBe("restored");
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe("{}");
    expect(reload).toHaveBeenCalledTimes(1);
    if (outcome.kind !== "restored") return expect.fail("expected restored");
    // The reload ran, so pi has re-read keybindings.json: nothing left to ask.
    expect(outcome.reloadRequired).toBe(false);
    expect(
      callArgs(notify).some((c) => c[0] === RESTORED_NOTIFY && c[1] === "info"),
    ).toBe(true);
    expect(CREATED_NOTIFY).toContain("reloading now");
    expect(RESTORED_NOTIFY).toContain("reloading now");
  });

  it("on a ctx WITHOUT reload the restored status says /reload is required and the hint is notified", async () => {
    askForNativePaste();
    writeKeybindings(ARTEFACT_PRE_123);
    const { ctx, notify } = makeCtx("tui");

    const outcome = await runNativePasteRestore(ctx);

    if (outcome.kind !== "restored") return expect.fail(`expected restored, got ${outcome.kind}`);
    expect(outcome.reloadRequired).toBe(true);
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe("{}");
    expect(
      callArgs(notify).some((c) => c[0] === RESTORED_RELOAD_HINT && c[1] === "info"),
    ).toBe(true);
    expect(RESTORED_RELOAD_HINT).toContain("/reload");
  });

  it("an untouched file is notified exactly once, with a message naming the file path and app.clipboard.pasteImage", async () => {
    askForNativePaste();
    const foreign = `{ "${UNBIND_KEY}": [], "app.editor.newLine": ["ctrl+enter"] }`;
    writeKeybindings(foreign);
    const { ctx, notify } = makeCtx("tui");

    const outcome = await runNativePasteRestore(ctx);

    expect(outcome.kind).toBe("untouched");
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, level] = notify.mock.calls[0] as [string, string];
    expect(level).toBe("warning");
    expect(message).toContain(keybindingsPath());
    expect(message).toContain(UNBIND_KEY);
    // Byte-for-byte unchanged, and no rewrite attempt of any kind.
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(foreign);
  });

  it("the untouched warning also says the paste key is left unbound, because the flag took our shortcut with it", async () => {
    // Since the shortcut gate exists, an untouched file is not merely "we did
    // not help you": with `suppressNativePaste: false` image-paste registers no
    // paste shortcut either, so between the warning and the user's edit the key
    // does NOTHING. Saying only "remove the entry and run /reload" would let
    // the user conclude that image-paste broke the key.
    //
    // Scoped deliberately to the refusal where that sentence is TRUE — a file
    // that still carries our `[]` unbinding. The no-entry refusals assert the
    // opposite wording (see "the refuse warning says what this file actually
    // holds").
    askForNativePaste();
    const foreign = `{ "${UNBIND_KEY}": [], "app.editor.newLine": ["ctrl+enter"] }`;
    writeKeybindings(foreign);
    const { ctx, notify } = makeCtx("tui");

    await runNativePasteRestore(ctx);

    const [message] = notify.mock.calls[0] as [string, string];
    expect(message).toMatch(/not binding the paste key/i);
    expect(message).toMatch(/does nothing/i);
    expect(message).toContain(UNBIND_KEY);
  });

  it("a plain second session_start in the same process stays silent for the same untouched file", async () => {
    askForNativePaste();
    const foreign = `{ "${UNBIND_KEY}": [], "app.editor.newLine": ["ctrl+enter"] }`;
    writeKeybindings(foreign);

    const first = makeCtx("tui");
    await runNativePasteRestore(first.ctx);
    expect(first.notify).toHaveBeenCalledTimes(1);

    const second = makeCtx("tui");
    const outcome = await runNativePasteRestore(second.ctx);

    expect(outcome.kind).toBe("untouched");
    expect(second.notify).not.toHaveBeenCalled();
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(foreign);
  });

  it("the once-guard is RELOAD-STABLE, not merely per-session: after vi.resetModules() + re-import (what /reload does to the module registry) the caller still does not notify again", async () => {
    // A module-level `let` passes the "second session_start" test above and
    // STILL re-warns here, because pi re-evaluates the extension module on
    // every load: loadExtensionModule() builds a fresh jiti with
    // `moduleCache: false` (pi 1.2.0 dist/core/extensions/loader.js:477-481) and
    // ctx.reload() clears the cached factory first (dist/core/resource-loader.js:359
    // → clearExtensionCache(), dist/core/extensions/loader.js:89-93).
    // `globalThis` is the only thing that survives it — so the guard lives under
    // Symbol.for("pi-archimedes:image-paste:restore-notified").
    askForNativePaste();
    const foreign = `{ "${UNBIND_KEY}": [], "app.editor.newLine": ["ctrl+enter"] }`;
    writeKeybindings(foreign);

    const first = makeCtx("tui");
    await runNativePasteRestore(first.ctx);
    expect(first.notify).toHaveBeenCalledTimes(1);

    // /reload: a brand-new module instance, same process, same globalThis.
    vi.resetModules();
    const reloaded = await import("./keybinding-offer.js");
    expect(reloaded.runNativePasteRestore).not.toBe(runNativePasteRestore);

    const second = makeCtx("tui");
    await reloaded.runNativePasteRestore(second.ctx);

    expect(second.notify).not.toHaveBeenCalled();
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(foreign);
  });

  it("a reload that re-fires session_start does NOT recurse: the second pass reports already-restored and never reloads again", async () => {
    // pi's own reload path: `AgentSession.reload()` emits `session_start`
    // (`reason: "reload"`, pi 1.2.0 dist/core/agent-session.js:2998) and
    // interactive mode calls `keybindings.reload()` only after it returns
    // (dist/modes/interactive/interactive-mode.js:5406). So a restore that
    // reloads re-enters this call — and must terminate. It does, because the
    // first pass leaves `{}`, which is reported without a rewrite.
    askForNativePaste();
    writeKeybindings(ARTEFACT_POST_123);

    const reloads: number[] = [];
    const passes: string[] = [];
    const runPass = async (depth: number): Promise<void> => {
      const notify = vi.fn();
      const ctx = {
        mode: "tui",
        hasUI: true,
        ui: { confirm: vi.fn(), notify },
        reload: async () => {
          reloads.push(depth);
          await runPass(depth + 1);
        },
      } as unknown as ExtensionContext;

      const outcome = await runNativePasteRestore(ctx);
      passes.push(`${outcome.kind}:${notify.mock.calls.length}`);
    };

    await runPass(0);

    // Exactly one reload, exactly two passes, one rewrite, no notify on the
    // second pass (the inner pass reports first — the reload is awaited inside
    // the outer call). A restore that rewrote `{}` instead of recognising it
    // would reload forever and never reach this assertion.
    expect(reloads).toEqual([0]);
    expect(passes).toEqual(["already-restored:0", "restored:1"]);
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe("{}");
  });

  it("the guard lives on globalThis under the mandated symbol key", async () => {
    askForNativePaste();
    writeKeybindings(`{ "${UNBIND_KEY}": [], "app.editor.newLine": ["ctrl+enter"] }`);
    expect((globalThis as Record<symbol, unknown>)[NOTICE_KEY]).toBeUndefined();

    await runNativePasteRestore(makeCtx("tui").ctx);

    expect((globalThis as Record<symbol, unknown>)[NOTICE_KEY]).toBe(true);
  });

  it("no notify at all when ctx.hasUI is false — and a headless run does not spend the guard", async () => {
    askForNativePaste();
    const foreign = `{ "${UNBIND_KEY}": [], "app.editor.newLine": ["ctrl+enter"] }`;
    writeKeybindings(foreign);

    const headless = makeCtx("rpc", { hasUI: false });
    const headlessOutcome = await runNativePasteRestore(headless.ctx);
    expect(headlessOutcome.kind).toBe("untouched");
    expect(headless.notify).not.toHaveBeenCalled();

    // A later TUI session still gets its one warning.
    const tui = makeCtx("tui");
    await runNativePasteRestore(tui.ctx);
    expect(tui.notify).toHaveBeenCalledTimes(1);
    expect((tui.notify.mock.calls[0] as [string, string])[1]).toBe("warning");
  });

  // The silence promise is stated for EVERY outcome, not just "untouched":
  // "No notify at all when ctx.hasUI is false". The `restored` branch goes
  // through the shared reload helper, which notified unconditionally. Measured
  // against pi 1.2.0: `hasUI` is `uiContext !== noOpUIContext`
  // (dist/core/extensions/runner.js:404), so print/json hosts hand out a
  // no-op `notify` and rpc reports `hasUI: true` — meaning the guard is what
  // makes the documented promise TRUE rather than accidentally true via a
  // host-side no-op, and it is the same rule the `untouched` branch already
  // applies.
  it("a headless session that RESTORES the file never notifies, and the log still carries the outcome", async () => {
    askForNativePaste();
    writeKeybindings(ARTEFACT_POST_123);
    const logFile = join(tempDir, `diag-${process.pid}-headless-restored.log`);
    const headless = makeCtx("rpc", { hasUI: false, withReload: true });
    process.env.PI_ARCHIMEDES_LOG = logFile;
    let outcome: NativePasteRestoreOutcome | undefined;
    try {
      outcome = await runNativePasteRestore(headless.ctx);
    } finally {
      delete process.env.PI_ARCHIMEDES_LOG;
    }

    // The work still happens — silence is not inaction.
    expect(outcome!.kind).toBe("restored");
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe("{}");
    // …with the headless ctx (which has a reload) reporting no /reload is needed.
    if (outcome!.kind !== "restored") return expect.fail(`expected restored, got ${outcome!.kind}`);
    expect(outcome!.reloadRequired).toBe(false);
    // …and NOT one notify emitted, and the once-per-process warning budget is
    // still unspent for whatever comes next.
    expect(headless.notify).not.toHaveBeenCalled();
    expect((globalThis as Record<symbol, unknown>)[NOTICE_KEY]).toBeUndefined();
    // …while the detailed channel still records it.
    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.readFileSync(logFile, "utf-8")).toContain(keybindingsPath());
  });

  it("a headless session with no reload on the ctx notifies nothing, and says /reload is required", async () => {
    askForNativePaste();
    writeKeybindings(ARTEFACT_PRE_123);
    const headless = makeCtx("print", { hasUI: false });

    const outcome = await runNativePasteRestore(headless.ctx);

    if (outcome.kind !== "restored") return expect.fail(`expected restored, got ${outcome.kind}`);
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe("{}");
    expect(outcome.reloadRequired).toBe(true);
    expect(headless.notify).not.toHaveBeenCalled();
  });

  it("a second session on the already-restored {} file notifies nothing and writes nothing", async () => {
    askForNativePaste();
    writeKeybindings("{}");
    const stamp = new Date("2020-01-01T12:00:00.000Z");
    fs.utimesSync(keybindingsPath(), stamp, stamp);

    const first = makeCtx("tui", { withReload: true });
    const outcome = await runNativePasteRestore(first.ctx);

    expect(outcome.kind).toBe("already-restored");
    expect(first.notify).not.toHaveBeenCalled();
    expect(first.reload).not.toHaveBeenCalled();
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe("{}");
    expect(fs.statSync(keybindingsPath()).mtimeMs).toBe(stamp.getTime());

    const second = makeCtx("tui", { withReload: true });
    expect((await runNativePasteRestore(second.ctx)).kind).toBe("already-restored");
    expect(second.notify).not.toHaveBeenCalled();
  });

  it("a failed write is surfaced as one warning naming the path and the key, and never throws", async () => {
    askForNativePaste();
    writeKeybindings(ARTEFACT_POST_123);
    const { ctx, notify } = makeCtx("tui");
    // Same uid-independent injection as the `restoreNativePaste` case: a
    // directory at the temp path makes the temp write fail for any uid, where
    // `chmod 0o555` is simply ignored by root.
    const blockedTmp = `${keybindingsPath()}.tmp`;
    fs.mkdirSync(blockedTmp, { recursive: true });
    let outcome: NativePasteRestoreOutcome | undefined;
    try {
      outcome = await runNativePasteRestore(ctx);
    } finally {
      fs.rmSync(blockedTmp, { recursive: true, force: true });
    }

    expect(outcome!.kind).toBe("failed");
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, level] = notify.mock.calls[0] as [string, string];
    expect(level).toBe("warning");
    expect(message).toContain(keybindingsPath());
    expect(message).toContain(UNBIND_KEY);
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(ARTEFACT_POST_123);
  });

  it("diag carries the detail, so the outcome is recorded even where notify cannot run", async () => {
    // `diag` is opt-in (PI_ARCHIMEDES_LOG names the file), which is exactly why
    // notify is mandatory for the actionable case — but with the log on, the
    // path and the key have to be in it.
    const logFile = join(tempDir, `diag-${process.pid}-untouched.log`);
    askForNativePaste();
    writeKeybindings(`{ "${UNBIND_KEY}": [], "app.editor.newLine": ["ctrl+enter"] }`);
    process.env.PI_ARCHIMEDES_LOG = logFile;
    try {
      await runNativePasteRestore(makeCtx("rpc", { hasUI: false }).ctx);
    } finally {
      delete process.env.PI_ARCHIMEDES_LOG;
    }

    expect(fs.existsSync(logFile)).toBe(true);
    const log = fs.readFileSync(logFile, "utf-8");
    expect(log).toContain("image-paste");
    expect(log).toContain(keybindingsPath());
    expect(log).toContain(UNBIND_KEY);
  });

  it("every session's untouched outcome is logged while notify stays silenced after the first", async () => {
    // `diag` is the detailed channel and may fire every session; the notify is
    // the once-per-process surface. Together they are the surfacing rule.
    askForNativePaste();
    const foreign = `{ "${UNBIND_KEY}": [], "app.editor.newLine": ["ctrl+enter"] }`;
    writeKeybindings(foreign);
    const logFile = join(tempDir, `diag-${process.pid}-twice.log`);
    process.env.PI_ARCHIMEDES_LOG = logFile;
    const first = makeCtx("tui");
    const second = makeCtx("tui");
    try {
      await runNativePasteRestore(first.ctx);
      await runNativePasteRestore(second.ctx);
    } finally {
      delete process.env.PI_ARCHIMEDES_LOG;
    }
    const log: string = fs.readFileSync(logFile, "utf-8");
    expect(
      log.split("\n").filter((line: string) => line.includes(keybindingsPath())).length,
    ).toBeGreaterThanOrEqual(2);
    expect(first.notify).toHaveBeenCalledTimes(1);
    expect(second.notify).not.toHaveBeenCalled();
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(foreign);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The wording of the refuse warning, per refusal (issue #127)
// ══════════════════════════════════════════════════════════════════════════
//
// ONE warning covers five refusals, and they are five different files. Only two
// of them actually hold an `app.clipboard.pasteImage` entry the user could
// delete:
//
//   * `extra-key` WITH our `[]` still sitting beside a foreign key — delete it
//     and pi's paste comes back, and until then nothing answers the key, because
//     the entry is empty AND `suppressNativePaste: false` took our shortcut;
//   * `binding-not-empty` — the entry is there but it is the USER's binding, so
//     the wording has to say whose it is, and cannot claim the key is dead.
//
// The other refusals hold no such entry at all: foreign keys only, `$schema`
// only (`extra-key`), JSON that is not an object, JSON that does not parse, and
// a file that cannot be read. There the instruction "remove the
// `app.clipboard.pasteImage` entry and run /reload" sends the user looking for a
// line that is not in the file, in a file that needs no edit at all — and for the
// two readable ones among them pi is already answering the paste key. So every
// refusal is pinned on its own: the warning always names the file, and it only
// tells the user to delete something when there is something to delete.

describe("runNativePasteRestore — the refuse warning says what this file actually holds", () => {
  beforeEach(clearNoticeGuard);

  /**
   * Refuse `raw`, and return the one warning the caller notified.
   *
   * The shared shape of EVERY refusal lives here, because it is the same for all
   * five: exactly one notify, at `"warning"`, naming the file path, on one line,
   * and the status behind it carrying the reason the wording branches on.
   */
  async function warningFor(raw: string, reason: UntouchedReason): Promise<string> {
    askForNativePaste();
    writeKeybindings(raw);
    const { ctx, notify } = makeCtx("tui");

    const outcome = await runNativePasteRestore(ctx);

    if (outcome.kind !== "untouched") {
      return expect.fail(`expected "untouched", got "${outcome.kind}"`);
    }
    expect(outcome.reason, "the reason the wording branches on").toBe(reason);
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, level] = notify.mock.calls[0] as [string, string];
    expect(level).toBe("warning");
    expect(message).toContain(keybindingsPath());
    expect(message).not.toContain("\n");
    expect(outcome.manualEdit).toContain(keybindingsPath());
    return message;
  }

  // ── the two refusals where an entry really is in the file ────────────────

  it("extra-key WITH our [] entry: the one case where naming the entry to delete is true, and the key is genuinely dead until it goes", async () => {
    const message = await warningFor(
      `{ "${UNBIND_KEY}": [], "app.editor.newLine": ["ctrl+enter"] }`,
      "extra-key",
    );

    expect(message).toContain(UNBIND_KEY);
    expect(message).toMatch(/remove the .*entry/i);
    expect(message).toMatch(/\/reload/);
    expect(message).toMatch(/not binding the paste key/i);
    expect(message).toMatch(/does nothing/i);
  });

  it("binding-not-empty: the entry is named, but as the user's OWN binding, and the key is not called dead", async () => {
    // The user wrote `"app.clipboard.pasteImage": ["ctrl+v"]`. Handing the key
    // to pi still means deleting that line, so the instruction is right — but it
    // is their line, not ours, and something (their own binding) does answer the
    // key today, so "does nothing until you do" would be false here.
    const message = await warningFor(`{ "${UNBIND_KEY}": ["ctrl+v"] }`, "binding-not-empty");

    expect(message).toContain(UNBIND_KEY);
    expect(message).toMatch(/your/i);
    expect(message).toMatch(/remove/i);
    expect(message).toMatch(/\/reload/);
    expect(message).not.toMatch(/does nothing/i);
  });

  // ── the refusals where there is nothing of ours to remove ────────────────

  it("extra keys but no app.clipboard.pasteImage entry: nothing of ours to remove, nothing to edit, pi already answers the key", async () => {
    const message = await warningFor(
      `{ "app.editor.newLine": ["ctrl+enter"] }`,
      "extra-key",
    );

    // No instruction to delete anything — there is nothing to delete.
    expect(message).not.toMatch(/remove|delete/i);
    expect(message).toMatch(/nothing for you to edit/i);
    expect(message).toMatch(/pi's own paste answers that key/i);
    // And no reload is demanded: a file that needs no edit needs no reload.
    expect(message).not.toMatch(/\/reload/);
  });

  it("a $schema-only file is the same refusal: no entry of ours, so no errand", async () => {
    const message = await warningFor(`{ "$schema": "${SCHEMA_URL}" }`, "extra-key");

    expect(message).not.toMatch(/remove|delete/i);
    expect(message).toMatch(/nothing for you to edit/i);
    expect(message).toMatch(/pi's own paste answers that key/i);
    expect(message).not.toMatch(/\/reload/);
  });

  // ── the refusals where the file cannot be read for advice ────────────────

  it("JSON that is not an object: left untouched, the file named, the user asked to check it — no entry named", async () => {
    const message = await warningFor(`["${UNBIND_KEY}"]`, "not-an-object");

    expect(message).toMatch(/not a JSON object/i);
    expect(message).toMatch(/check .*yourself/i);
    expect(message).toMatch(/\/reload/);
    // Neither an entry nor a deletion is named: we cannot see one to name.
    expect(message).not.toContain(UNBIND_KEY);
    expect(message).not.toMatch(/remove|delete/i);
  });

  it("JSON that does not parse: left untouched, the file named, the user asked to check it — no entry named", async () => {
    const message = await warningFor(
      `{ "${UNBIND_KEY}": [] // hand-edited, not valid JSON`,
      "unparsable",
    );

    expect(message).toMatch(/does not parse/i);
    expect(message).toMatch(/check .*yourself/i);
    expect(message).toMatch(/\/reload/);
    expect(message).not.toContain(UNBIND_KEY);
    expect(message).not.toMatch(/remove|delete/i);
  });

  it("a file that cannot be read: left untouched, the file named, the user asked to check it — no entry named", async () => {
    // The helper writes a file, so this refusal is set up by hand — same shape
    // of assertion: one `"warning"` naming the path, no entry, no deletion.
    askForNativePaste();
    fs.mkdirSync(keybindingsPath(), { recursive: true });
    const { ctx, notify } = makeCtx("tui");
    try {
      const outcome = await runNativePasteRestore(ctx);

      if (outcome.kind !== "untouched") {
        return expect.fail(`expected "untouched", got "${outcome.kind}"`);
      }
      expect(outcome.reason).toBe("unreadable");
      expect(notify).toHaveBeenCalledTimes(1);
      const [message, level] = notify.mock.calls[0] as [string, string];
      expect(level).toBe("warning");
      expect(message).toContain(keybindingsPath());
      expect(message).toMatch(/could not be read/i);
      expect(message).toMatch(/check .*yourself/i);
      expect(message).not.toContain(UNBIND_KEY);
      expect(message).not.toMatch(/remove|delete/i);
    } finally {
      fs.rmSync(keybindingsPath(), { recursive: true, force: true });
    }
  });

  it("a failed write still names the entry: the artefact is ours, it is in there, and it is dead until it goes", async () => {
    // The `failed` status shares the wording with the case above because the
    // file it refused IS our artefact — the entry is present and pi's paste is
    // the thing waiting on it.
    askForNativePaste();
    writeKeybindings(ARTEFACT_POST_123);
    const blockedTmp = `${keybindingsPath()}.tmp`;
    fs.mkdirSync(blockedTmp, { recursive: true });
    const { ctx, notify } = makeCtx("tui");
    try {
      const outcome = await runNativePasteRestore(ctx);
      expect(outcome.kind).toBe("failed");

      const [message, level] = notify.mock.calls[0] as [string, string];
      expect(level).toBe("warning");
      expect(message).toContain(keybindingsPath());
      expect(message).toContain(UNBIND_KEY);
      expect(message).toMatch(/remove the .*entry/i);
      expect(message).toMatch(/does nothing/i);
    } finally {
      fs.rmSync(blockedTmp, { recursive: true, force: true });
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// PR #129 review — the remaining clauses, checked against pi's own loader
// ══════════════════════════════════════════════════════════════════════════
//
// The #127 fix split one sentence into four and checked each clause against the
// shapes the split names. Three claims survived that are not facts about the
// file in front of us, and one promise turned out to be untested. Every claim
// below was measured against pi's OWN loader — `KeybindingsManager.create()`
// from `dist/core/keybindings.js`, run against these exact files on pi 1.2.0 and
// pi 0.87.0, which carry the same code — not reasoned about from our side:
//
//   * **The old name still bites.** pi renames `pasteImage` to
//     `app.clipboard.pasteImage` before it applies anything
//     (`KEYBINDING_NAME_MIGRATIONS`, `dist/core/keybindings.js:225`, applied by
//     `migrateKeybindingsConfig` at `:254-269`), so
//     `{ "pasteImage": [] }` resolves the paste action to `[]`: the key is
//     DEAD. Our reader only looks for the modern key, so it filed that file
//     under "nothing in it clears pi's paste binding — pi's own paste answers
//     that key", which is the exact opposite of what pi does with it.
//     pi's startup migration (`migrations.js:139-157`) rewrites the file on
//     disk before extensions load, so this is the narrow case where it did not:
//     a read-only agent dir (its `catch {}` swallows the failure), or a file
//     replaced by a dotfiles sync / editor after the migration and then
//     `/reload`ed — `keybindings.reload()` (`interactive-mode.js:5406`) only
//     re-reads, it never migrates the file.
//   * **We cannot see who wrote the file.** `{ "$schema": <pi's URL> }` is
//     byte-for-byte the line `offerKeybindingFix` writes, and it is the state a
//     user is in after following our own "remove the entry" instruction on that
//     file, so "nothing in this file was written by this suite" is not something
//     the refusal is allowed to assert.
//   * **An unreadable file does not leave the binding unknown.** pi DISCARDS the
//     whole file when it cannot read or parse it (`loadRawConfig` returns
//     `undefined` → `loadFromFile` returns `{}`, `keybindings.js:285-297`) and
//     every action falls back to its default, silently, with no diagnostic on
//     any path. So the paste key IS answered by pi's default and none of the
//     user's own bindings in that file are in force — "we cannot tell what the
//     paste key is bound to" tells the user to go read a file that pi is
//     ignoring.

describe("runNativePasteRestore — the refuse warning vs pi's own keybindings loader (PR #129 review)", () => {
  beforeEach(clearNoticeGuard);

  /** Refuse `raw` and return the one warning, with the shared refusal shape. */
  async function warning(raw: string): Promise<string> {
    // The notice guard is once-per-PROCESS, and one test below asks for two
    // refusals in a row, so the helper re-arms it rather than relying on
    // `beforeEach` alone.
    clearNoticeGuard();
    askForNativePaste();
    writeKeybindings(raw);
    const { ctx, notify } = makeCtx("tui");

    const outcome = await runNativePasteRestore(ctx);

    if (outcome.kind !== "untouched") {
      return expect.fail(`expected "untouched", got "${outcome.kind}"`);
    }
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, level] = notify.mock.calls[0] as [string, string];
    expect(level).toBe("warning");
    expect(message).toContain(keybindingsPath());
    expect(message).not.toContain("\n");
    return message;
  }

  it("the OLD name pasteImage: [] is an unbinding too: pi's paste is dead, and the entry to name is the old one", async () => {
    // Measured: pi resolves app.clipboard.pasteImage to [] for this file, so it
    // belongs with the "there is an entry, remove it, the key is dead until you
    // do" refusals — and naming the modern key would send the user looking for
    // a line that is not in the file (issue #127 again, in the other direction).
    const message = await warning(`{ "pasteImage": [] }`);

    expect(message).toMatch(/"pasteImage"/);
    expect(message).toMatch(/remove .*"pasteImage"/i);
    expect(message).toMatch(/\/reload/);
    expect(message).toMatch(/does nothing/i);
    // The two claims this file refutes.
    expect(message).not.toMatch(/pi's own paste answers that key/i);
    expect(message).not.toMatch(/nothing for you to edit/i);
    // Not told to delete an entry under a name the file does not contain.
    expect(message).not.toMatch(/remove the "app\.clipboard\.pasteImage" entry/i);
  });

  it("a $schema carrying pi's own URL is not evidence the file is foreign: no claim about who wrote it", async () => {
    // Still the no-errand refusal — pi keeps its default binding here.
    const message = await warning(`{ "$schema": "${SCHEMA_URL}" }`);

    expect(message).toMatch(/nothing for you to edit/i);
    expect(message).toMatch(/pi's own paste answers that key/i);
    expect(message).not.toMatch(/\/reload/);
    expect(message).not.toMatch(/remove|delete/i);
    // But the refusal must not assert authorship it cannot see: this exact line
    // is what the first-run offer writes.
    expect(message).not.toMatch(/was written by this suite/i);
    expect(message).not.toMatch(/nothing in .* was written/i);
  });

  it("a file pi cannot read is a file pi ignores: the warning says pi falls back to its defaults", async () => {
    for (const [label, raw] of [
      ["unparsable", `{ "${UNBIND_KEY}": [] // hand-edited, not valid JSON`],
      ["not-a-JSON-object", `["${UNBIND_KEY}"]`],
    ] as const) {
      const message = await warning(raw);

      expect(message, label).not.toMatch(/cannot tell what the paste key is bound to/i);
      expect(message, label).toMatch(/default/i);
      // Still: the file is named, the cause is named, the reading is handed back.
      expect(message, label).toMatch(/check .*yourself/i);
      expect(message, label).not.toContain(UNBIND_KEY);
      expect(message, label).not.toMatch(/remove|delete/i);
    }

    // The third shape cannot come from `warning()` (it writes a file), so it is
    // set up by hand: a directory where keybindings.json should be.
    clearNoticeGuard();
    askForNativePaste();
    // Clear whatever the loop above left at the path, then make it a directory.
    fs.rmSync(keybindingsPath(), { recursive: true, force: true });
    fs.mkdirSync(keybindingsPath(), { recursive: true });
    const { ctx, notify } = makeCtx("tui");
    try {
      await runNativePasteRestore(ctx);
      const [message] = notify.mock.calls[0] as [string, string];

      expect(message).toMatch(/could not be read/i);
      expect(message).toMatch(/default/i);
      expect(message).not.toMatch(/cannot tell what the paste key is bound to/i);
      expect(message).not.toContain(UNBIND_KEY);
      expect(message).not.toMatch(/remove|delete/i);
    } finally {
      fs.rmSync(keybindingsPath(), { recursive: true, force: true });
    }
  });

  it("a modern binding with a legacy [] behind it: clearing only the modern entry would re-dead the key", async () => {
    // Measured: pi drops the legacy entry while the modern key exists
    // (`keybindings.js:260-264`), so the old name is invisible today and takes
    // the binding over the moment the modern entry is deleted — i.e. exactly
    // after the user does what this warning tells them to do.
    const message = await warning(`{ "${UNBIND_KEY}": ["ctrl+v"], "pasteImage": [] }`);

    expect(message).toMatch(/your/i);
    expect(message).toMatch(/pasteImage/);
    expect(message).toMatch(/too\b/i);
    // Their own binding answers the key right now, so the key is not dead.
    expect(message).not.toMatch(/does nothing/i);
  });

  it("diag logs the SAME guidance the warning gave — the log line is not a second wording", async () => {
    // Written against a surviving mutant: replacing `status.manualEdit` with the
    // generic "remove the entry" guidance inside `describeRestoreStatus` passed
    // all 163 tests, because the log assertions only demanded "path + key name"
    // — both of which the OLD one-size sentence also contains. `manualEdit` is
    // the single source for the status, the notify and the log, so the log is
    // asserted against the refusal it belongs to.
    askForNativePaste();
    writeKeybindings(`{ "app.editor.newLine": ["ctrl+enter"] }`);
    const logFile = join(tempDir, `diag-${process.pid}-single-source.log`);
    process.env.PI_ARCHIMEDES_LOG = logFile;
    let notified = "";
    try {
      const { ctx, notify } = makeCtx("tui");
      const outcome = await runNativePasteRestore(ctx);
      expect(outcome.kind).toBe("untouched");
      notified = (notify.mock.calls[0] as [string])[0];
    } finally {
      delete process.env.PI_ARCHIMEDES_LOG;
    }

    const log = fs.readFileSync(logFile, "utf-8");
    expect(log).toContain(keybindingsPath());
    expect(log).toContain("pi's own paste answers that key");
    expect(log).not.toMatch(/remove the .*entry/i);
    expect(notified).toContain("pi's own paste answers that key");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The paste-key gate on the OFFER — issue #133
// ══════════════════════════════════════════════════════════════════════════
//
// `suiteMayClaimPasteKey()` is the single predicate that decides whether the
// suite holds pi's paste key this session, and until #133 the offer was not one
// of its readers: `packages/image-paste/src/index.ts:201` (shortcut
// registration) and `runNativePasteRestore` (`keybinding-offer.ts:778`) were its
// only two callers. So a fresh profile with `suppressNativePaste: false` — the
// escape hatch open, our shortcut deliberately NOT registered — still got the
// offer, and accepting it wrote the very unbinding that leaves `ctrl+v` bound to
// nobody: pi's action is cleared by the file and our handler is not there to
// take the key. The next session's restore then emptied the file the offer had
// just asked permission to create, and announced that it had.
//
// Two things the gate owes the user, both pinned below:
//
// * **Nothing to offer.** With the hatch open there is no shared key to
//   disentangle, so the offer does not ask for permission to create a file this
//   install has already decided it does not want, and emits no UI text at all.
// * **Still armed.** The skip must not spend `keybindingsPromptDone`. The hatch
//   is reversible; a user who closes it again must meet the offer in a later
//   session, which is the whole point of an escape hatch you can undo.

/** The two notices that must never describe the same file — see the invariant. */
const CREATED_TEXT = /Created ~\/\.pi\/agent\/keybindings\.json/;
const RESTORED_TEXT = /Restored pi's native clipboard paste/;

describe("offerKeybindingFix — the paste-key gate (issue #133)", () => {
  it("the hatch is open: no confirm, no file, no tmp, no notify, resolves false", async () => {
    askForNativePaste();
    const { ctx, confirm, notify } = makeCtx("tui");

    await expect(offerKeybindingFix(ctx)).resolves.toBe(false);

    expect(confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(keybindingsPath())).toBe(false);
    expect(fs.existsSync(tmpPath())).toBe(false);
    // Not one UI message of any kind — in particular no "Created …" text.
    expect(notify).not.toHaveBeenCalled();
  });

  it("the skip does NOT spend keybindingsPromptDone, and closing the hatch fires the offer on the same profile", async () => {
    // The reversible-hatch case end to end, on ONE profile: skip → settings
    // byte-identical → the user closes the hatch → the offer fires and accepting
    // it works. The middle assertion is what makes this a proof rather than a
    // hope: an implementation that marked the prompt done on the skip would
    // leave the offer dead for every later session.
    askForNativePaste();
    const skipped = makeCtx("tui");
    expect(await offerKeybindingFix(skipped.ctx)).toBe(false);

    expect(readFlag()).toBe(false);
    // Nothing was added to the namespace: the hatch-off object is untouched.
    expect(readSettings()).toEqual({ [NAMESPACE]: { suppressNativePaste: false } });

    writeSettings({ [NAMESPACE]: { suppressNativePaste: true } });
    const armed = makeCtx("tui");
    armed.confirm.mockResolvedValue(true);
    await offerKeybindingFix(armed.ctx);

    expect(armed.confirm).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(SNIPPET);
    expect(readFlag()).toBe(true);
  });

  it("deleting the setting instead of closing it also re-arms the offer on the same profile", async () => {
    // The other way back to the default: the key disappears entirely, and the
    // offer that the skip withheld is delivered.
    askForNativePaste();
    await expect(offerKeybindingFix(makeCtx("tui").ctx)).resolves.toBe(false);
    expect(readFlag()).toBe(false);

    cleanupArtifacts();
    writeSettings({ [NAMESPACE]: { enabled: true } });
    const armed = makeCtx("tui");
    armed.confirm.mockResolvedValue(true);
    await offerKeybindingFix(armed.ctx);

    expect(armed.confirm).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(keybindingsPath(), "utf-8")).toBe(SNIPPET);
  });

  it("gate 1 still wins: extension disabled + the hatch open → no confirm, no file, no flag", async () => {
    // The gate matrix must not shift: the ADR 0012 in-package `enabled` read
    // stays the first thing the offer consults, whichever way the hatch is set.
    writeSettings({ [NAMESPACE]: { enabled: false, suppressNativePaste: false } });
    const settingsBefore = readSettings();
    const { ctx, confirm, notify } = makeCtx("tui");

    await expect(offerKeybindingFix(ctx)).resolves.toBe(false);

    expect(confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(keybindingsPath())).toBe(false);
    expect(readSettings()).toEqual(settingsBefore);
    expect(readFlag()).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("the gate uses the restore's strict rule: only a strict false withholds the offer (\"false\", 0, null, \"off\", true all still ask)", async () => {
    // The two readers of the setting must not disagree about what "off" means:
    // `runNativePasteRestore` refuses to act on a stringified "false", so the
    // offer must not withhold itself on one either — otherwise the paste key
    // would be left with neither an offer nor a restore.
    for (const value of ["false", 0, null, "off", true]) {
      cleanupArtifacts();
      writeSettings({ [NAMESPACE]: { suppressNativePaste: value } });
      const { ctx, confirm } = makeCtx("tui");
      confirm.mockResolvedValue(false);

      await offerKeybindingFix(ctx);

      expect(confirm, JSON.stringify(value)).toHaveBeenCalledTimes(1);
      // A decline still spends the flag, exactly as the gate matrix records.
      expect(readFlag(), JSON.stringify(value)).toBe(true);
    }
  });

  it("no skip path emits a Created text — and a hatch-off skip never touches the keybindings.json path", async () => {
    // Two claims, both asserted rather than narrated:
    //
    // * No skip announces anything. Every row resolves `false`, asks nothing and
    //   notifies nothing, so no "Created …" can reach a user on any way out of
    //   the offer.
    // * The hatch-off rows never look at `keybindings.json` at all. Gate 4's
    //   check IS `existsSync(keybindingsPath)`, and `node:fs`'s `existsSync` is
    //   spied in this file, so the rows below assert that the path is never
    //   named: gate 1b demonstrably runs before gate 4, not merely somewhere
    //   before the dialog. A mutation that moves the paste-key check after gate
    //   4 fails here (verified: the spy then records the path for every
    //   hatch-off row) — the shape of regression this sentence is for.
    //
    // Gate 3's flag read is a different story and is NOT claimed here: it reads
    // settings.json through the same helper gate 1b itself uses, so its order is
    // not observable from outside. What matters about gate 3 is asserted
    // elsewhere — the reversible-hatch test above, and the gate matrix's rule
    // that a non-asking row leaves settings.json byte-identical.
    const skipPaths: Array<[string, Record<string, unknown>, Mode, boolean]> = [
      ["hatch open, tui", { suppressNativePaste: false }, "tui", false],
      ["hatch open, rpc", { suppressNativePaste: false }, "rpc", false],
      ["hatch open, json", { suppressNativePaste: false }, "json", false],
      ["hatch open, print", { suppressNativePaste: false }, "print", false],
      [
        "hatch open + flag already set",
        { suppressNativePaste: false, keybindingsPromptDone: true },
        "tui",
        false,
      ],
      [
        "hatch open + extension disabled",
        { enabled: false, suppressNativePaste: false },
        "tui",
        false,
      ],
      ["hatch open + a directory where the file would be", { suppressNativePaste: false }, "tui", true],
    ];

    for (const [label, ns, mode, asDirectory] of skipPaths) {
      cleanupArtifacts();
      writeSettings({ [NAMESPACE]: ns });
      if (asDirectory) fs.mkdirSync(keybindingsPath(), { recursive: true });
      const { ctx, confirm, notify } = makeCtx(mode);
      confirm.mockResolvedValue(true);
      existsSyncSpy.mockClear();

      await expect(offerKeybindingFix(ctx), label).resolves.toBe(false);

      // Gate 4's check IS `existsSync(keybindingsPath)` and that call is spied,
      // so a hatch-off skip naming the path at all would mean the paste-key gate
      // ran after it. It must not be named — not for the absent file, not for the
      // directory stand-in.
      const namedPath = existsSyncSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((p) => p === keybindingsPath());
      expect(namedPath, label).toEqual([]);

      expect(confirm, label).not.toHaveBeenCalled();
      expect(
        callArgs(notify).some((c) => CREATED_TEXT.test(String(c[0]))),
        label,
      ).toBe(false);
      expect(notify, label).not.toHaveBeenCalled();
      if (asDirectory) {
        expect(fs.statSync(keybindingsPath()).isDirectory(), label).toBe(true);
        fs.rmSync(keybindingsPath(), { recursive: true, force: true });
      } else {
        expect(fs.existsSync(keybindingsPath()), label).toBe(false);
      }
    }
  });
});

// ── the invariant: offer and restore are mutually exclusive ────────────────
//
// Stated in `docs/features/first-run-keybinding-offer.md` and in the code: for
// one setting value only one of the two flows may act — the offer runs only when
// `suiteMayClaimPasteKey()` is true, the restore only when it is false. So no
// session creates `keybindings.json` and empties it again, and one run never
// tells the user both "Created ~/.pi/agent/keybindings.json …" and "Restored
// pi's native clipboard paste …" about one file. The sequenced pair across a
// settings change is NOT covered here and is not a defect: accept the offer under
// the default, close the hatch later, and the restore hands the key back — that
// is the reversible hatch, exactly what the setting promises.
//
// This drives BOTH entry points in the order `meta/src/index.ts` runs them (the
// offer from the merged first-run handler, the restore last in the registration
// handler because a successful restore can call `ctx.reload()`) against real
// files, so the invariant is an artefact rather than a comment.

describe("the invariant — the offer and the restore cannot both act on keybindings.json", () => {
  beforeEach(clearNoticeGuard);

  /** What one session did, from the outside. */
  interface Session {
    offered: boolean;
    /** Whether the offer got as far as asking the user. */
    asked: boolean;
    restore: NativePasteRestoreOutcome;
    notices: string[];
    file: string | null;
    flag: boolean;
  }

  /**
   * One session, both flows, meta's order. Base-shape ctxs (no `reload`), which
   * is what the measured Pi versions hand a `session_start` handler, so neither
   * flow reloads the runtime out from under the other and the file/notice
   * effects are all that is left to judge.
   *
   * The namespace is MERGED into whatever settings the profile already holds,
   * because that is what a user does: they edit one key in `settings.json`. So a
   * second call inside one test is a later session on the same profile, and it
   * keeps the flag an earlier session spent — replacing the namespace here would
   * quietly reset the state the sequenced-pair test depends on.
   */
  async function runSession(
    ns: Record<string, unknown>,
    opts?: { confirmAnswer?: boolean; existingFile?: string },
  ): Promise<Session> {
    const before = readSettings();
    const beforeNs = (before[NAMESPACE] ?? {}) as Record<string, unknown>;
    writeSettings({ ...before, [NAMESPACE]: { ...beforeNs, ...ns } });
    if (opts?.existingFile !== undefined) writeKeybindings(opts.existingFile);

    const offer = makeCtx("tui");
    offer.confirm.mockResolvedValue(opts?.confirmAnswer ?? true);
    const offered = await offerKeybindingFix(offer.ctx);

    const restore = makeCtx("tui");
    const outcome = await runNativePasteRestore(restore.ctx);

    return {
      offered,
      asked: offer.confirm.mock.calls.length > 0,
      restore: outcome,
      notices: [
        ...callArgs(offer.notify).map((c) => String(c[0])),
        ...callArgs(restore.notify).map((c) => String(c[0])),
      ],
      file: fs.existsSync(keybindingsPath())
        ? fs.readFileSync(keybindingsPath(), "utf-8")
        : null,
      flag: readFlag(),
    };
  }

  /** The hatch, open: the setting that flips which flow is allowed to act. */
  const HATCH_OFF: Record<string, unknown> = { suppressNativePaste: false };
  const hatchOn: Array<Record<string, unknown>> = [{}, { suppressNativePaste: true }];

  it("hatch open, fresh profile: the session is silent end to end — no Created, no Restored, no file, still armed", async () => {
    const s = await runSession(HATCH_OFF);

    expect(s.offered).toBe(false);
    expect(s.restore.kind).toBe("missing");
    expect(s.file).toBe(null);
    expect(s.flag).toBe(false);
    // Before #133 this frame held exactly two notices: the offer wrote the file
    // and said "Created …", the restore emptied it and said "Restored …". The
    // hatch-off install never sees either one now.
    expect(s.notices).toEqual([]);
  });

  it("hatch open with our artefact already on disk: only the restore acts, and the offer never speaks about that file", async () => {
    const s = await runSession(HATCH_OFF, { existingFile: ARTEFACT_POST_123 });

    expect(s.offered).toBe(false);
    expect(s.restore.kind).toBe("restored");
    expect(s.file).toBe("{}");
    expect(s.notices.filter((t) => CREATED_TEXT.test(t))).toEqual([]);
    expect(s.notices.filter((t) => RESTORED_TEXT.test(t))).toHaveLength(1);
    // The offer stayed armed: the file it would have offered to create is the
    // one the restore just handed back to pi.
    expect(s.flag).toBe(false);
  });

  it.each([
    ["the default (key absent)", {}],
    ["hatch closed (suppressNativePaste: true)", { suppressNativePaste: true }],
  ] as Array<[string, Record<string, unknown>]>)(
    "%s: only the offer acts, and the restore reports suppressed",
    async (_label, ns) => {
      const s = await runSession(ns);

      expect(s.offered).toBe(false); // base-shape ctx: no reload was available
      expect(s.restore.kind).toBe("suppressed");
      expect(s.file).toBe(SNIPPET); // the offer wrote the artefact …
      expect(s.flag).toBe(true); // … and the accept spent the flag
      expect(s.notices.filter((t) => RESTORED_TEXT.test(t))).toEqual([]);
      expect(s.notices.filter((t) => CREATED_TEXT.test(t))).toHaveLength(1);
    },
  );

  it("the sequenced pair across a settings change is the hatch, not the breach: Created in session one, Restored in session two", async () => {
    // Greptile's read of the invariant, answered with a test rather than an
    // argument. Session one, the default setting: the offer fires, writes the
    // artefact and says "Created …".
    const first = await runSession({});
    expect(first.file).toBe(SNIPPET);
    expect(first.notices.filter((t) => CREATED_TEXT.test(t))).toHaveLength(1);
    expect(first.notices.filter((t) => RESTORED_TEXT.test(t))).toEqual([]);

    // Session two on the SAME profile, with the user having closed the hatch: the
    // restore gives the key back and says "Restored …". So one install does carry
    // both texts — in order, one per session, each describing what that session
    // did. That is the reversible hatch from ADR 0030, and the mutual exclusion
    // above must not be read to forbid it: it binds a single configuration, and
    // this case has two.
    clearNoticeGuard();
    const second = await runSession(HATCH_OFF);
    expect(second.restore.kind).toBe("restored");
    expect(second.file).toBe("{}");
    expect(second.notices.filter((t) => RESTORED_TEXT.test(t))).toHaveLength(1);
    // The offer stayed out of session two on both counts: the flag was spent in
    // session one, and the hatch is open.
    expect(second.asked).toBe(false);
    expect(second.notices.filter((t) => CREATED_TEXT.test(t))).toEqual([]);
  });

  it("no configuration makes both flows act on one file", async () => {
    for (const ns of [HATCH_OFF, ...hatchOn, { enabled: true, suppressNativePaste: false }]) {
      cleanupArtifacts();
      clearNoticeGuard();
      const s = await runSession(ns);
      const label = JSON.stringify(ns);

      // The notices: never two verdicts about one file.
      const created = s.notices.some((t) => CREATED_TEXT.test(t));
      const restored = s.notices.some((t) => RESTORED_TEXT.test(t));
      expect(created && restored, `${label}: both notices: ${JSON.stringify(s.notices)}`).toBe(
        false,
      );

      // The same exclusivity one level down, on the flows themselves: the
      // predicate that admits one must exclude the other.
      if (suiteMayClaimPasteKey()) {
        // The offer's configuration — the restore must have touched nothing.
        expect(s.restore.kind, label).toBe("suppressed");
      } else {
        // The restore's configuration — the offer must not have asked about,
        // written, or announced the file the restore is entitled to rewrite.
        expect(s.asked, label).toBe(false);
        expect(created, label).toBe(false);
      }
    }
  });
});

