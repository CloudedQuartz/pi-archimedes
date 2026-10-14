import { describe, it, expect, vi, afterEach } from "vitest";
import * as net from "node:net";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { Events } from "@pi-archimedes/core/events";
import type { AgentConfig } from "./agents.js";

// The child's argv is a contract with the `pi` CLI, and CLI strings are invisible
// to tsc — these tests are the only guard on what the child actually receives.
// `node:child_process` is mocked so no real pi process is spawned.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { startAskSocketServer, spawnSubagent } = await import("./spawn.js");

// startAskSocketServer is tested directly (not via spawnSubagent, which would
// spawn a real `pi` process). Each test gets its OWN bus stand-in — the host
// handle is passed in rather than reached for, so there is no process-wide
// singleton to leak between tests any more.

/** Stands in for the host's `createEventBus()` (same emit/on/unsubscribe shape). */
function fakeBus() {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown): void {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void): () => void {
      const subs = listeners.get(channel) ?? [];
      subs.push(handler);
      listeners.set(channel, subs);
      return () => {
        const current = listeners.get(channel) ?? [];
        const idx = current.indexOf(handler);
        if (idx !== -1) current.splice(idx, 1);
      };
    },
  };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).forEach((c) => c());
});

function track(fn: () => void): void {
  cleanups.push(fn);
}

// ── spawnSubagent argv ──────────────────────────────────────────────────────

/** A minimal spawn target: the argv assertions never touch the process. */
function fakeSpawnResult(): ChildProcess {
  const child = new EventEmitter() as ChildProcess & { pid: number };
  Object.assign(child, { pid: 4242, killed: false, kill: () => true });
  return child;
}

/** Run spawnSubagent against the mocked spawn and return the argv it received. */
function argvFor(agent: Partial<AgentConfig> | undefined): string[] {
  spawnMock.mockReset();
  spawnMock.mockReturnValue(fakeSpawnResult());
  const events = fakeBus();
  const socket = startAskSocketServer(agent?.name ?? "general", events);
  track(socket.cleanup);
  spawnSubagent({
    task: "do the thing",
    model: undefined,
    activeModel: undefined,
    cwd: "/tmp",
    signal: undefined,
    events,
    agent: agent
      ? { name: agent.name ?? "general", description: "d", systemPrompt: "p", source: "user", filePath: "/tmp/a.md", ...agent }
      : undefined,
  });
  const call = spawnMock.mock.calls[0] as [string, string[]] | undefined;
  if (!call) throw new Error("spawn was not called");
  return call[1];
}

describe("spawnSubagent tool allowlist (closed set, ADR 0028)", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("a non-empty tools allowlist also passes --no-mcp, so the list stays closed", () => {
    const argv = argvFor({ tools: ["read", "bash"] });
    expect(argv).toContain("--tools");
    expect(argv[argv.indexOf("--tools") + 1]).toBe("read,bash");
    expect(argv).toContain("--no-mcp");
  });

  it("mcp: true is the only way the allowlist stops being closed", () => {
    const argv = argvFor({ tools: ["read", "bash"], mcp: true });
    expect(argv).toContain("--tools");
    expect(argv).not.toContain("--no-mcp");
  });

  it("an empty tools list changes neither the tool set nor MCP", () => {
    const argv = argvFor({ tools: [] });
    expect(argv).not.toContain("--tools");
    expect(argv).not.toContain("--no-mcp");
  });

  it("mcp: true without an allowlist passes neither flag (nothing to close)", () => {
    const argv = argvFor({ mcp: true });
    expect(argv).not.toContain("--tools");
    expect(argv).not.toContain("--no-mcp");
  });

  it("the recursion guard survives the closed allowlist", () => {
    const argv = argvFor({ tools: ["read"] });
    const excludeIdx = argv.indexOf("--exclude-tools");
    expect(excludeIdx).toBeGreaterThan(-1);
    expect(argv[excludeIdx + 1]).toContain("subagent");
  });

  it("an agent with no config at all gets neither --tools nor --no-mcp", () => {
    const argv = argvFor(undefined);
    expect(argv).not.toContain("--tools");
    expect(argv).not.toContain("--no-mcp");
    expect(argv).toContain("--exclude-tools");
  });
});

function connectClient(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath, () => resolve(client));
    client.on("error", (err) => reject(err));
  });
}

function writeAskRequest(client: net.Socket, requestId: string, toolCallId?: string): void {
  client.write(
    JSON.stringify({
      type: "ask_request",
      requestId,
      toolCallId,
      questions: [{ id: "q1", question: "Which?", options: [{ label: "A" }] }],
    }) + "\n",
  );
}

