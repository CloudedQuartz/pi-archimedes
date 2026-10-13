import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import { parseKey } from "@earendil-works/pi-tui";
import { loadConfig, saveConfig } from "@pi-archimedes/core/settings-io";
import { execFile } from "node:child_process";

// ── Trigger constants ────────────────────────────────────────────────────────

const TRIGGER = {
  AGENT_SETTLED: "agent_settled",
  UI_PROMPT: "ui_prompt",
} as const;
type TriggerType = (typeof TRIGGER)[keyof typeof TRIGGER];

// ── Config ──────────────────────────────────────────────────────────────────

export interface NotifyConfig {
  // suite-managed by meta's plugin gate (archimedes.notify.enabled — see ADR 0012); notify never reads this
  enabled?: boolean;
  notifyOnAgentEnd: boolean;
  notifyOnQuestion: boolean;
  delayMs: number;
}

export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  notifyOnAgentEnd: true,
  notifyOnQuestion: true,
  delayMs: 30_000,
};

const NAMESPACE = "archimedes.notify";

export function loadNotifyConfig(): NotifyConfig {
  return loadConfig(NAMESPACE, DEFAULT_NOTIFY_CONFIG);
}

export function saveNotifyConfig(config: NotifyConfig): void {
  saveConfig(NAMESPACE, config);
}

// ── Terminal detection helpers ──────────────────────────────────────────────

/**
 * Did the user press a key, or is this the terminal answering a question?
 *
 * pi-tui decodes input for us, and the decode is the test: `parseKey()` returns
 * a key id for a keystroke (legacy byte, escape sequence, Kitty CSI-u press,
 * repeat **or** release) and `undefined` for everything else. Cancel on the
 * keystrokes only.
 *
 * The rule used to be "any byte that reaches the listener", which pi 1.x makes
 * wrong, because far more protocol traffic goes through the terminal now and
 * `TuiBase.handleTerminalInput()` (pi-tui `dist/tui.js:687-712`) forwards some
 * of it to extension listeners and swallows the rest:
 *
 * - The colour-scheme report is consumed before listeners, unconditionally. The
 *   OSC 10/11/4 colour replies go through the same pending-query branch as the
 *   device-attributes reply below, so during pi's palette query — at startup and
 *   on every theme switch, when that branch is armed — they are swallowed there;
 *   a reply that turns up with no query outstanding is forwarded like any other
 *   byte.
 * - A primary-device-attributes reply (`ESC [ ? … c`) is swallowed only while a
 *   colour query is pending (`tui.js`, `pendingTerminalColorQueries`), so a
 *   late or unsolicited one — the shape is `\x1b[?62;1;9c` — **is** forwarded.
 * - A cell-size report (`ESC [ 6 ; height ; width t`) is consumed only *after*
 *   listeners, so it always reaches them.
 * - Focus in/out, mouse reporting, bracketed-paste markers and the Kitty
 *   protocol query reply reach listeners too, and none of them is typing.
 *
 * So a reply used to be able to cancel an alert nobody asked for. A mouse event
 * no longer counts either — notify's contract is keystrokes (see README), and
 * `parseKey()` is what says whether one happened.
 *
 * The decoder is the test, but not the whole test: it names ASCII bytes and
 * escape sequences, and nothing else. A character outside ASCII is delivered as
 * itself — `é` is the two bytes C3 A9 on every terminal that did not take the
 * Kitty keyboard protocol (Terminal.app, VTE/GNOME Terminal, xterm, tmux) — and
 * `parseKey()` returns `undefined` for it. Treating that as "not a keystroke"
 * would fire an alert at someone standing at the keyboard typing an accented
 * letter, which is the failure this handler exists to prevent, so a printable
 * character with no control byte in it counts as typing too. The test stays
 * narrow on purpose: the `é`-shaped answer cannot mistake protocol traffic for
 * a key press, because every reply pi-tui forwards opens with `ESC`, and the
 * only other printable bytes a listener can see are the *tail* of a reply split
 * across two reads (`62;1;9c`) — printable ASCII, still no key press.
 */
