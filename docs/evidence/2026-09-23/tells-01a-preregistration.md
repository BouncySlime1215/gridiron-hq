# TELLS-01a pre-registration: the Tells Factory screen, ported (Sleeper 2021-24)

Written 2026-09-23 before `scripts/rnd/tells-factory.py` produced any number. The only numbers
below are the baseline: the R&D r18 scripts re-run unchanged on a `.backup` copy of the Sleeper
history DB (local copy), on origin/main `238d31bc`. Spec row: ENGINE-SPECS.md `| TELLS-01a |`.
Method source: `rnd/loop/scripts/r18i_tells_{build,screen,confirm}.py` (arm A) and
`r18x_tells_prevseason.py` (arm B). 2025 is never opened (SQL filter `season BETWEEN 2021 AND 2024`
plus an assert on every frame).

## Baseline (re-measured, local copy, r18 scripts unchanged except input paths)

| metric | r18 log | re-run here |
|---|---|---|
| FIT survivors (B2 baseline) | 148 | 148 (sha `94274608…`, identical) |
| placebo, gate-3 BH q<=0.10 | 0 of 3,219 | 0 of 3,219 |
| CONFIRMED 2023-24 | 85 | 85 (trade 8, adds 65, checkout 12) |
| adds R² delta, confirmed set | +0.0425 [+0.0366, +0.0481] | same |
| checkout AUC delta, confirmed set | +0.0628 [+0.0417, +0.0845] | same |
| trade AUC delta, confirmed set | +0.0055 [−0.0011, +0.0123] | same |
| trade AUC delta, all FIT survivors | −0.0122 [−0.0216, −0.0029] | same |
| arm B AUC delta (2024) | +0.0137 [+0.0022, +0.0251] | same |
| arm B placebo (BY) | not logged as a gate | 3 of 129 (BH 5) |

The task header's "adds +0.042..+0.055" spans the confirmed-set and all-survivor models; the
confirmed-set numbers above are the ones this unit grades against.

Arm B in r18 reads `rnd/skill/team_seasons.sqlite`, an R&D-derived table (not in the repo). Its
headline tells include `trades_won_expost`, which needs per-player points the Sleeper history DB
does not hold. This unit rebuilds arm B from the Sleeper history DB alone (below), so the
reproduction is of the finding, not of the exact r18 number.

## Arm A (this-season tells), frozen rules

- **Unit:** manager-season = (league, roster), Sleeper 2021-24, complete weeks 1-12 (6 early, 6 late
  team-weeks, a win% defined). As-of: end of week 6. Outcomes, weeks 7-12: `Y_adds` = log1p(FA adds
  + won claims), `Y_checkout` = any empty starter slot, `Y_trade` = in >= 1 completed trade.
- **Generator:** the r18i crossed templates, byte-for-byte in logic: event family (ADD_FA, CLAIM_WON,
  CLAIM_FAIL, CLAIM_ALL, DROP, ADD_ANY x ALL/QB/RB/WR/TE/K/DEF; TRADE:ALL) x statistic (rate,
  active, night, sun, montue, wedthu, frisat, medhour, burst; claims add loglat, lastlat, bid, prem)
  x window (w13, w46, w16; afterloss w26), plus LINEUP, TRADESHAPE and DROPTEN families.
  Expected: 1,504 candidates, 4,512 tests.
- **Baseline:** B2 (r18 ADDENDUM 1, the headline): within-league pct ranks of adds w1-3, adds
  w4-6, claims w1-6, drops w1-6, any trade w1-6, win%, PF z, squares of the two adds ranks;
  league-demeaned LPM fit on FIT; residual per outcome.