describe("startAskSocketServer", () => {
  it("a child ask_request carrying toolCallId → the bus ASK_REQUEST carries the same toolCallId", async () => {
    const events = fakeBus();
    const { socketPath, cleanup } = startAskSocketServer("test-agent", events);
    track(cleanup);
    await new Promise((r) => setTimeout(r, 50)); // let the server listen

    const requests: unknown[] = [];
    events.on(Events.ASK_REQUEST, (p) => requests.push(p));

    const client = await connectClient(socketPath);
    writeAskRequest(client, "req-1", "tool-9");

    await vi.waitFor(() => expect(requests.length).toBe(1));
    const req = requests[0] as { source: string; requestId: string; toolCallId?: string; questions: unknown[] };
    expect(req.source).toBe("subagent:test-agent");
    expect(req.requestId).toBe("req-1");
    expect(req.toolCallId).toBe("tool-9");
    expect(req.questions).toEqual([{ id: "q1", question: "Which?", options: [{ label: "A" }] }]);

    // Deliver the response (drains pending) before closing so no ASK_CANCEL is
    // signalled for a request that was already answered.
    events.emit(Events.ASK_RESPONSE, {
      requestId: "req-1",
      cancelled: false,
      results: [{ id: "q1", selectedOptions: ["A"] }],
    });
    await new Promise((r) => setTimeout(r, 50));
    client.destroy();
    await new Promise((r) => setTimeout(r, 50)); // close handler ran (no-op)
  });

  /**
   * The ask round-trip, over the handle: the child's socket request goes out on
   * the bus, the answer comes back on the SAME handle, and the server writes it
   * back down the socket. Before this migration both halves went through the
   * suite's `globalThis` bus; the transport changed, the socket contract did not.
   */
  it("round-trip: ask_request in → ASK_REQUEST out on the handle → ASK_RESPONSE in → ask_response back down the socket", async () => {
    const events = fakeBus();
    const { socketPath, cleanup } = startAskSocketServer("test-agent", events);
    track(cleanup);
    await new Promise((r) => setTimeout(r, 50));

    const frames: unknown[] = [];
    const requests: unknown[] = [];
    events.on(Events.ASK_REQUEST, (p) => requests.push(p));

    const client = await connectClient(socketPath);
    client.on("data", (chunk) => {
      for (const line of chunk.toString("utf-8").split("\n")) {
        if (line.trim()) frames.push(JSON.parse(line));
      }
    });

    writeAskRequest(client, "req-rt", "tool-rt");
    await vi.waitFor(() => expect(requests.length).toBe(1));

    events.emit(Events.ASK_RESPONSE, {
      requestId: "req-rt",
      cancelled: false,
      results: [{ id: "q1", selectedOptions: ["A"], customInput: undefined }],
    });

    await vi.waitFor(() => expect(frames.length).toBe(1));
    expect(frames[0]).toEqual({
      type: "ask_response",
      requestId: "req-rt",
      cancelled: false,
      results: [{ id: "q1", selectedOptions: ["A"] }],
    });

    client.destroy();
    await new Promise((r) => setTimeout(r, 50));
  });

  it("closing the child socket → ASK_CANCEL for the pending requestId + source", async () => {
    const events = fakeBus();
    const { socketPath, cleanup } = startAskSocketServer("test-agent", events);
    track(cleanup);
    await new Promise((r) => setTimeout(r, 50)); // let the server listen

    const cancels: unknown[] = [];
    events.on(Events.ASK_CANCEL, (p) => cancels.push(p));
    const requests: unknown[] = [];
    events.on(Events.ASK_REQUEST, (p) => requests.push(p));

    const client = await connectClient(socketPath);
    writeAskRequest(client, "req-2");

    // Wait until the request is registered (pending) before closing
    await vi.waitFor(() => expect(requests.length).toBe(1));
    client.destroy();

    await vi.waitFor(() => expect(cancels.length).toBe(1));
    expect(cancels[0]).toEqual({ requestId: "req-2", source: "subagent:test-agent" });
  });

  it("no ASK_CANCEL once the response has already been delivered (pending drained)", async () => {
    const events = fakeBus();
    const { socketPath, cleanup } = startAskSocketServer("test-agent", events);
    track(cleanup);
    await new Promise((r) => setTimeout(r, 50)); // let the server listen

    const cancels: unknown[] = [];
    events.on(Events.ASK_CANCEL, (p) => cancels.push(p));
    const requests: unknown[] = [];
    events.on(Events.ASK_REQUEST, (p) => requests.push(p));

    const client = await connectClient(socketPath);
    writeAskRequest(client, "req-3");
    await vi.waitFor(() => expect(requests.length).toBe(1));

    // Deliver the response (drains pending) before the socket closes
    events.emit(Events.ASK_RESPONSE, {
      requestId: "req-3",
      cancelled: false,
      results: [{ id: "q1", selectedOptions: ["A"] }],
    });
    await new Promise((r) => setTimeout(r, 50));
    client.destroy();
    await new Promise((r) => setTimeout(r, 50)); // close handler ran

    expect(cancels.length).toBe(0);
  });
});

// ── thinking level (pi warns and drops; we must not feed it one) ───────────

describe("spawnSubagent thinking level", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("passes a level pi accepts through to --thinking", () => {
    const argv = argvFor({ thinking: "xhigh" });
    const at = argv.indexOf("--thinking");
    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe("xhigh");
  });

  it("does not pass a level pi would warn about and drop", () => {
    // `--thinking ultra` is a `warning` diagnostic and a dropped flag in pi's
    // own parser (dist/cli/args.js), so the child ran at the default thinking
    // level while its config said otherwise — and in `--mode json` that warning
    // is stderr, which the stream reader only shows for a failed run. Passing
    // nothing is the same outcome, said out loud at dispatch instead.
    const argv = argvFor({ thinking: "ultra" });
    expect(argv).not.toContain("--thinking");
  });

  it("is case-sensitive, exactly like pi's list", () => {
    expect(argvFor({ thinking: "Medium" })).not.toContain("--thinking");
  });

  it("passes no --thinking when the config sets none", () => {
    expect(argvFor({})).not.toContain("--thinking");
  });
});
