# Point-in-time ML architecture for Gridiron HQ (single Node process + SQLite)

This builds on earlier research reports F05 (bitemporal data), F18 (audit consolidation), GF05 (backtesting frameworks) and FIX_AND_ADD_ARCHITECTURE items 28, 32, 36 and 37. I read the repo without changing anything.

## 0. What the repo actually has (checked against the code and a read-only DB query)

- **The bitemporal store exists but is empty.** `nfl_feature_revisions` has three clocks (`published_at`, `observed_at`, `valid_from`) plus a provenance field (captured / reconstructed / derived). The logic is in `server/services/nfl-bitemporal.js`. The table has **0 rows**.
- **Injuries are not bitemporal, contrary to the brief.** `nfl_injuries` has `PRIMARY KEY (season, week, gsis_id)` and only a `modified_at` column. A new value overwrites the old one.
- **`game_lines` is one mutable row holding everything.** It mixes pre-game inputs (`spread`, `open_spread`), the closing line (`closing_spread`) and the labels (`team_score`, `opp_score`). Any feature code that reads it can leak the future.
- **The decision tape is correct but barely used.** `nfl_decision_runs` and `nfl_decision_events` (migration 027) are append-only, enforced by triggers, and log every candidate. There are 49 events so far.
- **A tested model registry already exists** (`model_registry`, `model_experiments`, `model_production_pointer`), per F18. `assertTimestampedObservation()` in `server/modeling/contracts.js` checks for future data, but only the fantasy pipeline calls it.
- **A real silent wiring break just happened.** Migration 051 documents a `mode` column added to a frozen schema file. The live DB never got the column, so the next weekly capture would have thrown an error. This is exactly what contract tests are meant to catch.

## 1. What the literature says

1. **Point-in-time joins need two clocks.** Feast by default filters only on event time. The created timestamp is used just to break ties, so "a value that was backfilled or corrected later" can leak. Feast now offers `filter_by_created_timestamp=True`, which adds `created_timestamp <= entity_timestamp` and drops NULLs. This updates F05's warning, which said feature stores ignore the second clock. Source: https://docs.feast.dev/getting-started/concepts/point-in-time-joins
2. **"Time travel" is the classic way features leak.** Breck, Polyzotis, Roy, Whang and Zinkevich (SysML 2019) describe features read from a table that keeps changing, so training sees values that were not there at serving time. They name three kinds of skew between training and serving:
   - feature skew;
   - distribution skew;
   - scoring/serving skew, where only the items acted on get labels.

   To detect drift they chose d∞ = max|pᵢ−qᵢ| over chi-square tests. In their test, chi-square raised a false alarm 7 times out of 10 after only 0.01% of the data was changed. Source: https://mlsys.org/Conferences/2019/doc/2019/167.pdf
3. **Zinkevich's Rules of ML:**
   - #29: log the features used at serving time and train from that log.
   - #31: joined tables change underneath you.
   - #32: reuse the same code for training and serving, and avoid using different languages for each.
   - #37: measure the gap between training and serving.

   Source: https://developers.google.com/machine-learning/guides/rules-of-ml
