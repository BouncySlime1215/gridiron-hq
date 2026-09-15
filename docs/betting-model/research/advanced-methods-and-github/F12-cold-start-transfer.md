# F12 — Cold-start / transfer-learning for the fantasy weekly-learning loop

## The defect, confirmed by code read (read-only, fantasy-football-dashboard)

Chain, exact:

1. `server/services/player-week-engine.js:123-137` (`priorScores`) queries
   `SELECT * FROM player_week_usage WHERE season = ? AND week < ?` — **current
   season only**. At week 1, `week < 1` returns nothing, so `priorWeeks = []`
   for every player, every season, forever.
2. `server/services/weekly-ensemble.js:28-29` (`weeklyEnsembleContext`):
   `if (!priorWeeks?.length) return null;` — no fallback. Null propagates.
3. `player-week-engine.js:152-165`: `context` is null → `engine.heads = null`,
   `engine.mode = 'structural_only_no_current_season_history'`. The
   *structural* projection itself is fine (it already does cross-season
   shrinkage, see below) — only the ensemble `heads` object is null.
4. `server/services/weekly-learning.js:69` (`captureWeeklyPredictions`):
   `if (!engine?.heads) continue;` — the pregame snapshot is **silently
   skipped**, not captured with a degraded/structural-only value.
5. `server/services/weekly-learning.js:154` (`retrainWeeklyWeights`) reads
   `SELECT * FROM weekly_prediction_snapshots WHERE actual IS NOT NULL AND
   season_to_date IS NOT NULL` — so even a row that *did* get captured with
   `season_to_date = null` would be excluded from retraining. Two independent
   places both throw away the cold-start case rather than degrading
   gracefully.

Net effect: `player_week_engine.heads` is null every Week 1 (and for any
player whose first current-season game hasn't happened — trade, promotion,
return from injury with a role change), and the weekly-learning promotion
loop (`retrainWeeklyWeights`, `runWeeklyLearningCycle`) has *never once* seen
a Week 1 example to grade the ensemble against. This is exactly the
"zero forward snapshots at cold start, silent no-op" defect on the finding
sheet.

Important asymmetry already in the codebase: `server/services/
player-head-registry.js:55` (`candidatePlayerHeads`, the newer ~20-head
research registry, NOT the production ensemble) already has the fallback the
production path is missing:
```
if (!prior.length) return Object.fromEntries(PLAYER_HEADS.map(h => [h.id, structural]));
```
i.e. when there's no in-season history, every candidate head degrades to the
structural prediction instead of returning null. The production
`weeklyEnsembleContext` in `weekly-ensemble.js` does not do this. The fix
pattern already exists in the repo; it just isn't wired into the path that
actually captures snapshots.

Also worth knowing: the *structural* base model (`server/services/
projections.js`) already does real cross-season empirical-Bayes shrinkage —
`SEASON_WEIGHT = (s, through) => ({0:1, 1:0.55, 2:0.28})[through-s] ?? 0.12`
(line 75) plus `shrink()`/`shrinkSafe()` calls fit via
`shrinkage-fit.js`'s method-of-moments k = σ²within/σ²between. So Gridiron
already has one legitimate transfer mechanism for the *base rate* — it's the
in-season ensemble `heads` layer (season_to_date/last3/last1/median, meant to
capture current-year signal) that has zero fallback and zero cross-season
data, and the snapshot/retrain pipeline that throws the cold-start case away
twice.

## Primary sources (4 read in full)

1. **Brown, L.D. (2008), "In-Season Prediction of Batting Averages: A Field
   Test of Empirical Bayes and Bayes Methodologies"** (arXiv:0803.3697).
   Read in full (fetched PDF). Sample: 432 MLB players, 2005 season,
   predictions made after ~45 at-bats, target = rest-of-season average.
   Compares naive current-data-only estimate vs. James-Stein/empirical-Bayes
   vs. full hierarchical Bayes. Result: hierarchical Bayes has substantially
   lower total squared error than the naive current-season-only baseline;
   empirical Bayes lands between naive and full hierarchical. This is the
   direct, quantitative precedent for "when you have almost no current-period
   data, shrink hard toward a population/positional prior instead of
   returning nothing."
   Limitation (stated): metric-specific (batting average only), depends on
   the assumed league-wide prior distribution being right, and the full
   hierarchical fit is materially more compute than empirical Bayes for a
   result that's only incrementally better.

