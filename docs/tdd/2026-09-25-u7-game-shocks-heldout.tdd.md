# U7 GAME-SHOCKS-CHECK: held-out 2025 tail check for the grouped-t copula

Nick's NEW PLAN item 2 (2026-09-25): "the pre-registered tailCoexceedance
(correlation.js): Gaussian vs a shared t-shock nu=6 (fixed), held-out 2025,
P(U_j>0.9 | U_i>0.9) on same-game pairs. If there's no held-out improvement with a CI,
keep GRIDIRON_GAME_SHOCKS off and document it."

The shock itself shipped behind `GRIDIRON_GAME_SHOCKS` (off) with an in-sample M1 bar
(docs/tdd/2026-09-25-game-shocks.tdd.md). M1 compares 2021+ joint exceedance at one
pooled correlation, in sample, with no interval. This unit is the out-of-sample check
with a confidence interval that decides the flag.

## Pre-registration (written 2026-09-25, before the code or any run)

**Data.** Weekly regular-season box scores, QB/RB/WR/TE, PPR (`scoring.js` PPR,
`scoreLine`), grouped by NFL game exactly as `sameGameResiduals` groups them
(season, week, sorted team pair).

- Train: seasons 2021-2024. Test (held out): season 2025. Nothing from 2025 enters the
  fit: residual means and SDs, the per-player minimum-games filter and the archetype
  correlations are all computed on the train window only.
- Decider source: nflverse `stats_player_week_<season>.csv` (public; the same upstream
  the app's weekly log is built from), fetched and run in the cloud so the number is
  reproducible. The local database run (`player_week_usage`) is a confirmation; if the
  two disagree on the verdict, the flag stays off.

**Model side.** For each same-game test pair (i, j): its archetype
(position pair, same team | opponents) and that archetype's correlation fitted on the
train window, clamped to [-0.6, 0.85] as `fitCorrelations` does (unfitted archetype:
the app's defaults, 0.05 same team, 0.02 opponents). Copula off = Gaussian; on =
grouped-t with one shared chi2(6)/6 shock per game, nu = 6 fixed (`GAME_SHOCK_NU`).

**Tail event.** Within the test season, each player's residuals are cut at his own
q = 0.9 quantile with the same rule `tailCoexceedance` uses (strictly above
`sorted[ceil(q n) - 1]`); p_i is his actual exceedance share (with 17 games this is the
top game, about 0.06, not exactly 0.10). Players need 6+ test-season games.

**Statistic.** Per group, the pooled conditional co-exceedance
`CE = P(U_j > q | U_i > q)` over both orderings of every pair:

- empirical: `sum 2 * [both exceed] / sum ([i exceeds] + [j exceeds])`
- model (off / on): `sum 2 * Cbar(p_i, p_j; rho_ij) / sum (p_i + p_j)`, where Cbar is
  the copula's joint upper-tail probability at the pair's own marginal shares,
  from 200,000 keyed draws per archetype correlation. **Amended before any real-data
  run, see "Amendment 1".**

Groups: `qb_wr_team` (a QB and a WR on one team) and `same_game` (every pair in the
game, both sidelines).

**Bar.** Improvement `D = |CE_emp - CE_off| - |CE_emp - CE_on|` (positive = shocks-on is
closer). 95% interval by a game-cluster bootstrap over test games (2,000 resamples,
fixed key, percentile interval).

- PASS for a group: the interval's lower bound is above 0, AND `CE_on` does not exceed
  `CE_emp` by more than 25% relative (the M1 overshoot guard).
- Overall PASS only if both groups pass. Otherwise FAIL: `GRIDIRON_GAME_SHOCKS` stays
  off and this record says so.
- q = 0.8 is printed alongside for context only; it does not decide.
- What would fail it: shocks-on not clearly closer out of sample (interval touching or
  below 0) in either group, or overshooting the observed tail.

This unit never turns the flag on. A PASS is evidence for Nick to turn it on; the
coordinator's local confirmation run comes first.

## Amendment 1 (2026-09-25, after the synthetic validation, before any real-data run)

The GREEN test builds made-up leagues with a known copula (32 teams, five skill players
each, same-team rho 0.25, opponents 0.08) and runs the check on them. With the model
side as first registered (Cbar at each pair's marginal share), a true grouped-t nu 6
world scored `CE_emp 0.135` against `CE_on 0.157` and `CE_off 0.094` over twelve
held-out seasons: the empirical side sat well below the copula that generated it. The
cause is the estimator, not the copula: a per-player-season cut on 17 games is a sample
rank (each player exceeds exactly once or twice a season), and Cbar prices a population
quantile. The two disagree most when tails are heavy.

Change: each model side now **simulates the held-out season itself**, 400 copies, on
the real held-out games and players: correlated normals from the train-window archetype
matrix per game (Gaussian = off), the same normals divided by one shared sqrt(W) per
game (on), then the same per-player-season cut and the same pooled statistic. So the
finite-sample bias is on both sides. Off and on share random numbers. Everything else
(train/test split, groups, statistic, bootstrap, bar) is unchanged.

After the change, on the same synthetic worlds: grouped-t world `CE_emp 0.1347`,
`CE_on 0.1330`, `CE_off 0.0960` (PASS); Gaussian world `CE_emp 0.0962`, `CE_off 0.0953`,
`CE_on 0.1319` (FAIL). Both sides are calibrated.

**Power note (recorded before the real run).** On 20 synthetic grouped-t worlds with
ONE held-out season each (the shape of the real test), the bar passed 0 of 20 times
(same_game alone 2 of 20, QB-WR 0 of 20); on 20 Gaussian worlds, 0 of 20. With one
season, a FAIL is therefore expected whether or not the shock is real, and it would not
show the shock is wrong, only that 2025 alone cannot prove it. The flag still stays off
on a FAIL, as registered.

## RED

Commit `test: RED for U7 ...`: `test/game-shocks-heldout.test.js` fails to load
(`ERR_MODULE_NOT_FOUND: server/services/game-shocks-heldout.js`).

## GREEN

- `server/services/correlation.js`: `sameGameResiduals` split into a DB read plus
  `residualsFromLog(log, { from, until })` (season window applied before means, SDs and
  the minimum-games count); `archetypeCorrelations` and `pairArchetype` extracted from
  `fitCorrelations` (which now calls them; its output is unchanged); `clampCorrelation`
  and `CORRELATION_DEFAULTS` exported.
- `server/services/game-shocks-heldout.js`: `nflverseWeekRow`, `heldOutTailCheck`,
  `heldOutVerdict`. Measurement only; nothing is served.
- `scripts/measure-game-shocks-heldout.mjs`: the run, from nflverse CSVs or the database.

## Measured

## Needs local measurement
