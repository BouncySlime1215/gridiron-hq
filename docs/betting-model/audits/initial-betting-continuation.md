# Gridiron HQ betting model: recovered handoff and continuation

September 14, 2026. Scope: NFL game prediction and betting only. This is an assessment and implementation specification, not a completed model rebuild or evidence of profit.

## What actually finished

Claude's `nfl-learned-model-rebuild-design` workflow returned four inventories: evidence gates, data, existing learners, and market/target analysis. Its design, adversarial critique, and revised specification **all failed at the usage limit**. The workflow output explicitly records these failures despite the completion notification.

The separate methods sweep produced **14 reports and 13 structured verification reviews**. The open-source model survey has no completed verification result. The scale sweep has no completed reports in its journal: some workers failed and others stopped without delivering. No completed final synthesis was found. The earlier research2 directory survives, including methodology reports, code catalogs, and source papers.

The accompanying recovery archive preserves these documents and their source paths/hashes. Empty or incomplete worker outputs are not represented as completed research. Read the verification corrections before relying on a research report. The original reports are preserved unchanged and include mistakes corrected here.

Working repository inspected: `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard`, commit `43af933`. The GitHub-directory checkout has the same HEAD. Both were clean when inspected. No application code, live database, server process, model pointer, or bet settings were changed. Database checks used a direct read-only connection; application modules were not imported.

## Findings verified against today's code or database

| Finding | Evidence and consequence |
|---|---|
| Production forecast copies the market | 65/65 rows in `nfl_decision_events` have `is_market_identity=1`, `matching_calibration_missing`, and `calibration_not_proven`. This describes recorded decisions, not every historical experimental prediction. |
| Component gate never passed | 1,390 `nfl_ensemble_fit_artifacts` contain 43,090 component rows; zero have `residual_gate_passed=true`. `nfl-ensemble.js:1887` requires n≥250, RMSE gain≥0.03 and a computable DM p≤0.05, then zeroes failing components. |
| A real numerical defect silences specialists | `nfl-orthogonal-specialists.js:71` allocates observation weights by feature count. An isolated 40-row reproduction produced all-NaN coefficients. Changing the allocation to row count produced finite coefficients. The change was tested in isolation only; the repository remains unchanged. |
| Historical training counts were overstated | There are **7,276** completed home-game rows with scores and spreads in 1999–2025, not the inventory's stated 7,445. Two team rows must not count as two games. |
| Detailed history is much shorter | `nfl_play_by_play` has 254,191 rows spanning 2021–2026. `nfl_team_week_features` spans 2016–2025, with **zero 2026 rows**. Current predictions risk stale football inputs even though quote capture continues. |
| QBR feed contains corrupt season data | 520 rows labeled 2026 match 2025 rows on player/week/team and four statistical fields; 508 rows are labeled future weeks 2–18. Repair ingestion and quarantine affected source versions, including erroneous Week 1 copies; merely dropping future weeks is insufficient. |
| Frozen decisions are only partly wired | T−60 observations: one decided with a linked run, 13 frozen without a run, one scheduled. These counts do not establish why each remains frozen. `autoPickDecisionBoardForPacket` freezes the quote but reads game context and team features from live tables. |
| General revision store is empty | `nfl_feature_revisions` has zero rows. `nfl_pregame_snapshot_history` has 3,914 rows, but that is not a substitute for complete revision history of every feature. |
| Live neural model has no trained artifact | `nfl_online_neural_artifacts` has zero rows. Historical council neural experiments are a separate path. |
| Python tree libraries are already available | `research/.venv/bin/python` is Python 3.12.4; LightGBM, XGBoost, CatBoost, sklearn, pandas, scipy and TPOT are discoverable. Torch is absent. No installation is needed to start the tabular rebuild. Existing recorded runs also establish that these learners have executed before. |
| Tree tests were small, but not all 219 games | `server/data/tree-lab/latest.json` contains 1,795 market rows, not unique games. Its first movement folds use 219/215 games; later branches/folds reach 733. The 449 exclusions are reported as invalid/unpaired timestamp rows, not verified unique games. The extract explicitly restricts archive seasons to 2022–2025. |

