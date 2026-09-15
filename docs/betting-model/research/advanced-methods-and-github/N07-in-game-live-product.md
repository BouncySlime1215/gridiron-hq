# N07 — Live in-game win-probability product (bucket: new)

## What Gridiron actually has today (verified by reading the code, not assuming)

Gridiron is NOT starting from zero, but what exists is a stopgap the code itself
admits is a stopgap:

- `server/services/nfl-live.js` — `liveWinProbability(lead, secondsLeft, pregameSpread)`.
  Explicitly a **random walk**: `final margin = current margin + Normal(drift, sigma*sqrt(time_left))`,
  sigma = 14.16 pts measured from 1,424 games. The file's own header says what it
  is not: *"no possession, down-and-distance, or timeout awareness... will misprice
  the final two minutes, where those things decide games."* `liveGames()` (same
  file) polls ESPN's free scoreboard and is wired to a route: `server/routes/nfl-betting.js:533`
  (`GET /nfl-betting/live`).
- The ONLY UI surface for any of this is `client/src/pages/betting/Edges.tsx`, tab
  `'live'` (line 79, 90, 148-200) — a "Live scores" tab buried inside the betting
  Edges page, showing `home_win_probability` as a progress bar. There is no
  standalone route: `client/src/App.tsx`'s route table (grepped in full) has no
  `/live` or `/gameday` — Home is `/`, League is `/league`, nothing else touches
  live win probability. So "distinct from pregame spreads, as a new user-facing
  surface" is a real gap, not a strawman.
- `server/services/nfl-espn-pbp.js` — `pollLiveGames()` ingests ESPN's full live
  play log (down, distance, yards-to-endzone, clock, score, possession) into the
  same `nfl_play_by_play` table used for historical backtesting (idempotent on
  event_id/play_id). It ALSO contains two validation harnesses that already prove
  the state-conditioned approach is worth building:
  - `liveModelValidation()` (~line 507) grades `nfl-live.js`'s crude model against
    real outcomes, bucketed calibration + Brier score vs a base-rate baseline.
  - A second harness (~line 590-638) feeds live states into `simulateRemainder()`
    (the Monte-Carlo drive simulator, `nfl-drive-sim.js`) at 25/50/75% checkpoints
    and grades IT against the same `liveWinProbability()` baseline, reporting
    Brier, `incremental_skill`, and calibration buckets, explicitly stating its
    `state_contract: ['score','clock','possession','field position','down','distance']`.
