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

| # | mutation | result |
|---|---|---|
| M1 | back to the literal `'active'` | 3 fail |
| M2 | `null` and `undefined` collapsed again | 1 fail |
| M3 | supplied vectors collapsed to one label | 1 fail |
| M4 | no-fit keys as `0` instead of `null` | **equivalent — see below** |
| M5 | the basis dropped from the key entirely | 5 fail |

**M4 is an equivalent mutation, not a gap.** Fit ids come from `AUTOINCREMENT` and start at 1,
so `{fit: 0}` and `{fit: null}` are both distinct from every real fit and from each other in
the JSON key. The mutation changes no behaviour, so no test can fail on it and none should be
written to. Recorded rather than papered over, because an unkilled mutation with no
explanation reads the same as an untested line.

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
