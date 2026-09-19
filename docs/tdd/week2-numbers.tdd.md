# TDD evidence (retroactive): week-2 numbers, commit 11ab55c

**What this is.** Commit 11ab55c ("Week-2 numbers: lineup card, waivers+posture on
Start/Sit, honest odds, ranges, no fake schedule", 2026-09-18) changed six gated
behaviours across about 2,400 lines and committed 6 lines of test fixture. Its gates
were pre-registered and run, but the gate texts, verdicts and verifier evidence lived
only in the session scratch directory, and nothing in the repository tested the
behaviours. The review-fixes item (docs/tdd/review-fixes.tdd.md) wrote the tests
afterwards; this file keeps the gate record next to them.

**How the retroactive RED was shown.** The code already shipped, so a test written
now passes at HEAD. Each test file was therefore also run against scratch copies of
the code with the gated constant or line reverted (a mutation). A test that no
mutation can fail proves nothing, so every file below has at least one mutation per
guarded rule that fails it. Logs: `scratchpad/step1b/review-fixes/mutations-*.log`.

| Behaviour in 11ab55c | Gate (below) | Retroactive tests | Mutations caught |
|----------------------|--------------|-------------------|------------------|
| Lineup card: P(right) = Phi(gap/14.5), urgency 60%/75%, versus-zero swaps, IR, activate_from_ir, espn_disagrees, stale-row retire | Lineup card | `test/lineup-diff-urgency.test.js` (10) | 6 of 6 |
| Matchup card: POSITION_CV x SPREAD_SCALE 1.63, MATERIAL_EDGE 23 | Matchup card spread | `test/posture-calibration.test.js` (6); posture rule in `test/gate-verdicts.test.js` | 4 of 4 |
| Boom/bust: mean-preserving two-piece shock, per-position sigma | Boom/bust weekly level | `test/weekly-level.test.js` (6); coverage rule in `test/gate-verdicts.test.js` | 4 of 4 |
| Matchup no-signal: DvP and home/away off, sos 1, display-only table | Matchup signal | `test/matchups-no-signal.test.js` (5) | 4 of 4 |
| Trade floor/ceiling: lineup-total percentiles, lazy deltas | Trade floor/ceiling consumers | `test/lineup-spread.test.js` (5) | 5 of 5 |
| Waivers + posture priced on the Start/Sit number | (decision-leftovers J5 covers the shared pricing) | `test/lineup-surfaces-agree.test.js` (2) | 4 of 4 |

The two ship rules that decided WEEKLY_LEVEL and SPREAD_SCALE are now functions in
`server/services/gate-verdicts.js` (the scripts call them) with pass/fail tables in
`test/gate-verdicts.test.js`, like `evaluateRosGate` and `earlyGateVerdict`.

**Caveat on the coverage gate.** The band [0.78, 0.82] was graded at 300 draws and one
seed. With the model fixed, 2025 coverage reads 0.775-0.783 across seeds and draw
counts, and 0.778 at production's 2,000 draws
(`docs/evidence/baselines/2025-weekly-distribution-draws.json`). The shipped setting
passed as run; whether it passes a draw-robust version of the same gate has not been
decided (deferred in review-fixes).

## Lineup card, per-swap probability: recorded result (`scratchpad/step1/lineup-card/calib_result.json`)


```json
{
 "sigma": 14.5,
 "fit_pairs": 161078,
 "val_pairs": 78735,
 "overall_2025": 0.629,
 "logloss_A": 0.64448,
 "logloss_B": 0.64498,
 "bootstrap_B_minus_A_is_mean_A_minus_B": {
  "mean_diff": -0.0005,
  "ci90": [
   -0.0014,
   0.0003
  ],
  "p_b_better": 0.844,
  "significant": false,
  "n": 78735,
  "iterations": 2000
 },
 "gate2a_A": true,
 "gate2b_A": true,
 "decision": "ship A: Phi(gap/sigma)"
}
```

## Gate records


### Lineup card

Source: `scratchpad/step1/lineup-card/GATES.md` (copied verbatim; the scratch directory does not outlast the session).

```text
PRE-REGISTERED 2026-09-17, before any evaluation below was run.

GATE 1 — CONSISTENCY (ship gate for the lineupDiff change; set by the task)
  For every roster in all 5 leagues (46 rosters), the optimal lineup lineupDiff reports must equal
  lineupCall(lg.id, {myTeamId, objective:'mean'})'s optimal lineup (the Start/Sit tab):
    - same set of player ids in the starting slots, and
    - same projected points (|diff| <= 0.01 — both are sums of 2-dp rounded numbers).
  Any disagreement is either a bug to fix in lineupDiff, or a documented, justified difference.
  Pre-declared justified difference (task rule 1): a player on the ESPN IR slot (lineupSlotId 21) or
  with ESPN status INJURY_RESERVE is never recommended IN by lineupDiff. lineupCall does not
  exclude them (lineup-brain.js is not in this item's files), so a roster where lineupCall starts
  such a player is reported as a lineupCall bug, and on that roster the comparison is re-run with
  lineupCall's pool minus those IR players (the difference must then vanish).
  Pass rule: zero unexplained disagreements.

GATE 2 — PER-SWAP PROBABILITY CALIBRATION (decides which probability map ships)
  Question: P(the higher-projected player outscores the lower one | projected gap g).
  Data: replaySeasonWeekly(season, {startWeek:5, endWeek:17, distributions:false,
        roleRecency: WEEKLY_ROLE_RECENCY, predictionHead: live weights 'fit-1'}) -> r._decision_rows
        (players active the week before; a DNP scores 0 — the real start/sit information set).
  Pairs: every pair in the same (week, position) where BOTH projections >= 4 points.
  Outcome: 1 if the higher projection scored more, 0 if less, 0.5 on a tie in actual points;
           pairs with identical projections are dropped (no direction to be right about).
  Fit seasons: 2023 + 2024.  Validate: 2025, ONCE.
  Candidate A (ships if it passes): P = Phi(g / sigma), one parameter, sigma by maximum likelihood on
           2023+2024 (grid 3.00..20.00 step 0.05).
  Comparator / fallback B: the six-bin lookup (<1, 1-2, 2-3, 3-5, 5-8, 8+) fit on 2023+2024, made
           monotone (running max) and floored at 0.5.
  Gate 2a (calibration, 2025): in every one of the six bins, |mean predicted P - observed accuracy|
           <= 0.04.
  Gate 2b (not worse than the lookup, 2025): per-pair log-loss, pairedBootstrapDiff(a = lookup B,
           b = Phi A, {seed: 17, groups: higher-projected player's id}); FAIL if mean_diff > 0 AND
           significant (90% CI excludes 0).
  Decision: ship A if 2a and 2b both pass. Else ship B if B passes 2a. Else ship the task's own
           measured 2025 table as a lookup (monotone, floored at 0.5) and report the failure.

URGENCY LEVELS (fixed now, from the task's measured table, before seeing any fit):
  per swap probability p:  high  p >= 0.75   (table bins 5-8 = 78.6%, 8+ = 88.3%)
                           medium 0.60 <= p < 0.75  (bins 2-3 = 63.0%, 3-5 = 69.2%)
                           low    p < 0.60   (bins <1 = 48.6%, 1-2 = 57.0% — coin flips / slight leans)
  Card urgency = the highest urgency among the recommended swaps.
  Decision Inbox publishes only at medium or above (a low-urgency call is inside the projection's error).
```

### Matchup card spread (posture calibration)

Source: `scratchpad/step1/posture-calibration/GATE.txt` (copied verbatim; the scratch directory does not outlast the session).

```text
POSTURE CALIBRATION — PRE-REGISTERED GATE
Written 2026-09-17, before any fit or evaluation was run. Not to be changed after results.

QUESTION
lineupPosture prints P(win) = Phi(edge / sqrt(sA^2 + sB^2)). Is that probability honest,
i.e. does the SD it uses match the spread of (actual margin - projected margin)?

FACT ESTABLISHED BEFORE THE GATE (not an evaluation of any candidate)
Live snapshot, 46 rosters, 2026 W2: my_sd_coverage = 1.00 for every roster, i.e. every live
starter's spread comes from its weekly distribution ((p90 - p10) / 2.56), not DEFAULT_CV.
So "current production" = distribution spread x 1.9.

CALIBRATION SET (walk-forward, cutoff-safe)
- replaySeasonWeekly(season, { startWeek: 5, endWeek: 17, distributions: false,
    roleRecency: WEEKLY_ROLE_RECENCY, predictionHead: ctx => weeklyEnsemblePrediction(ctx, fit-1 weights) })
  for seasons 2023, 2024, 2025. kOverride omitted (production constants, cutoff-safe).
  Weeks 5-17: where the harness matches production and where the start/sit table was measured.
  Week 18 excluded (not a fantasy week). Weeks 2-4 reported as a diagnostic only (see below).
- Rows: r._decision_rows (players active in week w-1; actual = 0 if he did not play in w).
  Rows whose week-(w-1) team has no game in week w are dropped (bye: production projects 0 and
  never starts him).
- Per row, exactly as production builds a starter:
    a    = weeklyAvailability(season, w, { through: season - 1 }).active_probability (0.92 if absent)
    mean = prediction x a                                  (production: current_week_ppg, mult = 1 here)
    dist = sampleWeeks(params, 2000, PPR, 1, a) + (prediction - structural), floored at 0
           -> p10, p90                                     (production: playerWeekDistribution)
  params from buildProjections with the harness's own arguments; asserted equal to the harness's
  structural head on every graded row.
- Plausible starters per season-week: top 14 QB, 34 RB, 40 WR, 14 TE by mean.
- 100 replicate 10-team leagues per season-week (seeded). Each league shuffles each pool and deals
  QB, RB, RB, WR, WR, TE; FLEX dealt from the shuffled leftovers of RB/WR/TE pools. Teams paired
  (0,1),(2,3).. -> 5 matchups per league, 500 per week, ~6,500 per season. Win = actual_A > actual_B
  (exact ties dropped).

SPREAD MODELS (lineup SD = scale x sqrt(sum of player variances), players with mean > 0)
  B0  CURRENT (baseline): distribution spread x 1.9
  B1  code fallback (reported, not gated): DEFAULT_CV {QB .40, RB .57, WR .63, TE .67} x 1.9
  C1  distribution spread x k
  C2  DEFAULT_CV x k
  C3  per-position CV {QB, RB, WR, TE} fitted (4 parameters, no separate k)

FIT AND SELECTION (2023 + 2024 only)
- Parameters by maximum Bernoulli log-likelihood of actual wins.
- Selection among C1/C2/C3 by leave-one-season-out log loss inside the fit seasons
  (fit 2023 -> score 2024, fit 2024 -> score 2023, average). Lowest wins. Winner refit on 2023+2024.
- 2025 is not looked at until the winner and its parameters are fixed.

SHIP RULE (2025, evaluated once) — ALL of:
  1. log loss(winner) < log loss(B0)
  2. ECE(winner) < ECE(B0); ECE = 10 equal-width bins of P(A wins) on [0,1],
     sum_b (n_b / N) |mean predicted_b - win rate_b|
  3. week-clustered paired bootstrap on per-matchup log loss:
     pairedBootstrapDiff(ll_B0, ll_winner, { seed: 20260917, iterations: 2000, groups: season-week })
     90% CI of mean(winner - B0) entirely below 0.
     (Clustered by week, not by player: a matchup holds 14 players, and every matchup in a week
      shares that week's outcomes, which is the dependence that matters.)
If any fails: ship nothing, report honestly.

REPORTED, NOT GATED
- Reliability table (predicted bin vs actual win rate) for B0, B1 and winner on 2025.
- Weeks 2-4 of 2025 under B0 and winner (early-season diagnostic).
- Implied team-week SD vs league_week_scores (within-team-season SD 23.56 incl K/DEF) and vs
  the empirical SD of (actual - projected) lineup total in the calibration set.

IF IT SHIPS
- Constants in lineup-posture.js replaced, with provenance; the unsupported TEAM_WEEK_CV 0.28
  claim deleted.
- MATERIAL_EDGE re-derived: s = median lineup SD (new rule) over the 46 live starting lineups;
  delta = median |SD change| over every legal one-for-one bench swap (bench player projected > 0)
  on the 46 live rosters; MATERIAL_EDGE = smallest integer edge e >= 0 with
  |Phi(e / sqrt((s + delta)^2 + s^2)) - Phi(e / sqrt(s^2 + s^2))| >= 0.003.
- lineupPosture on all 46 rosters before/after; report the win-probability shift distribution.
- K and DEF stay outside the modelled slots; scope note kept.

ADDENDUM (written before any fit or evaluation, same session):
- The ship rule applies to the parameters ROUNDED to 2 decimals, exactly as they would be written
  into lineup-posture.js. The unrounded fit is reported beside it.
```

### Posture selection

Source: `scratchpad/step1/posture-calibration/SELECTION.txt` (copied verbatim; the scratch directory does not outlast the session).

```text
Selection fixed on 2023+2024 only, before 2025 was read (result-fit-only.json).
LOSO log loss (exact): C2 DEFAULT_CV x k 0.667156 | C3 per-position CV 0.667279 | C1 distribution x k 0.667327  (corrected transcription)
Winner: C2, k = 1.6304 fitted on 2023+2024 -> ships as 1.63.
Note: the three candidates are within 2e-4 of each other; the rule says lowest wins, so C2.
C3 put the QB CV at the 0.05 search bound (QB spread not identified) - not selected.
Implementation fix before validation: selection now uses unrounded fold losses (it used
4-decimal rounded ones; the winner is the same either way).
Found while building: production's active_probability for healthy starters averages ~0.76
(live W2 starters: QB .74 RB .77 WR .77 TE .72) while pooled calibration players played 98% of
weeks. The CV model is invariant to a uniform deflation of means (edge and SD scale together);
the distribution model is not.
```

### Boom/bust weekly level

Source: `scratchpad/step1/boom-bust/GATE.md` (copied verbatim; the scratch directory does not outlast the session).

```text
Boom/bust (weekly floor/ceiling) honesty -- PRE-REGISTERED GATE
Written 2026-09-17 BEFORE any candidate was measured on 2025. Not to be edited after results.

WHAT IS MEASURED (the "harness")
  replaySeasonWeekly(2025, { startWeek: 5, endWeek: 18, distributions: true, runs: 300,
    roleRecency: WEEKLY_ROLE_RECENCY, predictionHead: ctx => weeklyEnsemblePrediction(ctx, LIVE_WEIGHTS),
    level: <config> })            // kOverride omitted (cutoff-safe production default), default seed 20260826
  LIVE_WEIGHTS = activeWeeklyWeightSet({ season: 2026, week: 3 }).weights   (fit-1, what production runs)
  Caveat recorded up front: fit-1 was trained on 2023-2025, so the CENTRE is mildly in-sample on every
  replayed season. It is 5 global weights; the parameter being fit here is the SPREAD.

BASELINE ("LIVE"): WEEKLY_LEVEL as shipped = { sigma: 0.45, downMult: 1 } with the current,
  NOT mean-preserving shock exp(sigma * Z).

CANDIDATES (pre-registered, evaluated on 2025 once each)
  A. Global mean-preserving shock: level = exp(sigma_Z) / E[exp(sigma_Z)] (two-piece normaliser when
     downMult != 1). (sigma, downMult) selected on 2023 + 2024 by rule R.
  B. Per-position mean-preserving sigma (QB/RB/WR/TE), downMult fixed at A's selected value, each
     position's sigma selected by rule R on that position's 2023 + 2024 rows only.

GRID  sigma in {0, .10, .20, .25, .30, .35, .40, .45, .50, .55, .60, .70, .80}
      downMult in {1.0, 1.3, 1.6} (downMult skipped at sigma 0)

RULE R (fit seasons 2023 + 2024 only; metrics computed per season, then averaged over the 2 seasons)
  1. Keep grid settings whose coverage_80 is in [0.78, 0.82].
  2. Of those, pick the lowest calibration_error. Ties within 0.001 -> lower CRPS.
  3. If none is in the band, pick the coverage closest to 0.80.
  Fit-season metrics come from a per-row evaluator that mirrors weekly-backtest.js's distribution
  block exactly (same buildProjections args, same shift = head - structural, same clamp at 0, same
  randomized PIT and CRPS). It is cross-checked against the harness on 2024 before use.
  Sensitivity (report-only): the argmin of CRPS within the band, and the old 10x|cov-.8|+cal score.

GATE (2025, harness, each candidate vs LIVE)
  G1  coverage_80 in [0.78, 0.82]
  G2  calibration_error strictly lower than LIVE's
  G3  CRPS not worse: pairedBootstrapDiff(liveCrpsRows, candCrpsRows, { seed: 20260917, iterations: 4000,
      groups: player_id }) must NOT be (significant AND mean_diff > 0). Point CRPS reported too.
  A candidate passes only if G1, G2 and G3 all hold.
  Report-only robustness: player-clustered bootstrap of the calibration_error difference (90% CI);
  per-position and per-projection-tier coverage/calibration for LIVE vs candidate.

SHIP RULE
  - Neither passes -> ship nothing; projections.js and fit-weekly-coverage.mjs left as they were
    (except fit-weekly-coverage.mjs's grading of live weights, which is a measurement fix, not a model change).
  - Only A passes -> ship A.
  - Only B passes -> ship B.
  - Both pass -> ship B only if B's 2025 calibration_error < A's AND B's CRPS is not significantly worse
    than A's (same bootstrap, A as baseline); otherwise ship A (fewer parameters).

ACTIVE-PROBABILITY INTERACTION: the harness grades conditional on playing (activeProbability = 1),
  so no change to how availability enters the distribution can be validated by this gate. Report only.

--- appended after the fit-season sweep, BEFORE the 2025 validation (gate unchanged) ---
Fit-season selection (scripts/fit-weekly-coverage.mjs --fit-only, 2023 + 2024, head fit-1):
  A = { sigma: 0.25, downMult: 1.6, meanPreserving: true }            fit cov 0.784 cal 0.116 crps 3.091
  B = per position { QB: 0.30, RB: 0.30, WR: 0.20, TE: 0.25 }, downMult 1.6   fit cov 0.788 cal 0.117 crps 3.083
  Sensitivity: in-band CRPS argmin (0.30, 1.3); old 10x-score argmin (0.40, 1.0).
  Evaluator reproduces the harness exactly on 2024 (3 settings, all 10 PIT bins identical).
LIVE 2025 baseline (harness, measured before any candidate): cov 0.803, cal 0.134, CRPS 3.107,
  PIT [539,322,415,447,510,520,505,496,409,369].

--- RESULT (2025, run once via scripts/fit-weekly-coverage.mjs --json validation.json) ---
  shipped(old) cov 0.803 cal 0.134 crps 3.107 sim mean 8.27 (actual 7.46)
  A            cov 0.772 cal 0.111 crps 3.076 -> G1 FAIL (coverage out of band) => FAIL
  B            cov 0.782 cal 0.111 crps 3.078 -> G1 PASS, G2 PASS, G3 PASS (CRPS diff -0.0296, 90% CI [-0.0413,-0.0179]) => PASS
  report-only calibration bootstrap: B - old = -0.023, 90% CI [-0.048, +0.003] (not significant on its own)
  Ship rule: only B passes -> ship B. WEEKLY_LEVEL = { sigma 0.25, downMult 1.6, meanPreserving true,
  byPosition { QB .30, RB .30, WR .20, TE .25 } }. Default harness re-run reproduces B exactly; point metrics unchanged.
```

### Matchup signal

Source: `scratchpad/step1/matchup-signal/GATE.md` (copied verbatim; the scratch directory does not outlast the session).

```text
GATE — matchup-signal (pre-registered 2026-09-17, written BEFORE any 2025 run)

Question: does any matchup multiplier (home/away or defense-vs-position) improve the
live weekly projection? The live engine applies it as current_week_ppg = base x thisGame.mult,
so every arm here is   prediction = base x m(player, season, week).

Base (identical in every arm): the live blend, weeklyEnsemblePrediction(ctx, ws.weights) with
ws = activeWeeklyWeightSet({season: 2026, week: 3}) ('fit-1'), replaySeasonWeekly(season,
{startWeek 5, endWeek 18, roleRecency WEEKLY_ROLE_RECENCY}), kOverride omitted.
(fit-1 was trained through 2025 W18; that leak is common to every arm, so the paired
difference is still fair. Noted, not fixed here.)

Data: player_week_usage (2021-2025 weekly lines with team + opponent; PPR via scoring.js#scoreLine)
and game_lines (season/week/team -> home, neutral_site). Team for a player-week = his usage row that
week, else his most recent earlier usage row that season. No game that week (bye) -> m = 1 in every arm.

ARMS
 (a)  none:            m = 1
 (b1) live home:       m = 1.02 if game_lines.home = 1 else 0.98   (mirrors schedule_games.home, no neutral handling; unfitted)
 (b2) fitted home:     m = 1 + h home, 1 - h away, 1 neutral_site; ONE h, grid 0..0.10 step 0.0025
 (b3) fitted home/pos: same, one h per position (QB/RB/WR/TE)
 (c)  DvP strictly prior: for target (S, W) the log is player_week_usage for seasons S-3..S-1 plus
      season S weeks < W. Method = matchups.js#computeDvp exactly (position floor filter QB6/RB4/WR4/TE3,
      leave-one-out player-baseline ratio, shrink toward 1 with K). Recency: season S weight 1,
      season S-j weight d^j. Grid K in {12,25,50,100,200,400,800,1600}, d in {0,0.25,0.5,1}.
 Fitting: b2, b3, c are fitted on 2023+2024 played player-weeks by minimum pooled MAE. Frozen before 2025.
 Combinations (b+c) are NOT tested.

VALIDATION: 2025 weeks 5-18, run ONCE per frozen arm.
 Primary metric: MAE on played player-weeks (r.point.model.mae; identical row set in every arm).
 Test: pairedBootstrapDiff(err_a, err_arm, {seed: 20260917, iterations: 2000, groups: player_id}).
       mean_diff = mean(err_arm - err_a). PASS only if the 90% CI upper bound < 0.
 Rank guard: r.point.model.spearman(arm) >= spearman(a) - 0.002 (the codebase's rank_ok tolerance).
 Availability guard: r.decision_including_dnp.model.mae(arm) <= that of (a).
 A candidate ships only if it passes all three.
 If more than one passes: ship the one with fewest fitted parameters (b1=0, b2=1, c=2, b3=4);
 ties -> lower 2025 MAE.
 If none pass: ship (a). matchups.js then returns mult 1 everywhere, DvP disabled behind a named
 flag, and scheduleOutlook reports playoff_sos = 1 with signal: false and a reason.
 Multiplicity: 4 candidates at 90% each; stated in the report, not used to loosen or tighten.

Secondary (reported, NOT gating): harness CRPS / coverage_80 / calibration_error per arm;
per-position MAE delta; start/sit pairwise accuracy (same week, same position, decision rows)
for pairs whose base projections are within 3 points.

Playoff schedule: playoff_sos is the mean of weekly m over playoff weeks. It carries signal only if
a weekly arm ships. If only a home arm ships, playoff_sos is a home-game count and gets labelled as
that, not as schedule strength. If (c) does not pass weekly with in-season data one week ahead, a
DvP read 13 weeks ahead from less data is not separately tested (reported descriptively only).
```

### Trade floor/ceiling consumers

Source: `scratchpad/step1/trade-consumers/GATE.md` (copied verbatim; the scratch directory does not outlast the session).

```text
# trade-consumers — pre-registered gates

Written 2026-09-18 before any accuracy run of the new lineup spread and before any
before/after comparison of the playoff/horizon changes. Nothing below is changed
after a result is seen. If a gate turns out to be wrong it is reported next to the
original result, and nothing ships on the changed version.

DB: VACUUM INTO copy `work.sqlite` (production never written). Week = tradeWeekContext()
(2026 W2). "Before" code = `before_repo/` snapshot of server/ taken before any edit.

## Part A — lineup floor/ceiling (lineupSpread) from joint draws

### What "the lineup's weekly floor/ceiling" means (fixed now)
The 10th and 90th percentile of the starting lineup's TOTAL in one simulated week,
the starters' outcomes drawn jointly. Marginal model per starter (the same inputs the
per-player floor/ceiling on the asset already uses — this week's params, ensemble
shift, matchup multiplier and active_probability):
  - with probability 1 - active_probability he does not play and scores exactly 0;
  - otherwise one played week: sampleWeeks(params, ..., mult, activeProbability = 1)
    (the mean-preserving weekly shock is inside sampleWeeks), plus ensemble_shift,
    clamped at 0.
  (This deliberately does NOT reproduce player-week-engine.js#playerWeekDistribution's
  known artifact of adding the shift to did-not-play weeks — verify-boom-bust, HIGH.)
Dependence: Gaussian copula with correlation.js#correlationMatrix (fitted archetype
correlations, same game only).

### Production estimator (primary config, fixed now)
Per player a pool of M = 2,000 played-week draws (seeded per player/week/inputs) and a
fixed stream of N = 10,000 standard normals (common random numbers: the same player
gets the same stream in every lineup, so before/after deltas cancel shared noise).
Lineup total = sum over starters of Q_i(Phi(z_i)), z = e for uncorrelated starters and
z = L e over the correlated block (Cholesky of the block's copula matrix, block ordered
by player id). p10/p90 by stats-util's linear-interpolation quantile convention.
Pre-declared lighter config, used ONLY if the primary fails the speed gate A3:
N = 5,000, M = 2,000.

### Brute-force truth (independent implementation, scratch only)
Per starter a fresh pool of K = 200,000 marginal draws (DNP as an independent
Bernoulli per draw, fixed seed stream different from production), sorted; then
K = 200,000 joint draws with correlation.js#correlatedSampler (library copula code,
not the production vector code), fresh seed. p10/p90 via stats-util quantile.
Machinery sanity (A0): 9 independent normal marginals N(mu_i, sd_i) with no clamp —
brute p10/p90 within 0.3 pt of the analytic sum-of-normals quantiles.

### Test set (fixed now)
L = every team's optimal adj_ppg lineup in leagues 1-5 (46 lineups), plus every
"after" lineup for BOTH sides of every deal findTrades returns for Nick's team in each
league with requireMutual true and false (deduplicated by starter set).
D = the (before, after) lineup pairs of those deals, both sides.

### Gates
- A1 levels: over all lineups in L, for p10 and for p90 separately:
  max |prod - brute| <= 2.5 pts AND mean |prod - brute| <= 1.0 pt.
- A2 deltas: over all pairs in D, for delta p10 and delta p90 separately:
  |prod delta - brute delta| <= 1.0 pt for >= 95% of pairs AND <= 2.0 pts for all.
- A3 speed: fresh process per league; universe built untimed; then time
  findTrades(default opts) + JSON.stringify(result) (the stringify is where the lazy
  spreads are computed, so this is the real request cost). Median of 3 fresh processes.
  New <= max(1.15 x before, before + 0.30 s) for every league.

### Ship rule
Primary config ships if A0, A1, A2, A3 pass. If A1/A2 pass and A3 fails, the lighter
config is run once on A1, A2, A3 and ships if all pass. Otherwise the quadrature
interim (normal approximation: sum of marginal means, variance = sum of variances +
2 sum rho_ij sd_i sd_j, p10/p90 = mean -/+ 1.2816 sd) ships if it passes A1 and A2.
If nothing passes, the old sum-of-quantiles stays and is reported as wrong.
Report-only (never a gate): old sum-of-quantiles error vs brute, quadrature error vs
brute, sign agreement of prod vs brute deltas where |brute delta| >= 1.

## Part B — playoff/schedule consumers (no fit; deterministic checks)
Decision 3: no matchup/schedule multiplier has a validated signal. So:
- B1: every asset in all 5 leagues: ros_ppg == ppg (weekly rate, no sos) and
  playoff_ppg == ppg x (games his team plays in THIS league's remaining playoff weeks
  / remaining playoff weeks) — byes are schedule fact, not a matchup model; no
  playoff_sos factor. Players with no schedule (no team / K / DEF) keep share 1.
- B2: tag 'Playoff Push' appears on 0 deals (5 leagues, requireMutual true/false).
- B3: selfScout(lg, my team).playoff_swing is [] in all 5 leagues and no fix says
  "harder-than-normal defences"; a starter on bye in a league playoff week, if any,
  is reported as a bye (checked against schedule_games).
- B4: horizonGain's playoff leg = the lineup delta on playoff_ppg (rate x playoff-week
  game share), share-of-own-baseline rescaled as before; the importance weights
  (4:1 playoff weeks x P(playoffs)) are unchanged. Synthetic checks: a deal whose
  incoming player is out THIS week (active_probability 0.3) has positive playoff_tilt;
  a deal whose incoming player is on bye in a playoff week has negative playoff_tilt;
  with no byes and full availability, value == ppg_delta within 0.01.
- B5: routes/trades.js Claude prompts contain no 'weeks 15-17', 'matchup mult',
  'playoff schedule' or sos text (static check of the prompt template source).
- B6: tests: node --test test/fantasy-workflows.test.js test/find-trades.test.js
  test/trade-evidence.test.js test/league-roster-schedule.test.js
  test/decision-inbox.test.js test/waiver-brain.test.js (+ league-brain) — no test that
  passed before the change fails after it; npx tsc --noEmit exit 0; npm run build
  (outDir to scratch) passes.
Report-only: before/after of Nick's top trade ideas and waiver boards in all 5 leagues.

## RESULT of the Part A run (primary joint config), recorded before anything else ran
gate_spread_result_primary.json (K = 200,000; 150 lineups, 142 before/after pairs):
- A0 machinery: PASS (errors 0.04 / 0.12 vs analytic).
- A1 levels, joint N=10,000 / M=2,000: p10 max 1.43, mean 0.46 (ok); p90 max 2.71 > 2.5 -> FAIL.
- A2 deltas, joint: floor 96.5% within 1.0, max 1.44 (ok); ceiling 92.3% within 1.0 < 95% -> FAIL.
- Quadrature (moments from the 200,000-draw brute pools): A1 p10 max 1.27 / mean 0.50,
  p90 max 1.12 / mean 0.60 -> pass; A2 100% within 1.0, max 0.88 / 0.73 -> pass.
- Old sum-of-quantiles (report-only): level error mean -29.8 (p10) / +65.0 (p90); deltas
  within 1.0 for only 30% / 37%.
Per the ship rule the joint estimator does NOT ship (the lighter config is only for an A3
failure). The quadrature interim is next.

## ADDENDUM — written after the result above, before any run of a production quadrature
The quadrature above was scored with moments from the brute pools, which production does
not have. The production quadrature takes each starter's moments from the SAME
pre-registered per-player pool (M = 2,000 played weeks, seeded, plus the 0-atom at
1 - active_probability): mean = ap x mean(pool), E[x^2] = ap x mean(pool^2); correlation =
the copula rho over same-game pairs, used as Pearson (as in the scored version). M is not
changed. That exact implementation is scored against the SAVED brute truth
(gate_spread_result_primary.json) with the UNCHANGED A1/A2 tolerances, then A3 speed.
If it fails any of them, no new spread ships: the old sum-of-quantiles stays and is
reported as wrong, and the joint/quadrature results are reported side by side.
No other variant (bigger pool, more draws) is run to decide shipping.

## RESULT — production quadrature vs saved brute truth (gate_quad_result.json)
A1: p10 max 1.20 / mean 0.46; p90 max 1.98 / mean 0.59 -> PASS.
A2: floor 100% within 1.0, max 0.95; ceiling 99.3% within 1.0, max 1.16 -> PASS.
Sign agreement where |brute delta| >= 1: floor 101/101, ceiling 105/105. Lazy deal fields
equal the recomputation on all 142 pairs. Next: A3 speed (unchanged rule).

## RESULT — A3 speed (speed_runs.jsonl, 3 fresh processes per league per version, interleaved)
findTrades + JSON.stringify, median ms, before -> after (limit): L1 5377 -> 5227 (6184),
L2 5565 -> 5413 (6400), L3 5510 -> 5277 (6336), L4 5671 -> 5576 (6522), L5 5253 -> 5174 (6041).
PASS on all five. ~4.3 s of every fresh-process number is a one-time build of the preseason/
offseason evidence models (playerEvidence -> preseason-model.js, memoised per process), the
same in both versions. Second call in the same process: before 1131-1561 -> after 977-1172 ms.
The lineup spreads themselves cost 0-109 ms, paid at serialization.
=> SHIPS: production quadrature (normal approximation) lineupSpread.

## ADDENDUM 2 — playoff leg per week (design fix found in the report, before any run of it)
Part B passed as written. The before/after report then showed a flaw in the design B4
describes: solving ONE lineup on playoff_ppg = rate x game share charges a playoff-week
bye as if nobody replaces the player that week (league 3, Josh Allen on bye in week 14 of
weeks 14-17: the playoff leg treated him as a 75% QB in every playoff week instead of
0 in one week with the backup starting). No gate failed; this is a correctness fix.
New design: the playoff leg is the AVERAGE over this league's remaining playoff weeks of
the best ros_ppg lineup in each week, with anyone on bye that week left out of it
(weeks with no bye among the roster share one solve). Per-player playoff_ppg (rate x
share, B1) is unchanged; it still feeds waiver-brain.horizonValue for single players.
Check B4' (replaces B4 for the shipped code, B4's original result stays reported):
 a) incoming player out THIS week (ap 0.3): playoff_tilt > 0;
 b) incoming player on bye in one of 3 playoff weeks: the playoff leg equals the
    hand-computed (2 x full-week delta + bye-week delta) / 3 within 0.01, and tilt < 0;
 c) no byes, full availability, this week = rate: value == ppg_delta within 0.01;
 d) B1 unchanged; B2, B3, B5, B6 re-run on the final code.
Report-only: league 3 before/after of the Allen+Moore deal and the rest of Nick's lists.
If B4' fails, the per-week version does not ship and the averaged-rate version stays.

## RESULT — addendum 2 (per-week playoff leg), final code
B4': (a) hurt this week: tilt +2.80; (b) playoff-week bye: leg 4.67 = hand-computed 4.67,
tilt -2.33 (the averaged-rate version charged -4.00 on the same case); (c) plain: value
7.00 = ppg_delta 7.00 -> PASS. B1 0 violations; B2 0 'Playoff Push' in 106 deals; B3 all 5
leagues ok; B5 0 hits -> PASS. Quadrature re-scored on final deals: A1/A2 PASS, 0 missing,
0 lazy mismatches. A3 re-run (speed_runs2.jsonl): before -> after median ms L1 5361->5285,
L2 5461->5441, L3 5468->5561, L4 5666->5625, L5 5184->5142 -> PASS. Tests: 78/79 before and
after (only the known decision-inbox fixture failure); patched copy 17/17.
```
