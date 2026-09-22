# What the fantasy coordinator was actually fitted on

2026-09-20. `server/services/fantasy-coordinator.js`,
`test/fantasy-coordinator-coverage.test.js`. Off `main` 791b131.

## Three silent drops in one function

`buildFantasyCoordinatorExamples` builds the coordinator's training set and dropped data in three
places, counting none of them.

**1. A whole season's `boom_bust_signal`, on `.catch(() => null)`.** One of three expert signals,
gone for every example in that season. The fit still reports `ready: true`, because the remaining
rows satisfy `MIN_ROWS`.

**2. A week whose engine will not build, on `catch { continue; }`.** That week leaves the training
set entirely. A fit on sixty per cent of the weeks returned the same shape as a fit on all of them.

**3. A week with no settled usage.** Legitimate, and still worth counting: *"the season is only 14
weeks old"* and *"eleven weeks failed to load"* are different facts that produced the same row
count.

The fit reports `rows: examples.length`, so a shrunken training set was *partly* visible. But a
short history and a history that failed to load are indistinguishable in that one number, and case
1 is invisible in it entirely — the rows are all present, one of their columns is null.

## Why this is not housekeeping

This file's own comment at `weeklyExpertValues` reads:

> `boom_bust_signal` is deliberately NOT included: it already shrank to zero in the persisted fit
> (see this file's Phase 3 result above), so computing it here would only cost a GBM prediction for
> a coefficient the fit already learned to ignore.

**A signal that is null for a large share of its training rows would shrink toward zero whether or
not it carries information.** So case 1 and that conclusion are the same question asked twice, and
nothing recorded the number that separates them. If `predictRankGap` was failing for whole seasons,
the fit "learned to ignore" a signal it largely never saw, and a documented finding about the
signal's worth is an artifact of a swallowed error.

**This does not settle that question and does not claim to.** No figure here says what the share
actually was on real data — this container's database has no usable history for it, so the honest
statement is that the number is now *available* and has not yet been *read*. What is built is
`boom_bust_share`, the figure that answers it, plus the seasons that failed by name and their
reasons. Reading it on a database with real history is a follow-up, and it is the whole point of
building it.

CLAUDE.md names the family: *"a silent catch deleted a whole data layer and the page kept printing
numbers as if nothing had happened."*

## What changed

`fantasyCoordinatorExampleCoverage()` reports the last build: `ok`, `seasons_considered`,
`weeks_considered`, `weeks_no_actuals`, `weeks_engine_failed`, `examples`,
`examples_with_boom_bust`, `boom_bust_share`, `seasons_without_boom_bust`, `boom_bust_errors`,
`engine_errors`. `COORDINATOR_COVERAGE_KEYS` is exported and frozen, and a test asserts the exact
key set, so a drop that is counted but not listed — a drop nobody can ask about — cannot be added
quietly.

Re-derived per build, never accumulated: a stale verdict beside a fresh build is the same bug in a
new place. `F7` is that mutation.

**The coverage travels with the stored fit**, as `training_coverage` on the object
`refitFantasyCoordinator` saves. A stored fit whose row count is all it knows about its own
training set cannot later be asked whether a signal was absent when its coefficient was learned,
which is exactly the question above. `F9` is that mutation, and it survived the first sweep.

`ok` is false when the build produced nothing, lost a week, or lost a season's signal. It is not a
statement that the fit is good.

## The injection seam, and why it is not gratuitous

`buildFantasyCoordinatorExamples` now accepts `rankGap` and `buildEngine`. They exist only so a
test can make them throw, and the reason is measured rather than assumed:

- On a database with no history, `predictRankGap` **returns a falsy value rather than throwing**.
- `buildPlayerWeekEngine` **does not throw even with `nfl_player_week_features` renamed away.**

Both were probed directly before the seam was added. So the two catch blocks cannot be reached
from any fixture built out of data alone, and a counter nothing can reach is a counter nobody has
tested — which is precisely how the first sweep left `F1` and `F3` surviving. Same seam, and the
same reason, as `gbmFit` in `offseason-model.js`.

## Mutations

Base `fantasy-coordinator.js` = `7bbb7448cbaf`. Each row applied alone from the clean base, hashed
before and after, before/after text printed by the runner, file restored to base at the end.

| # | mutation | hash after | result | first sweep |
|---|---|---|---|---|
| F1 | swallow the boom-bust failure again | `0970c1dc33fb` | 1 fail | **survived, 0** |
| F2 | stop naming the seasons whose signal is absent | `12db9e023209` | 2 fail | 1 fail |
| F3 | stop counting weeks whose engine would not build | `238ad5ed9754` | 1 fail | **survived, 0** |
| F4 | stop counting weeks skipped for no settled usage | `08b084a8920f` | 2 fail | 1 fail |
| F5 | report the boom-bust share as 1 regardless | `17fc560add33` | 1 fail | 1 fail |
| F6 | call a build with lost weeks `ok` anyway | `7ddde90e020a` | 2 fail | 1 fail |
| F7 | accumulate coverage across builds | `108e41a05cb6` | 4 fail | 2 fail |
| F8 | drop a field from the frozen key list | `0a03ac3aecdf` | 1 fail | 1 fail |
| F9 | stop carrying coverage into the stored fit | `e969ea7b7923` | 1 fail | **survived, 0** |

**Three rows survived the first sweep at 0 fail, and all three were missing tests rather than weak
mutations.** F1 and F3 because no fixture could make either dependency throw, as measured above.
F9 because nothing asserted the stored fit carried its coverage. Three tests were written: a
throwing `rankGap`, a throwing `buildEngine` on a week that does have settled usage, and a refit
whose fit is checked for `training_coverage`. This is the third time tonight a survivor at zero
meant the test was absent — see `S6` in `docs/tdd/snap-share-ingest.tdd.md` and `P9` in
`docs/tdd/preseason-layer-health.tdd.md`. The pattern is now reliable enough to expect: **a
mutation that survives is first evidence about the suite, not about the mutation.**

## Numbers

RED: 4 tests, 0 passed, 4 failed. GREEN after the three added tests: 7 tests, 7 passed, 0 failed.
With the pre-existing suite: 12 tests, 12 passed, 0 failed across
`fantasy-coordinator-coverage.test.js` and `fantasy-coordinator.test.js`.

Full local check `npm run check`: exit 0 — **2,978 tests, 2,937 passed, 0 failed, 41 skipped**;
typecheck, lint and build clean; `start:smoke` passed on an isolated database (32 teams). CI is not
consulted: the Actions allowance is spent and the workflow is off.

**Isolation, stated rather than implied:** source-isolated at best — one working tree, shared
`node_modules`, no install during the run that I am aware of. Not isolated; I did not measure a
separate dependency tree, so it is not claimed.

## The five questions

**Is this well built?** One ledger, one frozen key list, one accessor, and the coverage attached to
the stored fit rather than left beside it. It is the same shape as `preseasonLayerHealth`
deliberately, so two producers answer "what was this built from" the same way.

**Is this based on stats, or is it made up?** It is about whether the statistics behind a fitted
model were there when it was fitted. The one substantive claim — that a signal null for whole
seasons would shrink toward zero regardless of its information — is a property of the fit, not an
empirical guess. What is *not* claimed is any figure for the real share; that is named as unread.

**How do we know?** Nine mutations, all failing, three of which survived the first sweep and were
closed by writing tests rather than weakening rows. The two dependencies' soft-failure behaviour
was probed directly and is quoted, not assumed.

**Should this data be pointed anywhere else on the platform?** Yes, three places. The
`boom_bust_share` on real history should be read, and if it is low the `weeklyExpertValues` comment
needs rewriting from a finding into an open question. Nothing surfaces `training_coverage` to a
reader yet. And `decay-watch.js:74` calls this builder to grade the frozen fit, so it inherits the
same coverage question about the rows it grades on — routed, since that file is not mine.

**How does it unify?** It makes a fitted model carry a record of its own training set, in the same
vocabulary the draft board's data layers now use: a closed set of fields, a count with samples, and
a reason attached rather than a silence.
