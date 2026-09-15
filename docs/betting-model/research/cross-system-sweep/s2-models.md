# s2-models — model-by-model read of the NFL betting engines
2026-09-12. Read-only pass over `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard`.
Every DB number below comes from a `node:sqlite` `readOnly:true` one-liner against `server/data.sqlite`.

---

## Q1. What each engine actually is, what it reads, live or shadow, who consumes it

| module | what it computes | reads | status | consumed by |
|---|---|---|---|---|
| `nfl-ensemble.js` | 31 registered components (22 active, 9 `challengerOnly`) → one weighted margin + total + empirical residual distribution | `game_lines`, `nfl_team_week_features` (via `nfl-pbp.teamWeeks`), injury table, `rosterStrengthWeek` | **live champion** | auto-picks, unified engine, blind audit, replay, neural head, council, family-contribution |
| `nfl-gbm.js` | depth-2/3 boosted regression trees on the **market residual**; 36 features (29 PBP diffs + spread/total/temp/wind/dome/div/rest) | `game_lines`, `nfl_team_week_features`, `nfl_game_weather` | research + council input | `nfl-expert-council` (`boosted_tree` AND `similar_games` share its matrix), `nfl-team-strength`, `offseason-model`, route |
| `nfl-drive-sim.js` | full play/drive/clock simulation → joint score distribution | learned team rates (`nfl-sim-learn`), `nfl-sim-policy` decisions | live, but min-KL–reconciled to ensemble means | `nfl-unified-engine`, council `game_replay`, live ledger, route |
| `nfl-sim-policy.js` | 20 coaching-decision modules (4th down EP, 2-pt chart, clock, OT) | game state + `nfl-live` WP | live inside the sim | `nfl-drive-sim` only |
| `gamescript.js` | (spread,total) → implied points, pass/rush volume; also the nflverse/ESPN line ingest | `game_lines` | live | **fantasy** paths mostly (props, waiver, ceiling, season-sim) |
| `season-sim.js` | 10k-season fantasy league sim | fantasy projections | live | fantasy only — not a betting model |
| `nfl-cover-calibration.js` | market-anchored logistic offset `sigmoid(logit(mkt)+b0+b1·edge/7)` + forward gate | `replaySeason` rows (fit with `blendMode:'market_residual'`, line 276) | **live gate on every spread pick** | auto-picks, betting-hub, research |
| `nfl-total-calibration.js` | same technique for totals | `nestedEvaluationRows()` from `nfl-market.js` | live gate | `nfl-props` |
| `nfl-expert-council.js` | 19-expert weekly contract, each emitting a market-residual opinion + coverage + authority | everything above + team cards + news + player engine | **fully built, never wired to a bet** | `nfl-unified-engine` (display `heads`), `page-explain-tools` |
| `nfl-specialists.js` | 11 PBP families + context/ATS/movement/news, ridge + context-interacted meta-model, permutation-tested | `nfl_team_week_features`, `game_lines` (incl. `open_spread`) | research | route, `nfl-rookies` |
| `nfl-orthogonal-specialists.js` | **sequential residual boosting** over 6 frozen-team-card families in a fixed order, influence chosen on a separate tune block | `nfl_team_cards` (4,298 rows) | shadow; 49 artifacts stored | `nfl-expert-council`, `nfl-model-growth` |
| `nfl-matchup-specialists.js` | 7 ridge roles on the market residual (trench continuity, tendency, situational, pressure, QB state, nfelo line, TeamRankings line) | `nfl_team_week_features`, `nfl_snaps`, `nfl-qbr`, `nfelo`, external ratings | candidates, no staking authority | council, `line-move-study` |
| `nfl-online-neural.js` | 10-hidden-unit tanh net on the market residual, prequential | **the ensemble's own output** (`spreadFeatureVector`) + availability + verified news | `active_shadow`; **`nfl_online_neural_artifacts` = 0 rows** | auto-picks (gated off), council, evidence daemon |
| `nfl-context-heads.js` | props-side multiplicative context heads (cutoff-safe DvP, weather, rest, home/away), Holm-corrected | `playerWeeks`, `gameContext`, `gamescript` | research | route only |
| `football-first.js` | 7 preregistered football facts → OLS on the market residual | `football-context`, `nfl-spread-context` | **failed, documented** (117-125, z=-1.256 on 2021-25) | route, `weekly-walkforward`, audit script |
| `nfelo.js` | ingests greerreNFL CSVs: QB Elo, nfelo pre-regression line, open/close + public ticket/money splits, stadium/altitude | GitHub CSVs | live ingest | `nfl-market` route, `beat-the-close`, `line-move-study`, matchup specialists |
| `nfl-external-ratings.js` | ESPN FPI (incl. **offense/defense/special-teams EPA components**) + TeamRankings predictive, date-addressable | public endpoints | snapshot only, not a default input | `nfl-market` route, `beat-the-close`, matchup specialists |

