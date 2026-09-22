---
name: mutation-sweep-finds-vacuous-tests
description: Running one mutation per guarded rule across three merged-ready fantasy PRs found six rules with no real test, including two tests whose fixtures could not distinguish the behaviour they named.
metadata:
  type: feedback
  modified: 2026-09-20T02:00:34.446Z
---

**On 2026-09-20 a retroactive mutation sweep over PRs #38, #40 and #44 ran 23
mutations and six of them passed.** Every one of those six was a guarded rule
with a test that named it. The tests were not missing; they were unable to fail.

**The three shapes, in order of how badly they fool a reader:**

1. **A threshold tested far from its boundary.** #38's fallback ladder compared a
   cell with 240 observations against cells with 0, so `MIN_CELL = 40` could be
   changed to 1 with nothing failing. #44 had the same shape twice.
2. **A fixture that produces no signal.** #38's gap test asserted the fit's
   curves were `{}` on a two-row panel — two rows are below `min_cell`, so they
   are `{}` whatever the code does. My own first attempt at a replacement had it
   too: a `simulateSeason` fixture that read `expected_points: 0` for both sides,
   where every week ties and the title goes to the better seed deterministically.
   **A fixture that cannot produce the good outcome cannot detect the bad one.**
3. **A precondition that makes the interesting branch unreachable.** #44's
   `projection-fit-meta.test.js` deliberately ran with `shrinkage_fits` empty
   (the production state, and worth keeping), so `activeFitMeta()` returned null
   and `projectionFitMeta` returned before reaching any of the logic the field
   exists for. Three mutations passed all four of its tests, including
   hardcoding `volume_k` to `'fitted'` — the one field another thread had already
   written user-facing copy against.

**Why:** a test named after a rule is read as covering it, by reviewers and by
the next session. That borrowed confidence is worse than no test, because nobody
looks again. `CLAUDE.md`'s "a test that no mutation can fail proves nothing" is
the rule; the sweep is how you find out.

**How to apply:** for each rule a PR claims to guard, revert exactly that line
and run the test file. Restore from a pristine copy between mutations, never by
re-editing. Paste the output into the evidence file — the run is the evidence,
not the claim. Where a mutation passes, decide which of the three shapes it is
and fix the test; where it passes *because the value is a tuning choice with no
measurement behind it*, say so instead of pinning the number (a test that pins
`MIN_CELL = 40` fails the day someone justifies 50).

**One trap specific to defensive code.** #38's gap guard is unreachable given the
`break` above it, so removing it fails nothing, and turning the `break` into a
`continue` while keeping it also fails nothing. Only removing both protections
grades the week past a gap. When a mutation passes, check whether a *second*
line is covering for it before concluding the rule is untested.

Records: `docs/tdd/simulator-league-shape.tdd.md` (#40),
`simulator-projection-basis.tdd.md` (#44), `injury-return.tdd.md` (#38), and
`nflverse-usage-truth.tdd.md` (#66), each with every mutation's output.
See [[gridiron-failure-modes]] and [[nflverse-usage-stamp-lies]].
