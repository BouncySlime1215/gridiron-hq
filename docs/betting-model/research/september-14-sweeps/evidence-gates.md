# NFL game model: every mechanism that withholds evidence

**Scope:** spread, total and moneyline. Everything was read-only. I queried `server/data.sqlite` only with `DatabaseSync(readOnly)` and imported no app modules. My scratch scripts are in the session scratchpad and are named `wi_*.mjs`.

**Labels used below:**
- **LEARNING** means the evidence never reaches the forecast.
- **BET AUTHORITY** means the model computes a number, but the number can't publish a pick or carry a stake.
- **Fires today** is a count from the live DB unless marked as a static reading of the code.

No `nfl-weekly-state*` file exists in `server/`. The closest file is `nfl-weekly-feature-store.js`, covered in item 23.

---

## Tier 1: removes all model signal from the served forecast

### 1. The residual gate makes production's forecast equal the market line (LEARNING, for the served number)
- **Where:** `services/nfl-ensemble.js:1887-1892` (gate), `:2057-2059` (fallback), `:2075` (identity flag). Production uses `blendMode: 'market_residual'` at `services/nfl-auto-picks.js:84` and `:275`.
- **Withholds:** every one of the 29 component forecasts. The raw joint-ridge blend is fitted, then thrown away in production.
- **Condition:** `residual_n >= 250 && residual_rmse_gain >= 0.03 && residual_dm_ok && residual_dm_p <= 0.05`. Challengers must also have `includeChallengers`. If nothing passes, the forecast is the market margin exactly.
- **Fires:**
  - **0 passes in 37,510 component-cutoff rows across 1,210 artifacts.** The earlier count of 848 artifacts / 26,288 rows was all pre-DM rows; the table has grown since.
  - Near misses: 16 rows met n, gain and DM-computable but failed p. Another 16 met gain and p but had n < 250.
  - The DM test couldn't be computed in 1,950 rows ("fewer than 2 paired observations" 1,764; "fewer than 2 forecast periods" 186). Those rows fail automatically.
  - Live: `nfl_decision_events` has 33/33 rows with `is_market_identity=1`, `edge_points=0`, `margin_models_active=0`.

### 2. Hand-coded formulas plus frozen calibration eras (LEARNING)
- **History cut:** `MIN_SEASON = 2015` at `nfl-ensemble.js:37`, used by `games()` at `:58`. This drops **4,248 settled games with closing spreads from 1999–2014**.
- **Calibration frozen before 2022:** `EVAL_FROM = 2022` at `:38`. `calibrate()` trains only on `season < min(2022, cutoff)` (`:1155`, `:1425`, `:1666`). Component points-per-unit slopes never learn from **2022–2026 (1,153 games)**.
- **Components with no fitted scale at all:**
  - colley ×55 at `:681`
  - pythagorean ×50 at `:693`
  - melo /25 at `:707`
  - massey, point_diff, recent_form and turnover_regressed use raw values + hfa
  - `turnover_regressed` hard-codes 0.6·70
  - `rest_travel` divisional penalty is −0.4
  - `weather_total` uses fixed `FLAT_WEATHER_POINTS` (`:447`)
  - `pace_total` uses 2.05/30 constants
- **Fallback scales:**
  - `fitLine` needs ≥100 pairs (`:1189`), else the hand scale (e.g. 65) applies. **84 of 1,210 artifacts (all 2016 cutoffs) had no feature calibration.**
  - The availability calibration is missing in **664 of 1,210 artifacts**, which then use `raw*1.2 + hfa` (`:658`). Where it exists, it has n = 270.
- **Raw-weight window:** `WEIGHT_FIT_FROM = 2018` (`:39`, `:1315`) keeps 2015–2017 (801 games) out of the raw weights. `RAW_BLEND_MIN_ROWS = 30` (`:1453`, `:1607`) falls back to equal weights. **168 of 1,210 artifacts (all 2016 and 2017 cutoffs) had all-zero weights.**
- **Negative coefficients clipped to 0** (`:1626`), e.g. zero margin weight for availability in 475/1,210, epa_neutral 466, situational 468, colley 462, rest_travel 436.
- **Other hard floors:**
  - `residual_slope` is null unless the fit block has ≥100 rows (`:1788`).
  - `marketRegression` needs ≥50 games (`:1010`).
  - A week is skipped when history < 100 games (`:1369`).
  - Efficiency features only exist from 2016 (`nfl_team_week_features` covers 2016–2025, 0 rows for 2026), so every 2015 game abstains on efficiency.
  - Injuries and snaps start in 2021.

