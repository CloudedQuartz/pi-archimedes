import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── What this pins ──────────────────────────────────────────────────────────
//
// Two cancel paths, both of which pi 1.x changed underneath us:
//
// 1. `before_agent_start`. pi 1.2.0 made the event a union on `messageType`
//    ("user" for a submitted prompt, "custom" for `pi.sendMessage(…,
//    { triggerTurn: true })` fired while idle) and fires it for both. A run
//    that is *starting* makes a pending "Task complete — waiting for input"
//    stale either way, so the handler stays unconditional and this file pins
//    both members of the union.
//
// 2. Terminal input. The cancel used to be "any byte that reaches the
//    listener". pi now puts far more protocol traffic through the terminal —
//    and `TuiBase.handleTerminalInput()` (pi-tui `dist/tui.js`) forwards some
//    of it to extension listeners and swallows the rest:
//      - OSC 10/11/4 colour replies and the colour-scheme report are consumed
//        *before* listeners run, so a palette reply can never reach notify;
//      - a primary-device-attributes reply (`ESC [ ? … c`) is consumed before
//        listeners only while a colour query is pending, so a late or
//        unsolicited one *is* forwarded;
//      - a cell-size report (`ESC [ 6 ; h ; w t`) is consumed only *after*
//        listeners, so it always reaches them.
//    So a reply is not a keystroke: only input pi-tui decodes to a key
//    (`parseKey`) cancels.

