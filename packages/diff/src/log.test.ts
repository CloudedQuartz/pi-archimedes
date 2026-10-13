import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { diag } from "./log.js";

// Same contract as `@pi-archimedes/core/log` — see `packages/core/src/log.test.ts`.
// Kept in sync deliberately: this package is standalone, so the sink is a
// sibling implementation, and a contract test is what keeps them siblings
// rather than drift.
const SANDBOX = mkdtempSync(join(tmpdir(), `archimedes-diff-log-${randomUUID()}-`));
const ENV = "PI_ARCHIMEDES_LOG";
const previous = process.env[ENV];

afterEach(() => {
  if (previous === undefined) delete process.env[ENV];
  else process.env[ENV] = previous;
});

describe("diff diag — the diagnostics sink", () => {
  it("writes nothing when the env var is unset", () => {
    const target = join(SANDBOX, "unset.log");
    process.env[ENV] = target;
    diag("diff", "enabled");

    delete process.env[ENV];
    expect(() => diag("diff", "a message")).not.toThrow();
    expect(readFileSync(target, "utf8").trimEnd().split("\n")).toHaveLength(1);
  });

  it("appends a timestamped, scoped line", () => {
    const target = join(SANDBOX, "write.log");
    process.env[ENV] = target;

    diag("diff", "SDK not available");

    const lines = readFileSync(target, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const match = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\] \[(.+?)\] (.*)$/.exec(lines[0]!);
    expect(match, `unexpected line shape: ${lines[0]}`).not.toBeNull();
    expect(match![2]).toBe("diff");
    expect(match![3]).toBe("SDK not available");
  });

  it("appends across calls", () => {
    const target = join(SANDBOX, "append.log");
    process.env[ENV] = target;

    diag("diff", "one");
    diag("diff", "two");

    expect(readFileSync(target, "utf8").trimEnd().split("\n")).toHaveLength(2);
  });

  it("never throws on an unwritable target, and creates no directories", () => {
    const missing = join(SANDBOX, "nope", "log.txt");
    process.env[ENV] = missing;
    expect(() => diag("diff", "ENOENT")).not.toThrow();
    expect(existsSync(join(SANDBOX, "nope"))).toBe(false);

    const dir = join(SANDBOX, "directory");
    mkdirSync(dir, { recursive: true });
    process.env[ENV] = dir;
    expect(() => diag("diff", "EISDIR")).not.toThrow();
  });
});
