# nfl_projection_range_fits: persisting the fitted quantile table

2026-09-22. `server/migrations/064_nfl_projection_range_fits.js` (new),
`server/services/projection-range.js` (additive: `saveProjectionRangeFit`,
`activateProjectionRangeFit`, `activeProjectionRangeTable`,
`projectionRangeFitHistory`), `test/projection-range-persistence.test.js`
(new). Off `main` `654ff93`, on branch `effk`.

## Where this sits

`docs/tdd/projection-range-coverage.tdd.md` cleared spec §7 — the causal
empirical-quantile method holds its stated coverage against real production
data (80.21% WR/TE/RB, 22,040 graded player-weeks) — and named the remaining
step: wiring the fitted table into `buildProjections`'s actual serving
output (§5's `range_lo`/`range_hi`/... fields). A fit over thousands of
player-weeks is not something `buildProjections` can afford to redo on every
request, so it needs a persisted, servable form first. This unit is that
form; attaching the §5 fields inside `buildProjections` is the next unit.

## What this adds

**Migration 064**: `nfl_projection_range_fits` — `fitted_at`,
`through_season`, `min_hist`, `n_rows`, `coverage_overall`, `coverage_json`,
`table_json`, `active`.

**Design choice, stated rather than left implicit**: versioned and
activatable, mirroring `shrinkage-fit.js`'s own
`shrinkage_fits`/`shrinkage_k` (`saveFit`/`activateFit`/`activeKVector`/
`fitHistory`) — not `nfl_metric_reliability`'s upsert-in-place shape. The
difference is what each table represents: `nfl_metric_reliability` is many
small, independent per-metric measurements where "what do we believe about
metric X right now" is the natural read. `nfl_projection_range_fits` is one
periodic batch artifact — a single job fits the whole table over all
positions at once and `buildProjections` reads exactly one active version —
so a re-fit is a new row kept for accountability/rollback, not an overwrite.
`table_json` stores `fitProjectionRangeTable`'s return shape verbatim;
`coverage_overall`/`coverage_json` record `causalCoverageReport`'s
self-check alongside the fit as evidence, not as a claim asserted about the
fit — the durable coverage claim is the one already measured and written
into `projection-range-coverage.tdd.md`, not whatever a future refit's
in-sample walk-forward happens to report.

`activateProjectionRangeFit` and `activeProjectionRangeTable` are the same
shape as `activateFit`/`activeKVector`: deactivate every row, then activate
one; read back the one active row, `null` if none.

## Mutations

Base `projection-range.js` = `e508872f5c5e`. Each row applied alone from a
clean base via the sweep runner, hashed before/after, file restored at the
end.

| # | mutation | result | first sweep |
|---|---|---|---|
| M1 | `saveProjectionRangeFit` inserts with `active=1` instead of `0` | 1 fail | 1 fail |
| M2 | `activateProjectionRangeFit` drops the deactivate-all step | 1 fail | 1 fail |
| M3 | `activeProjectionRangeTable` drops the `active = 1` filter | 1 fail | 1 fail |
| M4 | `activeProjectionRangeTable` stops parsing `table_json` | 2 fail | 2 fail |
| M5 | `projectionRangeFitHistory` orders ascending instead of descending | 1 fail | 1 fail |
| M6 | `activeProjectionRangeTable` stops parsing `coverage_json` | 1 fail | **survived, 0** |
| M7 | `saveProjectionRangeFit` stops storing `coverageOverall` (always `null`) | 1 fail | **survived, 0** |

**M6/M7 survived the first sweep at 0 fail** — the original six tests never
read `coverage_overall` or `coverage_by_position` back off
`activeProjectionRangeTable()` at all, so a fit's coverage self-check could
silently come back as raw JSON text or as `null` regardless of what was
passed to `saveProjectionRangeFit`, and nothing would notice. Closed with one
test that saves a fit with real `coverageOverall`/`coverageByPosition`
values and asserts the active table's `coverage_overall` is the same number
(not just non-null) and `coverage_by_position` is the same parsed object
(not the JSON string). Re-swept: 7/7 rows caught, 0 survivors.

## Numbers

RED (`00a123e`): 6 of 6 tests failed as expected (the four persistence
functions didn't exist). GREEN, before closing the M6/M7 survivors: 6 tests,
6 passed. After adding the coverage round-trip test: **7 tests, 7 passed, 0
failed** in `projection-range-persistence.test.js`. Re-run alongside
`projection-range.test.js` (10) and `projection-range-coverage.test.js` (8):
**24/24 total**, unaffected.

Full local check `npm run check` on `effk`, this commit (staged before the
run, `git write-tree` = `f3331aaeea4709c7669d3da2565d87ab195454ed`
immediately before `npm run check` started): exit 0 — **3,050 tests, 3,009
passed, 0 failed, 41 skipped**; typecheck, lint and build clean;
`start:smoke` passed on an isolated database (32 teams). Delta from the
prior full-check baseline (3,043/3,002/0/41, this branch's `ee3f41e`
commit): exactly **+7/+7/0/0**, matching this unit's own new test count
precisely.

**Isolation, stated rather than implied:** source-isolated — one working
tree, shared `node_modules`, no install during the run.

## The five questions

**Is this well built?** Two-step save-then-activate, same shape this
codebase already trusts for `shrinkage_fits`, so a bad refit never
overwrites the table `buildProjections` reads until something explicitly
activates it.

**Is this based on stats, or is it made up?** The persistence layer carries
whatever `fitProjectionRangeTable` fits and whatever `causalCoverageReport`
measured; nothing here invents a number. The design choice
(versioned+active vs. upsert) is a judgement call, stated as one, reasoned
from what kind of artifact each table represents rather than copied from a
spec.

**How do we know?** Seven mutations, two survivors at first pass, both from
the same gap — coverage fields nothing yet read back — closed with a test
built specifically to exercise that read path with real, distinguishable
values.

**Should this data be pointed anywhere else on the platform?** Yes — this is
the servable form `buildProjections` needs to attach §5's `range_lo`/
`range_hi`/`range_coverage`/`range_basis`/`range_fitted_at`/`range_n` fields
without refitting per request. Not wired there yet; that is the immediate
next unit.

**How does it unify?** Same versioned-and-activatable pattern as the
production k-vector fit this repo already runs on, so anyone auditing "what
is live right now" for either table already knows how to read it.
