import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { diag } from "./log.js";

// A scratch directory per test file; `diag` is pointed at files inside it.
const SANDBOX = mkdtempSync(join(tmpdir(), `archimedes-log-${randomUUID()}-`));

const ENV = "PI_ARCHIMEDES_LOG";
const previous = process.env[ENV];

afterEach(() => {
  if (previous === undefined) delete process.env[ENV];
  else process.env[ENV] = previous;
});

describe("diag — the diagnostics sink", () => {
  it("writes nothing at all when the env var is unset", () => {
    // Unset is the default state of every real session, so this is the
    // "logging costs nothing and touches no disk" guarantee. A file from an
    // earlier enabled run proves the sink had somewhere to go; it must not
    // gain a line now.
    const target = join(SANDBOX, "unset.log");
    process.env[ENV] = target;
    diag("core", "enabled");

    delete process.env[ENV];
    expect(() => diag("core", "a message")).not.toThrow();

    expect(readFileSync(target, "utf8").trimEnd().split("\n")).toEqual([
      expect.stringContaining("[core] enabled"),
    ]);
  });

  it("treats an empty value as off, not as the file named ''", () => {
    // `PI_ARCHIMEDES_LOG=` is how an operator switches logging back off in a
    // shell, and appendFileSync("") would resolve against the cwd — so the
    // empty string must short-circuit rather than write somewhere surprising.
    const target = join(SANDBOX, "blank.log");
    process.env[ENV] = target;
    diag("core", "before");

    process.env[ENV] = "";
    expect(() => diag("core", "after")).not.toThrow();

    expect(readFileSync(target, "utf8").trimEnd().split("\n")).toEqual([
      expect.stringContaining("[core] before"),
    ]);
  });

  it("appends one line carrying an ISO-8601 timestamp, the scope and the message", () => {
    const target = join(SANDBOX, "single.log");
    process.env[ENV] = target;

    const before = new Date();
    diag("session-name", "title request failed");
    const after = new Date();

    const text = readFileSync(target, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(1);

    const match = /^\[(.+?)\] \[(.+?)\] (.*)$/.exec(lines[0]!);
    expect(match, `unexpected line shape: ${lines[0]}`).not.toBeNull();
    const [, stamp, scope, message] = match!;
    expect(scope).toBe("session-name");
    expect(message).toBe("title request failed");
    // ISO-8601 with an offset — parseable, and inside the call window.
    const at = new Date(stamp!);
    expect(Number.isNaN(at.getTime())).toBe(false);
    expect(at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(at.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    expect(stamp!).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2})$/);
  });

  it("appends across calls instead of truncating the file", () => {
    const target = join(SANDBOX, "append.log");
    process.env[ENV] = target;

    diag("bus", "first");
    diag("footer", "second");

    const lines = readFileSync(target, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[bus] first");
    expect(lines[1]).toContain("[footer] second");
  });

  it("re-reads the env var on every call (a later export takes effect)", () => {
    // pi sets nothing itself: the operator exports PI_ARCHIMEDES_LOG in a shell,
    // but a test/tool that sets it mid-run must also be honoured — reading it
    // once at module load would freeze the no-op path.
    const target = join(SANDBOX, "late.log");
    delete process.env[ENV];
    diag("core", "dropped");
    expect(existsSync(target)).toBe(false);

    process.env[ENV] = target;
    diag("core", "captured");
    expect(readFileSync(target, "utf8")).toContain("[core] captured");
  });

  it("never throws when the target cannot be written, and creates no directories", () => {
    // A path under a directory that does not exist: appendFileSync fails with
    // ENOENT. Logging must swallow it — and must not "helpfully" mkdir.
    const missingDir = join(SANDBOX, "missing-dir");
    process.env[ENV] = join(missingDir, "log.txt");

    expect(() => diag("core", "unreachable")).not.toThrow();
    expect(existsSync(missingDir)).toBe(false);
  });

  it("never throws when the target is a directory", () => {
    const dir = join(SANDBOX, "a-directory");
    mkdirSync(dir, { recursive: true });
    process.env[ENV] = dir;

    expect(() => diag("core", "EISDIR")).not.toThrow();
  });

  it("tolerates a message containing newlines without throwing", () => {
    // Callers format error objects; a stack would arrive here multi-line. The
    // sink keeps it verbatim rather than trying to sanitise.
    const target = join(SANDBOX, "multiline.log");
    process.env[ENV] = target;

    expect(() => diag("core", "line one\nline two")).not.toThrow();
    expect(readFileSync(target, "utf8")).toContain("[core] line one\nline two");
  });
});

// ── describeError — what a swallowed error looks like in the log ───────────
//
// `console.error(scope, err)` used to print the stack. Routing a swallowed
// error through a formatter that keeps only `err.message` would leave the log
// with a message and no origin, and for these call sites the log is the ONLY
// record: the write smears a fullscreen frame, and a subagent child discards
// it. So the formatter keeps the whole `Error`, stack included. (The user-facing
// surface keeps taking the message alone — see `describeError`'s doc.)

import { describeError } from "./log.js";

describe("describeError", () => {
  function exploded(): Error {
    // A named frame on purpose: the assertion below wants an origin, not just
    // a message — that is the whole reason the stack is kept.
    return new Error("listener exploded");
  }

  it("keeps the stack, which is the only source location a swallowed error ever gets", () => {
    const text = describeError(exploded());
    expect(text).toContain("listener exploded");
    expect(text).toMatch(/\n\s+at\s+\S/);
    expect(text).toContain("exploded");
  });

  it("falls back to the message when the error carries no stack", () => {
    const err = new Error("no stack here");
    delete (err as { stack?: string }).stack;
    expect(describeError(err)).toBe("no stack here");
  });

  it("stringifies anything that is not an Error", () => {
    expect(describeError("a string")).toBe("a string");
    expect(describeError({ code: 42 })).toBe("[object Object]");
    expect(describeError(undefined)).toBe("undefined");
  });
});
