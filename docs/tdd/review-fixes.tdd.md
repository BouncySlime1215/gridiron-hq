# TDD evidence: review-fixes

Source: the step-1b review panel's findings (one reviewer per installed skill plus
silent-failure-hunter and mle-reviewer), handed over as a list of 31 critical, high
and medium findings on 9a7a809..79dbeb1. Journeys were derived from those findings
during this run. Gates for this item were written before any fix, in
`scratchpad/step1b/review-fixes/GATE.md`: this item moves no fitted constant, no gate
threshold and no number a user sees today; anything that would is deferred with the
gate it needs.

Runner (every command below):

    GRIDIRON_DB_PATH="$(mktemp -u "${TMPDIR:-/tmp}/gridiron-test-XXXXXX").sqlite" SCHEDULER_DISABLED=1 \
      NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks --test \
      --test-concurrency=1 <file>

## 1. The scheduled weekly retrain kept undoing the early-week blend (high)

Journey: as Nick, I want weeks 2-4 to keep using the structural-only projection
after the automatic retrain runs, so that a player's week-2 number is not 80% his
week-1 score again.

Found two defects, both reproduced:

1. `retrainWeeklyWeights` saved a promoted fit with the four per-position vectors and
   no `early` block, so the next week's `activeWeeklyWeightSet` served no early
   buckets.
2. It fit and graded the per-position vector on settled week 2-4 rows, where
   production never serves that vector. The live table's only settled rows will be
   2026 week 2 (1,183 rows). The RED run shows what would have happened: the
   candidate `[1,0,0,0,0]` fit on week-2 rows beat fit-1's vector (MAE 0 vs 3.58 on
   the synthetic rows), was promoted with no `early`, and would have been served at
   weeks 5-18.

Fix: `saveWeeklyFit` carries the newest stored early block onto any promoted fit
that has none (the invariant lives in the store, so no caller can drop it), and the
retrain drops rows inside the stored early window before fitting and grading. The
pass rule (player-clustered paired bootstrap, rank, coverage band, sizes) is
unchanged. The fix the early-week TDD doc suggested,
`carryEarlyWeights(candidate, champion.weights)`, would not have worked: the champion
is read at a week-5+ row, where `early` has already been stripped.

| # | What is guaranteed | Test | Type | RED (3034218) | GREEN |
|---|--------------------|------|------|---------------|-------|
| 1 | A promoted retrain keeps the stored early buckets for weeks 2-4 | `weekly-retrain-early-carry.test.js: a promoted weekly retrain keeps the stored early-week buckets` | integration | FAIL (`early` undefined) | PASS |
| 2 | `saveWeeklyFit` carries `early` onto a promoted fit without one; a rejected fit is stored as evaluated | `...: saveWeeklyFit carries the newest stored early block...` | unit | FAIL | PASS |
| 3 | Week 2-4 rows neither fit nor grade the per-position vector; with only week-2 rows nothing is trained or stored | `...: settled rows inside the early-week window...` | integration | FAIL (promoted a week-2 fit) | PASS |
| 4 | Rows outside the window still train (650 of 650 used, 180 week 2-4 rows ignored) | `...: rows outside the window still train...` | integration | FAIL (sample 830) | PASS |

Regression: `model-integrity` 94/94, `weekly-early-week-blend` 19/19,
`weekly-prediction-snapshot-mode-migration` 3/3.
