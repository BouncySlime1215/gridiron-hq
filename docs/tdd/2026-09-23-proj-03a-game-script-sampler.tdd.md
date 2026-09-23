# PROJ-03-a: seeded game-script sampler (CE-01 part a)

Unit PROJ-03-a, plan item CE-01 (ENGINE-SPECS rev 3, PROJ-03 table). Branch
`claude/local-proj-03-a-game-script-sampler`, based on origin/main `3c13f508`.
All DB numbers come from a **local copy, not production**
(`sqlite3 ~/gridiron-local/data.sqlite ".backup .local-db/data.sqlite"`, 2026-09-23 15:47 local).

## 1. Audit (written before the first test)

What exists for "a game's score distribution" on origin/main `3c13f508`:

| Surface | Where | What it does | Verdict |
|---|---|---|---|
| Line ingest | `server/services/gamescript.js:36 syncHistoricalLines`, `:119 syncCurrentLines` | Writes table `game_lines` (spread, total, implied_points, team_score/opp_score, closing_spread/closing_total). 2021-25: 570/568/570/570/570 scored team-games; 2026: 544 rows, 64 scored (weeks 1-2), weeks 2-18 source `espn` (command A1). | Read, not changed |
| Line -> volume fit | `gamescript.js:331 fitGameScript`, `:369 modelAt`, `:389 gameScriptFor` | OLS of team pass/rush attempts on (spread, total), cutoff-safe per (season, week). Returns a pre-game *multiplier*; no score distribution, no sd, no win probability. | **Extend** (same file, same cutoff pattern) |
| Keyed randomness | `stats-util.js:117 keyedSeed`, `:128 keyedNormal` | Deterministic (key, counter) -> standard normal. | Read and reuse |
| Copula / correlation | `correlation.js:212 correlatedSampler` | Player-level Gaussian copula for season-sim. | Not touched here; PROJ-03-c retires it for sim use |
| Betting-side game sims | `server/services/nfl-drive-sim.js`, `server/betting/nfl/strategy/margin-distribution.js` | Betting margin models, private `logGamma` copies (3 in server/betting). | **Not reused**: fantasy-only scope (INT-159-3, ENGINE-SPECS fact 2). Named as a duplication follow-up below. |
| Power ratings | `nfl-external-ratings.js:251 externalRatingsFeatures` over table `nfl_external_ratings` | ESPN FPI (2026 weeks 1-3) and TeamRankings predictive (2022-26). | Read-only reuse for the no-line fallback |

Grep for a second producer of the same concept (command A2; the only hits are betting-side `win_probability` in execution-slate-reasoning.js, a bet-cover probability, not a game path):
`git grep -n -i "sampleGame\|scoreDist\|win_prob\|winProb" -- server/services` finds no
fantasy-side producer of a per-game score path. Decision: **extend gamescript.js**; do not
create `services/sim/*` (coordinator note; ENGINE-SPECS PROJ-03 notes). No new table, no
column, no side store: the sampler is a pure function of (game, key, params), and params
are fitted in memory at the (season, week) cutoff exactly like `modelAt`.

## 2. Pre-registration (committed before any number is run)

**Method, grounded.** An NFL final margin is close to Normal around the spread with an sd
near 14 points (Stern 1991, *The American Statistician* 45:179-183). The in-game margin
behaves like Brownian motion with drift, which gives win probability at time t in closed
form (Stern 1994, *JASA* 89:1128-1134). Two teams' scores are modelled as dependent
marginals joined by a copula rather than independent counts (cf. the bivariate-Poisson
correlation of Karlis & Ntzoufras 2003, *JRSS-D* 52:381-393). Forecasts are graded with
the CRPS and the PIT histogram (Gneiting & Raftery 2007, *JASA* 102:359-378; Gneiting,
Balabdaoui & Raftery 2007, *JRSS-B* 69:243-268).

**The model.** For a game with home spread s and total T, implied points are
`T/2 - s/2` (home) and `T/2 + s/2` (away), the same formula as `gamescript.js:31`. The
bucket is |s| < 3, 3 <= |s| <= 7, or |s| > 7. Each team's points are Gamma with
mean = implied and sd = the bucket's sd. The two teams are joined by a Gaussian copula
with the bucket's residual correlation rho. Both are fitted on scored team-games from
season 2021 up to the cutoff. Quarter points split each final by Dirichlet(shape/4 x 4),
which is the bridge of a gamma process. Win probability after each quarter follows
Stern's Brownian model, using the bucket's margin sd. Pace is expected pass and rush
attempts given the drawn final margin and total. It comes from OLS on realized outcomes,
using the same `ols` and the same cutoff.

**Hypothesis.** The bucketed Gamma sampler is calibrated for team points and no worse
than a pooled Normal.

**Held-out split (walk-forward, ENGINE-SPECS):** fit 2021-22, test 2023; refit 2021-23,
test 2024. **2025 is not scored** (not a look). The forward check is 2026 weeks 1-2,
fit 2021-25 (2025 is used as training only), scored team-games only.

**Lines:** `COALESCE(closing_spread, spread)`, `COALESCE(closing_total, total)`, which is
the same rule as `observations()` at gamescript.js:301.

**Unit of observation:** one team-game (two per game). Uncertainty comes from a
week-clustered bootstrap (`stats-util.js weeklyClusterBootstrap`, 4000 iterations, its default seed).

**Metrics and ship rule (all must hold on BOTH 2023 and 2024):**

1. **Coverage.** The 80% central interval [q10, q90] of team points covers the actual
   score in 77-83% of team-games, in each of the 3 |spread| buckets (6 cells).
   An outcome y is covered if q10 <= y <= q90.
2. **PIT uniform.** Randomized PIT for integer scores is
   `u = F(y-0.5) + V*(F(y+0.5) - F(y-0.5))`, with V ~ U(0,1) seeded 20260923.
   Scores are grouped into 10 equal bins. Pass if the chi-square test gives p >= 0.01 per
   test season, pooled over buckets. KS is reported but not gated.
3. **CRPS no worse.** d = CRPS(sampler) - CRPS(Normal(implied, pooled sd)), per
   team-game. The pooled sd is the sd of (score - implied) over all training team-games.
   **Sign convention: negative d = sampler better.** Pass if the upper end of the
   week-clustered bootstrap 95% CI of mean d is <= +0.05 points (non-inferiority margin).

**Forward (2026 wk 1-2, n = 64, anecdote-sized):** holds if the Wilson 95% CI of the
pooled 80% coverage contains 0.80 and mean d <= +0.05. Ship ON needs both the pre-reg
and the forward check to hold; otherwise it ships as "unconfirmed forward". No consumer
reads the sampler yet (see section 5), so ON/OFF here labels the result; it does not
flip a setting.

**Decline rule:** If any gated metric fails, the unit is declined. The report then gives
the minimum detectable effect: the coverage deviation detectable at 80% power
(alpha 0.05, two-sided) at each cell's n.

**RED (non-statistical):** the same key gives a deep-equal path. Over 20,000 keys, the
mean drawn total equals the line total within ±0.1. The quarters sum to the finals. The
win probability before kickoff equals Phi(mu/sigma).

Decision grading (rule d): this unit feeds no start/sit, waiver or trade call by itself.
That grading happens in PROJ-03-c, when the served range and start/sit read these paths.
Here it is **not applicable**, and this is stated, not skipped.