The old tree results are negative evidence for the tested configurations. A small sample and limited features justify a better experiment; they do not establish that more data will make the model profitable.

## Remaining problem register

These items come from the recovered inventories, selected code checks, and existing evidence documents. Entries not independently reproduced in this review remain reported findings to validate during their implementation slice.

### Learning and model construction

1. Challenger-only flags exclude nine components without a normal promotion path. Convert their legitimate underlying information into candidate features; do not grant them betting authority automatically.
2. The production council is disconnected from the primary forecast. Some roles are support functions with no forecast; “19 experts” does not mean 19 independent predictive models.
3. The coordinator applies another significance gate before combination. Its reported split-half check uses even/odd rows, not chronological folds.
4. `MIN_SEASON=2015`, pre-2022 component calibration, and Week-5 feature/audit defaults exclude useful old data, recent recalibration, and early-season games respectively.
5. Many formulas use fixed scales; several market-derived components reuse the same information. Raw blending can pull a strong market forecast toward weaker estimates.
6. Existing specialists reportedly stack in-sample predictions, and some same-day news filters lack timestamp precision. Reusing their output blindly can introduce leakage.
7. Listwise feature deletion, current-season-only warmups, and unexplained residual clipping discard data. Replace missingness with explicit flags and priors where appropriate; preserve genuine data-integrity exclusions.
8. Neural epoch resets and whole-week settlement dependencies can strand training examples. Preserve historical evidence across epochs while separating incompatible feature/model versions.
9. Signal-reliability updates are disabled in production and their artifact store was empty in the inventory. Multiple controllers currently apply overlapping shrinkage or authority rules.
10. Forecast combination, joint-score, and specialist code is not equivalent to an approved learned pipeline. The joint-score report explicitly uses synthetic data and does not clear its stated gate. Validate any distribution on real chronological football data before reuse for prices.

### Data and time integrity

11. Scores/closing lines extend to 1999; raw plays, charting, player detail, and verified quotes do not. Backfill data by source and season, rather than just changing a year constant.
12. Older opening lines have mixed identities and provenance: contest lines, lookahead lines, and unresolved medians are not interchangeable with real opening quotes.
13. Some archive quotes are timestamped after kickoff; historical near-kickoff snapshots are sparse. Apply the actual decision cutoff, not merely “before kickoff,” when evaluating T−60.
14. Historical final weather is not a forecast. Use archived forecast vintages where available. Missing weather forecasts remain missing.
15. Injury rows are overwritten; absent publication/receipt times cannot be replaced with an assumed Friday timestamp and called verified history.
16. Imported ratings, retrospectively generated QB values, full-season coach game counts, Hi/Lo ratings, actual starters, and late-revised feature aggregates can encode the future. Audit each field, not just the enclosing table's timestamp.
17. Derived vectors/cards with thousands of features and a cutoff label need lineage checks. A hash proves identity, not historical availability.
18. Current-season team feature refresh and QBR season validation need fixing before claiming that the system adapts to current football.

### Serving, evaluation, and betting

19. Quote-only freezing is insufficient for reproducibility. Freeze feature values, model artifact identity, preprocessing and calibrator, alongside the quote.
20. Calibration identity differs between historical raw/closing and live market-residual modes. Preserve identity checks and generate matching calibration; do not bypass the check.
21. Several policy/staking thresholds conflict: 200 versus 250 observations, fixed edge/disagreement limits, and a 24-point prediction-width ceiling versus observed 32–33-point widths. Outcome unpredictability is not the same as uncertainty about expected advantage.
22. Recorded staking remains disabled. Enabling units or deleting gates cannot create predictive value.
23. 2021–2025 has been repeatedly inspected. It is development data, including when tested by a chronological “blind audit.” A new model cannot acquire prospective evidence retroactively.
24. Trial history is incomplete. Record every new feature set, tuning choice and failed candidate, not just survivors. Multiplicity corrections cannot reconstruct forgotten experiments or erase prior selection.
25. Point accuracy alone cannot establish betting profitability. Need probabilities at the exact handicap, push treatment, attainable prices, fees where relevant, realistic fills, correlated exposure, and independent settlement/CLV grading.
26. More plays improve estimates of football processes; they do not create millions of independent game outcomes. Cluster validation by game/week across every model level.