vi.mock("@pi-archimedes/core/settings-io", () => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

import { loadConfig } from "@pi-archimedes/core/settings-io";
import { DEFAULT_NOTIFY_CONFIG, registerNotify } from "./index.js";

const DELAY_MS = 1_000;

/** The OSC 777 fallback payload `notify()` writes for each trigger. */
const TASK_COMPLETE_OSC = "\x1b]777;notify;Pi;Task complete — waiting for input\x07";
const QUESTION_OSC = "\x1b]777;notify;Pi;A question needs your answer\x07";

interface Harness {
  /** Fire a pi event at the handlers `registerNotify` subscribed. */
  emit(event: string, payload?: unknown): void;
  /** Feed one chunk of raw terminal input to the registered listener. */
  terminalInput(data: string): void;
  /** Notification payloads written to stderr so far. */
  written(): string[];
  /** Let the pending notification's delay elapse (and then some). */
  waitPastDelay(): void;
}

function setup(): Harness {
  vi.mocked(loadConfig).mockReturnValue({ ...DEFAULT_NOTIFY_CONFIG, delayMs: DELAY_MS });
  // Fall through to the OSC 777 dispatcher: no terminal-specific branch.
  vi.stubEnv("WT_SESSION", "");
  vi.stubEnv("KITTY_WINDOW_ID", "");
  vi.stubEnv("TERM_PROGRAM", "");
  vi.stubEnv("ITERM_SESSION_ID", "");
  vi.stubEnv("TMUX", "");
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  const handlers: Record<string, Array<(payload: unknown, ctx: unknown) => void>> = {};
  let terminalListener: ((data: string) => unknown) | undefined;

  const pi = {
    on: vi.fn((event: string, handler: (payload: unknown, ctx: unknown) => void) => {
      (handlers[event] ??= []).push(handler);
    }),
  } as unknown as Parameters<typeof registerNotify>[0];

  registerNotify(pi);

  const ctx = {
    hasUI: true,
    ui: {
      onTerminalInput: vi.fn((handler: (data: string) => unknown) => {
        terminalListener = handler;
        return () => {
          terminalListener = undefined;
        };
      }),
    },
  };
  for (const handler of handlers["session_start"] ?? []) handler(undefined, ctx);

  return {
    emit(event, payload) {
      for (const handler of handlers[event] ?? []) handler(payload ?? { type: event }, ctx);
    },
    terminalInput(data) {
      terminalListener?.(data);
    },
    written() {
      return write.mock.calls.map((call) => String(call[0]));
    },
    waitPastDelay() {
      vi.advanceTimersByTime(DELAY_MS * 2);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("notify cancel-on-input under pi 1.x terminal traffic", () => {
  it("does not cancel on a forwarded primary-device-attributes reply", () => {
    const harness = setup();

    harness.emit("agent_settled");
    // The DA1 reply shape pi-tui forwards to extension listeners.
    harness.terminalInput("\x1b[?62;1;9c");
    harness.waitPastDelay();

    expect(harness.written()).toContain(TASK_COMPLETE_OSC);
  });

  it("does not cancel on a cell-size report", () => {
    const harness = setup();

    harness.emit("agent_settled");
    // ESC [ 6 ; height ; width t — consumed by pi-tui only after listeners.
    harness.terminalInput("\x1b[6;24;80t");
    harness.waitPastDelay();

    expect(harness.written()).toContain(TASK_COMPLETE_OSC);
  });

  it("does not cancel on a colour reply or a colour-scheme report", () => {
    const harness = setup();

    harness.emit("agent_settled");
    harness.terminalInput("\x1b]10;rgb:ffff/ffff/ffff\x07");
    harness.terminalInput("\x1b]11;rgb:0000/0000/0000\x1b\\");
    harness.terminalInput("\x1b]4;1;rgb:ff00/0000/0000\x1b\\");
    harness.terminalInput("\x1b[?u"); // the Kitty keyboard-protocol query reply
    harness.waitPastDelay();

    expect(harness.written()).toContain(TASK_COMPLETE_OSC);
  });

  it("does not cancel on focus, mouse or bracketed-paste traffic", () => {
    const harness = setup();

    harness.emit("agent_settled");
    // None of these is typing, and pi-tui passes all of them to listeners: focus
    // in/out, an SGR mouse press, and the bracketed-paste marker.
    harness.terminalInput("\x1b[I");
    harness.terminalInput("\x1b[O");
    harness.terminalInput("\x1b[<0;10;10M");
    harness.terminalInput("\x1b[200~");
    harness.waitPastDelay();

    expect(harness.written()).toContain(TASK_COMPLETE_OSC);
  });

  it("cancels on a plain keystroke", () => {
    const harness = setup();

    harness.emit("agent_settled");
    harness.terminalInput("a");
    harness.waitPastDelay();

    expect(harness.written()).toEqual([]);
  });

  // What `parseKey()` names is not the whole set of keystrokes. pi-tui's
  // `StdinBuffer` splits batched input into single sequences before listeners
  // run, so a typed character reaches us on its own — but the decoder only
  // resolves ASCII bytes and escape sequences. A character outside ASCII
  // arrives as itself (`é` is the two bytes C3 A9 on any terminal that did not
  // take the Kitty keyboard protocol, which is Terminal.app, VTE, xterm and
  // tmux), `parseKey()` has no name for it, and the keystroke would be missed:
  // the alert fires at someone sitting at the keyboard, typing an accented
  // letter. Under Kitty the same key arrives as CSI-u and does decode, so this
  // is exactly the legacy-terminal path.
  it("cancels on a typed character pi-tui's decoder does not name", () => {
    const harness = setup();

    harness.emit("agent_settled");
    harness.terminalInput("é"); // one key press, no Kitty protocol
    harness.waitPastDelay();

    expect(harness.written()).toEqual([]);
  });

  it("cancels on a typed CJK character", () => {
    const harness = setup();

    harness.emit("agent_settled");
    harness.terminalInput("中");
    harness.waitPastDelay();

    expect(harness.written()).toEqual([]);
  });

  it("does not cancel on the ASCII tail of a reply split across reads", () => {
    const harness = setup();

    // A reply whose ESC header pi-tui consumed can leave a bare tail (digits
    // and semicolons) to be flushed as input. It is printable ASCII with no
    // escape byte, so "is it text?" is the wrong question to ask — only a
    // character that could only have come from a key press cancels.
    harness.emit("agent_settled");
    harness.terminalInput("62;1;9c");
    harness.waitPastDelay();

    expect(harness.written()).toContain(TASK_COMPLETE_OSC);
  });

  it("cancels on a Kitty-protocol key press and on its release", () => {
    const harness = setup();

    harness.emit("agent_settled");
    harness.terminalInput("\x1b[97:1u"); // CSI-u press for 'a'
    harness.waitPastDelay();
    expect(harness.written()).toEqual([]);

    harness.emit("agent_settled");
    harness.terminalInput("\x1b[97:3u"); // the matching release
    harness.waitPastDelay();
    expect(harness.written()).toEqual([]);
  });

  it("fires when the terminal stays quiet", () => {
    const harness = setup();

    harness.emit("agent_settled");
    harness.waitPastDelay();

    expect(harness.written()).toEqual([TASK_COMPLETE_OSC]);
  });
});

describe("notify cancel-on-run-start (pi 1.2.0 before_agent_start union)", () => {
  const base = {
    type: "before_agent_start",
    systemPrompt: "prompt",
    systemPromptOptions: {},
  };

  it("cancels a pending notification for a user-prompt run", () => {
    const harness = setup();

    harness.emit("agent_settled");
    harness.emit("before_agent_start", { ...base, messageType: "user", prompt: "hi" });
    harness.waitPastDelay();

    expect(harness.written()).toEqual([]);
  });

  it("cancels a pending notification for an idle custom message with triggerTurn", () => {
    const harness = setup();

    harness.emit("agent_settled");
    harness.emit("before_agent_start", {
      ...base,
      messageType: "custom",
      message: { role: "custom", customType: "note", content: "hello", display: true },
    });
    harness.waitPastDelay();

    expect(harness.written()).toEqual([]);
  });

  it("cancels on agent_start as before", () => {
    const harness = setup();

    harness.emit("agent_settled");
    harness.emit("agent_start");
    harness.waitPastDelay();

    expect(harness.written()).toEqual([]);
  });
});

describe("notify ui_prompt_end scoping (ADR 0013)", () => {
  it("cancels a pending question notification when the prompt closes", () => {
    const harness = setup();

    harness.emit("ui_prompt_start");
    harness.emit("ui_prompt_end");
    harness.waitPastDelay();

    expect(harness.written()).toEqual([]);
  });

  it("leaves a pending task-complete notification alone", () => {
    const harness = setup();

    harness.emit("agent_settled");
    harness.emit("ui_prompt_end");
    harness.waitPastDelay();

    expect(harness.written()).toEqual([TASK_COMPLETE_OSC]);
    expect(harness.written()).not.toContain(QUESTION_OSC);
  });
});
