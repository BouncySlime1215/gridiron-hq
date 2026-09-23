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

## 3. RED / GREEN

- **RED** `e3d7b063` "test: PROJ-03-a RED for the keyed game-script sampler". Failing
  assertion: `TypeError: gs.sampleGameScript is not a function` (6 of 6 fail).
- **GREEN** `a51f959b` "feat: PROJ-03-a keyed game-script sampler in gamescript.js".
  `test/proj-03a-game-script.test.js`: 6 of 6 pass. The GREEN commit also fixes an
  arithmetic slip in the RED test: a -3.5 spread and a 47.5 total imply 25.5 / 22.0 points,
  not 25.75 / 21.75 (that pair has a margin of 4). Before the fix, the test failed with
  `mean home 25.547 vs 25.75`. The drawn means matched the correct values: home 25.547,
  away 21.951, total 47.499.
- **Test 7** was added after the mutation sweep. It checks that the copula rho reaches the
  draws and that the quarter split depends on the key (see section 5). 7 of 7 pass.
- Command: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/x.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/proj-03a-game-script.test.js`.
- The existing `test/gamescript-closing-line.test.js` still passes 2 of 2 with the same
  command.

## 4. What it does

**Re-review change (section 10):** because the unit is declined, the sampler is study code.
It moved out of `server/services/gamescript.js` into `scripts/proj03a/game-script-sampler.mjs`.
`server/services/gamescript.js` is identical to origin/main. There is no new table,
column or store.

- `scoreModelAt(season, week)` fits in memory, per |spread| bucket: n, team-points sd,
  margin sd and residual rho, plus a pooled sd. It trains on scored `game_lines` home rows
  from 2021 to just before the cutoff. It is cached per cutoff and cleared by
  `clearScoreModelCache`.
- `sampleGameScript(game, key, params)` draws one path from a `keyedSeed` key:
  - both finals and the margin;
  - 4 quarters per side (a Dirichlet split with an exact sum), each side on its own
    keyed stream;
  - `win_prob_home` at kickoff and after Q1, Q2, Q3, then the final result.

  The same key always gives the same path, so every player in the game can share it.
- `gameFor(season, week, team)` builds the game from the line: closing, else current
  (which covers ESPN look-ahead rows). Null without a line.
- `teamPointsDistribution`, `spreadBucket`, `gammaQuantile` and `regularizedGammaP` serve
  the calibration script `scripts/proj03a-calibration.mjs`.

Readers: that script and the test only. No route, job or page reads the sampler, and
test 11 fails if anything in `server/` or `client/` imports it. The engine must not
register it as the `engine_state` game-path producer (section 7).

## 5. Mutation sweep

Target: the unit test. Harness: replace one string, run the test file, restore the file.

| Mutant | Result |
|---|---|
| M1 home implied uses the away sign | killed (test 2) |
| M2 bucket edge 7 made exclusive | killed (test 4) |
| M3 cutoff `week < ?` changed to `<=` (leak) | killed (test 5) |
| M4 pregame win-prob sign flipped | killed (test 3) |
| M5 `gameFor` away side keeps its own spread | killed (test 6) |
| M6 sampler always uses bucket lt3 | killed (test 3) |
| M7 rating fallback drops the home edge | killed (test 6) |
| M8 copula rho sign flipped | survived the first sweep; **killed by test 7** |
| M9 quarter draws ignore the key | survived the first sweep; **killed by test 7** (after the fractions were rounded to 6 dp: without rounding, float noise made them unequal) |
| M10 both sides read the same normal | killed (test 2) |
| **Designed survivor:** the negative-Q4 guard threshold `< 0` changed to `< -1` | survived, as designed: Q4 = pts - (q1+q2+q3), and the Dirichlet fractions sum to 1, so the branch cannot be reached beyond float noise |
| **Call site:** the calibration script fits on season+1 (leak) | **survived**: the script has no test. Known defect below |
| **Not-applied control** (the target string does not exist) | reported NOT APPLIED, so the harness does not count a no-op as a kill |

## 6. The numbers (local copy, not production)

Command: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=.local-db/data.sqlite node scripts/proj03a-calibration.mjs`.
Tree: this branch at the commit that adds this section. DB: a local copy made on
2026-09-23 at 15:47. Known-nonzero control: `game_lines` has 570 scored team-games in each
of 2021-2025 and 64 in 2026 (`sqlite3 .local-db/data.sqlite "SELECT season, COUNT(*),
SUM(team_score IS NOT NULL) FROM game_lines WHERE season>=2021 GROUP BY season"`). The
writer is `syncHistoricalLines` (`gamescript.js:36`) / `syncCurrentLines` (`:119`).
Weeks 1-22 are included (postseason too), as the pre-registration did not exclude them.