2. **Oreshkin, B. et al. (2021), "Meta-Learning Framework with Applications
   to Zero-Shot Time-Series Forecasting"** (arXiv:2002.02887, AAAI 2021).
   Read in full (ar5iv). Trains N-BEATS-style blocks as meta-learners on
   M4 (100k series) + FRED (290k series); zero-shot-evaluates (no retraining)
   on M3 (3,003 series), Tourism (1,311 series), Electricity (370 meters),
   Traffic (963 lanes). Results: M4→M3 sMAPE 12.44 vs. Theta baseline 13.01;
   M4→Tourism MAPE 18.82 vs. Theta 20.88; M4-Hourly→Electricity ND 0.09,
   matching DeepAR's 0.09 despite zero target-domain training. Ablation:
   meta-learning alone (vs. a single non-meta block) accounts for ~1.2%
   (M3) to ~7.8% (Tourism) of the improvement.
   Limitation (stated): needs input/output scale normalization or it fails
   catastrophically on scale-mismatched targets; >30 meta-blocks starts
   overfitting the inner loop; assumes the training task distribution is
   representative of what you'll see at inference (an assumption that is
   exactly the risk of transferring 2023-fit weights onto 2026 games).

3. **Efron, B. & Morris, C. — the James-Stein baseball result** (as
   reported and re-derived across multiple secondary sources; the original
   is Efron & Morris 1977, *Scientific American*, "Stein's Paradox in
   Statistics" — not independently re-fetched in full here, cross-checked
   via 3 consistent secondary derivations). 18 MLB players, 1970 season,
   first 45 at-bats used to shrink toward the grand average (0.265) and
   predict the rest of the season. Total squared prediction error: naive
   per-player average = 0.086; James-Stein shrinkage estimator = 0.027 —
   less than one-third the error. This is the canonical, smallest possible
   demonstration of exactly Gridiron's situation: n≈0-3 games of new
   evidence, shrink hard toward a group mean, win big on total error. (Not
   counted toward "4 read in full" — flagged as secondary/cross-checked, see
   Brown 2008 and the fantasy blog below for full reads on the same idea.)

4. **Rome, S., "Bayesian Hierarchical Modeling Applied to Fantasy Football
   Projections for Increased Insight and Confidence"** (practitioner blog,
   srome.github.io). Read in full. Sample: 2014 NFL fantasy weekly data,
   trained on 2014, tested on 2015, hierarchical structure over
   position/team/rank quartile with Normal/Uniform/Exponential priors.
   Honest result: MAE 6.08 vs. 5.99 for a plain 7-game rolling average —
   essentially a wash on point accuracy. The paper's real value was
   *calibration* (lower predicted SD rows were in fact more accurate), and
   the author explicitly flags that players with sparse history caused
   convergence trouble and were "handled" only by inflating their predictive
   SD, not by a real transfer mechanism. This is an important negative/
   honest result to cite: naive hierarchical Bayes alone does not
   automatically solve cold start — you still need an explicit
   cross-period or cross-source prior (à la source 1, 2 below) to feed it,
   not just a partial-pooling model structure with nothing to pool from at
   week 1.

5. **FiveThirtyEight NFL Elo methodology, as documented by The Reef Data
   Lab, "NFL Elo Model"** (thereefdatalab.substack.com; the original
   fivethirtyeight.com methodology page 301-redirects to an unrelated ABC
   News politics page and could not be fetched directly — noted, not used
   as the primary citation). Read in full. Exact mechanism: each team's
   preseason rating = 1/3 regression toward the league mean (1505) of last
   season's final Elo, **blended 2/3 with a market-derived prior** (Vegas
   season win-total, converted at ~34 Elo points per win, floor ~1250) for
   the *current* season, and for a franchise with literally zero history
   (2003 season 1), the market prior gets 100% of the weight (w1=0, w2=1).
   This is the practitioner playbook for "cross-period decay + external
   market prior when internal history is zero" — precisely the two-part fix
   candidates below (F1 cross-season internal transfer, F3 external
   market-prior head).

## Candidates

50/50 split: 3 "fix" tied to the exact heads-null defect, 3 "new" capability.
Cost/exit tests below; do_not_do list follows.
