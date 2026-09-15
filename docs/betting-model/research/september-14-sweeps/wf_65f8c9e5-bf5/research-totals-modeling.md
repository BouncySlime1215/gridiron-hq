# Totals modeling for Gridiron HQ

## 0. Where this starts from
- **F17** (research2/F17-margin-distribution-lit.md) says not to copy soccer bivariate-Poisson models directly. NFL scores are sums of 3/6/7/8-point events. Moyer et al. (2024) found even a multi-event independent-Poisson NFL model puts about half the real probability on key numbers. F17 also lists a compound-Poisson totals engine as a later candidate.
- **N17** says the flat `weather_total` constant is mixed up with roster construction (windy-city teams build run-heavy rosters). It proposes fixed-effects weather-by-team-style interactions and a humidity test (Paul 2017, abstract only).
- **FIX_AND_ADD #15 and F08** rate the Koopman & Lit score-driven bivariate Poisson highly. That evidence is from soccer only.
- **New in this report:** I checked the literature on totals-market efficiency and ran read-only queries on `server/data.sqlite`. The scripts are in the scratchpad (`gl.csv`, `tot.py`, `rel.py`, `joint.py`). Nothing in the repo was changed.

## 1. Is the totals market less efficient?

### Literature (mixed and mostly old)
- **Paul & Weinbach (2002), J. Sports Econ. 3(3), 1979–2000** ([link](https://journals.sagepub.com/doi/10.1177/1527002502003003003)): the market was efficient overall, but unders on high totals (≥47.5) won 58.7% (from the search summary and Kelly & Chen's restatement).
- **Kelly & Chen, Research in Business and Economics Journal vol. 14** ([PDF, read](http://www.aabri.com/manuscripts/193138.pdf)): the same rule won 59.7% in 2001–09 (95-141, p=0.014). It lost in 2010–18 (47.1% on unders). Bettors still favor overs, and the authors credit the change to sportsbooks pricing differently.
- **Borghesi (2008), Applied Financial Economics 18:947–953, 1984–2004** ([link](https://www.tandfonline.com/doi/full/10.1080/09603100701335432)): heat, wind and rain are under-priced in totals, and an out-of-sample weather rule beat the 52.38% breakeven. I only read the abstract.
- **Kain & Logan (2014), J. Sports Econ. 15(1)** ([link](https://journals.sagepub.com/doi/abs/10.1177/1527002512437744)): totals lines predict less well than spreads across US leagues. This is from the abstract and search summaries; the full text was blocked (403).
- **Moskowitz (2021), J. Finance** ([PDF, read](https://spinup-000d1a-wp-offload-media.s3.amazonaws.com/faculty/wp-content/uploads/sites/3/2021/08/AssetPricingandSportsBetting_JF.pdf)):
  - Over/under contracts show the same pattern as other bets: momentum from open to close, then a reversal. About half of the open-to-close move is undone by the result.
  - Over/under returns are uncorrelated with spread returns.
  - The returns "fail to overcome transactions costs".
- **Shank (2019), IJSF** ([link](https://journals.sagepub.com/doi/10.32731/IJSF.141.022019.01)): blocked (403), not verified.

### Gridiron's own data
Source: `game_lines`, home rows, weeks ≤18, nflverse `total`/`spread`. The exact timestamp of these lines is not documented, so I treat them as "near-close".

| Era | n | Total RMSE | R² of total line* | Total calibration slope | Spread RMSE | R² of spread |
|---|---|---|---|---|---|---|
| 1999–09 | 2836 | 13.72 | 0.078 | 0.90 | 13.39 | 0.176 |
| 2010–19 | 2600 | 13.31 | 0.083 | 0.97 | 13.29 | 0.173 |
| 2020–26 | 1635 | 13.12 | 0.080 | 0.99 | 12.65 | 0.203 |

\*R² is measured against a season-mean baseline.

- **Totals are much harder to predict**, and that shows in R². It is not proof of mispricing: the recent calibration slope is about 1.0.
- **Paul-Weinbach replication:** lines at least 5 points above the season mean went under 53.3% in 2013–26 (n=383). That is not significant against 52.4%.
- **Opening vs closing total (2020+, n=1356):** RMSE 13.38 vs 13.13. Regressing (actual − open) on the line move gives slope 1.14 ± 0.16, not significant. Spreads give 1.02.
- **Wind ≥15 mph, outdoors, 2000+:** unders won 56.6% (n=617, z=2.07 vs 52.4%; 57.7% in 2000–12, 54.9% in 2013–26). The actual total came in about 1.5 points below the line.
  - **This result is look-ahead.** The `wind` column is recorded game-time wind, not the forecast available when betting. It is also one test among many. Treat it as a hypothesis, not an edge.

**Verdict:** the evidence for an exploitable totals inefficiency is weak and has decayed. The one plausible, mechanism-backed lead is weather priced late (Borghesi, and the wind check above). Totals are a separate market with uncorrelated returns (Moskowitz), so they add diversification, but expect edges smaller than 1 point.

## 2. What predicts totals: pace, efficiency, red zone
Measured on `nfl_team_week_features` (per-game values, 2016–25, n=320 team-seasons):

| Metric | Split-half r (odd vs even weeks) | r(first 8 games → rest-of-season points/g) | r(first 8 → rest-of-season game total/g) |
|---|---|---|---|
| Offense EPA/play | 0.59 | 0.52 | 0.34 |
| Points/drive | 0.58 | 0.51 | 0.34 |
| TD/drive | 0.57 | 0.47 | 0.34 |
| Success rate | 0.62 | 0.47 | 0.29 |
| **Red-zone TD rate** | **0.04** | 0.18 | 0.14 |
| **Goal-to-go TD rate** | **0.03** | 0.07 | 0.05 |
| Seconds/play (proxy) | 0.52 | 0.11 | 0.02 |
| Offensive plays | 0.37 | 0.10 | 0.07 |
| PROE | 0.73 | 0.12 | 0.07 |
| Defense EPA/play | 0.32 | 0.21 (points allowed) | 0.01 |

What this shows:
- **Red-zone TD rate is noise** at the team-season level. This matches the practitioner claim that it barely persists year to year (Barnwell, cited via [The Ringer](https://www.theringer.com/2016/11/10/nfl/nfl-offenses-red-zone-efficiency-panthers-saints-patriots-3f6ae285941a); secondary source). Two caveats:
  - The stored field is TDs per red-zone *play*, not per trip, which adds noise by construction.
  - Don't use raw red-zone rate as a feature. Use shrunken red-zone TD/trip, or an expected TD rate from yards/EPA.
- **Pace is stable but barely predicts points** on its own. The seconds/play proxy is crude (drive seconds ÷ plays, not neutral-situation); nflfastR-style neutral pace (clock running, win probability 20–80%, per [Sharp](https://www.sharpfootballanalysis.com/stats-nfl/nfl-team-pace-stats/)) should be tested before dismissing pace. Pace belongs in the drive count, multiplied by efficiency, not as a linear term.
- **Offensive efficiency carries the signal.** Defensive metrics are much less stable, so they need heavier shrinkage.

## 3. Joint score distribution
From `joint.py`:
- **Team scores are nearly independent once you know each team's implied total.** Residual correlation between home and away scores, given market-implied team totals, is 0.02 / 0.00 / 0.035 across the three eras. A bivariate Poisson covariance term buys almost nothing at this level; independent team PMFs convolved together are adequate.
- **Spread and scale:** total residual SD is about 13. It rises slightly with the line (13.07 below 40 → 13.6–13.8 at 48+). Skew is +0.2 to +0.36, and the actual total averages about 0.5 above the line.
- **Key numbers in totals are weak.** Since 2015 the most common total (51) happens 3.85% of the time, versus 14.6% for a margin of 3. You still need a discrete PMF to price pushes on integer totals, but the tilted key-number machinery the margin needs matters much less here.
- **Baker & McHale (2013), IJF 29(1):122–130** ([link](https://doi.org/10.1016/j.ijforecast.2012.07.002)): a point-process model with separate TD/FG hazards, driven by team stats and/or the spread and over/under. The market slightly beats it on results; it does at least as well as the market on exact scores. I read the abstract only; the full text was blocked. Its structure (TD and FG hazards) is the right NFL-native alternative to soccer Poisson.
- **Koopman & Lit (2015), JRSS-A 178(1)** ([link](https://doi.org/10.1111/rssa.12042)) and Karlis & Ntzoufras (2009, Skellam, [link](https://academic.oup.com/imaman/article-abstract/20/2/133/716512)): soccer only. I found no NFL validation of score-driven (GAS) models; that is unverified.

## A. Key findings
1. The literature's totals anomalies (high-total unders, weather) were real in 1979–2009 samples. The high-total rule is gone after 2010 (Kelly & Chen; my replication). Totals move and reverse like spreads and don't cover costs (Moskowitz 2021).
2. Closing totals are calibrated (slope 0.99 since 2020) but explain only about 8% of variance, against about 20% for spreads. A totals model's error will be close to the market's (~13.1); gains will be small.
3. Red-zone TD rate has about zero split-half reliability. Efficiency per play/drive does (~0.6). Pace is reliable but weakly predictive alone. Defense is much noisier than offense.
4. Given the market, home and away scores are nearly independent. Residuals are mildly heteroscedastic and right-skewed, and totals key numbers are weak.
5. The wind ≥15 mph under signal (56.6%, z=2.07) matches Borghesi (2008) but uses realized wind, so it is look-ahead. It has to be re-tested with archived forecasts.

## B. Recommendations (Node, numpy-only research, ~270 games/season)
1. **Build one model with two outputs.** Predict expected points for each team:
   - μ_team = drives_game × PPD(offense efficiency, opponent defense efficiency, context).
   - Spread = μ_home − μ_away; total = μ_home + μ_away.
   - Offense and defense ratings are shared with the spread model (ridge/state-space per F08/F15), so spread and total can never contradict each other.
   - The drive count is a shared pace term built from both teams' neutral pace, pass rate over expected, and the expected script (from the spread).
2. **Anchor to the market and regularize.** Model:
   - target = actual team points − market-implied team total at decision time;
   - residual = Xβ with ridge (closed-form Cholesky in plain JS; 30–60 features × ~5k team-games is trivial);
   - β shrinks to 0, so the forecast defaults to the market;
   - choose λ by walk-forward CV only.
   - Fit a market-free version in parallel to measure how much information the model has on its own.
   - This replaces binary gates.
3. **Features, all as-of kickoff minus the decision lag:**
   - Opponent-adjusted, exponentially weighted offense/defense EPA/play, success rate and PPD, with separate half-lives and heavier shrinkage for defense.
   - Red zone only as expected TD/trip, shrunk.
   - QB/OL availability from bitemporal injuries (F05).
   - Forecast wind, precipitation, temperature and humidity × roof × team pass rate (N17 design).
   - League scoring environment by season-week, since mean totals drifted from 41.6 to 46.2.
   - Rest, turf, altitude.
4. **Distribution:**
   - Per-team discrete PMF: the empirical team-score PMF near μ, tilted to match μ (the same idea as `margin-distribution.js`).
   - Convolve the two teams' PMFs for the total and derive P(over/under/push) at every half-point.
   - Scale the SD with μ; calibrate PIT/CRPS walk-forward. Add Baker-McHale-style TD/FG hazards only if the PMF approach fails calibration.
5. **Bet gate:**
   - Totals get their own continuous out-of-sample CLV and log-loss tracking against the close. Stake only on a posterior-positive rolling CLV, and shrink edges by their estimated noise.
   - Weather: pre-register the forecast-wind test using Open-Meteo archived forecasts ([Historical Forecast API from ~2022; Previous Runs API from Jan 2024](https://open-meteo.com/en/docs/historical-forecast-api)). Do not use `game_lines.wind` for betting.
6. **Walk-forward protocol:** weekly retrains; score RMSE/CRPS against the actual total and CLV against the close. Record every feature and λ trial in the trial registry (F06).

## C. Adoptable code/repos
- **nflverse/nflfastR (MIT, per GF09):** borrow the definitions of neutral situations (win probability 20–80%, no spikes/kneels), EPA and drive fields to recompute neutral pace and PPD correctly. Port the definitions, not the R runtime.
- **martineastwood/penaltyblog (MIT, [repo](https://github.com/martineastwood/penaltyblog)):** reference for the time-decay-weighted likelihood, bivariate Poisson/Dixon-Coles negative log-likelihood (for a one-off benchmark in numpy) and the walk-forward `Backtest` with `lookback < date` slicing. Don't port its soccer score model into production.
- **LeoEgidi/footBayes (GPL-2, per GITHUB_BUILD_CATALOG):** `biv_pois_dynamic.stan` is a design reference only. GPL applies if copied, and it needs Stan, which is not installed.
- **No verified JS library for any of this.** The ridge fit, PMF tilt and convolution are each under 200 lines and should be written in-house.

## D. Open questions and risks
- **Line timestamps:** I don't know whether the nflverse `total` is the true close. The open-vs-close checks use `open_total`, which only exists from 2020.
- **Red-zone field:** the stored rate is per play, so its near-zero reliability may partly be an artifact. Re-measure per trip from nflverse play-by-play.
- **Weather:** the wind finding is look-ahead and a single test. Archived forecasts only go back to 2022–24, so there will be few windy games, low power, and several seasons of waiting.
- **Unverified:** Baker-McHale, Kain-Logan, Borghesi and Shank were read at abstract or summary level only, and I found no NFL validation of GAS models.
- **Sample size:** about 270 games/season. Expected gains over the market are likely under 0.2 RMSE, and CLV noise needs hundreds of bets to separate edge from zero.
- **Shared-rating risk:** because spread and total use the same ratings, an error in the offense/defense ratings would hit both markets at once. That is a reason to monitor both markets' CLV jointly.