import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ── The rule (issue #128) ───────────────────────────────────────────────────
//
// `meta/README.md` is the npm page for the composed suite. It is a
// hand-maintained copy of the root `README.md` — the npm renderer cannot follow
// a relative link to a sibling file, so the copy has to exist — and copies
// drift. Reviewing PR #126 found it still describing the pre-#123
// `keybindings.json` accept-set ("a single `app.clipboard.pasteImage`", "only
// when the file holds nothing else") after the commit that corrected exactly
// that wording in `README.md`. CI said nothing, because nothing compared them,
// and `meta` is the page a user on npm actually reads.
//
// This is the cheap half of the fix: no README generator, no template, nothing
// to run at release time. Two things are checked, both by reading the two files
// from the repo:
//
//   1. the lines that talk about the file the suite writes to a user's agent
//      directory must agree verbatim between the two READMEs — that is what
//      catches a one-sided edit, which is the exact shape of the drift;
//   2. a list of phrasings the shipped code makes false must be absent from
//      every page users read about this file — that catches the pair drifting
//      together away from the code, which a pure A-vs-B comparison cannot see.
//
// Deliberate limits: it compares the READMEs against each other and against the
// stale-phrasing list, NOT against `keybinding-offer.ts`. The code side is
// pinned where it belongs — `packages/image-paste/src/keybinding-offer.test.ts`
// asserts the snippet byte-for-byte ("the README quotes this line verbatim") and
// every user-facing warning string. Nothing here reads `$HOME`, a package
// `node_modules`, or the network: the imports are `node:fs`, `node:path` and
// `node:url`, and the whole file is a handful of reads of three small Markdown
// files (measured: ~10ms for five tests, and it passes from an unrelated cwd
// with `env -i` and a nonexistent `$HOME`).

/** Repo root, resolved from this file (`meta/src` → repo root), never `$HOME`. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const ROOT_README = "README.md";
const META_README = join("meta", "README.md");
/**
 * The package's own page. It is NOT part of the A-vs-B copy comparison (it
 * legitimately says more than the suite pages), but it is the page a standalone
 * `pi install @pi-archimedes/image-paste` user reads, so a claim the code makes
 * false is just as wrong here — which is how "a message naming the line to
 * delete" survived in it after the warning stopped saying that (PR #129 review).
 */
const PACKAGE_README = join("packages", "image-paste", "README.md");
/** The living feature doc — same audience, same rule. */
const FEATURE_DOC = join("docs", "features", "first-run-keybinding-offer.md");

/**
 * Words that mean "this line is about the file the suite writes into the user's
 * agent dir". Extraction is by vocabulary rather than by heading so a reworded
 * setup section still lands in the comparison; the count test below is what
 * stops the list from becoming vacuous if the vocabulary ever disappears.
 */
const KEYBINDING_VOCABULARY = [
  "keybindings.json",
  "app.clipboard.pasteImage",
  "suppressNativePaste",
  "pasteImage",
];

/**
 * Phrasings about the keybinding file that the shipped code makes false. Each
 * entry is a claim the suite does not implement, with the reason it went stale.
 *
 * * "single `app.clipboard.pasteImage`" — the pre-#123 accept-set: what the
 *   suite writes today is the unbinding PAIRED with a `$schema` line, so a
 *   sentence calling it a single entry describes a file the offer no longer
 *   produces.
 * * "only when the file holds nothing else" — the accept-set is not "nothing
 *   else"; it is the suite's own artefact, and its own `$schema` counts as ours.
 * * "naming the … line to delete" (any tense, with or without "one", with or
 *   without "you should") — the refuse warning used to order every refused file
 *   to delete an `app.clipboard.pasteImage` entry. Issue #127: most refusals hold
 *   no such entry, so the warning now branches and only names an entry when the
 *   file holds one. This is a PATTERN and not a literal string on purpose: the
 *   two literals this list carried ("naming the one line to delete", "names the
 *   line to delete") both missed "a message naming the line to delete", which is
 *   why that sentence was still living in `packages/image-paste/README.md` when
 *   PR #129 was reviewed. The test below keeps the pattern honest in both
 *   directions — it must catch the rewordings and must not catch the wording
 *   that replaced them.
 * * "its wording assumes the first" — the warning no longer has one wording for
 *   every refusal.
 */
const STALE_PATTERNS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    pattern: /single `app\.clipboard\.pasteImage`/,
    why: "the suite writes the unbinding plus its own `$schema` line, not a single entry",
  },
  {
    pattern: /only when the file holds nothing else/,
    why: "the accept-set is the suite's own artefact, and its own `$schema` counts as ours",
  },
  {
    pattern:
      /nam\w+\s+the\s+(one\s+)?line\s+(that\s+)?(you\s+(should|need\s+to|can)\s+)?(to\s+)?delete/i,
    why: "the refuse warning only names an entry when the refused file actually holds one (issue #127)",
  },
  {
    pattern: /its wording assumes the first/i,
    why: "the warning no longer has one wording for every refusal",
  },
];

