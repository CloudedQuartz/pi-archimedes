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
//      both — that catches the pair drifting together away from the code, which
//      a pure A-vs-B comparison cannot see.
//
// Deliberate limits: it compares the READMEs against each other and against the
// stale-phrasing list, NOT against `keybinding-offer.ts`. The code side is
// pinned where it belongs — `packages/image-paste/src/keybinding-offer.test.ts`
// asserts the snippet byte-for-byte ("the README quotes this line verbatim") and
// every user-facing warning string. Nothing here reads `$HOME`, a package
// `node_modules`, or the network, and the whole file costs two `readFileSync`
// calls, so it is as fast as the discipline guards in `packages/core/src`.

/** Repo root, resolved from this file (`meta/src` → repo root), never `$HOME`. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const ROOT_README = "README.md";
const META_README = join("meta", "README.md");

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
 * * "naming the one line to delete" / "names the line to delete" / "its wording
 *   assumes the first" — the refuse warning used to order every refused file to
 *   delete an `app.clipboard.pasteImage` entry. Issue #127: four of the five
 *   refusals hold no such entry, so the warning now branches and only says it
 *   when there is something to delete.
 *
 * Phrased as plain substrings, because the point is that these exact words read
 * as a promise the code does not keep.
 */
const STALE_PHRASES: ReadonlyArray<{ phrase: string; why: string }> = [
  {
    phrase: "single `app.clipboard.pasteImage`",
    why: "the suite writes the unbinding plus its own `$schema` line, not a single entry",
  },
  {
    phrase: "only when the file holds nothing else",
    why: "the accept-set is the suite's own artefact, and its own `$schema` counts as ours",
  },
  {
    phrase: "naming the one line to delete",
    why: "the refuse warning only names an entry when the refused file actually holds one (issue #127)",
  },
  {
    phrase: "names the line to delete",
    why: "same claim in another tense — four of the five refusals hold no entry to name",
  },
  {
    phrase: "its wording assumes the first",
    why: "the warning no longer has one wording for every refusal",
  },
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

  it("neither README carries a phrasing the shipped code makes false", () => {
    for (const { label, relPath } of BOTH_READMES) {
      const text = readme(relPath);
      for (const { phrase, why } of STALE_PHRASES) {
        // A boolean, so a failure prints the phrase rather than both whole
        // READMEs as an expected/received diff.
        expect(text.includes(phrase), `${label} must not claim "${phrase}" — ${why}`).toBe(
          false,
        );
      }
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