### 3. The expert council and coordinator never reach production (LEARNING for production)
- **Where:** `nfl-expert-council.js` (every output has `authority:'historical_candidate_only'`), with no import in `nfl-auto-picks.js` or `nfl-ensemble.js`. Picks are frozen at 0 stake (`:670-678`).
- **Withholds:** all 19 experts and the learned coordinator. Only the audit pages and forward shadow rows consume them.
- **Fires:** always.

### 4. Coordinator Stage-A shrink gate, a binary 0-or-scale switch (LEARNING, inside the council)
- **Where:** `nfl-expert-coordinator.js:110` and `:127`.
- **Condition:** a role gets k = 0 unless it has ≥60 settled forecasts, t > 2, split-half crossGain > 0, and k > 0.
- **Fires (run 33, 909 ready games × 19 experts):** **k = 0 in 17,138 of 17,271 cells (99.2%)**.
  - 13,924 were "no walk-forward gain"; 3,214 were "fewer than 60".
  - Only rulebook (88 games), nfelo_line (29) and qb_state (16) ever got k > 0.
  - Coordinator `active_weight_l1`: median 0, p90 0.021. |forecast residual|: median 0.29.
- **Also:**
  - Warmup `MIN_GAMES = 128` / `MIN_WEEKS = 8` (`:24-25`, `:274`): 130/1,039 games abstained.
  - Caps: `MAX_WEIGHT = 0.35`, `MAX_TOTAL_INFLUENCE = 0.8`, intercept clamped to ±1 (`:209-216`), output clamped to ±10 (`:415`, `:442`).
  - Regimes need 96 games / 6 weeks (`:30-31`).

### 5. Orthogonal specialists are silently NaN, so `specialist_team` is always 0 (LEARNING; a bug, not a gate)
- **Where:** `nfl-orthogonal-specialists.js:71`: `let weights = Array(Z[0].length).fill(1)`. It is sized by column count (7), not row count, so `weights[i]` is undefined for i ≥ 7.
- **Effect:** `xtx` becomes NaN and every beta is null. I reproduced this standalone on real v2 team cards. The stored artifact through 2025 W18 also has all-null betas.
- **Fires (run 33):** 610/1,039 games had `forecast_residual` exactly 0 with every family inactive. The other 429/1,039 hit the `examples < 420` gate (`:163`; tune and report need ≥48, `:165-166`) and fell back to the legacy family median.

### 6. Nine `challengerOnly` components get zero weight (LEARNING in production)
- **Where:** `nfl-ensemble.js:663` (roster_strength) and `:736-771` (early_down_eff, pass_eff_matchup, rush_eff_matchup, explosive_pass, pressure_response, series_sustain, field_position, second_half_eff). They are excluded at `:1825`, `:1890`, `:2038`, `:2048-2049`, `:2055`, and in `nfl-auto-picks.js:164`.
- **Condition:** `includeChallengers` must be true. Only `shadow-ledger.js:16` and research replays pass it.
- **No promotion path:** nothing clears the flag.
- **Fires:** zero margin weight in 1,201/1,210 artifacts (the other 9 are all-inputs runs). These components have the **largest best-case residual RMSE gains** of any: explosive_pass 1.345, field_position 1.342, rush_eff 1.273, second_half 1.212.

---

## Tier 2: learners that exist but are starved

### 7. The production online neural net has never been trained (LEARNING)
- **Where:** `nfl-online-neural.js`.
  - Promotion: `promotion_sample: 128`, `promotion_weeks: 8`, CI90 lower bound > 0 (`:25`, `:285-287`).
  - Used only if `production_eligible` (`nfl-auto-picks.js:128`).
  - Trains only after every game in the week is final (`:303`).
  - Examples are filtered by the active learning epoch (`:161`, `:266`).
- **Withholds:**
  - All history. It learns only from forward captures, never from the 7,068 observed `deep_residual` audit examples.
  - Epoch-2 examples (32) were orphaned by the 2026-09-09 reset.
