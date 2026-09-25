# ML-TESTBENCH — pre-registration (2026-09-25)

One honest, reproducible offline evaluation of every ML piece that can be tested now.
Written and committed BEFORE any evaluation below is run. Nothing served changes: no flag,
no producer, no migration. Scripts live in `scripts/eval/ml-testbench/`; every run reads a
COPY of the app database (the scripts refuse `~/gridiron-local/data.sqlite`) and writes only
to `~/gridiron-local/evidence/ml-testbench/` (outside the repo). Outputs carry ids and counts
only: no league-mate names, no chat text, no credential columns.

One command runs everything: `scripts/eval/ml-testbench/run-all.sh <copy.sqlite>`.

## Verdict words (the only three used)

- **promising** — beats the named simple comparator with a 95% CI that excludes zero in the
  model's favour (section rules below say exactly which difference).
- **worse than simple** — the 95% CI of the same difference excludes zero against the model.
- **no evidence yet** — anything else (the CI crosses zero). The point estimate's direction is
  reported but decides nothing.

Bootstrap: 1,000 resamples, seed 20260925, percentile intervals. Paired differences are
bootstrapped on the same resample for both arms.

## A. Acceptance models, P(yes)

**Data.** The one producer of decided offers, `server/services/eval/decided-offers.js`
(through `eval/e1-league.js#loadLeagueOffers`), all 5 leagues: ESPN `league_transactions_raw`
proposal -> answer pairs plus `trade_outcomes` rows (the 4 `observed_screenshot` declines
included, as that producer already includes them). y = 1 accepted, 0 declined/countered.
Withdrawn, expired and unanswered are excluded by that producer's rules, unchanged.
Primary set = offers with a proposal time. Sensitivity set (reported, not judged) = primary
plus the producer's `orphans` (answered, proposal row never collected) whose terms are known
from the answer row, with the proposal time set to the answer time. That time is an upper
bound, so an orphan's training set may include offers resolved after it was really proposed (a
small lookahead): which is why this set is reported and never judged.

**Order (prequential).** Offers in proposal order. Offer i is predicted from a model fit only
on offers RESOLVED strictly before offer i was PROPOSED (the E1 grader's cutoff,
`e1-league.js#priorCounts`).