The CRPS closed form (Scheuerer & Möller 2015) was checked against numeric integration on
the first team-game of each season: 2.232 = 2.232, 5.6361 = 5.6361, 4.5248 = 4.5248.

**80% interval coverage by |spread| bucket** (ship band 0.77-0.83):

| Test | lt3 | 3to7 | gt7 | Pooled (Wilson 95%) |
|---|---|---|---|---|
| 2023 (fit 2021-22, 569 games) | 0.787 (n 150) pass | **0.733** (n 300) FAIL | **0.858** (n 120) FAIL | 0.774 [0.738, 0.806] |
| 2024 (fit 2021-23, 854 games) | 0.780 (n 132) pass | 0.804 (n 336) pass | **0.765** (n 102) FAIL | 0.791 [0.756, 0.823] |

MDE for coverage at 80% power (alpha 0.05, two-sided): lt3 0.091 / 0.097; 3to7
0.065 / 0.061; gt7 0.102 / 0.111. The two cell misses in 2023 are both within one MDE of
0.80. The rule is the pre-registered band, not a significance test, and it fails as
written.

**PIT (randomized, 10 bins, chi-square df 9; pass at p >= 0.01):**
- 2023: chi-square 18.77, p 0.027, pass (KS D 0.058).
- 2024: chi-square 20.81, p 0.0135, pass (KS D 0.089).

**CRPS** d = sampler - Normal(implied, pooled sd). Negative d means the sampler is
better. Pass if the upper end of the 95% CI is <= +0.05.

| Test | Sampler | Normal | Mean d | 95% CI (week-cluster, 22 clusters) | Verdict |
|---|---|---|---|---|---|
| 2023 | 5.214 | 5.179 | +0.034 | [-0.025, +0.095] | **FAIL** |
| 2024 | 5.074 | 5.033 | +0.041 | [+0.008, +0.075] | **FAIL** |

In 2024 the interval excludes 0 on the worse side: the pooled Normal beats the sampler.
MDE at 80% power, from the bootstrap SE (the CI width / 3.92 x 2.8), is 0.086 for 2023
and 0.048 for 2024. So 2024 is not an underpowered miss.

**Forward 2026, weeks 1-2** (fit 2021-25, n = 64 team-games, anecdote-sized):
- pooled coverage 0.734, Wilson [0.615, 0.827], which contains 0.80;
- mean d +0.073, CI [+0.035, +0.110], which fails the <= +0.05 rule;
- PIT p 0.055.

The forward check does **not hold**.

Fitted bucket sds are nearly flat: for 2024 they are 8.69 / 9.40 / 9.16 against a pooled
9.18. The |spread| bucket carries little sd signal, and the Gamma shape (right skew) scores
slightly worse than the symmetric Normal on CRPS.

## 7. Verdict: DECLINED

The pre-registered ship rule fails on both test seasons. Coverage fails in 3 of 6 cells
and CRPS fails non-inferiority in both years. The forward check fails too. Under the
decline rule, the sampler must **not** be registered as the `engine_state` game-path
producer in its bucketed Gamma form.

What still stands:
- The non-statistical RED contract passes: keyed determinism, mean total ±0.1 over 20k
  draws, quarters summing to finals, and pregame win probability = Phi(mu/sigma).
- The pooled Normal baseline is the better team-points marginal on this evidence.

Follow-up, not run here (a new analysis on these test seasons would be a forking path):
pre-register a pooled-sd marginal, Normal or Gamma, as a new unit before the engine
registers any game-path producer.

Holdout looks:
- **2025:** not scored. 2025 rows enter only as training data for the 2026 forward fit.
  No 2025 outcome was graded, so there is no `L` row.
