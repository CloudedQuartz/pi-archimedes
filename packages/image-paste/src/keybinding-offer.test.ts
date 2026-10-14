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
  CREATED_NOTIFY,
  CREATED_RELOAD_HINT,
  RESTORED_NOTIFY,
  RESTORED_RELOAD_HINT,
} = await import("./keybinding-offer.js");

import type {
  NativePasteRestoreOutcome,
  RestoreNativePasteStatus,
} from "./keybinding-offer.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const NAMESPACE = "archimedes.imagePaste";
/** The exact snippet from packages/image-paste/README.md → "Paste shortcuts". */
const SNIPPET =
  '{ "$schema": "https://pi.dev/schemas/keybindings.schema.json", "app.clipboard.pasteImage": [] }';
/** What a concurrent process writes into keybindings.json at rename time. */
const CONCURRENT_CONTENT = '{ "app.clipboard.pasteImage": ["ctrl+v"] }';


const settingsPath = (): string => join(tempDir, "settings.json");
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
  // handler receives: no command-only methods like `reload` (Pi 0.85.1
  // attaches reload to the command context only), so tests stay honest about
  // what the real ctx provides. The auto-reload branch is covered separately
  // by passing { withReload: true }, which simulates a future Pi version
  // that puts reload() on the event ctx.
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
    expect(untouched.manualEdit).toContain(UNBIND_KEY);
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