**Arms.**
1. **Base rate**: pooled accept rate of the training set, Laplace (acc + 1) / (n + 2).
2. **Activity baseline**: `eval/e1.js#activityBaseline` (responder's rate shrunk to the pool, k = 5).
3. **Clone**: `eval/e1-league.js#scoreAsOf` p (the trade-acceptance.js band mid replayed as of
   the offer; a recorded prediction where one exists).
4. **Live blend**: `p-yes-blend.js` exactly as served: weights = `blendState(offers, league, now = proposed_at)`,
   p = `blendP(weights, {baseline, clone})` (the same computation as `p-yes-blend.js#prequential`).
5. **Hierarchical Bayesian logistic (new)**: logit p = a + u_league + v_manager + X b, manager =
   (league, counterparty team). Priors a ~ N(0, 1.5^2), b_j ~ N(0, 1), u ~ N(0, tau^2), v ~ N(0, tau^2).
   tau on the grid {0.25, 0.5, 1.0}, the three fits averaged by their Laplace-approximate marginal
   likelihood (uniform grid prior). Each fit: MAP by scipy L-BFGS, Gaussian (Laplace) posterior
   from the Hessian, predictive p = sigmoid(mu / sqrt(1 + pi s^2 / 8)). Unseen manager/league: their
   effect is 0 with variance tau^2 (included in s^2). Features, standardised on the training set only:
   - `value_gap`: FantasyCalc value the responder RECEIVES minus value he GIVES, /1000
     (`dynasty_values`, the league's format: 8-team leagues rd_sf1_t8_ppr1, 10-team rd_sf1_t10_ppr1;
     an unvalued player = 0). FantasyCalc history (`dynasty_value_history`) starts 2026-09-24, after
     every offer, so this is CURRENT value, not as-of: a known lookahead, labelled in the report.
   - `need_fit`: mean over players the responder receives of (league mean rostered count at that
     position minus the responder's count), from `league_roster_snapshots` at the latest scoring
     period whose week had started by the proposal (week 1 for pre-season offers, flagged).
   - `package_size`: log(number of players in the deal).
   - `activity`: log1p(ESPN TRADE_PROPOSAL EXECUTE rows the responder was a party to, proposed
     strictly before this offer).
   Missing terms -> value_gap = need_fit = 0, package_size = log 2, counted.
6. **LightGBM (small-data comparison)**: same 4 features, `objective=binary, n_estimators=50,
   learning_rate=0.05, num_leaves=3, max_depth=2, min_child_samples=5, reg_lambda=10,
   min_split_gain=0, subsample=1, seed=20260925`. When the training set has < 10 offers or a single
   class, it predicts arm 1 (counted as `fallback`).

All probabilities clipped to [0.02, 0.98] before scoring (the E1 clip).

**Metrics.** Mean log loss; Brier with Murphy decomposition (reliability, resolution,
uncertainty; 5 equal-width bins of p); AUC only when the set has >= 5 accepts and >= 5 non-accepts.
Bootstrap over offers (iid) for every metric and for paired differences; a manager-clustered
bootstrap is reported as a sensitivity.

**Judged comparison.** Paired log-loss difference (arm - reference) with its 95% CI. Reference
("simple"): arm 2 for arms 3-6; arm 1 for arm 2. Arm 1 gets no verdict (it is the floor).
**Power.** For each judged difference with mean d and per-offer SD s: offers needed for a
two-sided 5% test at 80% power, n = ((1.96 + 0.84) s / d)^2, and "never" when d is 0.
If nothing beats the activity baseline, the report says so in one sentence.

## B. Projections (E-XGB rolling origin)

**Data.** The E-XGB phase-1 panel (`scripts/eval/exgb_panel.py`, unchanged) built on the DB copy,
seasons 2022-2026. ESPN RETROSPECTIVE projections from `~/gridiron-local/evidence/exgb/espn-retro-*.json`
(fetched 2026-09-25 after the games; labelled RETRO everywhere; not frozen).

**Rolling origin.** For each test season S in {2024, 2025} and each week t with finals: train on
every panel row of that position with season < S, or season = S and week < t; predict week t.
Settings are FIXED at the phase-1 selections (docs/tdd/2026-09-25-exgb-retrospective.tdd.md), not
re-tuned: XGBoost QB abs-error depth 3 x 251, RB abs depth 5 x 215, WR abs depth 4 x 162, TE abs
depth 3 x 176; LightGBM QB l1 7 leaves x 156, RB l1 15 x 100, WR l1 15 x 124, TE l1 7 x 222
(learning rate 0.05, subsample 0.8, colsample 0.8, seed 20260925). Caveat stated in advance: those
settings were selected on 2024 validation, so 2024 is mildly optimistic for the trees; 2025 is the
clean season.

**Arms.** XGB; LGBM; trailing mean (`exgb_models.py#trailing_mean`); ESPN RETRO; **B2** = ESPN RETRO +
r(x, ESPN), r an XGBoost model (that position's phase-1 XGB settings) of (actual - ESPN RETRO) on the
panel features plus ESPN RETRO, fit on the same rolling training rows that have an ESPN value;
lambda fixed at 1 (no frozen weeks exist to fit it; phase 2b's lambda needs frozen weeks). Arm
definition reused from `origin/claude/local-exgb-phase2b:scripts/eval/exgb_arms.py` (read, not merged).

**Metric.** MAE (full-PPR points) per position and season on the rows where every arm has a value
(the ESPN rows), plus all-rows MAE for the non-ESPN arms. 95% CIs by week-clustered bootstrap
(resample weeks).

**Verdict per model (XGB, LGBM, B2), pooled 2024-2025, per position.** Simple comparator =
ESPN RETRO (free, and the bar that matters). promising = CI of MAE(model) - MAE(ESPN RETRO) wholly
below 0 at >= 2 positions and wholly above 0 at none; worse than simple = wholly above 0 at >= 3
positions; else no evidence yet. Trailing mean is reported as the sanity floor. RETRO is biased in
ESPN's favour (phase 1 drift check), so "worse than simple" against RETRO is not final.

**Smoke test (not judged).** 2026 week 2: models trained on everything before 2026 week 2, scored
against the frozen ESPN week-2 capture (`espn_player_market_weekly`, captured 2026-09-17 22:08Z,
before kickoff). 2026 week 3: count the pre-kickoff rows in `espn_weekly_projection_snapshots`
(late = 0, captured before kickoff); scored only if week-3 finals exist at run time.

## C. Weekly range calibration (p10-p90 of lineup totals)

**Outcome.** Each team-week of 2026 weeks 1-3 in all 5 leagues with finals: the sum of
`actual_points` of that team's starters in `league_roster_snapshots` (`is_starter = 1`). A week
with any starter missing an actual is not scored (week 3 at run time is expected to be unscoreable).

**What is scored.** No served weekly range was stored for weeks 1-3 (`served_numbers` starts
2026-09-24 and has no range field), and the served range (`lineup-week-range.js`, the league
world) cannot be rebuilt as of a past week. So the equivalents, from as-of inputs:
- **C1 ours**: our week-2 per-player snapshot (`weekly_prediction_snapshots`, as of 2026-09-17,
  before kickoff): each starter a split-normal with median = `prediction`, p10 = `lower_80`,
  p90 = `upper_80`, floored at 0; K / D/ST (not in that table) fixed at their ESPN projection, as
  the world fixes them. Independent draws, 20,000 runs, the lineup's p10 and p90 read off. Week 2 only.
- **C2 ESPN frozen + positional CV**: mean = sum of frozen ESPN week-2 projections; sd from
  `lineup-posture.js#POSITION_CV` summed in quadrature, NOT scaled by SPREAD_SCALE (a margin model,
  not a range); band = mean +/- 1.2816 sd. Week 2 only.
- **C3 ESPN RETRO + positional CV**: as C2 on `league_roster_snapshots.projected_points`
  (backfilled 2026-09-22, after the games: RETRO). Weeks 1-2.
- **Simple comparator**: ESPN projection +/- 1.2816 x 24.1 (24.1 = the team-week SD measured in
  `league_week_scores` 2023-25, quoted in lineup-posture.js).

**Metric.** Coverage = share of team-weeks with total inside [p10, p90]; share below p10 and above
p90. 95% CI by bootstrap clustered on league-week. Target 0.80.
**Verdict.** promising = CI contains 0.80 and |coverage - 0.80| <= the simple band's; worse than
simple = CI excludes 0.80 and the simple band's |coverage - 0.80| is smaller; else no evidence yet.

## D. Matchup win-probability calibration

No weekly win probability was stored for weeks 1-3. Reproducible version: the served formula,
`lineup-posture.js#lineupMoments` + `normalCdf(edge / sqrt(sd_a^2 + sd_b^2))` (POSITION_CV x
SPREAD_SCALE 1.63), on each side's ACTUAL starters, projections as below. Outcome: the
`league_week_scores` result for that matchup (ties excluded, counted). One row per game.
- **D1 ESPN frozen** (week 2), **D2 ours** (week 2, `weekly_prediction_snapshots`; K / D/ST from
  frozen ESPN), **D3 ESPN RETRO** (weeks 1-2).
**Metrics.** Brier with reliability/resolution (5 bins), log loss, 95% bootstrap CI over games.
**Simple comparator** = 0.5 for every game (Brier 0.25). Verdict on the paired Brier difference
(arm - 0.25): promising / worse than simple / no evidence yet as defined above. Small n (about 23
games a week) is stated next to every number.

## What would change a conclusion

A model is only called promising on a CI, never a point estimate. A lookahead (current FantasyCalc
in arm 5/6, RETRO ESPN in B/C3/D3) can only flatter the arm that uses it, so a "no evidence yet" or
"worse" there stands; a "promising" there is marked as needing an as-of rerun before it counts.