- **2026:** the forward check is ledger row F017 (first committed as F007, which collided
  with HX-01's F007 on origin/main; F016 is taken on an open branch).

## 8. Known defects

1. `scripts/proj03a-calibration.mjs` has no test. The season+1 leak mutant survives it.
2. `logGamma` is a private Lanczos copy. Two exist in this change (gamescript.js and the
   script), and there are 3 more in `server/betting`. Consolidating them in
   `stats-util.js` is a follow-up. It was not done here because `stats-util.js` is
   read-only for this unit.
3. (Fixed in re-review) The power-rating fallback and pace were removed; see section 10.
4. The sampler is study code under `scripts/`, so it has private copies of Lanczos
   `logGamma` and of the one-line implied-points formula (`gamescript.js:31`).
5. `weeklyClusterBootstrap` is reused for the CRPS CI. It rounds the interval to 3 dp.

## 9. Nick's five questions

1. **Well built?** It is study code under `scripts/` with no side store and no production
   reader. It has 11 tests. The re-review's surviving mutants are now killed (section 10).
   One call-site mutant survives (defect 1).
2. **Stats or made up?** Stats. All params are fitted from `game_lines` scores at a
   cutoff. The rating fallback, the one guess, was removed.
3. **How do we know?** Through a pre-registered walk-forward test on 2023 and 2024 plus a
   2026 forward check. It failed, and that is why it is declined.
4. **Pointed elsewhere?** No consumer reads it yet. Nothing on screen changes.
5. **How does it unify?** It is meant to be the one game-path producer for the engine,
   and no second fantasy-side producer exists (audit, section 1). The betting-side margin
   models stay separate (fantasy-only scope). Registration waits on a passing
   re-pre-registered marginal.

Decision grading (rule d): not applicable. This unit feeds no start/sit, waiver or trade
call.

## 10. Re-review fixes (2026-09-23)

Skeptic findings and what changed. Tree: this commit, merged with origin/main 309877ef.

1. **Ledger id collision.** origin/main already has an HX-01 `F007`. The row is now
   `F017`. `grep -c '^| F007' docs/evidence/HOLDOUT-LEDGER.md` = 1 (HX-01 only) and
   `grep -c '^| F017'` = 1. F016 was skipped because
   `origin/claude/local-rl-8-2b-trade-split-fresh-test` already adds one (loop of
   `git show <branch>:docs/evidence/HOLDOUT-LEDGER.md | grep '^| F016'` over `git branch -r`).
2. **No consumer / study code in a production module.** The sampler moved to
   `scripts/proj03a/game-script-sampler.mjs`. `git diff origin/main -- server/services/gamescript.js`
   is empty. The new test 11 (`git grep -l game-script-sampler -- server client` must be
   empty) is live: adding a commented import line to gamescript.js made it fail
   (`not ok 11`), then the file was restored.
3. **Second pace producer.** Pace was removed from the sampler. The canonical producer of
   expected attempts stays `gameScriptFor` (`server/services/gamescript.js`, fit by
   `fitGameScript`, table `gamescript_model`). The skeptic's disagreement (2024 wk 10:
   existing pass_mult BAL 1.101 > ARI 1.017 > CAR 0.962 > CHI 0.95, sampler pass_att
   CAR > ARI > BAL > CHI) is gone because the second producer is gone. Follow-up for a
   future engine unit: any game path must read pace from `gameScriptFor`, not refit it.
4. **Unmeasured power-rating spread producer.** Dropped. `gameFor` returns null without a
   line; test 6 now asserts a rated game with no line stays null.
5. **Test liveness.** Three tests added. The skeptic's mutants, run against the new
   module (sed, run the test file, restore):

| Mutant | Result |
|---|---|
| home draw uses `1.5 * b.sd` | killed (test 8: draw sd and 10%/90% quantiles vs the bucket Gamma) |
| win-prob loop drops `Math.sqrt(rest)` | killed (test 9: Q1-Q3 win prob recomputed by hand for 3 keys) |
| away quarters reuse the home stream (base 20 -> 10) | killed (test 10: home/away fractions differ; Q1-share correlation near 0) |
| pace for the home side uses `-margin` | not applicable: pace removed |

   Each line printed `# pass 10 # fail 1`. The unmutated file prints `# pass 11 # fail 0`.
   The earlier "10/10 killed" figure used a scratchpad harness not in the repo, and the
   re-review showed it did not cover the contract items named above.
6. **Calibration numbers (section 6) still hold.** They were not re-run (the DB copy was
   deleted). `scoreModelAt`'s bucket fit, `teamPointsDistribution`, `gammaQuantile` and
   `regularizedGammaP` are unchanged by the move: a `git diff --no-index` of the old
   gamescript.js block against the new module shows only comment lines touching them.
   The removed fields (pace, home_edge, mean_total) were not read by the calibration script.

