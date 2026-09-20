# A promoted shrinkage fit has to reach a running process

2026-09-20. `server/services/player-week-engine.js`, `test/player-week-memo-fit.test.js`.
RED `b4e0bcd`-class commit first, then the fix, then five mutations.

## The defect

`buildPlayerWeekEngine` memoises on a key whose shrinkage slot read
`kOverride ?? 'active'`. The literal stood in for "whatever the active fit is", so promoting
a fit left the key unchanged and the engine built from the **previous** fit was served for the
life of the process. Nothing calls `clearPlayerWeekEngineCache` when a fit is activated.

**Why that is worse than a stale number.** It is not detectable from the output. Both fits
produce plausible projections, and `projectionFitMeta` puts a fit id on the served payload —
so a promotion could leave the label naming the new fit while the numbers came from the old
one. The label is what a reader checks, so the wrong pairing is worse than no label at all.

The key already carried `weightFit: weightChampion.id` for exactly this reason on the weekly
weight set. This is the shrinkage fit catching up with a pattern already in the same line.

## The second defect, found by the fifth test

`kOverride ?? 'active'` treats `null` and `undefined` alike. But they are different calls:
`undefined` means "use whatever is active", `null` means "no fit, use the hand-set constants".
Both mapped to `'active'`, so a caller explicitly bypassing the fit was served the fitted
engine.

`projectionFitMeta` already distinguishes these two (`hand_set_forced` against
`caller_supplied_vector`). The memo key now uses the same three cases under the same names, so
the basis a payload *reports* and the basis the memo *keys on* cannot drift apart.

## A collision the fix nearly introduced

The first version returned the string `'caller_supplied_vector'` for the supplied-vector case.
That would have served one caller's engine to another caller with different constants — the
same defect this change exists to remove, arriving by a different route. The vector itself goes
in the key, and there is a test asserting two different supplied vectors are two different
builds.

## Mutations

Sweep re-run 2026-09-20 in the canonical shape: every row applied to
`server/services/player-week-engine.js` one at a time from the same clean base, the file's
SHA-256 (first 12 characters) recorded before and after so an edit that silently failed to
match cannot be read as a green row, and the run is
`node --test --test-concurrency=1 --experimental-test-module-mocks test/player-week-memo-fit.test.js`.

Base file: `51fe17160436`. Restored to `51fe17160436` after the last row, checked.

| # | mutation | state | sha256 before -> after | fail | a test that fails |
|---|---|---|---|---|---|
| M1 | the shrinkage slot back to the literal `'active'` | APPLIED | `51fe17160436` -> `467fead46c49` | 3 | promoting a fit is visible to a running process, with no cache clear |
| M2 | `null` and `undefined` collapsed again (`=== undefined` becomes `== null`) | APPLIED | `51fe17160436` -> `838b6b0dce5f` | 1 | an explicit kOverride still keys separately from the active fit |
| M3 | two supplied vectors collapsed to one label | APPLIED | `51fe17160436` -> `640c47f0d6f3` | 1 | two different supplied vectors are two different builds |
| M4 | no fit keys as `0` instead of `null` | APPLIED | `51fe17160436` -> `9b7947004f78` | 0 | **none — equivalent, see below** |
| M5 | the shrinkage basis dropped from the cache key entirely | APPLIED | `51fe17160436` -> `ec51e3a1eb9e` | 5 | promoting a fit is visible to a running process, with no cache clear |
| CONTROL | a comment reworded, no code path touched | APPLIED | `51fe17160436` -> `07b54b439f25` | 0 | none, and none should |

**Why the state column is here.** A mutation applied by matching a string can fail to match —
a changed quote, a reflowed line — and then the suite passes because nothing was mutated. That
reads identically to a mutation the tests caught. Every row above changed the file's hash, so
every row is a real measurement. The CONTROL row is the other half of the same argument: it
changes the file (its hash moves) but changes no behaviour, and it fails nothing. A sweep where
the control also failed tests would mean the suite was reacting to the file being touched
rather than to what the edit did.

