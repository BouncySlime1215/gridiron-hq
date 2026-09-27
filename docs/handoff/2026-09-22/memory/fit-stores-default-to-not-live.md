---
name: fit-stores-default-to-not-live
description: shrinkage_fits.active and weekly_ensemble_fits.promoted both DEFAULT 0, so a row count or a fitted-at stamp reads a model on its hardcoded fallback as fitted — and /api/model/status has that bug live.
metadata:
  type: project
---

Read from the DDL 2026-09-22 on 654ff93:

- `shrinkage_fits.active INTEGER NOT NULL DEFAULT 0` (server/db/schema/mlb-model-misc.js:677)
- `weekly_ensemble_fits.promoted INTEGER NOT NULL DEFAULT 0`, plus a
  `rejection_reason` column (same file, :784)
- `correlation_estimates.fitted_at` and `gamescript_model.fitted_at` are both
  **nullable** (server/db/schema/core-and-fantasy.js:494, :695)
- `gamescript_model.target` is the PRIMARY KEY, values `pass_att` / `rush_att`,
  so a model needs BOTH rows to be fitted

**Why:** a fit store full of rows with none active or promoted is a model
answering from its hardcoded fallback, behind a recent stamp and a healthy row
count. `weekly_ensemble_fits` stores its REJECTED candidates as rows, so a count
counts rejections as coverage. This is the empty-table-with-a-fresh-timestamp
failure one layer up, and neither a count nor a timestamp catches it.

**GET /api/model/status has that bug live.** At server/routes/model.js:598-599
(654ff93) `correlations_fitted` and `gamescript_fitted` are bare
`SELECT COUNT(*)` — no predicate on the nullable `fitted_at`, no check that
gamescript holds both targets. It reports a half-fitted game-script model and
undated correlations as fitted. routes/model.js belongs to the wiring map
thread; the scheduler thread only read it.

**How to apply:** a freshness or fitted rule for one of these stores must require
`active = 1` / `promoted = 1`, and for a weekly store that its `through_week`
reaches the week being served. Do not add a season rule to `shrinkage_fits` -- a
fit through the last completed season is the correct mid-season state, so
`through_season >= current` would raise a false alarm. The seven fit stores and
their rules live in `servedTables()` under grain `'fit'`; see
[[servedtables-is-coverage-not-timestamps]].

**CONFIRMED LIVE 2026-09-22 08:04Z:** `weekly_ensemble_fits` has ZERO promoted
rows and production has only ever served the frozen fallback. The predicted
failure is the actual state — see [[gridiron-no-promoted-fit-has-ever-run]].
