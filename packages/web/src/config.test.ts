import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Where web's config comes from ───────────────────────────────────────────
//
// `loadConfig()` used to read `~/.pi/agent/settings.json` by hand, which cannot
// see project-scoped settings (`<cwd>/.pi/settings.json`) or in-process
// overrides — so a key configured only in the project file was invisible to the
// search tools while `pi.getSettings()` could see it. The handle is threaded in
// from the tool/command call sites, which have it; `getSettings()` lives on
// ExtensionAPI, not on ExtensionContext, so it has to be `pi` and not `ctx`.

const { tempDir, fs, join, randomUUID } = vi.hoisted(() => {
  const fs = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  const { randomUUID } = require("node:crypto");
  const dir = join(tmpdir(), `web-config-test-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return { tempDir: dir, fs, join, tmpdir, randomUUID };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => tempDir,
}));

const { loadConfig } = await import("./config.js");

const settingsPath = () => join(tempDir, "settings.json");

/** The env vars loadConfig consults first — cleared so tests are deterministic. */
const ENV_KEYS = [
  "BRAVE_API_KEY",
  "TAVILY_API_KEY",
  "OPENAI_API_KEY",
  "PERPLEXITY_API_KEY",
  "SEARXNG_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  try {
    fs.unlinkSync(settingsPath());
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  try {
    fs.unlinkSync(settingsPath());
  } catch {
    /* ignore */
  }
});

describe("loadConfig with an ExtensionAPI handle", () => {
  it("sees a key that exists only in the effective settings (project scope)", () => {
    // The global file says nothing about web at all; the value lives in the
    // project's `.pi/settings.json`, which only pi's merged view contains.
    fs.writeFileSync(settingsPath(), JSON.stringify({ theme: "dark" }), "utf-8");
    const pi = {
      getSettings: () => ({ "archimedes.web": { braveApiKey: "project-only-key" } }),
    };
    expect(loadConfig(pi as never).braveApiKey).toBe("project-only-key");
  });

  it("prefers the effective settings over the file when both carry a value", () => {
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ "archimedes.web": { braveApiKey: "global-key", defaultProvider: "brave" } }),
      "utf-8",
    );
    const pi = {
      getSettings: () => ({ "archimedes.web": { braveApiKey: "effective-key" } }),
    };
    const config = loadConfig(pi as never);
    expect(config.braveApiKey).toBe("effective-key");
    // Whatever the effective object does not carry is simply absent: it is the
    // effective view, not a merge with our private file read.
    expect(config.defaultProvider).toBeUndefined();
  });

  it("carries the rest of the namespace through (provider selection sees project config)", () => {
    const pi = {
      getSettings: () => ({
        "archimedes.web": { defaultProvider: "tavily", tavilyApiKey: "tvly-project" },
      }),
    };
    const config = loadConfig(pi as never);
    expect(config.defaultProvider).toBe("tavily");
    expect(config.tavilyApiKey).toBe("tvly-project");
  });

  it("an env var still outranks both sources (unchanged precedence)", () => {
    const pi = {
      getSettings: () => ({ "archimedes.web": { braveApiKey: "effective-key" } }),
    };
    process.env.BRAVE_API_KEY = "env-key";
    expect(loadConfig(pi as never).braveApiKey).toBe("env-key");
  });
});

describe("loadConfig without a usable handle (the fallback that keeps core's floor)", () => {
  it("reads settings.json when no handle is passed", () => {
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ "archimedes.web": { braveApiKey: "file-key" } }),
      "utf-8",
    );
    expect(loadConfig().braveApiKey).toBe("file-key");
  });

  it("reads settings.json when the host predates getSettings()", () => {
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ "archimedes.web": { searxngUrl: "http://localhost:8888" } }),
      "utf-8",
    );
    expect(loadConfig({} as never).searxngUrl).toBe("http://localhost:8888");
  });

  it("reads settings.json when getSettings() throws", () => {
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ "archimedes.web": { braveApiKey: "file-key" } }),
      "utf-8",
    );
    const pi = {
      getSettings: () => {
        throw new Error("Extension is not active");
      },
    };
    expect(loadConfig(pi as never).braveApiKey).toBe("file-key");
  });

  it("yields an empty config when there is nothing anywhere, and never writes", () => {
    expect(loadConfig()).toEqual({});
    expect(fs.existsSync(settingsPath())).toBe(false);
  });
});
