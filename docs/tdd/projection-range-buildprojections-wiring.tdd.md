# Wiring the fitted table into buildProjections's serving output

2026-09-22. `server/services/projections.js` (additive: `rangeBand`, and its
call inside `buildProjections`'s per-player emit), `test/projection-range-
wiring.test.js` (new). Off `main` `654ff93`, on branch `effk`. Also fixes a
real bug this unit's own tests exposed — see "The runMigrations() gap"
below.

## Where this sits

`docs/tdd/projection-range-fit-persistence.tdd.md` gave `buildProjections` a
servable, persisted fitted table. This unit is the last piece named in the
coordinator's instruction: wire it into `buildProjections`'s actual output
so UI, Model evidence audit and R&D-integration have something real to read
instead of nothing.

## What this adds

**`rangeBand(rangeFit, position, ppg)`** in `projections.js`: looks up
`projectionRangeFor(rangeFit.table, position, ppg)` and returns the six
serving fields, or all six `null` when there is no active fit or the
position/bin was never seen — "absent beats invented" is already
`projectionRangeFor`'s own rule (spec section 5); this unit only carries it
through to the served object rather than re-deciding it.

**Design calls, stated rather than left implicit:**

- `range_lo`/`range_hi` are conditioned on `ppg` (the per-game point
  estimate), never `points`/`points_horizon` (a full-season total on a
  different basis) — `range_basis: 'ppg'` states this on the object itself
  rather than leaving a consumer to assume it. This is also the exact basis
  `docs/tdd/projection-range-coverage.tdd.md`'s real 80.21% coverage number
  was measured against (`weekly-backtest.js`'s `rawModelPred = p.ppg`), so
  the served band is provably the same quantity the calibration claim is
  about.
- The band is looked up against `meanPpg` (the QBR-adjusted figure the
  player is actually served under), not `structuralPpg` (the pre-adjustment
  one available earlier in the same function) — a QB whose QBR nudge moves
  his `ppg` gets a band that moves with it, not one stale by that
  adjustment.
- `range_coverage` prefers the active fit's position-specific measured
  coverage (`coverage_by_position[pos].coverage`) over its overall figure,
  falling back to the overall figure only when no per-position reading was
  recorded — a WR-labelled band should be read against WR calibration, not
  the cross-position average.
- `activeProjectionRangeTable()` is read once per `buildProjections` call,
  not once per player — consistent with how the function already reads
  `activeKVectorFor` once per call rather than per player.

## The runMigrations() gap this unit's tests exposed

Five existing test files built isolated temp databases for
`buildProjections` (directly or transitively) without ever calling
`runMigrations()`: `ros-projection.test.js`, `model-integrity.test.js`,
`draft-abstention-audit.test.js`, `preseason-model.test.js`,
`fantasy-coordinator.test.js`. `migration 064`'s `nfl_projection_range_fits`
table therefore didn't exist in any of them, and this unit's new
`activeProjectionRangeTable()` read (unconditional, once per
`buildProjections` call) threw `no such table` against every one.

That threw error did not fail loudly everywhere. In `fantasy-coordinator
.test.js` it crashed the suite outright — the one honest failure mode. In
the other four it propagated up through a call chain (`buildProjections` ->
`ros-projection.js`/`preseason-model.js`/`weekly-backtest.js` ->
whatever caller invoked them) until something upstream caught it and
returned an empty or default result instead of surfacing the error. That is
CLAUDE.md's own named failure class, verbatim: "Errors are handled or they
throw. No bare `catch {}` that swallows a fault... If a layer goes inert,
the surface must say so." Concretely: `ros-projection.test.js`'s
`rosPriorMap` returned no prior at all for a player who plainly had 2025
history (`priors.get(id)` was `undefined`), and `model-integrity.test.js`'s
"player-head validation remains sealed unless explicitly opened" test
failed because the swallowed error broke that sealed-by-default invariant.
Neither test's own assertions mentioned migrations, tables, or SQL —
each just failed on an unrelated-looking assertion, which is exactly how
a swallowed fault at a lower layer is supposed to look from three call
frames up: quietly wrong, not loudly broken.

Fixed in all five by adding, right after the DB import and before any
other side-effect import:

```js
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
```

the same pattern several other test files (`qbr-projection-signal.test.js`,
`projection-range-wiring.test.js` itself, and others) already used
correctly. Verified each file individually and the group together, and
confirmed against the previously-pushed `ca56e04` (before this unit's
`activeProjectionRangeTable()` call existed in `buildProjections`) that the
pre-existing failures in `model-integrity.test.js` unrelated to this gap
(3 of them — a missing-API-key test, an ensemble-weights test, and an
evidence-daemon test) are untouched by either this fix or this unit's
wiring, and were already failing on the pushed baseline.

## Mutations

Base `projections.js` = `9a6d57194945`. Each row applied alone from a clean
base via the sweep runner, hashed before/after, file restored at the end.

| # | mutation | result | first sweep | after rewrite |
|---|---|---|---|---|
| W1 | `rangeBand` drops the `rangeFit` null-guard before calling `projectionRangeFor` | 1 fail | 1 fail | — |
| W2 | the no-band guard is inverted (`if (band)` instead of `if (!band)`) | 4 fail | 4 fail | — |
| W3 | `range_coverage` prefers the fit's overall figure over its position-specific reading | 1 fail | 1 fail | — |
| W4 | `range_basis` is hardcoded to `'points'` instead of `'ppg'` | 1 fail | 1 fail | — |
| W5 | `range_fitted_at` reports the fit's `through_season` instead of its `fitted_at` | 1 fail | **survived, 0** | 1 fail |
| W6 | the band is looked up against pre-QBR `structuralPpg` instead of the served `meanPpg` | 1 fail | **survived, 0** | 1 fail |

**W5 survived** because the original assertion only checked `range_fitted_at`
was truthy — `through_season` (e.g. `2022`) is also truthy, so a field swap
passed. Closed by asserting the exact value against
`activeProjectionRangeTable().fitted_at` read independently, not just a
non-null check.

**W6 survived** because every original fixture was a non-QB position, where
`meanPpg === structuralPpg` always (the QBR nudge only ever applies to QBs),
so the two bases were never actually distinguishable by the existing tests —
this is the same "test passes for the wrong reason" pattern found repeatedly
this session, here from a fixture that could never exercise the branch it
was meant to guard. Closed with a QB fixture carrying a deliberately huge
`qbrSignal.k` override (50, vs. the real `QBR_SIGNAL.k` of `0.073`) against a
fine-grained QB-only fitted table, so the QBR-adjusted and pre-adjustment
`ppg` values are forced into different bins; the test asserts the served
`range_lo` moves between a call with the signal disabled and one with it
enabled by that much, which only happens if the lookup is keyed off the
post-adjustment figure. Re-swept: 6/6 rows caught, 0 survivors.

## Numbers

RED (`0f2b93e`): 4 of 4 tests failed as expected (the fields were
`undefined`, not wired). GREEN, before closing the W5/W6 survivors: 4 tests,
4 passed. After the QB fixture and the exact `fitted_at` check: **5 tests, 5
passed, 0 failed** in `projection-range-wiring.test.js`.

Full local check `npm run check`, this commit (staged, tree
`96acf9217d01a09456b23b3ea731f9ae5045eb33`): exit 0 — **3,055 tests, 3,014
passed, 0 failed, 41 skipped**; typecheck, lint and build clean; `start:smoke`
passed on an isolated database (32 teams). Delta from the prior full-check
baseline (3,050/3,009/0/41, `ca56e04`): **+5/+5/0/0** — exactly this unit's
own 5 new tests (the migrations-gap fixes added zero new tests; they made
existing tests pass correctly rather than adding coverage).

**Isolation, stated rather than implied — and corrected this run:**
`git write-tree` alone hashes the INDEX, not the working tree, so a run
starting with unstaged edits can match the hash straight through them. This
run instead recorded `git status --porcelain` (piped through `md5sum` for a
single comparable value), `git write-tree`, and `node_modules`'s mtime
**both immediately before and immediately after** `npm run check`, and all
three were identical on both sides — the tree actually checked is the tree
this commit contains, not merely a tree that happens to share its hash.
Source-isolated otherwise: one working tree, shared `node_modules`, no
install during the run.

## The five questions

**Is this well built?** The serving contract is a thin, single-purpose
helper (`rangeBand`) called once per player from data already computed —
nothing here re-derives `ppg` or re-reads the DB per player.

**Is this based on stats, or is it made up?** The bands themselves come
from whatever fit is active, already measured for real
(`projection-range-coverage.tdd.md`'s 80.21%); this unit's own contribution
is wiring, not a new statistical claim, and states that basis (`ppg`) on the
served object so a consumer isn't left to assume it.

**How do we know?** Six mutations, two survivors, both from the same root
cause (a fixture that could never distinguish the correct behavior from the
mutated one) closed by building fixtures that specifically can — an exact
`fitted_at` comparison, and a QB fixture large enough to force the
QBR-adjusted and pre-adjustment `ppg` into different bins.

**Should this data be pointed anywhere else on the platform?** This is the
unblock the coordinator named — UI, Model evidence audit and
R&D-integration were waiting on exactly this contract shape being live in
`buildProjections`'s output. Nothing further to point it at from this
file; the consumers pick it up themselves once this ships.

**How does it unify?** Same absent-beats-invented discipline as
`projectionRangeFor` itself, carried through to the served object rather
than re-decided; same "state the design call" habit as every other unit
this session (basis, coverage precedence, once-per-call vs. once-per-player).
