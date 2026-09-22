# nfl_metric_reliability: persisting fitK's ICC reading

2026-09-22. `server/migrations/063_nfl_metric_reliability.js` (new),
`server/services/shrinkage-fit.js` (additive: `saveMetricReliability`,
`loadMetricReliability`, `allMetricReliability`), `test/nfl-metric-
reliability.test.js` (new). Off `main` `654ff93`, on branch `effk`.

## Where this sits in R&D's handoff

Data & techniques R&D's `RELIABILITY-SPEC.md` (2026-09-22, routed by the
coordinator, then sent directly by the R&D thread as content since nothing of
theirs is pushed) asks for three things, explicitly separable (§6):

1. `fitK` gains `icc` in its return — **done, pushed, `9e2f079`.**
2. A persisted `nfl_metric_reliability` table with a `weighting_scheme`
   column, fitted for the metrics in their results tables. **This unit.**
3. A fitting job over real nflverse-sourced data (`nfl_ngs`,
   `player_week_usage`), and a shrink-vs-no-shrink ablation gate via
   `backtest.js`'s CRPS/PIT calibration on held-out seasons, per their §6 gate
   requirement (`nfl-model-watch.js:1-18`'s own lesson: two features passed
   isolated OOS validation and still degraded the pipeline; only ablation
   caught it). **Not started here** — a fitting job that reads real synced
   data and an ablation harness are each their own unit, reported as a
   separate scope call to the coordinator, who confirmed the split and asked
   for this step next rather than everything at once.

## What this adds

**Migration 063**: `nfl_metric_reliability` — `population`, `metric`,
`weighting_scheme`, `icc`, `k`, `sigma2_within`, `sigma2_between`,
`n_players`, `n_obs`, `seasons`, `fitted_at`, exactly the column list R&D's
spec names, with `UNIQUE(population, metric, weighting_scheme)`.

**Design choice, stated rather than left implicit**: this table is a
*current-measurement* table, upserted on refit — not a version history like
the existing `shrinkage_fits`/`shrinkage_k` (this file's own production
k-vector fit log, versioned and activatable). R&D's spec text lists the
columns without an `active` flag or version semantics, and "what do we
believe right now" is the natural read for a reliability-reporting table.
`saveMetricReliability` upserts on the unique key rather than appending.

**Why `weighting_scheme` is enforced, not just documented**: R&D's own
retracted first pass sorted one ICC column across metrics fitted under
different weights and produced an invalid headline. Their proof, same
metric and rows: target share reads ICC 0.611 at flat weight and 0.041
weighted by team pass attempts. `saveMetricReliability` throws if
`weightingScheme` is missing — a caller cannot accidentally write an
anonymous, incomparable row.

**Existing consumer checked before writing anything**: `fitK` is reused
outside this file by `mlb-shrinkage-fit.js` (tested via `test/mlb-nrfi-
shrinkage.test.js`), which only reads `.k` and asserts no exact-shape check.
Re-run alongside this unit's suite (below) and confirmed still green — not
assumed safe from reading the code alone.

## Mutations

Base `shrinkage-fit.js` = `e1b41909ca37`. Each row applied alone from a clean
base via the sweep runner, hashed before/after, file restored at the end.

| # | mutation | result | first sweep | after rewrite |
|---|---|---|---|---|
| M1 | `saveMetricReliability` stops requiring population/metric/weightingScheme | 1 fail | **survived, 0** | 1 fail |
| M2 | stops validating the fit shape (finite icc/k) | 1 fail | **survived, 0** | 1 fail |
| M3 | the upsert's `ON CONFLICT` stops updating (`DO NOTHING`) | 1 fail | **survived, 0** | 1 fail |
| M4 | `loadMetricReliability`'s `WHERE` drops the `weighting_scheme` filter | 1 fail | **survived, 0** | 1 fail |
| M5 | `allMetricReliability` stops ordering by `fitted_at` | 1 fail | 1 fail | 1 fail |

**Four of five rows survived the first sweep at 0 fail — every one of them a
test passing for the wrong reason, not a weak mutation, the same pattern
established repeatedly this session on other files (most recently L13/L14 on
`league-config-verification.js`) but the widest count of survivors in one
sweep so far:**