---

## Q2. Distinct in CONSTRUCTION vs distinct in PARAMETERIZATION — the concrete grouping

Pulled the live champion fit artifact (`cutoff='2026|2'`, `champion-inputs`) and grouped the 22 active
components by the **function that produces them**, not by the `family` label they carry:

| construction | components | Σ margin weight |
|---|---|---|
| **posted market** — identity or OLS of the same posted spread | `market_anchor` .0938, `market_regression` .0934 | **.1872** |
| **accumulated score margin** — every one a monotone function of (points for, points against) | `dynamic_state` .0714, `melo` .0547, `massey` .0411, `point_diff` .0410, `turnover_regressed` .0395, `pythagorean` .0353, `recent_form` .0089 | **.2919** |
| **`diffModel(c, f, scale, id)`** — literally the same function, 8 active times, one column of `nfl_team_week_features` each, each with its own fitted `b0/b1` | `epa_net` .0673, `drive_eff` .0646, `epa_neutral` .0624, `success_rate` .0617, `explosive` .0479, `situational` .0456, `trenches` .0434, `opp_adjusted` .0339 | **.4268** |
| injury report | `availability` .0383 | .0383 |
| rest + division flag | `rest_travel` .0329 | .0329 |
| binary win/loss | `colley` .0227 | .0227 |

**85.6% of the margin weight lives in three constructions.** That is the "three real signals" diagnosis,
now quantified from the fitted artifact rather than asserted. The sharper statement: the largest group is
not "correlated components", it is **one function registered eight times** (`nfl-ensemble.js:657-670`), each
instance an OLS of actual margin on one column of one table. Nine `challengerOnly` components are *also*
`diffModel` — so 15 of 31 registered components are the same estimator.

Same pattern outside the ensemble: `boosted_tree` and `similar_games` in the council share one
`buildGbmDataset()` matrix (`nfl-expert-council.js:73-77`, `treePrediction`/`analogPrediction`); `deep_residual`'s
feature vector is built **from the ensemble's own family aggregates** (`nfl-online-neural.js:118-157`), so it is a
non-linear re-read of the same blend rather than an independent path.

Genuinely distinct constructions that do exist: `nfl-drive-sim` (joint play-level), `nfl-orthogonal-specialists`
(sequential residual boosting on frozen cards — and it is the only place `pace_script` and a
`market_shape` family with `open_move`/`total_move`/`book_count` exist), `trench_continuity` (snap-count
personnel continuity), `nfelo_line`/`teamrankings_line` (published external lines).

---

## Q3. Genuinely independent families that are ENTIRELY absent

**1. Special teams — zero, everywhere.** Dumped the key list of a 2025 row of `nfl_team_week_features`:
183 keys, **not one special-teams key**. No FG attempt/make, no distance distribution, no net punt, no
returns, no ST EPA. In the simulator, `fieldGoalProbability()` is a single league-average logistic in
distance (`nfl-sim-policy.js:44-48`) used for all 32 teams, and punts are a constant net-40
(`nfl-drive-sim.js:440`, `nfl-sim-policy.js:70-74`). The only proxy — `field_position` (drive start) — is
`challengerOnly`, i.e. weight 0. Meanwhile ESPN FPI's own special-teams component is already being synced
into `nfl_external_ratings` and never used as an input. nflverse PBP already carries every input needed.