const TYPED_NON_ASCII = /[\u00a0-\uffff]/;
const CONTROL_BYTE = /[\u0000-\u001f\u007f-\u009f]/;

function isKeystroke(data: string): boolean {
  if (parseKey(data) !== undefined) return true;
  return TYPED_NON_ASCII.test(data) && !CONTROL_BYTE.test(data);
}

/** Wrap an OSC sequence for tmux passthrough. */
export function wrapForTmux(sequence: string): string {
  if (!process.env.TMUX) {
    return sequence;
  }
  // Escape inner ESC characters so tmux doesn't interpret them
  const escaped = sequence.replace(/\x1b/g, "\x1b\x1b");
  return `\x1bPtmux;${escaped}\x1b\\`;
}

// ── OSC notification dispatchers ────────────────────────────────────────────

/** OSC 777 — generic notify (used as fallback) */
export function notifyOSC777(title: string, body: string): void {
  const seq = `\x1b]777;notify;${title};${body}\x07`;
  process.stderr.write(wrapForTmux(seq));
}

/** OSC 9 — Konsole / generic terminal */
export function notifyOSC9(message: string): void {
  const seq = `\x1b]9;${message}\x07`;
  process.stderr.write(wrapForTmux(seq));
}

/** OSC 99 — Kitty terminal */
export function notifyOSC99(title: string, body: string): void {
  const seq1 = `\x1b]99;i=1:d=0;${title}\x1b\\`;
  const seq2 = `\x1b]99;i=1:p=body;${body}\x1b\\`;
  process.stderr.write(wrapForTmux(seq1));
  process.stderr.write(wrapForTmux(seq2));
}

/** Windows Terminal — PowerShell toast notification */
export function notifyWindows(title: string, body: string): void {
  const script = windowsToastScript(title, body);
  execFile(
    "powershell.exe",
    ["-NoProfile", "-Command", script],
    { shell: false },
    () => {
      /* ignore */
    },
  );
}