- **M1/M2**: `nfl_metric_reliability`'s own `NOT NULL` columns (`population`,
  `metric`, `weighting_scheme`, `icc`, `k`) throw a SQLite constraint error
  when the JS-level guard is removed and a required field is missing or the
  fit shape is malformed — so a bare `assert.throws(() => ...)` with no
  message match passed either way, testing "the database eventually
  complains," not "this function's own validation fired." Closed by matching
  each `assert.throws` on the specific error message text
  (`/requires population, metric and weightingScheme/`,
  `/requires a fitK\(\) result with a finite icc/`), which only the
  function's own guard — not a downstream SQLite error — produces.
- **M3**: the original test asserted only `COUNT(*) === 1` after saving the
  same key twice. `ON CONFLICT DO NOTHING` also keeps the count at 1 — it
  just leaves the FIRST fit's numbers stored forever instead of updating them,
  which a row-count check can't see. Closed by saving two fits with visibly
  different `icc` under the same key, then asserting the loaded row carries
  the SECOND fit's numbers, not the first's.
- **M4**: the original test asserted only that two rows existed for two
  weighting schemes on the same metric — true whether or not
  `loadMetricReliability` reads the `weighting_scheme` column back correctly,
  since `.get()` (via this repo's `row()` helper) still returns *a* row
  either way. Closed by saving two fits with visibly different `icc` under
  two different schemes, then asserting `loadMetricReliability` returns each
  scheme's OWN value, not whichever row SQLite happened to pick first.

Re-swept after the rewrite: 5/5 rows caught, 0 survivors.

## Numbers

RED (`150fa04`): 6 of 8 tests failed as expected (the three persistence
functions didn't exist); the table-exists check and one validation test
passed — the latter for the wrong reason (see M1/M2 above), corrected before
mutation testing, not left as a false-positive pass.

GREEN, before the mutation-driven test rewrite: 8 tests, 8 passed. After
adding the fit-shape validation test and rewriting the upsert/weighting-scheme
tests to pin real behavior: **9 tests, 9 passed, 0 failed** in
`nfl-metric-reliability.test.js`. `shrinkage-fit.test.js` (9) and
`mlb-nrfi-shrinkage.test.js` (4) re-run alongside: 19/19 total, unaffected.

Full local check `npm run check` on `effk`, this commit (staged before the
run, `git write-tree` = `26f31e37b36c06da8ce4726716468c76c9a6e53b` immediately
before `npm run check` started): exit 0 — **3,025 tests, 2,984 passed, 0
failed, 41 skipped**; typecheck, lint and build clean; `start:smoke` passed
on an isolated database (32 teams). Delta from the prior full-check baseline
(3,016/2,975/0/41, this branch's `9e2f079` commit): exactly **+9/+9/0/0**,
matching this unit's own new test count precisely.

**Isolation, stated rather than implied:** source-isolated — one working
tree, shared `node_modules`, no install during the run.

## The five questions

**Is this well built?** A table matching R&D's own column list exactly, an
explicit and stated design choice (current-measurement, not version history)
where the spec text was silent, and a non-nullable `weighting_scheme` that
makes the invalid comparison R&D's first pass made structurally impossible
to persist, not just discouraged in a comment.

**Is this based on stats, or is it made up?** The persistence layer carries
whatever `fitK` measures; nothing here invents a number. The design choice
(upsert vs. version history) is a judgement call, stated as one rather than
presented as the spec's own requirement.

**How do we know?** Five mutations, four survivors at first pass — the
widest survivor count in one sweep this session — each one closed by
identifying exactly what the original test could not distinguish (a
downstream constraint from the guard itself; row presence from row
correctness) and rewriting to pin the real guarantee.

**Should this data be pointed anywhere else on the platform?** Yes — per
R&D's spec, item 19 (uncertainty UI) reads interval width from `icc`, item 20
(the why engine) picks which of its clauses to lean on, item 14 (luck
decomposition) gets `sigma2_between`/`sigma2_within` directly. None of that is
wired yet; this unit only gives them something to read from once step 3
populates real rows.

**How does it unify?** Same table shape for every metric R&D measured
(volume, share, efficiency, NGS and pbp alike) — one place to check "do we
trust this number" for anything the model touches, once step 3 fills it in.