4. **Chronon (Airbnb) measures consistency directly.** It logs what was fetched online, reruns the offline join with that log as the input, and reports the mismatch rate, missing/extra rates and SMAPE for each feature. Source: https://chronon-ai.pages.dev/Online_Offline_Consistency
5. **Kapoor & Narayanan (Patterns 2023)** list 8 types of leakage, found across 294 papers in 17 fields (https://arxiv.org/abs/2207.07048). Two matter most here:
   - L1.2: preprocessing fitted on train and test together, such as scaler statistics.
   - L3.1: temporal leakage.
6. **Validation method.** Tashman (IJF 2000) recommends rolling-origin evaluation with recalibration (https://doi.org/10.1016/S0169-2070(00)00065-0). Cawley & Talbot (JMLR 11, 2010) show that tuning model settings on the evaluation data biases the result by amounts comparable to the differences between algorithms (https://jmlr.org/papers/v11/cawley10a.html). So tuning has to happen inside each walk-forward step.
7. **Registries, and why piecemeal pipelines fail.** MLflow uses auto-incrementing versions linked to the run that made them, plus movable aliases such as `champion` (https://mlflow.org/docs/latest/ml/model-registry/). Sculley et al. (NeurIPS 2015) name "pipeline jungles" and "undeclared consumers"; F18 cites this.
8. **When nflverse data becomes available** (https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html):
   - Play-by-play: nightly after game days.
   - NGS: 3–5 AM ET.
   - PFR advanced stats and depth charts: 07:00 UTC.
   - Snap counts: every 6 hours.
   - Injuries: "not currently available for 2025".
9. **`node:sqlite` is at stability 1.2 (release candidate) in Node 25.7.** It provides `backup()`, `database.function()` and `createSession()`/`changeset()`. Source: https://nodejs.org/api/sqlite.html

## 2. Design: tables (each layer is append-only unless marked)

**L0 Raw.** Existing source tables stay as they are. Add `ingest_batches(batch_id, source, requested_at, received_at, provenance, content_hash)`.

**L1 Facts: fill the existing `nfl_feature_revisions`.** Add three columns:
- `knowable_at`, computed once and stored.
- `supersedes_revision_id`.
- `availability_policy_id`.

Add `availability_policy(source, rule, delay, version)`.
- For **captured** rows: `knowable_at = max(observed_at, published_at + delay)`.
- For **reconstructed** backfill: `knowable_at` comes from the policy alone. Example: PBP for a game = next 12:00 UTC after the game, per the nflverse nightly schedule. Set these conservatively.

Every revision is tagged with its provenance, and backtests report results separately by provenance.

**L2 Features.**
- `feature_defs(name, version, grain, inputs_json, code_hash, max_staleness)`
- `decision_points(game_id, kind ∈ {open, T-60, close}, cutoff_at)`
- `feature_vectors(game_id, kind, cutoff_at, feature_set_version, vector_json, vector_hash, max_input_knowable_at, mode ∈ {backfill, live}, computed_at)`, with `CHECK(max_input_knowable_at <= cutoff_at)`.

One function, `buildVector(db, game_id, cutoff_at, fsv)`, is the **only** path. The backfill, the walk-forward and live serving all call it. It reads only through `asOf(entity, feature, cutoff)`, which returns the newest revision with `knowable_at <= cutoff`. Borrow Feast's dedup ordering: rank by event time descending, then created time descending. Index on `(entity, feature, knowable_at)`.

**L3 Labels.** `labels(game_id, kind ∈ {margin, total, cover}, value, settled_at, source, revision)`, kept physically separate from `game_lines`. Closing lines are also stored as facts, with `knowable_at` = kickoff.

**L4 Training and registry (reuse the existing registry tables).**
- `training_runs(run_id = sha256(stableJson({fsv, train_from, train_until, label_as_of, hyperparams, code_hash, seed})))`
- `model_artifacts(artifact_hash PK, run_id, blob_json)`. The blob holds coefficients, scaler statistics fitted on the training rows only, feature order and the chosen λ.
- `model_aliases` plus a history table.

Use the existing `stableJson`/`configurationHash` as the single hashing module (FIX item 32).

**L5 Predictions.** `predictions(prediction_id, game_id, kind, cutoff_at, artifact_hash, vector_hash, mean, sd, quantiles_json, mode ∈ {live, walkforward}, served_at)`. The vector is logged when served (Rule #29).

**L6 Decision tape.** Extend the 027 tables with:
- `prediction_id` (foreign key);
- `quote_id` with its `received_at`;
- `gate_snapshot_json`, the exact out-of-sample metric values the continuous bet gate read;
- `stake`.

Every candidate still gets a row, bet or not.

**L7 Grades.** `outcome_grades(prediction_id | decision_event_id, metric ∈ {abs_err, log_score, crps, clv_pts, clv_prob}, value, graded_at, label_revision)`. CLV comes from the one shared CLV function (FIX item 28). Corrections are added as new rows that point to the row they replace; nothing is overwritten.

**L8 Evaluation and monitoring.**
- `eval_metrics(artifact_hash | alias, window, metric, value, n, week_clustered_ci)`
- `monitor_events(check, severity, culprit, value, at)`

## 3. Jobs (in the existing `server/platform/jobs.js`, one process)

| Job | Trigger | Input to output | Refuses to run when |
|---|---|---|---|
| J1 ingest | per source cadence | API → raw + `ingest_batches` | `received_at` is missing |
| J2 revise | after J1 | raw → `nfl_feature_revisions` (idempotent on `raw_hash`) | the source has no policy (reconstructed rows) |
| J3 materialize | at each `decision_points.cutoff_at` | revisions → `feature_vectors` (live) | the watermark shows a stale source; it logs `status=stale` instead of dropping the game |
| J4 retrain | weekly, once labels settle | labels with `settled_at <= now` + backfill vectors → run + artifact | the code hash is not committed |
| J5 predict | right after J3 | alias → `predictions` | the artifact's `fsv` differs from the vector's `fsv` |
| J6 decide | after J5 + quotes | → decision tape | the quote's `received_at` is after the cutoff |
| J7 settle/grade | after the game and the close | predictions/decisions + labels/close → `outcome_grades` | — |
| J8 audit | weekly | grades → `eval_metrics`; d∞ drift; freshness watermarks | — |
| J9 parity replay | nightly | recompute last week's live vectors in backfill mode; compare hashes; report Chronon-style mismatch rate and SMAPE | — |

**The walk-forward is J4 → J5 run in a loop, with no separate harness.** For each historical week origin T:
1. Train on labels with `settled_at <= T`.
2. Choose λ inside that window using only data before T.
3. Predict week T's games at their cutoffs.
4. Write with `mode=walkforward`.

This makes the "5–7 audit engines" problem go away by construction.

**Contracts between stages:**
- Every row carries its upstream hashes: vector → prediction → decision → grade.
- Every stage checks a `contract_version` and fails loudly on a mismatch.

## 4. Invariants (node:test, synthetic fixture DB plus a sampled read-only copy)

- **I1, future-perturbation test (the most important).** Pick a random (game, cutoff). Randomize or insert every revision with `knowable_at > cutoff` and rebuild: `vector_hash` must not change. Also randomize labels with `settled_at > T` and test-fold feature values: `artifact_hash` must not change. This covers L3.1 and L1.2.
- **I2.** `max_input_knowable_at <= cutoff_at` for every vector (CHECK constraint plus a query).
- **I3, parity.** J9 mismatch rate = 0 for hashes, and SMAPE is under tolerance for numeric fields.
- **I4, reproducibility.** Re-running a `training_runs` spec produces the identical `artifact_hash` (deterministic Cholesky solve, seeded).
- **I5.** UPDATE or DELETE on predictions, artifacts, decision tables and grades aborts with RAISE(ABORT).
- **I6, no orphans.**
  - Every decision event has a prediction.
  - Every prediction has an artifact and a vector.
  - Every settled, predicted game is graded within 48 hours.
- **I7, denominator.** Decision events per decision point = eligible markets (guards against scoring/serving skew).
- **I8, schema contract.** Every column each stage writes exists in the live DB (catches the migration-051 class of bug).
- **I9, static lint.** Feature modules may not reference `labels`, the score or closing columns of `game_lines`, or `nfl_injuries` directly; they read only through `asOf`.
- **I10.** The code hash stored on walk-forward predictions equals the live serving code hash for the same `fsv`.
- **I11.** NULL or unparseable timestamps are rejected. `bitemporal.js` already guards against a NULL date turning into 1970.

## (A) Key findings

1. Point-in-time correctness needs event time and knowable time as separate filters. Feast's default does not do this; it has to be switched on (Feast docs).
2. Time-travel feature skew and label selection bias are the standard failure modes; d∞ is a drift metric that suits small samples (Breck et al. 2019).
3. The training and serving paths must be the same code, and served features must be logged (Zinkevich Rules 29/31/32/37).
4. Consistency should be measured by recomputing with the logged inputs (Chronon).
5. Preprocessing and tuning must stay inside each fold (Kapoor & Narayanan 2023; Cawley & Talbot 2010; Tashman 2000).
6. Gridiron already has the building blocks: the three-clock store, the append-only tape and the registry. But the store is empty, and the key inputs (`game_lines`, `nfl_injuries`) are overwrite-in-place tables.

## (B) Recommendations

1. **Fill `nfl_feature_revisions` first.** Nothing downstream can be trusted while features read the overwrite-in-place tables directly.
2. **Use Node/JS only for features, fitting and scoring.** Ridge or Bayesian linear models with p ≈ 50–300 and n ≈ 7k games need only a Cholesky solve in JS, so no installs are needed. If the numpy fitting option is ever used, keep scoring in JS and add a parity test (Rule 32).
3. **Build the walk-forward on J4/J5 with an expanding window**, with λ tuned inside each origin.
4. **Report results split by provenance.** Only captured live predictions prove anything; reconstructed backfill supports research only.
5. **Make J1 and J2 the first milestone**, gated by I1 and I8, before any modeling work.

## (C) Adoptable code and repos

| Source | License | What to borrow |
|---|---|---|
| Feast `postgres.py` point-in-time join template (https://github.com/feast-dev/feast) | Apache-2.0 | The as-of ranking and TTL semantics, rewritten as SQLite window SQL; no dependency |
| Chronon (https://github.com/airbnb/chronon) | Apache-2.0 | The definitions of the consistency metrics (mismatch, missing/extra, SMAPE) |
| penaltyblog `backtest.py` | MIT (GF05) | Structural `lookback < date` slicing |
| sports-betting `backtest()` | MIT (GF05) | Rejecting splitters that are not time-ordered |
| In-repo: `nfl-bitemporal.js`, migration 027, `modeling/registry.js`, `contracts.js` | — | Extend these; do not replace them (F18) |

## (D) Open questions and risks

1. **Historical knowable times are policy guesses.** Nobody recorded when data actually arrived, and injury history is overwritten. The 2025 nflverse injuries feed is unavailable. The Pinnacle opening lines backfilled by migration 047 are reconstructed data.
2. **The exact posting time of opening lines, and stat corrections, are unverified.** Both need their own policies.
3. **As-of query speed on a 13GB DB is unmeasured.** Materializing vectors once per (game, cutoff, version) should keep it bounded, but benchmark it first.
4. **Monitoring is noisy with about 270 games a season.** Drift and parity alerts should be informational, not blocking. Only the parity mismatch rate (I3) should block.
5. **Capturing overwrites from the mutable tables** with `createSession()` changesets is possible, but I have not tested it on this DB.
6. **The node:sqlite API could still change**, since it is at release-candidate stability.