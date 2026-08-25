# Model Operations Protocol

Gridiron HQ treats the sportsbook market as the production baseline until a challenger proves incremental value on unseen data. Historical ROI alone cannot promote a model.

## Evidence lifecycle

1. A feature contract declares its source, availability rule, cadence, freshness limit, missing behavior, and leakage risk.
2. Pregame inputs are written as immutable, content-addressed evidence manifests.
3. Predictions, abstentions, model version, quote, and feature snapshot are recorded before the event.
4. Evaluation is chronological. Discovery, validation, and holdout periods never overlap.
5. A one-time holdout can open only after validation passes.
6. Champion/challenger promotion requires every gate in one immutable audit to pass.

## Evidence daemon and research controls

The evidence daemon plans immutable capture windows at first observation, T-24h,
T-6h, T-60m, T-15m, and near close. It runs every five minutes, groups work by
NFL week and MLB slate date, and records each window as `queued`, `captured`, or
`partial`. A partial record is useful context evidence but not a real-price or
CLV observation; it retries after the feed returns.

The daemon never backfills a past event. It also rejects source rows timestamped
after the capture cutoff, quarantining only that source row rather than silently
admitting leakage or stopping every other capture.

Advanced analytics are research controls, not production inputs: chronological
conformal uncertainty intervals, partial-pooled season bias, regime drift,
market-movement snapshots, red-team invariants, and a paper-only shadow ledger.
None can change a selection, stake, or champion state until a preregistered
experiment independently clears the promotion gates.

## NFL promotion gates

- The nested market-residual challenger must improve unseen margin accuracy over the sportsbook line.
- Cover calibration must beat no-vig market probability on chronological folds.
- The exact production policy must have positive ROI and at least 75% estimated probability that ROI is positive.
- At least 250 settled forward decisions must exist.
- Average closing-line value must be positive.
- Current pregame snapshot coverage must include all 32 teams.

Feature-family ablations are diagnostic only. Results from an already opened period may remove a broken input, but cannot promote a tuned family combination.

## MLB promotion gates

NRFI/YRFI, pitcher strikeouts, and batter total bases qualify independently. Each requires:

- 500 cutoff-valid historical predictions.
- Calibration slope from 0.85 through 1.15 and expected calibration error no greater than 0.03.
- Better Brier score than the no-vig market probability.
- 150 settled forward predictions.
- 150 forward predictions with real stored prices.
- Positive closing-line value.

Missing confirmed lineups, probable starters, pregame snapshots, or real quotes cause an abstention. Retrospective rows remain quarantined and never contribute to ROI.

## Operational endpoints

- `GET /api/nfl-market/operations`
- `POST /api/nfl-market/operations/audit`
- `POST /api/nfl-market/operations/ablations`
- `POST /api/nfl-market/operations/promote/:auditId`
- `GET /api/nfl-market/intelligence`
- `GET /api/nfl-market/evidence/status`
- `POST /api/nfl-market/evidence/capture`
- `GET /api/mlb/operations`
- `POST /api/mlb/operations/audit`
- `GET /api/mlb/model/calibrations`
- `POST /api/mlb/model/calibrations/:market`
- `POST /api/mlb/operations/promote/:auditId`
- `GET /api/mlb/intelligence`
- `GET /api/mlb/evidence/status`
- `POST /api/mlb/evidence/capture`

Promotion endpoints reject blocked audits. This makes a UI or API mistake incapable of bypassing the evidence standard.

## Persisted registry and release commands

The production registry is `GET /api/model/registry`. Its mutation endpoints
require a persisted bearer session and a persisted `model_permissions` grant
(`model:train`, `model:promote`, `model:execute`, or `model:*`); client-supplied role headers
are never accepted. NFL/MLB research experiment tables remain supported analytics
inputs but are not production pointers. Only `model_production_pointer` and
`model_promotion_history` represent production state.

Use an explicit database path for reproducible release work:

```sh
GRIDIRON_DB_PATH=/absolute/path/gridiron.sqlite npm run db:migrate
GRIDIRON_DB_PATH=/absolute/path/gridiron.sqlite node server/platform/provision-auth.js --subject operator@example.com --league-id 1 --role commissioner --model-permissions model:train,model:promote --draft-team 7:1
GRIDIRON_DB_PATH=/absolute/path/gridiron.sqlite npm run db:rollback -- 007_model_permissions_and_upgrade_guard
GRIDIRON_DB_PATH=/absolute/path/gridiron.sqlite npm run db:rollback -- 006_identity_and_draft_authorization
GRIDIRON_DB_PATH=/absolute/path/gridiron.sqlite npm run db:rollback -- 005_model_registry_integrity
GRIDIRON_DB_PATH=/absolute/path/gridiron.sqlite npm run db:migrate
```

Rollback is deliberately one migration at a time, refuses an unexpected target,
and runs the migration `down()` plus migration-record removal in one transaction.
Back up the SQLite file (including `-wal` and `-shm` companions when present)
before a production rollback. Migration verification runs `foreign_key_check`.

Migration 007 explicitly records pre-authentication drafts in
`legacy_draft_quarantine`. Assign each quarantined draft with the provisioning
command's `--draft-team draftId:slot`; that command attaches its league, owner,
and removes the quarantine record in one reproducible operation.

The registry accepts only content-addressed observation datasets. The supported
HTTP backtest runner is currently `mean_baseline`; unsupported candidate types
are rejected clearly. It derives metrics and promotion gates server-side and
does not accept caller-supplied completion status, results, or gates.
