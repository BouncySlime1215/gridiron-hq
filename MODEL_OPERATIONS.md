# Model Operations Protocol

Gridiron HQ treats the sportsbook market as the production baseline until a challenger proves incremental value on unseen data. Historical ROI alone cannot promote a model.

## Evidence lifecycle

1. A feature contract declares its source, availability rule, cadence, freshness limit, missing behavior, and leakage risk.
2. Pregame inputs are written as immutable, content-addressed evidence manifests.
3. Predictions, abstentions, model version, quote, and feature snapshot are recorded before the event.
4. Evaluation is chronological. Discovery, validation, and holdout periods never overlap.
5. A one-time holdout can open only after validation passes.
6. Champion/challenger promotion requires every gate in one immutable audit to pass.

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
- `GET /api/mlb/operations`
- `POST /api/mlb/operations/audit`
- `GET /api/mlb/model/calibrations`
- `POST /api/mlb/model/calibrations/:market`
- `POST /api/mlb/operations/promote/:auditId`

Promotion endpoints reject blocked audits. This makes a UI or API mistake incapable of bypassing the evidence standard.