- **Fires:** 0 examples trained, 0 artifacts. It is a random cold-start network, `authority: shadow_only` in 33/33 decisions. 2026 W1 is blocked at 14/16 games final.

### 8. Council matchup specialists (LEARNING)
- **Where:** `nfl-matchup-specialists.js`.
  - `MIN_TRAINING_ROWS = 200` (`:32`).
  - Only the last 4 seasons are used (`:207`).
  - `FORECAST_CAP = 4` (`:35`).
  - Rows with |residual| > 45 are dropped (`:213`).
  - trench_continuity needs ≥2 current-season snap weeks with no prior-season borrowing (`:110`), so weeks 1–2 always miss.
  - Profiles need ≥2 current weeks or a prior season (`:76`).
- **Fires (run 33):**
  - trench_continuity: 176/1,039 missing (17%)
  - nfelo_line: 160/1,039
  - teamrankings_line: 352/1,039 (34%). Of these, 208 had no profile and 144 were under 200 rows.

### 9. Other council experts (LEARNING)

| Expert | Where | Condition | Fires (run 33) |
|---|---|---|---|
| deep_residual | `nfl-expert-council.js:287` | Only rows with schema `v2-verified-news` and the same vector length; same `auditRunId` only (`:280`) | 16 missing |
| boosted_tree | `:84` | ≥400 rows; rows missing any of 29 features are dropped listwise (`nfl-gbm.js`) | 0 missing |
| similar_games | `:98`, `:117` | ≥200 rows; shrink `n/(n+30)` | 0 missing |
| line_movement | `:217`, `:215`, `:224-226` | <120 rows means missing; \|move\| ≤ 14 and \|y\| ≤ 45 filters; slope and intercept clamped ±1, forecast ±6 | 0 missing |
| news_reaction | `:246` | Typed feed only exists from 2026-08, so it falls back to the event archive | `feed_coverage_missing` in 1,039/1,039; forecast 0 in 234 |
| live_updater, price_shopper, player_opportunity | `:556-565` | `forecast: null` by design | Never forecast (3 of 19 experts) |

Two small defects in the same file:
- `playerOpportunity` is computed at `:509` and never used.
- `simpleIds` at `:469` lists `'elo'`, which is not a component.

### 10. Signal-reliability controller (LEARNING)
- **Hard-coded off in production:** `nfl-ensemble.js:1959-1960` and `:2088` (`'production-unchanged'`).
- **Where:** `nfl-signal-reliability.js`.
  - Shrink-only; the multiplier is never above 1 (`:60-66`).
  - `MIN_EXAMPLES = 32`, `MIN_WEEKS = 4` (`:13-14`).
  - Drops examples with |signal residual| < 0.25 or actual residual 0 (`:40`).
  - Built only from settled `shadow_decisions`.
- **Fires:** `nfl_signal_reliability_artifacts` has 0 rows, so even candidate mode is neutral cold start. `shadow_decisions` has 40 settled.

### 11. Weather team-specific deviations (LEARNING)
- **Where:** `nfl-ensemble.js:563` and `:579-582`.
- **Condition:** fewer than 8 teams, or a one-sided 95% significance test fails, means the league constant only. Deviations are also capped (`:464`).
- **Fires:** unknown. The diagnostics aren't persisted.

### 12. Opponent-adjusted EPA
- **Where:** `nfl-ensemble.js:1058`, `:839`, `:846`.
- **Condition:** fewer than 3 opponents means the league average is used (LEARNING). This fires early-season only.

### 13. Preseason, team-strength and FPI evidence has no path into the game model (LEARNING)
- `nfl-team-strength.js` and `nfl-preseason-blend.js` are registered only as governance contracts (`model-governance.js:50-51`, "to record … not to enable a promotion").
- `nfl-ensemble.js` doesn't import them. FPI has only 32 rows (2026).

---

## Tier 3: bet authority (the model learns, but can't publish or stake)

### 14. Cover-calibration identity lock (BET AUTHORITY)
- **Where:** `nfl-cover-calibration.js:400-404`, plus `nfl-policy.js:29` and `:219` (`calibration_not_proven`).
- **Why it can never match:** the stored calibrations use `blend_mode: raw` and `information_regime: historical_weekly_closing`. The live board uses `market_residual` and `live_weekly_unfrozen`, and the identity hash covers both fields. Even a matching market_residual calibration would have zero edges everywhere, so it couldn't pass the test that edge predicts covers.
- **Fires:** 33/33 decisions show `matching_calibration_missing`, recorded as abstention reason `calibration_not_proven`.