**M4 is an equivalent mutation, not a gap.** Fit ids come from `AUTOINCREMENT` and start at 1,
so `{fit: 0}` and `{fit: null}` are both distinct from every real fit and from each other in
the JSON key. The mutation changes no behaviour, so no test can fail on it and none should be
written to. Recorded rather than papered over, because an unkilled mutation with no
explanation reads the same as an untested line.

**M5 is the row that matters most**, and not for the five failures. The accessor rework in this
same branch replaced text between two anchors and `memoKBasis` sat between them, deleting it.

**The cross-file count, measured 2026-09-20 rather than asserted.** It was quoted before it was
run, on the targeted suite only, so it is re-measured here: delete `memoKBasis` on the merged head
(file `f9da8591e948` -> `36026fc4f4da`, APPLIED, restored to `f9da8591e948` after) and run the
whole suite. **2,949 tests, 2,854 passed, 54 failed, 41 skipped**, of which **51** carry
`memoKBasis is not defined`. First three by name: "an injury status changed in place for the
served week rebuilds the universe", "a stat correction made in place for the served season
rebuilds the universe", "a line moved in place rebuilds the universe" — none of them about caching
a fit.

**And a correction to how that was first told.** "Both targeted suites passed" was too broad.
`test/availability-basis.test.js`, the suite the rework was aimed at, passes 11 of 11 with
`memoKBasis` deleted — that part holds, and it is the part that let the deletion through.
`test/player-week-memo-fit.test.js` fails 6 of 6, so running *this* file would have caught it
immediately. The lesson survives the correction and is narrower than stated: a suite aimed at the
change is not evidence when the edit is structural rather than logical, because the file it broke
was not the file it was editing. Only the full run is.

## Numbers

RED: 5 tests, 1 passed, 4 failed. GREEN: 6 tests, 6 passed, 0 failed. (The sixth is the
collision test written during the fix.) The first test asserts the memo is still a memo, so
none of the others can pass vacuously on a disabled cache.

Full local check `npm run check`: exit 0 — 2,966 tests, 2,925 passed, 0 failed, 41 skipped;
typecheck, lint and build clean; `start:smoke` passed on an isolated database.

## A docs correction carried in the same commit

`docs/FANTASY-ENGINE-MASTER-PLAN.md` said `llm-budget.js:39` ships `trade_proposals: 0.50`
with "no production consumer — pre-built for that stage and currently dead code". Re-verified
in the tree: it is **live**. `routes/trades.js:34` imports `proposalsFor` and `liveCaller`,
`:864-865` passes `liveCaller(callClaude)` and `dbCache(lg.id)` in, `trade-proposals.js:515`
sets `feature: trade_proposals:league-${leagueId}`, and `TradeBrain.tsx` renders a `proposals`
tab. The line number was wrong too: it is `:43`.

The general rule now in that file: **a phrase like "currently dead", "not yet wired" or "no
production consumer" in a docs file is an assertion about a past tree, and is re-verified
before anyone repeats it.** This one had survived long enough to be quoted back as current.

## The five questions

**Is this well built?** The memo now keys on the same three cases the payload reports, in one
small function with the reasoning next to it, so the two cannot drift.

**Is this based on stats, or is it made up?** No statistics involved — it is a cache-identity
question, and the tests assert identity rather than numbers, which is what the defect actually
is. Asserting changed *values* would have needed a seeded database and would have tested
`buildProjections` instead of the key.

**How do we know?** Four of five mutations fail and the fifth is shown to be behaviourally
equivalent. RED came first and failed for the stated reason.

**Should this data be pointed anywhere else on the platform?** The reverse: this is what makes
the fit id already on the payload true. Every consumer of `projectionFitMeta` was at risk of
reading a correct label over numbers from a different fit.

**How does it unify?** It brings the shrinkage fit into line with `weightFit`, already in the
same key for the same reason, and reuses `projectionFitMeta`'s vocabulary rather than inventing
a second set of names for the same three states.