/** Every page a user reads about this file — all of them carry the same truth. */
const SCANNED_PAGES = [
  { label: "README.md", relPath: ROOT_README },
  { label: "meta/README.md", relPath: META_README },
  { label: PACKAGE_README, relPath: PACKAGE_README },
  { label: FEATURE_DOC, relPath: FEATURE_DOC },
];

function readme(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf-8");
}

/** Every line of that README that talks about the file the suite writes. */
function keybindingLines(relPath: string): string[] {
  return readme(relPath)
    .split("\n")
    .filter((line) => KEYBINDING_VOCABULARY.some((word) => line.includes(word)));
}

const BOTH_READMES = [
  { label: "README.md", relPath: ROOT_README },
  { label: "meta/README.md", relPath: META_README },
];

describe("README agreement — the npm page and the repo page (issue #128)", () => {
  it("there is something to compare: each README has keybinding prose", () => {
    // Without this the comparison below could pass on two empty lists — the
    // failure mode of every "compare the docs" test that keys off a word nobody
    // wrote any more.
    for (const { label, relPath } of BOTH_READMES) {
      expect(keybindingLines(relPath).length, `${label} keybinding lines`).toBeGreaterThanOrEqual(5);
    }
  });

  it("the two READMEs say the same thing about keybindings.json, line for line", () => {
    // The drift this guards has one shape: someone fixes the wording in one file
    // and not the other. Verbatim equality of the extracted lines is the whole
    // guard, and it is what a hand-maintained copy can actually sustain.
    expect(keybindingLines(META_README)).toEqual(keybindingLines(ROOT_README));
  });

  it("no page a user reads carries a phrasing the shipped code makes false", () => {
    for (const { label, relPath } of SCANNED_PAGES) {
      const text = readme(relPath);
      for (const { pattern, why } of STALE_PATTERNS) {
        // A boolean, so a failure prints the phrase rather than the whole page
        // as an expected/received diff.
        expect(
          pattern.test(text),
          `${label} must not claim ${pattern} — ${why}`,
        ).toBe(false);
      }
    }
  });

  it("the stale-claim patterns catch rewordings, and leave the honest wording alone", () => {
    // The failure mode of a substring ban list is a synonym. These are the
    // rewordings of the #127 claim that the literal list let through, plus the
    // shape the guard has to keep rejecting.
    const REWORDINGS = [
      "anything else is left alone with a message naming the line to delete",
      "the warning names the one line to delete",
      "the warning names the line you should delete",
      "you get a message naming the one line that you need to delete",
    ];
    for (const text of REWORDINGS) {
      expect(
        STALE_PATTERNS.some(({ pattern }) => pattern.test(text)),
        `must be caught: "${text}"`,
      ).toBe(true);
    }
    // And the wording that replaced them must not trip the list, or the guard
    // becomes the reason nobody edits the sentence.
    const HONEST = [
      "naming the entry to remove when the file really holds one, and otherwise saying there is nothing of ours to remove",
      "the warning names the file in every case, and the entry only where one is actually in there",
      "a file of foreign keys, or a `$schema`-only file, is told there is nothing of ours to remove",
    ];
    for (const text of HONEST) {
      expect(
        STALE_PATTERNS.some(({ pattern }) => pattern.test(text)),
        `false positive: "${text}"`,
      ).toBe(false);
    }
  });

  it("neither README calls keybindings.json 'untouched' — the suite does write that file", () => {
    // The word is the tell of the pre-#123 wording, which described the file as
    // something the suite never touches. It does touch it: it creates it, and it
    // empties its own entry again. The honest phrasings the code supports are
    // "left byte-for-byte alone" (a file it refused) and "removes that entry,
    // leaving `{}`" (its own artefact).
    for (const { label, relPath } of BOTH_READMES) {
      const offending = keybindingLines(relPath).filter((line) => /untouched/i.test(line));
      expect(offending, `${label} calls the file "untouched"`).toEqual([]);
    }
  });

  it("both READMEs describe the same accept-set: the same two artefacts and the same own-entry-only claim", () => {
    const ACCEPT_SET_CLAIMS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
      { pattern: /`app\.clipboard\.pasteImage: \[\]`/, what: "the unbinding the offer writes" },
      {
        pattern: /https:\/\/pi\.dev\/schemas\/keybindings\.schema\.json/,
        what: "the `$schema` line paired with it",
      },
      { pattern: /the suite's own entry only/i, what: "only our own entry is ever acted on" },
      { pattern: /leaving `\{\}`/, what: "the restore empties that entry and writes `{}`" },
    ];

    for (const { label, relPath } of BOTH_READMES) {
      const text = readme(relPath);
      for (const { pattern, what } of ACCEPT_SET_CLAIMS) {
        expect(pattern.test(text), `${label} states: ${what}`).toBe(true);
      }
    }
  });
});
