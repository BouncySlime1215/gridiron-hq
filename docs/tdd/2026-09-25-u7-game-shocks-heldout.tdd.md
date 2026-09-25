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
  from 200,000 keyed draws per archetype correlation.

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

## RED

## GREEN

## Measured

## Needs local measurement