- `server/services/nfl-pbp.js` ingests nflverse's full CSV (372 columns) including
  a per-play `wpa` column (from nflverse's own model), but only as a SEASON
  AGGREGATE feature for team/player efficiency reports — never used to compute a
  live, playable win-probability curve for a game in progress.
- The `nfl_play_by_play` table (251,591 rows per tonight's FOUND) already carries
  every feature Lock & Nettleton and nflfastR use — down, distance,
  yards_to_endzone, clock_seconds, score, possession — sitting unused for a
  directly-fit model. Right now the only thing standing between Gridiron and a
  real play-level WP model is: nobody has fit one. The simulator
  (`nfl-drive-sim.js`) is being asked to do that job by Monte Carlo instead, and
  it has 6 physics bugs (tonight's FOUND) that make its live-state estimates
  untrustworthy in exactly the situations (kneel-downs, timeout management,
  overtime, home/away asymmetry) where a live product lives or dies.

**Conclusion:** the gap is not "no play-by-play infrastructure" (there is
plenty) and not even "no win-probability number" (there is one, crude, and a
harness that already grades it). The gap is (1) no DIRECTLY-FIT statistical WP
model of the kind the entire academic/public literature on this topic actually
uses, and (2) no standalone user-facing surface — today it is one progress bar
in a betting sub-tab.

---

## Primary sources (4, all read in full)

### 1. Lock, D. & Nettleton, D. (2014). "Using random forests to estimate win
probability before each play of an NFL game." *Journal of Quantitative Analysis
in Sports* 10(2):197-205. DOI 10.1515/jqas-2013-0100.
Full text read: https://homepage.divms.uiowa.edu/~dzimmer/sports-statistics/nettletonandlock.pdf

- **Data**: nflverse-precursor data (ArmChairAnalysis.com) from all 2001-2012
  NFL play-by-play. Train = 2001-2011 (n=430,168 plays, 2,928 games); **2012
  held out as test set** (season-level holdout, not row-level — this matters).
- **Method**: random forest of REGRESSION trees (not classification — they show
  regression trees materially beat classification trees late in games), 500
  trees, tuned by CV on the 2011 season: `mtry=2`, `nodesize=200` (well above
  randomForest's default of 5). 9 predictors: `Down, Score` (score differential),
  `Seconds` (remaining in game), `AdjustedScore = Score/(Seconds+1)^0.5`
  (engineered — 0.5 exponent itself chosen by CV), `Spread` (Vegas pregame
  line), `TIMO`/`TIMD` (timeouts offense/defense), `TOTp` (total points scored
  so far), `Yardline`, `YTG` (yards to go).
- **Headline result (honest, with numbers)**: test-set (2012, truly
  out-of-sample) calibration correlation r=0.998 between predicted WP bucket
  and actual win rate in that bucket (Figure 2) — i.e. genuinely well-calibrated,
  not just accurate. Overall test MSE = 0.156. **MSE by quarter, out-of-sample:
  Q1=0.201, Q2=0.177, Q3=0.143, Q4=0.107** — the model gets measurably sharper
  as the game proceeds, which is the opposite failure mode of Gridiron's current
  `nfl-live.js`, which self-flags as LESS reliable near the end because it has
  no state awareness there.
- **Variable importance (permutation, Table 3)**: `Score` dominates overall
  (0.1365) and in 3 of 4 quarters; **`Spread` is actually the single most
  important variable in Q1 (0.0577 vs Score's 0.0470)** and decays to near
  irrelevance by Q4 (0.0046) — i.e., the pregame line matters most exactly when
  the least in-game evidence exists, then correctly gets swamped by what's
  actually happening. `Down`, `TIMO`, `TIMD`, `YTG` individually matter very
  little on their own (their information is mostly redundant with score/time
  once field position is known) but the paper is explicit these interactions
  are what the tree method captures that a flat linear model would miss.
- **Direct, worked comparison against Brian Burke's model** (Figure 8, Super
  Bowl 45): the two track closely; Lock/Nettleton's differs mainly by giving a
  non-50% start (because Spread enters directly) while Burke's method starts
  every game at 50/50 regardless of the pregame line.
- **Applied example that is a template for a Gridiron feature**: they use
  ΔWP (win probability added, the play-level delta) to re-rank the "greatest
  plays" of two real Super Bowls — David Tyree's helmet catch (SB42) actually
  only added ΔWP=0.113; the Plaxico Burress TD 4 plays later added ΔWP=0.389;
  James Harrison's goal-line INT return for a TD (SB43) added ΔWP=0.511 and by
  this metric is the biggest play of that era of Super Bowls, not the plays
  ESPN/media coverage emphasized. This is exactly the "swing plays" feed
  described in candidate N07-C3 below — it is not a hypothetical use case, it's
  the paper's own demonstrated application.
- **Coaching-decision use case** (Section 7, also directly reusable): they
  compute WP for accept-vs-decline penalty and 4th-down go/kick decisions
  directly from the forest (e.g., 3rd-and-10 penalty-decline vs 3rd-and-20-accept:
  46% vs 43% WP — a real, non-obvious answer). This generalizes past this year's
  4th-down decision engine into a live sequencing tool.
- **Honest limitation, stated by the authors themselves**: the model treats
  each game's ~150 sequential plays as independent observations — momentum
  adjustments (score-at-end-of-prior-quarter as a predictor, separate forests
  by down/quarter/second) were all TRIED and DISCARDED because they made
  out-of-sample performance worse or unchanged, not better. This is a direct,
  falsifiable warning against over-engineering feature-count on a similar-sized
  dataset — relevant since Gridiron's own play-by-play is comparably sized
  (251,591 rows vs their 430,168-play training set, but likely fewer distinct
  seasons of clean live-state data — see do_not_do below).

### 2. Baldwin, B. / nflfastR team, "nflfastR EP, WP, CP, xYAC, and xPass
models." *Open Source Football*, 2020-09-28. Full text read:
https://opensourcefootball.com/posts/2020-09-28-nflfastr-ep-wp-and-cp-models/

- **Why they moved off Lock & Nettleton-style random forests to gradient
  boosting**: to fix nonlinear interactions at end-of-half/end-of-game the RF
  handled coarsely, and to make era-adjustment (rule changes, scoring-rate
  drift across 20 seasons) tractable.
- **Features**: seconds remaining in half AND in game (both, not just one),
  yardline, score differential, down/distance, timeouts remaining EACH team,
  a `receive_2h_ko` indicator (whether this team gets the 2nd-half kickoff —
  directly relevant near halftime), home/away, and a **time-decayed score
  differential term**: `point_differential · e^(4·(3600 − game_seconds_remaining)/3600)` —
  an explicit engineered feature making a given lead "worth more" as time runs
  out, which is the same idea as Lock & Nettleton's `AdjustedScore` but with a
  different, deliberately-tuned decay shape. A separate "spread-adjusted"
  variant adds a time-decayed Vegas-line feature.
- **Architecture (numbers, not vibes)**: `xgboost`, binary logistic objective,
  `eta=0.2, max_depth=4, subsample=0.8, colsample_bytree=0.8`, `nrounds=65`
  (base model) / `nrounds=534` (spread-adjusted variant). **Leave-one-season-out
  (LOSO) cross-validation across 20 seasons (2000-2019)** — i.e. every model
  evaluation is genuinely out-of-sample by season, never by row.
- **Calibration procedure**: Yurko/Ventura/Horowitz binning (see source 3
  below) — predictions binned into 5% buckets, observed-vs-predicted win rate
  compared per bucket, quarter by quarter.
- **Headline numeric result**: base WP model calibration error **0.0055**
  vs. the prior-generation nflscrapR model's **0.0397** (roughly 7x tighter);
  spread-adjusted variant calibration error 0.0066 (marginally worse than the
  no-spread model on pure calibration, but the source reports it **reduces
  cross-validated classification error rate from 27% to 23% and log-loss from
  0.52 to 0.44** by adding the market prior) — i.e., adding a market/spread
  input measurably improves discrimination even though it doesn't improve raw
  calibration, a genuine and useful nuance for how Gridiron should combine its
  own market data with a live model.

### 3. Yurko, R., Ventura, S., Horowitz, M. (2019). "nflWAR: A Reproducible
Method for Offensive Player Evaluation in Football" (extended ed.). arXiv:1802.00998,
published in *Journal of Quantitative Analysis in Sports*. Full text read
(PDF, sections 1-4.1 in detail with figures).

- Not primarily a WP paper, but it is the paper that DEFINES the calibration
  procedure nflfastR cites (source 2) and is a second, independently-designed
  WP model worth knowing for its differences from Lock & Nettleton and
  nflfastR: a **Generalized Additive Model (GAM)**, not a random forest or
  GBM:
  `log(P(Win)/P(Loss)) = s(E[S]) + s(s_h)·h + s(E[S/(s_g+1)]) + h·u·t_off + h·u·t_def`
  where `E[S]` is an expected-score-differential term built by first fitting a
  SEPARATE **multinomial logistic regression "next-score" expected-points
  model** (touchdown/FG/safety/no-score/opponent-TD/opponent-FG/opponent-safety
  as the 7-class response) and feeding its output into the WP model — i.e. EP
  as an engineered feature for WP, a two-stage architecture distinct from both
  other sources' single-stage models.
- Data: nflscrapR play-by-play, all games 2009-2017 (public source since the
  NFL only exposes play data from 2009 forward via its API).
- Validation: LOSO CV "yields the best calibration results" (their words);
  calibration plots by quarter (their Figure 6) show observed-vs-expected win
  proportion tracking the diagonal in every quarter — same diagonal-plot
  standard as source 2, "no obvious systematic patterns that would signal a
  flaw," a finding they note is corroborated independently by Yam & Lopez
  (2018) grading both this model and Lock & Nettleton's.
- **Worked example directly reusable as a Gridiron feature**: the paper
  computes EPA and WPA for the Philly Special (Super Bowl LII) — the offense's
  expected points were ≈2.78 before the trick-play TD, so EPA ≈ 7−2.78 = 4.22,
  and the associated WPA ≈ 0.1266. It also formalizes splitting a single pass
  play's value into `EPA_air` (value of the throw location) and `EPA_yac`
  (value of yards after catch) by inserting a hypothetical intermediate game
  state at the moment of the catch — a genuinely new decomposition Gridiron's
  current `wpa`/`epa` columns (season aggregates only, see `nfl-pbp.js:295,376,402`)
  do not attempt.
- **Honest limitation stated by the authors**: WAR itself (the paper's main
  contribution) is currently only computable for offensive skill positions
  (QB/RB/WR/TE) because public play-by-play doesn't identify which of the
  other 18 players were on the field for a given play — a data ceiling, not a
  modeling one, and one Gridiron shares (ESPN's live feed has the same gap).

### 4. Burke, B. "Win Probability Model/Calculator Upgrades — Team Strength
Adjustment & More." *Advanced Football Analytics*, 2013-12.
https://www.advancedfootballanalytics.com/2013/12/win-probability-modelcalculator.html

- The historically first public in-game WP model (2007-on), read here in its
  2013 refined form. Method (confirmed by Lock & Nettleton's own description of
  it, source 1, since Burke's site doesn't itself publish the internals in
  detail): **empirical binning + smoothing**, not a fitted parametric/tree
  model — partition historical plays into bins by score/time/field position/
  down/distance, use the in-bin win rate as the estimate, extrapolate/smooth
  across nearby bins. The 2013 upgrade adds: a team-strength adjustment (user
  supplies a pregame WP or point spread; the site decays the team-strength
  edge "proportionally to the log of time" as the game progresses — this is
  the SAME modeling idea as Lock & Nettleton's `AdjustedScore` and nflfastR's
  exponential time-decay term, independently arrived at, which is a useful
  cross-validation of the general shape of that decay across three unrelated
  research efforts), 2-point-conversion goal-line accounting, and recursive
  4th-down decision logic feeding into the WP call itself.
- **Honestly reported limitation, in Burke's own words**: he states plainly he
  has NOT incorporated timeout management into the live model — "a whole
  other level of complexity" — and that the model can show visible
  discontinuities at the boundary where a trailing team's optimal strategy
  flips from normal play-calling to a four-down/no-punt mindset. No accuracy
  or calibration numbers are published for this version (unlike sources 1-3);
  that absence is itself the useful finding: Burke's site is what popularized
  in-game WP as a live TV/media product, but its own methodology page carries
  none of the calibration rigor Gridiron would need before shipping a number
  to users. This is exactly the ESPN model was is the ancestor of ESPN's own
  live win-probability graphic (they later hired Burke), showing the
  progression from ad hoc binning -> tree/GAM models with published
  calibration is the field's own arc, and Gridiron should skip straight to
  the tree/GAM end rather than starting at Burke's 2007 approach.

---

## Reference repos (checked, not blindly ported)

| repo | stars | license | last commit | what it is |
|---|---|---|---|---|
| `AndrewRook/NFLWin` | 24 | MIT | 2019-10-20 (stale) | Python sklearn `Pipeline`: `ComputeElapsedTime` -> feature transforms -> `LogisticRegression`/`RandomForestClassifier` wrapped in `CalibratedClassifierCV`, validated with `brier_score_loss`. Cloned and read `nflwin/model.py` (519 lines) and `nflwin/preprocessing.py` (537 lines) directly — confirms this is a real, working, calibration-first WP pipeline, not a toy. |
| `nflverse/fastrmodels` | 8 | MIT (nflverse std) | 2026-02 (active) | Ships the actual trained xgboost model object(s) nflfastR loads at runtime (`wp_model` etc., R `.rda` binaries under `data/`). Confirms source 2's numbers came from a real, still-maintained artifact, not a one-off blog post. |
| `nflverse/nflfastR` | 541 | Other/nflverse std | 2026-09-06 (active this week) | The package itself; not portable to Gridiron's Node stack directly but is the reference implementation whose feature list and CV scheme (LOSO, 2000-2019) source 2 is describing. |

**Adoption path for Gridiron (Node/JS, SQLite via `db/index.js`, no Python/R
runtime in the stack)**: none of these are directly importable. The correct
move is `borrow-idea`: replicate the FEATURE LIST and the LOSO-by-season
validation discipline in native JS against `nfl_play_by_play`, using either
(a) a hand-rolled regularized logistic regression (a few dozen lines, no
dependency, matches Burke/topfunky's simplest approach and is enough to beat
`nfl-live.js`'s score-only random walk), or (b) a small pure-JS gradient
boosting library if more accuracy is wanted later. `AndrewRook/NFLWin`'s
PIPELINE STRUCTURE (elapsed-time feature -> categorical encode -> model ->
isotonic/Platt calibration wrapper) is the concrete blueprint to copy in JS
even though the code itself won't run in this stack.

---

## Candidates
See structured output. Summary of the 7 candidates:

1. (new) Directly-fit play-level WP model (logistic regression to start,
   optionally GBM later) trained on `nfl_play_by_play`, replacing the
   random-walk in `nfl-live.js` as the model backing live WP.
2. (new) Standalone `/live` (Game Center) user-facing route — distinct from
   `/betting/nfl` — surfacing the new model's WP curve per live game.
3. (new) Live "swing plays" WPA feed (biggest ΔWP plays this week/right now),
   directly modeled on Lock & Nettleton's Tyree/Burress/Harrison worked example.
4. (new) Versioned, retrainable model artifact + weekly refit job (mirrors
   `PLAY_MODEL_VERSION` pattern already used in `nfl-drive-sim.js`), so the WP
   model doesn't silently rot as rules/scoring rates drift across seasons.
5. (new) Fantasy-facing live WP surfacing — "trailing team = garbage-time pass
   volume" flag on player pages, powered by the same model, kept OUT of the
   betting surface per Nick's fantasy-over-betting priority.
6. (fix) Fix the specific `nfl-drive-sim.js` bugs (inverted kneel rule, dead
   timeout counter, home-spread-for-away-WP) that make `simulateRemainder()`
   untrustworthy as a live-state engine — a hard prerequisite before any
   simulation-based (as opposed to directly-fit) live WP number can be shown
   to users.
7. (fix) Consolidate: any new live-WP/WPA number must not become a 6th
   disagreeing implementation on top of tonight's already-documented 5
   conflicting CLV implementations — route all WP/WPA through one function
   and one sign convention before shipping a user-facing number.

## Do-not-do list
See structured output field `do_not_do`.