**2. Opponent-adjusted efficiency at a unit level — computed, then thrown away.** `nfl-features.js:226-231`
and `:449-457` already produce `opp_adj_off_epa`, `opp_adj_def_epa`, `opp_adj_net_epa`, `sos_played`,
`sos_remaining`. Consumers: `nfl-reasoning.js:22`, `nfl-ai-replay.js:12`, `routes/nfl-betting.js:19`,
`nfl-context-heads.js:33` — **all display/explain/props, no spread or total forecaster.** Inside the ensemble
the only opponent adjustment is `opp_adjusted` (weight .0339, self-documented as "not a fully iterative SRS
solve" and "has not yet been walk-forward validated"). `nfl-gbm`, `nfl-specialists`, `nfl-matchup-specialists`
and `nfl-orthogonal-specialists` all consume **raw unadjusted team rates**.

**3. Pace/possession count for the SIDE.** `pace_total` returns `{margin:null}` — pace only ever touches the
total. `pace_script` exists in orthogonal specialists but that engine has no staking path.

**4. Market microstructure — exists but is structurally disadvantaged.** `FAMILY_SPEC` in
`nfl-orthogonal-specialists.js:16-32` is fit **sequentially in a declared order**, and `market_shape` (the
only family carrying `open_move`, `total_move`, `book_count`) is **last** — it only ever sees the residual
left after roster, efficiency, pace, availability and environment have taken their cut. Given this project's
documented bias toward structural/market edges, the one family that could carry one is the one the ordering
penalises most. Reordering is a one-line experiment.

Coaching/situational tendency and trench play are NOT absent (`tendency_matchup`, `pressure_matchup`,
`trench_continuity`, `trenches`) — but none has staking authority.

---

## Q4. Where models silently disagree, and what reconciles them

**Reconciled:** drive-sim vs ensemble (min-KL to `targetMargin`/`targetTotal`, `nfl-unified-engine.js:47-57`).
Experts vs each other (`nfl-expert-coordinator.js:36-41` — Stage A per-role walk-forward shrinkage, Stage B
**correlation ≥ 0.6 collapses roles into one coefficient**, with an audit note that four roles correlated
0.74-0.92 all added error at full scale).

**Not reconciled:**
- **`raw` vs `market_residual` blend.** `nfl-blind-audit.js:307` and `nfl-expert-council.js:463` score `raw`;
  `nfl-auto-picks.js:83`, `nfl-unified-engine.js:40`, `nfl-cover-calibration.js:276` and
  `nfl-forecast-identity.js:41` all default to `market_residual`. These are different numbers for the same game
  and nothing compares them. **See F1 below — this is the big one.**
- **Two total forecasts.** `nfl-ensemble`'s `projected_total` (gated by nothing) and `nfl-market.predictGame`'s
  total (gated by `nfl-total-calibration`). Only one is gated; nothing reconciles them.
- **The expert council reaches no decision.** `expertCouncilGame` is called in exactly two places:
  `nfl-unified-engine.js:82` (a display `heads` field) and `page-explain-tools.js:100`. 100,483
  `nfl_weekly_expert_examples`, 2,625 forward predictions, 231 settlements, a trained coordinator — and no
  path into `computeDecisionBoard`.
- **Ensemble weighting is correlation-blind while the coordinator is not.** `rawWeight` is
  `exp(-0.7·RMSE)` normalised (`nfl-ensemble.js:1160-1178`), with no covariance term at all. Eight instances of
  one function get eight independent votes.

---

## F1 (biggest, measurement). The audited model and the staked model are not the same model — and the staked one has never once left the market

`blendMode:'market_residual'` returns `marketMargin` unless at least one component clears
`residual_n ≥ 250 && residual_rmse_gain ≥ 0.03 && residual_paired_t ≤ -1.645`
(`nfl-ensemble.js:1185-1190`, applied at `:1293-1299`).

I scanned **all 840 stored champion fit artifacts** in `nfl_ensemble_fit_artifacts`:
**zero cutoffs, zero components, have ever passed that gate.** Best residual gain ever recorded across every
artifact: `trenches` at cutoff 2017|7, gain 1.42, t = -1.703 — blocked on sample size.

Therefore, at every cutoff this repo has ever computed:
- `unifiedGameProjection`'s "canonical answer" margin **is the market spread**, and the simulator is KL-pulled
  onto it. `spread_edge` ≡ 0.
- `autoPickDecisionBoard` computes `edge = projectedMargin - marketMargin` ≡ **0.000** for every game, so
  `home = (edge > 0)` is always false → the away side is nominally "selected" with zero edge on every game.
- `nfl-cover-calibration.js:276` fits the live staking gate on replays whose `edge_points` is identically zero
  — which explains the stored coefficients exactly: `intercept -0.000641`, `edge_slope +0.0000194`,
  `selected_lambda 16384`, `lambda_reason: "Heavy shrinkage selected — the model adds nothing to the market on
  training data."`
- Meanwhile the **blind audit** (`nfl-blind-audit.js:307`, no `blendMode` → `raw` default at
  `nfl-ensemble.js:1221`) grades the weighted raw blend — a genuinely different function. The settled
  −7.7% ROI / −2.28 CLV numbers describe `raw`; production runs `market_residual`.

Nothing is *broken* here — it is honest abstention working. What is missing is that **nobody has said it out
loud**: the production spread forecast is the market line by arithmetic, the historical verdict measures a
different function, and Step 2's walk-forward leaderboard is about to grade candidates under a protocol that
does not distinguish the two. A one-line assertion — "a blend mode whose gate has never passed must be
reported as `is_market_identity: true`, and every audit must declare its blend mode" — makes every future
comparison interpretable. This also means the correct reading of Step 5b's "no forecast has yet consumed a
frozen packet in production" is stronger than written: no forecast has yet moved off the market at all.

## F2. `market_anchor` reads the OPENER live and the CLOSE in every backtest

`games()` — the only history source for fitting *and* for grading — hardcodes
`NULL AS open_spread, NULL AS open_total` (`nfl-ensemble.js:60`).
`ensembleLine`'s per-game query uses `CASE WHEN team_score IS NULL THEN open_spread END AS open_spread`
(`:1247`). `market_anchor` is `openSpread ?? spread` (`:599-606`).

So: settled game → opener is NULL → component = the **closing** line. Unplayed game → component = the
**opening** line. The data is there: 271 of 272 2026 games carry `open_spread`, 285/285 in 2023-25.

Consequences, from the live artifact's weights:
- `market_anchor` earned **margin weight .0938 and total weight .2503** by being graded as the closing line.
  Live it serves the opener.
- The raw margin blend therefore contains `+0.0938 × (openMargin − closeMargin)` — a built-in **fade-the-move**
  term. Mean |close − open| is 1.17 pts (2025), 0.93 (2024), 1.19 (2023). That is a systematic push onto the
  stale side of exactly the games that moved, in a portfolio whose documented failure mode is 78% adverse moves.
- **Totals are worse: 25.0% of the total weight** is the opening total live and the closing total in every
  backtest. `projected_total` feeds the simulator's `targetTotal` in the unified engine.
- No backtest can ever detect this, because every backtest replays settled games where the branch is dead.
- Knock-on: `captureOnlineNeuralWeek` (unplayed → opener) and `nfl-neural-replay.js:108` (`team_score IS NOT
  NULL` → no opener) compute the neural head's `market_mean_residual` feature from **different definitions**.

Fix is one line (`SELECT open_spread, open_total` in `games()`) but it is a real behaviour change: it should
be run as a comparison, not a patch, because it will change every fitted weight.

## F3. Neutral-site games: 43% of the margin weight carries a +1.6 home intercept that is never zeroed

`diffModel` returns `cal.b0 + cal.b1 * raw` when a calibration exists (`nfl-ensemble.js:664`; the same at
`:333` for `availability`) — **`c.hfa` and `c.neutral` are dropped entirely.** Every calibrated `b0` in the
live artifact is a home-field constant: 1.603, 1.641, 1.655, 1.710, 1.700, 1.656, 1.713, 1.465.

Weighted over the 8 active calibrated components (Σ weight .4312), that is **+0.71 points of spurious home
lean at every neutral-site game**, while every uncalibrated component correctly reads `hfaFor()` → 0
(`:806-807`). The unified engine even remembers to pass `homeFieldPoints: 0` to the simulator
(`nfl-unified-engine.js:45-47`) — the ensemble it is reconciling to does not.

Scope, stated honestly: this hits the **`raw`** blend, so it corrupts the blind audit, the replay, the
council and the neural capture — i.e. precisely the historical record Step 2 is about to convert into a
verdict. 2026 has 9 neutral-site games; 2015-2025 has ~60 inside the fit window.

## F4 (biggest, modelling). The ensemble's weighting has no correlation term, and the repo already contains the fix

`rawWeight = exp(-0.7 · margin_rmse)`, normalised (`nfl-ensemble.js:1160-1178`). Nothing anywhere prices the
covariance between components. Eight instances of one function (`diffModel` over eight columns of one table)
each receive an independent vote, which is *why* 31 components collapse to three signals — it is not an
emergent property to be fixed by adding a fourth signal, it is a direct consequence of this line.

`nfl-expert-coordinator.js:36-41` already implements the correct treatment for the council: Stage A
walk-forward per-role shrinkage, Stage B collapse of roles correlating above 0.6 into a single coefficient,
with the audit note that four roles at r = 0.74-0.92 all added error at full scale. The champion engine never
got it.

The inputs are already computed: `fitEnsemble` builds `residuals[m.id].signal` — a full walk-forward matrix
of every component's deviation from the market, in chronological order (`nfl-ensemble.js:1090-1098`). The
covariance is one pass over arrays that already exist in memory.

**Why this is not Step 4b / item 11.** The plan's answer to "three real signals" is to *add* a fourth
(bottom-up player total, independent totals engine). Both are good. Neither prevents the existing 22 from
continuing to be counted as 22 independent votes, and neither is testable as an improvement until the
weighting can tell a new signal apart from a re-labelled old one.

## F5. `beats_market` has no magnitude threshold, so the cover-calibration card prints the opposite of the truth

`nfl-cover-calibration.js:261` — `beats_market: modelSse < marketSse`, no tolerance. The stored calibration's
sweep is monotone toward the market: differences `0.000388, 0.000283, 0.000123, 0.000025, -0.000004,
-0.000005, -0.000002, -0.000001, 0.000000`. The λ=65536 row "beats" by a floating-point artifact, so
`any_lambda_beats_market = true` and the card reads:

> "At least one blend weight beats the market out of sample — the model carries signal worth keeping."

while `lambda_reason` on the same row reads "the model adds nothing to the market on training data" and
`forward_gate_passed` is `false`. The correct verdict string **already exists two branches below** (`:267-271`:
"…the curve is monotone: every unit of weight on the model strictly degrades the forecast… There is no edge
here to calibrate") and is exactly right for this data — it is being suppressed by a comparison with no
threshold. Fix: require the Brier difference to exceed its own standard error.

## F6. Companion invariant worth having

Because `market_residual` yields a zero-variance `edge_points` column whenever the residual gate is empty
(always, per F1), `buildCoverCalibration` can be handed a degenerate design matrix and still store a row.
`sd(edge_points) > 0` and `n_distinct(edge_points) > 1` should be preconditions for persisting any
calibration artifact.

## F7. The `deep_residual` expert is a zero-output cold start, and is not an independent path anyway

`nfl_online_neural_artifacts` has **0 rows**, so `activeNetwork` returns `createNetwork(...)`
(`nfl-online-neural.js:166-172`), whose `w2` is all zeros by design (`:50-61`) → `predictNetwork` returns
exactly 0 → `predicted_margin` = the market margin. Separately, `spreadFeatureVector` (`:118-157`) is built
from `ensembleLine`'s own per-family mean residual / dispersion / coverage, so even once trained it is a
non-linear re-read of the ensemble, not a second data path. Honest reading: this is scaffolding, correctly
inert, but it should not be counted as one of the engine's independent opinions.

---

## Things the plan already covers that I checked and am NOT re-proposing

- "31 components collapse to ~3 signals" — Step 4b and item 11 name it. F4 is the *mechanism in code*, not
  the diagnosis.
- No forward-data gate before promotion — item 14.
- Independent totals engine / bottom-up team total — items 11 and 4b.
- Purged walk-forward, trial registry, effective trial count, deflated Sharpe — Step 2 (5a-5e). Confirmed
  `nfl_model_trials` does not exist in the DB, matching "the table was built tonight; it is empty."
- Overtime model (12), timeout ingestion (13), prediction-realism check (15).
- nflfastR EP/WP comparison and the seven-method devig dispatcher — Step 5c.
- Retention policy, boot-path integrity check, ESPN reauth — Step 6 / open decisions.
- The rejected list (GP/symbolic regression, MoE gating, deep generative, RL play-calling, sentiment,
  cross-venue arb) — nothing here touches any of them.