### 15. Cover calibration forward gate (BET AUTHORITY)
- **Where:** `:357-367`. It requires walk-forward n ≥ 200, Brier and log loss no worse than the market, |intercept| ≤ 0.2, edge-slope z > 1.96, slope in [0.7, 1.3] if estimable, and ECE ≤ 0.05.
- **Bias toward the market:** the one-standard-error rule picks the strongest shrinkage (`:96`), and fewer than 3 seasons forces λ = 1024 (`:65`).
- **Fires:** 0/2 stored calibrations pass (z = 0.85 and 0.80; selected λ = 16384). `nfl_total_calibrations` also fails 0/2.

### 16. Staking gates (BET AUTHORITY)
- **Where:** `staking.js:327-330`.
- **Conditions:** calibration passed; forward settled ≥ **250** (the policy uses 200, `nfl-policy.js:79`); 80% interval width ≤ **24**.
- **Fires:** the interval width is 32–33 on **33/33** games, so this blocks unconditionally on NFL spreads.
- **Also:** `NFL_MODEL_STAKE_UNITS` isn't set in `.env`, so auto-pick units are 0 (`nfl-auto-picks.js:40`). `predictiveDistribution` hard-codes `production_eligible: false` (`nfl-ensemble.js:384`) and needs ≥200 calibration rows and bins of 150 (`:286-287`, `:325`).

### 17. Policy filters (BET AUTHORITY)
- **Where:** `nfl-policy.js:20-23`. Markets are spread only (totals and moneyline are never bet live), `minEdge 3`, `maxDisagreement 4.5`, `maxPicksPerWeek 5`, plus the expected-return floor of 0.01 with a 0.01 haircut.
- **Fires (run 33, historical policy, all markets):** of 3,117 candidates, 1,859 fell below the edge threshold, 492 hit model disagreement, 140 hit weekly capacity; 626 were selected.

### 18. Promotion workflows that have never promoted anything (BET AUTHORITY)
- **Candidate findings:** 3 holdout seasons, zero failures, and a human actor are required. The only action is a veto (`nfl-candidate-findings.js:70`, `:199`, `:394`). DB: 1 `discovered`, 0 promoted.
- **Challenger-vs-champion comparison:** `nfl-replay.js:1101` requires beating the vig and ROI95 lower bound > 0. **0/5 audits passed**, even though 4 of the 5 had positive ROI deltas (+0.029 to +0.071).
- **Governance:** `model-governance.js:79-81` marks the NFL spread challenger research_only and the totals challenger blocked. `promoteEligibleAudit` requires every gate to pass. `model_promotion_history` is empty.
- **Research-only paths:** `nfl-replay.js:1149` neural replay (≥200 calibration rows, 0.02 EV buffer, 3 picks/week); `analyzeErrors` (minBets 25, Holm α 0.05, ROI effect ≥ 0.05, `:600`, `:648`).

---

## Tier 4: coverage and cadence limits (LEARNING, smaller)

19. **Blind audit starts at week 5 at the earliest** (`nfl-blind-audit.js:182`). Weeks 1–4 (about 320 games in 2021–2025) never produce council or coordinator training rows. The coordinator also never sees anything before 2021.
20. **Whole-week settlement locks:** neural `completeWeek` (above). `nfl_weekly_learning` sync reports "capture blocked, slate started" and "need 250 settled snapshots". `nfl_model_growth` shows finalized_week 0, so the reliability artifact is never built.
21. **Epoch reset** (`nfl_learning_epochs` id 3) discards adaptive neural state by design.
22. **`forecast-combination.js`** is research-only and not wired in. Its `INCUMBENT_GATE` copy (`:45`) still uses the superseded paired-t −1.645 rule.
23. **`nfl-weekly-feature-store.js:309` and `:330`** default `startWeek = 5`.
24. **`weekly-learning.js`** (`:37`, `:129`, `:194`) and **`player-head-registry.js:100`** belong to the fantasy player-week domain. Their only link to the game model is the support-only `player_opportunity` expert, which has no forecast.