## Decisions for the continuation

**Keep:** Python labs and their useful chronology checks; rating/football feature definitions; quote tape and provenance contracts; decision ledger; forecast-combination and purged-evaluation infrastructure; existing simulation as a separately evaluated candidate; leakage/drift checks; price shopping and execution records.

**Replace or repair:** broken numerical routines, duplicated extraction logic, cutoff-unsafe fields, gate-before-combination architecture, and fragmented train/serve paths. Keep old modes for comparisons. Do not delete historical evidence.

**Defer:** transformers, graph networks, foundation models, a new giant expert council, and new automatic staking. Their value has not been demonstrated here, and the scale-up research was not completed. Player and play models belong in the design, but add them in measured increments after a complete baseline pipeline works.

### One shared information contract

Each example needs canonical game ID, market, cutoff, information regime, source observation IDs, feature values, missingness/age, feature-schema hash, and label availability time. Each model artifact needs training cutoff, source/code hashes, feature order, preprocessing, seed, fitted parameters and calibration identity.

Historical reconstruction and actual prospective capture must have distinct labels. An old downloaded record with a plausible event date is not proof that our app had that exact value at the time. The event and knowledge clocks must both be handled; point-in-time joining is the relevant pattern. [Feast documentation](https://docs.feast.dev/getting-started/concepts/point-in-time-joins).

Separate three uses of history:

- **Football training:** learn team strength and score/margin/pace from earlier results and legitimate football features; use broad history, with era handling and available-feature masks. No opening quote requirement.
- **Decision-time betting:** train/evaluate residuals against a real quote available at the declared cutoff. Spread target is home margin plus the home spread; total target is total points minus quoted total. Final forecast is the decision-time market baseline plus the learned correction.
- **Closing-line diagnostics:** use the close as a benchmark or future movement label. Closing-only history can support research, but cannot calibrate an earlier-price betting claim by pretending it was T−60 data.

A separate movement model may predict the later close from earlier information. Its CLV results remain separate from outcome evidence; do not count both as independent observations of the same latent edge.

### Initial learner

Use the existing Python environment. Start with a regularized linear baseline and **one** shallow LightGBM candidate. This is an implementation choice to limit experiments, not a claim that LightGBM won the earlier tests. Retain other libraries for later bounded comparisons.

Begin with a manageable set of football summaries: offense/defense efficiency, pace, opponent-adjusted strength, lagged QB/player usage, availability, rest/travel, weather forecasts and legal market information. Existing formula predictions may enter as features only when every underlying fit is earlier than that example. Missing detail must not delete otherwise useful old games from the football task.

Fit preprocessing, feature selection, early stopping, hyperparameters and calibration only within earlier training folds. A shared preprocessing/scoring implementation prevents training and serving from disagreeing. [scikit-learn leakage guidance](https://scikit-learn.org/stable/common_pitfalls.html).

Use chronological out-of-fold predictions to learn a small regularized combination including the market/zero-residual baseline. Accept that it can choose essentially zero model influence. No nontrivial combiner can guarantee it will never underperform the market on future games.

### Training and scoring

Use weekly outer prediction origins, whole-game/week grouping, and labels actually available before each fit. Tune on earlier inner origins, with a small declared search budget. Early stopping cannot see the outer week. Fit scalers and all upstream player/team models inside these boundaries too.

After a clean configuration is chosen, refit on all eligible prior data using the selected stopping/settings policy. Preserve original out-of-fold predictions for evaluation and calibration rather than replacing them with fitted values. Purge unresolved labels; do not impose an arbitrary embargo that throws away settled data without a reason.

Report market versus learner on the same eligible games, coverage by season/horizon, margin/total error, log loss, Brier score, calibration, push/key-number behavior, CLV and price-based paper returns. Record all attempts. Repeated model selection can create apparent gains as large as real algorithm differences. [Cawley and Talbot, 2010](https://jmlr.org/papers/v11/cawley10a.html).

Future validation starts only after the model/protocol is frozen and predictions are recorded before games. Already viewed 2026 games are not an untouched holdout. CLV is useful monitoring, not a promise of profit after a few weeks.

### Probability and authority

Price each offered line from a calibrated distribution with win/loss/push probabilities. Reuse existing discrete-margin machinery only if its real-data comparison supports it. Simulation must not manufacture confident probabilities by being forced to unvalidated means.

Keep prediction separate from betting permission. Use regularization to control learning; retain hard checks for illegal timestamps, unavailable executable quotes, corrupt artifacts and numerical failures. Bet selection uses estimated return at the actual price, uncertainty and existing exposure limits. Consolidate duplicate authority rules under one versioned policy after calibration is demonstrated. This specification does not authorize changing live stakes or placing bets.

## Ordered implementation slices and acceptance criteria

| Order | Concrete work | Completion evidence |
|---|---|---|
| 1. Repair substrate | Fix `nfl-orthogonal-specialists.js` allocation with a real regression test and artifact-version change. Trace and repair QBR ingestion; quarantine corrupt rows in research extracts. Restore current-season team-feature production. | Finite coefficients on more rows than features; known stale QBR copies rejected; 2026 feature freshness and source games verified. Existing stored artifacts are not silently relabeled. |
| 2. Shared dataset | Extend `research/betting/nfl/dataset.py` or a sibling common builder, replacing duplication in tree/market labs. Export broad football and quote-qualified betting datasets separately. | One row per game/cutoff contract; count/missingness report; future-row mutation cannot change earlier features; old games survive missing market-detail columns. |
| 3. Historical backfill | Add idempotent, season-bounded ingestion using existing nflverse loaders where possible. Start with missing historical team/player aggregates; expand raw plays when needed for a specific feature. | Source manifest/checksums, duplicate-safe reruns, era coverage report, prior-game-only aggregation. Do not run a giant uncontrolled download first. |
| 4. Bounded learner run | Adapt `research/tree_lab.py` to ridge and shallow LightGBM on the shared datasets. Save all out-of-fold forecasts and fitted artifacts. | Completed walk-forward comparison against zero residual/market and existing model; no outer-fold tuning; failures and no-edge results retained. |
| 5. Distribution/calibration | Reuse `forecast-combination.js`, cover/total calibration and discrete distribution interfaces with corrected chronological inputs. | Held-out probabilities sum to one, correct push handling and signs, identity matches the exact learner/data/horizon; report negative findings. |
| 6. Complete serving path | Extend `nfl-t60-packet.js` to freeze actual feature values and model references. Wire a new learned candidate through `nfl-auto-picks.js`, `nfl-ensemble.js` adapter, and `server/betting/nfl/strategy/t60-runner.js`. Prefer Python scoring with the same saved pipeline first; any later JS export requires parity tests. | One packet → one forecast → one recorded decision/abstention. Changing live tables after freeze does not change its answer. Crash/retry is idempotent; missing artifact fails explicitly. |
| 7. Replay and prospective comparison | Adapt `nfl-replay.js`, `nfl-blind-audit.js` and existing evaluation tools to the same candidate entry point. Freeze the protocol and run future shadow predictions. | Same packet/artifact yields the same forecast in replay and serving; no real stakes enabled; complete prediction/settlement/CLV lineage and missing-game reasons. |
| 8. Add hierarchy incrementally | Train player availability/usage and play/drive processes, aggregate to team-game features, then evaluate additions to the working baseline. Revisit deeper architectures only after measured incremental value. | Earlier-only upstream predictions, full-pipeline ablation, game/week uncertainty and compute cost; no synthetic plays counted as independent betting evidence. |

**First useful delivery:** a repaired data path plus one learned candidate trained on appropriately broad football history and honestly priced market history, connected to a reproducible shadow decision. This is the practical next milestone; another broad research sweep is unnecessary to start it.

## Limits of this review

The four inventories cover a broad problem surface; this review did not independently rerun every historical audit, test every module, or reverify every paper. Current counts differ from older snapshots because live capture continues. The direct read-only checks and isolated numerical reproduction establish the headline defects; the recovery archive retains the rest of the evidence and its uncertainties for implementation.

The proposed continuation improves the chance of getting a meaningful answer about predictive value. Neither more data, fewer learning gates, nor more elaborate models establishes profitability.
