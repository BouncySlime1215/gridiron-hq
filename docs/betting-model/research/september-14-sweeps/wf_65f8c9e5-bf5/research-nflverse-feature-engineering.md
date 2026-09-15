# nflverse feature engineering: how the best public NFL models turn play-by-play into team-strength features

**Scope and method.** I built on earlier reports rather than repeating them: GF02 (nfelo's Elo structure), F15 (shrinkage), F08 (it first flagged momentumnfl) and GF09 (the nflfastR expected-points and win-probability models). New work for this report:
- Cloned and read `greerreNFL/wepa`, `nfelounits` and `nfeloqb` into `/private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/feat_research/`.
- Re-read the local clones of `nfelo`, `nflfastR` and `momentumnfl`.
- Pulled 538's methodology page from a Wayback snapshot dated 2024-01-10.
- Read the Gridiron schema (read-only). `nfl_team_week_features` has 2016–2025 per-game JSON features built from nflverse play-by-play CSVs. Its garbage-time filter keeps plays with nflverse `wp` between 0.1 and 0.9 (`server/services/nfl-pbp.js:290-293`).

---

## (A) Key findings with sources

**1. Basic definitions in nflverse.**
- `success = epa > 0` (`nflfastR/R/helper_additional_functions.R:75`).
- The expected-points model behind EPA was built with leave-one-season-out validation over 2000–2019 and includes era dummies ([Baldwin, OSF 2020](https://www.opensourcefootball.com/posts/2020-09-28-nflfastr-ep-wp-and-cp-models/)).
- The only filter in the nflfastR beginner's guide is illustrative: `wp > .20 & wp < .80 & down <= 2 & qtr <= 2 & half_seconds_remaining > 120` (`vignettes/beginners_guide.Rmd:259`). nflverse ships no official garbage-time rule.
- nflverse `vegas_wp` is built from the pregame spread (`R/ep_wp_calculators.R:148`).

**2. nfelounits is the most complete public EPA unit model** ([repo](https://github.com/greerreNFL/nfelounits); no license; last commit 2026-09-08).
- **Six units:** pass, rush and special teams, each on offense and defense.
- **Filters:** it removes plays with null or zero EPA, kneels and two-point tries. It has **no garbage-time filter**. Instead it shrinks the update when a game's play count is unusual: `sf *= 1/(1+(z/threshold)²)`.
- **Update rule:** an EWMA on the opponent-adjusted residual, `new = old + sf*(observed − expected)`.
  - Offense expected EPA = own rating + QB adj + location + weather − opponent rating + league baseline.
  - The league baseline is its own slow EWMA, which keeps the process point-in-time and handles era drift.
- **Fitted per-game smoothing factors** (implied half-life = ln 0.5 / ln(1−sf), my calculation):

  | Unit | sf | Half-life |
  |---|---|---|
  | Pass offense | 0.0622 | ≈10.8 games |
  | Pass defense | 0.0474 | ≈14.3 |
  | Rush offense | 0.0502 | ≈13.5 |
  | Rush defense | 0.0326 | ≈20.9 |
  | ST offense | 0.0256 | ≈26.7 |
  | ST defense | 0.0131 | ≈52.6 |

- **Offseason reversion toward league average:**
  - Pass offense 0.0, but 0.509 toward the Week 1 starter's QB value.
  - Pass defense 0.476, rush offense 0.391, rush defense 0.536, ST 0.34 / 0.27.
  - So defense regresses harder than offense.
- **Turnover discount rates (config names):** INT 0.096, QB fumble 0.167, non-QB fumble 0.645. Non-QB fumbles are treated as mostly noise.
- **QB:** QB-Elo difference / 25 converts to EPA. The adjustment applies only when a non-starter plays.
- **Weather:** sigmoid discounts with midpoints fixed at 18 mph wind and 32°F. Wind mainly hurts passing.
- **Result:** over 5,065 games its log loss is 0.623, versus 0.6224 for 538 QB-Elo and **0.6093 for the market** (Analytics README).
- **Caveat:** the config is a single all-history optimization, so its parameters are *not* point-in-time.

**3. WEPA** ([repo](https://github.com/greerreNFL/wepa); no license; [method page, 2020-09-05](https://www.nfeloapp.com/analysis/weighted-EPA-methodology-and-performance/)).
- It down-weights random-outcome plays (recovered fumbles) and plays at extreme win probability, and up-weights close-game plays on a bell curve.
- v3 features: `tos_three_quarters_int`, `special_teams_all`, `d_plays_all_boosted`. The feature-definition modules are **not in the public repo**, so the exact weights can't be verified.
- **Objective:** R² of first-half-season WEPA predicting second-half margin (`window_type='team_halves'`).
- **Point-in-time weights:** retrained each season on seasons ≤ s and tested on s+1. Weights are smoothed with a softmax blend of running median, previous value and new fit (`WepaWeights.smoother`).
- Claimed lift over raw EPA: a "7.5% median lift" in R², *inconsistent across windows* (their own words).
- nfelo's in-season update blends margin 0.7382, WEPA 0.1506 and PFF 0.1113 (`nfelo/config.json`). An earlier nfelo article found 60/20/20 best ([source](https://www.nfeloapp.com/analysis/whats-the-best-nfl-game-grade/)).

**4. Opponent adjustment leaks when it uses future ratings.** The same nfelo article reports DVOA R² of 0.263 point-in-time versus 0.278 with end-of-season opponent adjustments. That is a measured lookahead inflation.

Public ways to adjust for opponent:
- **Lagged opponent mean** (Goldberg, [OSF 2020-08-20](https://opensourcefootball.com/posts/2020-08-20-adjusting-epa-for-strenght-of-opponent/)): `adj_off = off_epa + (league_mean − opp_def_epa_lag10)`. Accuracy 0.640 vs 0.635 unadjusted, on a small sample with no significance test.
- **Play-level ridge** (Bud Davis, [2021-10-12](https://radsportsanalytics.com/blog/opponent-adjusted-stats-ridge-regression/)): one-hot offense, defense and HFA; `RidgeCV(alphas=[75…325])`. Full seasons select α≈150–200, partial seasons select higher. Built for college football; the method transfers.
- **Bayesian hierarchical, Student-t** (Anderson, [OSF 2021-06-27](https://opensourcefootball.com/posts/2021-06-27-estimating-team-ability-from-epa/)): ν=6, σ_off prior N(0.06, 0.03), σ_def prior N(0.03, 0.03). The prior sets defensive spread at half of offense.
- **Elastic-net ordinal regression** that combines opponent adjustment with complementary-unit features (Skripnikov & Sivadanam 2025, [arXiv:2506.03057](https://arxiv.org/abs/2506.03057)). I read only the abstract; no numbers verified.

**5. momentumnfl is the closest production analogue** ([repo](https://github.com/renenunezg/momentumnfl), MIT, commit 2026-09-10).
- **Refit:** weekly from scratch on games before the forecast week, as a joint weighted ridge regression across all teams at once (`joint_scoring.py`).
- **Garbage time:** decided by score margin at drive start, not by win probability. Thresholds are Q1 28, Q2 21, Q3 16, Q4+ 14 points (`features/drives.py`). This avoids the spread embedded in `vegas_wp`.
- **Target:** points per drive fused with EPA per drive. EPA is rescaled by a fitted slope clipped to [0.1, 2], then the two are combined with inverse-covariance weights.
- **Weights and priors:** recency weight `0.5^(Δweek/6)`; strength prior SD 0.25 points per drive; HFA prior 2±1 points.
- **Calibration grids:** half-life {∞, 12, 6}; preseason carryover {0.5, 0.6, 0.7} × win-total blend {0.2, 0.35, 0.5}.
- **QB layer:** EPA strength with a 1,000-dropback span and a 52-calendar-week half-life, shrunk with 200 prior dropbacks, coefficient 0.25. Its own README admits the 2022–2025 validation couldn't separate coefficients between 0.25 and 0.75.
- **Honesty:** the README says 2022–2025 is "repeatedly inspected retrospective validation, not a fresh holdout". The repo publishes no accuracy numbers against the closing line.

**6. 538** (Wayback snapshot 2024-01-10; [code](https://github.com/fivethirtyeight/nfl-elo-game), MIT).
- **Elo:** K=20. MOV multiplier `ln(PD+1)·2.2/(EloDiff·0.001+2.2)`. HFA ≈48 plus 4 per 1,000 miles; bye +25; playoff ×1.2; Elo points / 25 = spread.
- **Preseason:** revert 1/3 toward 1505, blended with Vegas win totals.
- **QB VALUE formula:** `−2.2·Att + 3.7·Cmp + Yds/5 + 11.3·TD − 14.1·INT − 8·Sk − 1.1·RuAtt + 0.6·RuYds + 15.9·RuTD`, adjusted for the opposing defense.
  - Individual rating is an EWMA with α=0.1; team rating uses α=0.05 (a 20-game window).
  - Adjustment = 3.3 × (starter − team rolling rating), in Elo points.
  - Offseason: QBs with 10–100 starts revert 1/4. Team preseason QB rating is 1/3 prior team rating plus 2/3 projected starter.
- nfeloqb's refit ([repo](https://github.com/greerreNFL/nfeloqb), no license) uses player α=0.0886, team offense α=0.0346 and team defense α=0.0371, with career-aware S-curve regression.

**7. Offense is stickier than defense.**
- ESPN FPI says so without numbers; it is built on EPA per play "adjusted for 'trash time' and opponent strength" and publishes no formula ([ESPN](https://www.espn.com/nfl/story/_/id/13539941/how-espn-nfl-football-power-index-was-developed-implemented)).
- nfelo recommends weighting offensive EPA 1.6 and defensive EPA 1.0 to predict future net EPA, derivation not shown ([EPA tiers](https://www.nfeloapp.com/nfl-power-ratings/nfl-epa-tiers/)).
- The nfelounits reversion rates are the strongest data-fitted evidence.

**8. Garbage-time filters have weak evidence.** I found no primary source showing that a win-probability cutoff improves out-of-sample prediction. A search snippet claiming "10–90% helps median EPA" could not be traced to a source, so treat it as unverified. nfelounits, the most tuned model, uses no filter. Early-season stabilization claims (such as "3–4 games") come only from blogs; also unverified.

**9. Recency.** Lichtenstein ([OSF 2020-12-29](https://opensourcefootball.com/posts/2020-12-29-exploring-rolling-averages-of-epa/)) found exponential averaging best for pass-offense EPA and running averages best for rushing and point differential. The article gives no numeric R², so this is directional only.

---

## (B) Concrete recommendations for Gridiron

1. **Replace the ~20 hand-coded formulas with one point-in-time state estimator: a joint weighted ridge regression refit every week.**
   - **Parameters:** offense and defense for each of pass, rush and ST, per team, plus HFA. That is about 193 parameters.
   - **Build:** accumulate X'WX play by play (each row touches 2–3 columns) and solve with Cholesky in plain JS. No ML libraries needed; numpy is only for an offline cross-check.
   - **Priors:** prior mean = last season's final posterior × (1 − reversionᵤ) plus a QB prior. Prior precision per unit comes from walk-forward selection, not hardcoding. This replaces binary evidence gates with continuous shrinkage.
2. **Two evidence channels per team-game, fused as momentumnfl does:** competitive points per drive, and EPA per drive rescaled to points by a slope fitted on training data only. Offer a turnover-discounted EPA variant using nfelounits' INT, QB-fumble and non-QB-fumble rates as starting points on the grid. Use `qb_epa` for pass units.
3. **Treat garbage time as a hyperparameter, not a rule.** Compare three options walk-forward: none; a continuous weight such as `w = max(floor, 4·wp·(1−wp))` using nflverse `wp` (not `vegas_wp`); and momentumnfl's score-margin thresholds. The null gets a real chance to win. Do not let `vegas_wp` or `spread_line` into "model-only" features, or the forecast echoes the market again.
4. **Recency and regression per unit.** Grid over half-lives {∞, 16, 10, 6} weeks, with defense and ST allowed longer half-lives and heavier reversion. Select only on development seasons such as 2006–2017; report 2018+ once. Keep a trial registry per F06.
5. **Early season needs no DAVE-style schedule.** The Bayesian prior hands weight from preseason to in-season data automatically as games accumulate. Keep two preseason priors separate:
   - a **market-free** one (carryover + QB), used for bet decisions;
   - a **win-total-informed** one, for forecasting only.

   This avoids feeding the market back into itself.
6. **QB layer outside team units.** Rating = starter − team baseline, from shrunk QB EPA (for example 200 prior dropbacks) or 538 VALUE with α 0.1 / 0.05. Identify the starter only from the bitemporal injury and depth-chart snapshot before the decision, never from play-by-play of the game being predicted.
7. **Point-in-time hygiene:**
   - league baselines are EWMAs, never full-season means;
   - opponent adjustment uses only games before the cutoff (the DVOA 0.263 vs 0.278 gap shows the leak);
   - hyperparameters are fit on data up to season s and applied to s+1 (WEPA pattern);
   - store the nflverse release date for each season file, because EPA is revised;
   - backfill `nfl_team_week_features` from 1999 or 2006 onward. It currently covers only 2016–2025, about 2,700 games, which is thin for 193 parameters plus hyperparameter selection.
8. **Expectations.** The most elaborate public EPA unit model reaches log loss 0.623 against the market's 0.609. Expect this redesign to roughly match nfelo/538, not beat the close. The gate on actual bets should stay continuous closing-line-value performance.

---

## (C) Adoptable code and repos

| Repo | License | What to borrow |
|---|---|---|
| renenunezg/momentumnfl | MIT | `solve_ridge` (prior-precision GLS); `fit_joint_scoring` EPA/points fusion with inverse-covariance weighting; `competitive_drive_mask`; preseason carryover; calibration grids; `tests/test_leakage_guard.py` (fit refuses games at or after `as_of`). Port to JS. |
| nflverse/nflfastR | MIT | Definitions of `success`, `qb_epa`, `fixed_drive`, era handling; data only, no model port needed. |
| fivethirtyeight/nfl-elo-game | MIT | Elo baseline benchmark (`forecast.py`). |
| greerreNFL/nfelounits, wepa, nfeloqb, nfelo | **No license (all rights reserved)** | **Ideas and published parameter values only; do not copy code.** Residual-EWMA unit design, league-baseline EWMA, pace-anomaly discount, turnover discounts, point-in-time weight smoothing. |
| Bud Davis ridge blog | Blog, no code license | Play-level one-hot ridge design; α range as a sanity check. |

---

## (D) Open questions and risks

- **Unverified claims:** the exact WEPA feature weights (the modules aren't public); any primary out-of-sample evidence for garbage-time filters; DAVE's weekly weights (FTN pages returned 403); nfelo's 1.6/1.0 derivation; how success rate compares with EPA for prediction.
- **EP-model leakage:** historical EPA for 2000–2019 comes from an expected-points model trained with those seasons pooled. Small, not quantified, and unavoidable unless the model is retrained point-in-time, which is out of scope without xgboost.
- **Sample size:** ~270 games per season versus ~193 parameters plus about 5 grids makes selection risk high. Needs multiplicity control and one untouched holdout.
- **Parameter transfer:** nfelounits and 538 parameters were tuned in-sample on Elo/EWMA structures and don't transfer directly to a ridge; use them only as grid centers.
- **Data coverage:** Gridiron's `nfl_play_by_play` table (2021+, ESPN-style) has no EPA. The model depends on nflverse CSV ingestion (`nfl-pbp.js`), so the backfill and release-version tracking must be built first.