- **Gates (FIT 2021-22 only):**
  1. defined for >= 2,000 FIT manager-seasons, >= 3 distinct values;
  2. **support floor (new):** non-zero in >= 30 distinct FIT *chains*. A chain is a league lineage
     (Sleeper `previous_league_id` followed to its root) x roster_id. Below it: `dead: 'support'`;
  3. repeatable: odd {1,3,5} vs even {2,4,6} weeks, Spearman, BH q <= 0.10 across templates and
     rho >= 0.10;
  4. predictive: within-league rank vs B2 residual, BH q <= 0.10 across ALL tests, decided by
     `benjamini_hochberg` imported from `scripts/model-lab/mass_test_harness.py:74`. BY at q = 0.10
     is reported as a sensitivity check, not a gate;
  5. stable: same sign in 2021 and 2022;
  6. **prune (new):** within each outcome, greedy by FIT p, a survivor whose |corr| with an
     already-kept survivor (within-league rank, FIT rows) is >= 0.8 is `dead: 'redundant'`.
  The kept survivors are frozen (sha256 printed) before any 2023-24 outcome is read.
- **Placebo:** tells shuffled within league (seed 18), gates 4 and 4+2+3+5 re-run on FIT.
  Pass (a): 0 placebo survivors on the gate-4 BH count.
- **CONFIRM 2023-24, one look:** same sign as FIT, one-sided p, BH q < 0.05 across the frozen set,
  same sign in 2023 and in 2024 separately.
- **Model (b):** B2 + confirmed tells (ridge alpha 1, league-demeaned), fit on FIT, scored on
  2023-24; 1,000-draw league-cluster bootstrap (seed 18), 90% CI. Pass (b): adds R² delta CI > 0 and
  checkout within-league AUC delta CI > 0.
- **Trade (c):** the same model for `Y_trade` on the confirmed trade tells and, as in r18, on every
  FIT trade survivor. If the confirmed-set CI does not clear 0, every this-season `Y_trade` tell is
  `dead: 'trade_kill'` and no this-season tell is `p_accept_eligible`. Expected: KILL.

## Arm B (prior-season trade tells), frozen rules

- **Rows:** team-weeks of seasons 2022-24 whose league has a `previous_league_id` with the same
  team count, matched on roster_id (the chain link). Week w from 3 to playoff_week_start − 2, a
  matchup row that week. Outcome y = the team is a side of a completed trade in week w + 1. Only
  league-weeks with >= 1 trade are kept (as r18x).
- **Baseline:** this season's adds per week through w, and any trade through w (r18x), within
  league-week demeaned.
- **Family (prior regular season, weeks 1 .. playoff_week_start − 1), 14 tells:** n_trades,
  n_trade_partners, trades_with_picks, uneven_trades, players_recv, players_sent, n_start_trade
  (starter slots filled by trade-acquired players in later weeks), trades_early (w1-6),
  trades_late (w7+), any_trade, n_adds, n_fail_claims, win_pct, drops. `trades_won_expost` is not
  buildable from this DB and is excluded.
- **Screen:** fit 2022 (incremental on the baseline, within league-week, chain-clustered SE),
  BH q <= 0.10 via the harness (BY reported); replicate 2023 same sign with one-sided p < 0.05;
  prune |corr| >= 0.8 on 2022-23.
- **Grade 2024:** LPM ridge (lambda = 1.0 x n, all standardised), fit 2022-23, within-league-week
  AUC, baseline vs baseline + kept tells; 2,000-draw chain bootstrap (seed 1818), 90% CI.
  Pass (d): lower bound > 0. Without it arm B is `lead` and `p_accept_eligible` stays false.
- **Placebo:** within-league-week permutation of the fit rows (seed 1818), BH count reported.

## What ships
One artifact, `server/data/tells-screen.json`: aggregates only (tell id, family, outcome, effects,
q, verdict, dead reason, ESPN observability, EB prior), no league ids, no names. A JS library
(`server/services/tells/library.js`) computes any tell from `engine_events` as of a timestamp and
matches the Python generator on a 3-team synthetic golden fixture. `refitTells({asOf})`
(`server/services/tells/refit.js`) returns rows and writes nothing, behind `GRIDIRON_TELLS_ENABLED`
(default off; PREVIEW-01's switch also turns it on). A metric that misses its bar is reported as a
miss and the tells it covers stay `dead` or `lead`.