/** Generate a self-contained PowerShell script for toast notifications */
export function windowsToastScript(title: string, body: string): string {
  // Escape single quotes for PowerShell string interpolation
  const escapedTitle = title.replace(/'/g, "''");
  const escapedBody = body.replace(/'/g, "''");

  return [
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
    "Add-Type -AssemblyName System.Runtime.InteropServices.WindowsRuntime",
    '$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    '$textNodes = $xml.GetElementsByTagName("text")',
    "$textNodes.Item(0).InnerText = '" + escapedTitle + "'",
    "$textNodes.Item(1).InnerText = '" + escapedBody + "'",
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Pi').Show($toast)",
  ].join(";");
}

// ── Main notify dispatcher ──────────────────────────────────────────────────

/** Dispatch a notification to the appropriate terminal handler. */
export function notify(title: string, body: string): void {
  // 1. Windows Terminal
  if (process.env.WT_SESSION) {
    notifyWindows(title, body);
    return;
  }

  // 2. Kitty
  if (process.env.KITTY_WINDOW_ID) {
    notifyOSC99(title, body);
    return;
  }

  // 3. iTerm2
  if (process.env.TERM_PROGRAM === "iTerm.app" || process.env.ITERM_SESSION_ID) {
    notifyOSC9(body);
    return;
  }

  // 4. Fallback — OSC 777
  notifyOSC777(title, body);
}

// ── Circuit breaker state ───────────────────────────────────────────────────

let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let pendingTrigger: TriggerType | null = null;

// ── Circuit breaker logic ───────────────────────────────────────────────────

/** Cancel any pending notification timer. */
export function cancelPending(): void {
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  pendingTrigger = null;
}

/** Schedule a delayed notification (circuit breaker). */
export function scheduleNotify(trigger: TriggerType): void {
  // Cancel any existing timer first
  cancelPending();

  // Load config fresh on each trigger
  const config = loadNotifyConfig();

  if (trigger === TRIGGER.AGENT_SETTLED && !config.notifyOnAgentEnd) {
    return;
  }

  if (trigger === TRIGGER.UI_PROMPT && !config.notifyOnQuestion) {
    return;
  }

  pendingTrigger = trigger;
  notifyTimer = setTimeout(() => {
    fireNotification(pendingTrigger);
    notifyTimer = null;
    pendingTrigger = null;
  }, config.delayMs);

  // Don't block process exit
  notifyTimer.unref();
}

/** Fire the actual notification based on the pending trigger. */
function fireNotification(trigger: TriggerType | null): void {
  if (trigger === TRIGGER.AGENT_SETTLED) {
    notify("Pi", "Task complete — waiting for input");
  } else {
    notify("Pi", "A question needs your answer");
  }
}

// ── Registration ────────────────────────────────────────────────────────────

/** Register the notify extension with the Pi agent. */
export function registerNotify(pi: ExtensionAPI): void {
  pi.on("agent_settled", () => scheduleNotify(TRIGGER.AGENT_SETTLED));
  // Any blocking extension UI prompt (ask, sudo) — fires in the
  // parent process for direct and subagent-relayed prompts alike.
  pi.on("ui_prompt_start", (_event) => scheduleNotify(TRIGGER.UI_PROMPT));
  pi.on("input", () => cancelPending());
  // Any run that *starts* makes a pending alert stale, so this handler takes no
  // filter. pi 1.2.0 made `before_agent_start` a union on `messageType` —
  // `"user"` for a submitted prompt, RPC prompt or `pi.sendUserMessage()`, and
  // `"custom"` for `pi.sendMessage(…, { triggerTurn: true })` fired while idle,
  // which is new traffic that fires it too — and both members mean the same
  // thing here: work is beginning, so "Task complete — waiting for input" is
  // now a lie, whoever caused the run. Same reason `agent_start` cancels.
  pi.on("before_agent_start", () => cancelPending());
  pi.on("agent_start", () => cancelPending());
  // A prompt that closes without terminal input (e.g. a ctx.ui.confirm
  // that times out and auto-declines) cancels the question timer so a
  // long-gone prompt does not fire a stale "question needs your answer".
  // Scoped so it never wipes a pending "task complete" timer.
  pi.on("ui_prompt_end", () => {
    if (pendingTrigger === TRIGGER.UI_PROMPT) {
      cancelPending();
    }
  });

  // Listen for raw terminal keystrokes — cancel on any key press, and only on
  // one: terminal protocol traffic is not a keystroke (see `isKeystroke`).
  let unsubTerminalInput: (() => void) | null = null;
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    unsubTerminalInput = ctx.ui.onTerminalInput((data) => {
      if (isKeystroke(data)) {
        cancelPending();
      }
    });
  });

  pi.on("session_shutdown", () => {
    cancelPending();
    unsubTerminalInput?.();
  });
}

// ── Default export (for standalone pi.extensions loading) ─────────────────

// registerNotify subscribes its own session_start/session_shutdown (and
// agent/input) handlers internally, so the default factory just registers it.
export default function (pi: ExtensionAPI): void {
  registerNotify(pi);
}

// ── Settings UI ─────────────────────────────────────────────────────────────

/** Build settings UI items for the notify package. */
export function getNotifySettingsItems(config: NotifyConfig): SettingItem[] {
  return [
    {
      id: "notifyOnAgentEnd",
      label: "Notify on task complete",
      description: "Notify when agent finishes a task",
      currentValue: config.notifyOnAgentEnd ? "On" : "Off",
      values: ["On", "Off"],
    },
    {
      id: "notifyOnQuestion",
      label: "Notify on question",
      description: "Notify when a question needs your answer",
      currentValue: config.notifyOnQuestion ? "On" : "Off",
      values: ["On", "Off"],
    },
    {
      id: "delayMs",
      label: "Delay before notify",
      description: "Seconds to wait before sending notification",
      currentValue: String(config.delayMs / 1000) + "s",
    },
  ];
}
