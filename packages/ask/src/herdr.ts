import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Report the ask dialog to herdr's managed extension (herdr-agent-state.ts).
 *
 * That extension listens for "herdr:blocked" on pi's SHARED event bus
 * (`pi.events` — every extension in the process sees it) and refcounts the
 * blocked state: `active: true` → +1 (message = label), `active: false` → −1.
 * It is TUI-only and inert unless herdr spawned pi with `HERDR_ENV=1` +
 * `HERDR_SOCKET_PATH` + `HERDR_PANE_ID`, so when herdr is not active the
 * event has no live listeners and the emit is a no-op — the same pattern as
 * the `ASK_REQUEST` bus emit (a notify hook). No env gate is needed here.
 *
 * The caller MUST pair every `active: true` with exactly one `active: false`
 * (try/finally) so the refcount never leaks — an unpaired increment would
 * leave the pane stuck at "blocked".
 */
export function emitBlocked(pi: ExtensionAPI, active: boolean, label?: string): void {
	pi.events.emit("herdr:blocked", { active, label });
}

/**
 * The label herdr shows while the agent is blocked: the first question,
 * collapsed to one line and truncated (herdr renders it in the pane's
 * status line). One pair per dialog, not per question — the dialog is one
 * UI, and the refcount is per pending prompt.
 */
export function blockedLabel(questions: Array<{ question: string }>): string {
	const question = questions[0]?.question;
	if (!question) return "question";
	const label = question.replace(/\s+/g, " ").trim();
	if (label.length === 0) return "question";
	return label.length > 80 ? `${label.slice(0, 79)}…` : label;
}
