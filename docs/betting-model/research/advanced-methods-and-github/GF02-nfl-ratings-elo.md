# GF02 — NFL rating/Elo systems for replacing nfl-team-strength.js's hand-tuned blend

Target defect (from tonight's verified findings):
> Team-strength ratings (nfl-team-strength.js) mix stale preseason priors with
> in-season data via a hand-tuned blend, not a principled state-space/Bayesian
> update.

Verified against current code: `server/services/nfl-team-strength.js` (read-only,
fantasy-football-dashboard) computes six raw feature differentials
(`proj_off_points`, `vacated_opportunity_share`, `returning_points_share`,
`qb1_change`, `qb1_qbr_delta`, `qb1_proj_ppg_delta`) purely from **preseason**
inputs (`rosterAtSeasonStart`, `preseasonProjections`, `off_team_season`), with
no in-season update path at all, and the only "shrinkage" is `leaguePrior()`
substituting the unweighted league mean for a null column
(`teamStrengthGbmFeatures()` differences to zero when a season/team is
missing). There is no normalization (no per-feature variance/sigma), no
explicit prior-vs-observation weighting, and nothing updates week to week — a
true hand-tuned, static blend, exactly as the finding states.

## Repos cloned and read

All cloned shallow (`--depth 1 --filter=blob:none`) into
`scratchpad/research2/github/`. No `node_modules`/`venv` in any of them.

### 1. `greerreNFL/nfelo` — the production nfelo Elo/market model
- **License**: none present (no LICENSE file in the repo) → all rights reserved by default. Public repo, 56 stars, **last commit 2026-09-11** (actively maintained, commits daily around season openers).
- **What it actually does** (read, not README): `nfelo/Model/Nfelo.py` runs a per-game Elo update loop. Verified in code:
  - `nfelo/Utilities/offseason_regression.py` — `offseason_regression()`: takes a team's ending Elo, mean-reverts it toward the league median (`reversion * 1505 + (1-reversion) * previous_elo_norm`), then blends in a list of `ExternalPrior(prior_type, weight, value)` objects (DVOA, win-total-implied "wt" rating, "units" preseason Elo). Each external prior is normalized via `prior_to_elo()`.
  - `nfelo/Utilities/Priors/prior_to_elo.py` — `prior_to_elo()`: loads a JSON config per prior type with a fixed `mu` and a **per-season `sigma`** (retrained periodically with a half-life-weighted history, see `Priors/update/`), z-scores the raw value `(value-mu)/sigma`, then maps the z-score onto the Elo scale via a single `prior_elo_scale` constant (`1505 + z*scale`). This is a real per-prior normalization scheme — not raw differencing.
  - `offseason_regression()` then renormalizes prior weights to sum to ≤1, computes the leftover weight as the mean-reversion weight, and takes a straight weighted average of the normalized priors' Elo values with the reverted Elo. This is the exact "prior + observation, weighted" blend pattern team-strength.js lacks.
  - `nfelo/Utilities/elo_shift.py` — `calc_shift()`/`calc_weighted_shift()`: the **in-season** update. Computes model error and market error against the actual game margin, and only increases the update aggressiveness (`adj_k = k * (1 + |model_error - market_error| / market_resist_factor)`) when the model was *more* wrong than the market — a "resist the market" throttle that keeps the model from over-reacting when the market was already right. `Nfelo.project_game()` (Model/Nfelo.py) shows the full per-game pipeline: offseason reversion → base Elo diff → dynamic per-game HFA (`row['hfa_mod']`, not a flat constant) → QB-adjustment (`self.config['qb_weight'] * (home_538_qb_adj - away_538_qb_adj)`) → playoff boost multiplier → Elo-to-probability via `elo_to_prob(z=...)`.
- **Adopt**: `borrow-idea` (no license → do not copy the code verbatim; reimplement the two-part pattern — per-prior z-score normalization against a trained per-season sigma, then weighted blend with mean-reverted state — in JS).
- **Gridiron attachment point**: `server/services/nfl-team-strength.js`, the `teamStrength(season)` function. Replace `leaguePrior()`-as-fallback with: (1) a small trained sigma table per `TEAM_STRENGTH_KEYS` column (computed once from `off_team_season`/`teamOffseasonSummary` history, analogous to nfelo's `Priors/config/*.json`), (2) z-score each raw column, (3) blend z-scored columns with weights that sum to ≤1 and let the remainder default to the league prior — replacing the current unweighted `?? leaguePrior` fallback.

### 2. `greerreNFL/nfelohfa` — per-game home-field-advantage model
- **License**: none present. 1 star, **last commit 2026-09-11** (updated same day as nfelo).
- **What it does**: `nfelohfa/Model/BaseHFA.py` — `BaseHFA.calc_hfa_sub()` computes league-wide HFA as a **rolling regression** over a trailing window of weeks (`reg_weeks`) with a `kick_in` gate (don't start adjusting until `kick_in`% of the window has data), then smooths that with an EMA (`level_weeks` as the EMA span) — explicitly described in-file as "LOESS-like." `Model/AdjustedHFA.py` then layers per-game adjustments (bye weeks, timezone/travel, surface mismatch, divisional game) on top of the smoothed base. This is a genuinely dynamic, per-game HFA, the opposite of a flat constant.
- **Adopt**: `borrow-idea` (no license).
- **Gridiron attachment point**: this is not team-strength.js's problem, but it directly fixes a named tonight's defect elsewhere: `server/services/nfl-drive-sim.js`'s "home-field advantage is a flat 7-point post-OT lump distorting the key-number distribution." The rolling-regression + EMA + per-game-adjustment structure (not the specific numbers) is the fix pattern.

### 3. `greerreNFL/nfelosrs` — win-total-implied ratings + a real Bayesian weekly updater
- **License**: none present. 8 stars, last commit 2026-09-07.
- **What it does**:
  - `nfelosrs/Resources/WT/WTRatings.py` (WT Ratings): converts sportsbook win-total futures + over/under odds into an optimizer-fit team-strength value per team (minimizes error between market-implied win totals and a schedule-simulated win total) — a more principled preseason-strength construction than team-strength.js's raw "sum of starters' projected points."
  - `nfelosrs/Resources/Bayes/BayesianRankings.py` — **this is the real find**: `likelihood()` and `update_priors()` implement a textbook Gaussian-conjugate (precision-weighted) Bayesian update, verified line-by-line:
    ```
    updated_mean = (prior_mean/prior_stdev**2 + obs/obs_stdev**2)
                   / (1/prior_stdev**2 + 1/obs_stdev**2)
    updated_stdev = sqrt(1 / (1/prior_stdev**2 + 1/obs_stdev**2))
    ```
    run **per game, per team, every week** — the prior for week N+1 is the posterior from week N, seeded in week 1 from the WT Ratings prior with a trained `ranking_stdev` from `distributions.json` (fit via `scipy.stats.invgamma`). The observation (`home_result`/`away_result`) is the actual score margin adjusted for opponent rating, QB value, and modeled HFA. This is exactly what "principled state-space/Bayesian update" means, implemented, working, and small (~40 lines of actual math).
- **Adopt**: `borrow-idea` (no license; the math is standard Gaussian-conjugate updating, safe to reimplement from scratch in JS using this as a structural reference).
- **Gridiron attachment point**: `server/services/nfl-team-strength.js`. Add a `teamStrengthWeekly(season, week)` that seeds `{mean, stdev}` per team from the current preseason columns (using their observed cross-season variance as the prior stdev) and updates them with each week's actual game result via the same precision-weighted formula, carrying uncertainty (`stdev`) as a first-class output — which the file currently has zero notion of.

### 4. `fivethirtyeight/nfl-elo-game` — the canonical simple NFL Elo baseline
- **License**: **MIT**. 348 stars, last commit 2026-09-05 (fivethirtyeight's account still gets automated/data-refresh pushes).
- **What it does** (`forecast.py`, 58 lines, read in full): classic 538 Elo —
  `HFA = 65.0` Elo points, `K = 20.0`, `REVERT = 1/3` season carryover
  (`team.elo = 1505*REVERT + team.elo*(1-REVERT)`, with a hardcoded table of
  historical franchise-relocation exceptions). The margin-of-victory multiplier
  is the well-known 538 formula: `mult = ln(max(pd,1)+1) * (2.2 / (autocorrelation-adjusted elo_diff * 0.001 + 2.2))`, which damps the multiplier when a big favorite wins big (avoiding Elo over-reacting to expected blowouts) — this specific damping term is the one thing missing from a naive "shift by log(margin)" approach.
- **Adopt**: `port` (MIT license, attribution retained).
- **Gridiron attachment point**: not a direct patch to team-strength.js (which is feature-differential, not a self-contained ladder-rating system) but a legitimate **independent baseline** to backtest team-strength.js and `nfl-ensemble.js` against — the project currently has no simple, decades-validated Elo of its own to sanity-check the GBM/ensemble against. Attach as a new `server/services/nfl-baseline-elo.js`, fed the same `off_team_season`/game results, scored with the existing `backtest-significance.js` harness.

### 5. `sublee/glicko2` — reference Glicko-2 implementation
- **License**: **BSD-3-Clause**. 124 stars, last commit 2026-09-07 (recently touched, actively maintained fork of the original 2012 package).
- **What it does** (`glicko2.py`, 172 lines, read in full): faithful implementation of Mark Glickman's Glicko-2 system — each team/player carries `(mu, phi, sigma)`: rating, **rating deviation** (uncertainty), and volatility. `rate()` runs the full published algorithm (steps 2-8 per the Glicko-2 paper): scale to internal units, compute variance from the game(s) played weighted by opponents' own uncertainty (`reduce_impact`/`g(RD)`), solve for updated volatility via an Illinois-algorithm root-find (`determine_sigma`), then update `phi`/`mu`. Verified the numerics match the reference paper's worked example structure.
- **Adopt**: `port` (BSD-3-Clause permits this; keep the copyright header).
- **Gridiron attachment point**: `server/services/nfl-team-strength.js` (or a new sibling `nfl-glicko.js` feeding the same `TEAM_STRENGTH_KEYS` contract). Unlike the nfelo/nfelosrs Elo variants, Glicko-2's `phi` (rating deviation) is an **off-the-shelf, already-correct uncertainty estimate per team** — directly usable to address the separately-flagged "no conformal or otherwise honestly-calibrated uncertainty interval exists anywhere in the pipeline," at least for the team-strength inputs to the GBM, without inventing a new calibration method.

## Candidates
See structured output. 6 candidates, all `bucket=fix`, `applies_to` split between
`betting-model` (team-strength itself) and `simulation` (the HFA fix, which
targets the drive-sim's flat-7-point defect using the same class of repo
research).

## Do-not-do
- Do not `npm install`/`pip install` or execute any code from these repos —
  read-only extraction of the update-rule math only.
- Do not copy code verbatim from `greerreNFL/*` (no LICENSE file present in
  any of the three repos — treat as all-rights-reserved; reimplement the
  documented algorithm from scratch, cite the repo/path/line as the source of
  the *idea*, not the text).
- Do not let a ported prior/Elo model touch `fantasy-football-dashboard`
  directly — it is read-only tonight (live Week 1 capture in progress). All of
  this is written up for a future edit session, not applied now.
- Do not feed any market-derived column into a re-blended team-strength
  output — `nfl-team-strength.js`'s own header comment documents that this was
  tried once (`implied_team_points`/`implied_points_delta`) and failed
  (0.995, CI 0.951-1.044); nothing here should reintroduce it.
