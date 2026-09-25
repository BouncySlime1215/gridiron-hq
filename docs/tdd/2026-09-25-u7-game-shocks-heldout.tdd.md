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
- `scripts/lib/game-shocks-heldout.mjs`: `nflverseWeekRow`, `heldOutTailCheck`,
  `heldOutVerdict`. Measurement only; nothing is served (it lives under scripts/ so
  `check:wiring` does not read it as an unwired server module).
- `scripts/measure-game-shocks-heldout.mjs`: the run, from nflverse CSVs or the database.

## Measured (held-out 2025, the registered decider)

```
node scripts/measure-game-shocks-heldout.mjs --csv stats_player_week_2021.csv,...,stats_player_week_2025.csv
```

nflverse `stats_player_week_<season>.csv`, fetched 2026-09-25 (sha256 prefixes 2021
`41915fb49238902a`, 2022 `ad426c3fe5bf1cc3`, 2023 `f19cb71a5de0dce7`, 2024
`3ddc45a84f759aa3`, 2025 `e5e0615b3d96a3ea`); 29,376 regular-season QB/RB/WR/TE rows.
Train 2021-2024, test 2025: 272 games, 400 simulated season copies per arm, 2,000
bootstrap resamples, no Cholesky fallbacks.

q = 0.9 (decides), P(U_j > 0.9 | U_i > 0.9):

| group | pairs | tail events | held-out | Gaussian (off) | shocks on | improvement | 95% interval | verdict |
|---|---|---|---|---|---|---|---|---|
| QB-WR same team | 2,349 | 273 | 0.1319 | 0.0929 | 0.1259 | +0.0330 | -0.0340 to +0.0356 | fail |
| every same-game pair | 53,987 | 6,198 | 0.0703 | 0.0655 | 0.0924 | -0.0172 | -0.0277 to +0.0143 | fail |

**U7 FAIL. `GRIDIRON_GAME_SHOCKS` stays off.**

q = 0.8, context only (does not decide): QB-WR held-out 0.3040, off 0.2314, on 0.2511,
improvement +0.0197 (0.0172 to 0.0217); every same-game pair held-out 0.1804, off
0.1795, on 0.1998, improvement -0.0184 (-0.0210 to +0.0116).

What it says, beyond the verdict:

- QB-WR: the point estimate favours the shock (2025 QB-WR tails co-occurred more than
  the Gaussian copula predicts, at both q), but 273 tail events cannot separate the two
  at q 0.9. This is the power note playing out.
- Every same-game pair: the Gaussian copula is already close (0.0655 vs 0.0703), and
  one shock shared by the whole game overshoots (0.0924, +31%). The overshoot guard
  would fail it even with a tighter interval. Most same-game pairs are opponents or
  low-correlation teammates, and a game-wide shock lifts them all together.
- Read together: the tail dependence 2025 shows is team-level (a QB and his receivers),
  not game-level. A per-team shock would be a different model and a NEW registration;
  this record does not change GRIDIRON_GAME_SHOCKS or propose turning it on.

## Needs local measurement

The local confirmation on the app's own weekly log (does not decide; a PASS there
would not override this FAIL):

```
SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<copy of the live db> node scripts/measure-game-shocks-heldout.mjs --train 2021-2024 --test 2025
```
