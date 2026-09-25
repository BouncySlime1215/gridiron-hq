# LIVING-01a: per-manager engagement state and activity rates

Unit LIVING-01a, 2026-09-23. Branch `claude/local-living-01a-v3`, based on the ONE ENGINE spine
(`claude/local-engine-00a-engine-spine`, PR #216, tree `9e8fc9d0` when measured).
Numbers file: `docs/evidence/2026-09-23/living-01a-output.json` (aggregates only).

## Verdict

**Ship behind the flag (default off).** All three gates pass in both graded seasons, 2023 and 2024.
Fit on Sleeper 2021-22 only. 2025 was never opened.

| gate (both 2023 and 2024) | 2023 | 2024 | pass |
|---|---|---|---|
| 1. next-week adds log-likelihood gain per team-week vs flat per-manager Poisson, 90% CI (league bootstrap, 1000) excludes 0 | +0.0506 [+0.0443, +0.0576] | +0.0417 [+0.0367, +0.0471] | yes / yes |
| 2. checkout AUC >= 0.65 and above win%-only | 0.949 [0.940, 0.955] vs 0.630 | 0.959 [0.952, 0.966] vs 0.639 | yes / yes |
| 3. calibration slope of P(dead or empty starter next week) in 0.8-1.2 | 1.021 [0.995, 1.043], intercept -0.218 | 0.973 [0.951, 0.993], intercept -0.164 | yes / yes |

## What the model is

`server/services/engine/activity-model.js`. A 3-state hidden Markov model per manager-season:
engaged, drifting, checked out. Each week it emits:

- the number of players added: Poisson, with a rate for the state times the manager's own volume
  multiplier `rho`;
- whether he started a dead or empty slot: Bernoulli, `logit = a[state] + c * (share of NFL teams on bye)`.

`rho` is the manager's adds divided by what a manager with his state path would add, shrunk to 1 with
`alpha` = 8 weeks of prior (gamma-Poisson; `alpha` chosen on 2021-22 by predictive log-likelihood).
Trade and lineup-error rates are reported shrunk to the 2021-22 population with an 8-week prior.
Post-loss tilt is not modelled (two R&D lenses found none).

Fitted on 2021-22 (EM, then `alpha`, then EM again):

| | engaged | drifting | checked out |
|---|---|---|---|
| adds per week | 1.826 | 0.460 | 0.008 |
| P(dead or empty starter), no byes | 0.054 | 0.170 | 0.932 |
| stay next week | 0.927 | 0.838 | 0.985 |
| week-1 share | 0.554 | 0.379 | 0.068 |

The checked-out state is near-absorbing (0.985 per week), as the physics lens found (B'). The bye
coefficient is +5.33 on the logit per unit bye share (a week with 6 of 32 teams on bye adds about +1.0).

## Data and definitions

- Sleeper: a `sqlite3 .backup` copy of `data/derived/sleeper_history.sqlite`, leagues with
  `season BETWEEN 2021 AND 2024`, `playoff_week_start >= 13`, no IDP slots: 1,938 leagues,
  21,286 team-seasons, 297,234 team-weeks. Regular season = weeks 1 to playoff start - 1.
- Adds: completed `free_agent` and `waiver` transactions, one per player in `adds_json`, credited to
  the roster it went to, by the transaction's week. Trades: completed `trade`, one per party.
- Lineup error: a starting slot that is empty (`"0"`), a DEF whose NFL team had no game, or a player
  (Sleeper id -> gsis id through nflverse `roster_weekly`) with no REG stat row that week. A starter
  with no id mapping is UNKNOWN, not dead: 2,714 of 2,874,240 starter slots; 2,242 team-weeks have
  an unknown lineup and are skipped by the error emission and the calibration grade.
- The nflverse extract (`idmap`, `played`, `team_games`) is built read-only with the sqlite3 CLI:

```
sqlite3 .scratch/nv_extract.sqlite "ATTACH 'file://<gridiron-hq>/data/line-history/nflverse.sqlite?immutable=1' AS nv;
CREATE TABLE idmap AS SELECT DISTINCT season, sleeper_id, gsis_id FROM nv.roster_weekly WHERE season BETWEEN 2021 AND 2024 AND sleeper_id IS NOT NULL AND gsis_id IS NOT NULL;
CREATE TABLE played AS SELECT DISTINCT season, week, player_id AS gsis_id FROM nv.stats_player_week WHERE season BETWEEN 2021 AND 2024 AND season_type='REG' AND player_id IS NOT NULL UNION SELECT DISTINCT season, week, player_id FROM nv.player_stats WHERE season BETWEEN 2021 AND 2024 AND season_type='REG' UNION SELECT DISTINCT season, week, player_id FROM nv.player_stats_kicking WHERE season BETWEEN 2021 AND 2024 AND season_type='REG';
CREATE TABLE team_games AS SELECT season, week, home_team AS team FROM nv.games WHERE season BETWEEN 2021 AND 2024 AND game_type='REG' UNION SELECT season, week, away_team FROM nv.games WHERE season BETWEEN 2021 AND 2024 AND game_type='REG';"
```

## Commands

```
# baseline first (no model code runs)
node scripts/living01a-fit.mjs --sleeper .scratch/sleeper_history.sqlite --nv .scratch/nv_extract.sqlite --baseline
# fit 2021-22, grade 2023 and 2024 (about 25 s)
node scripts/living01a-fit.mjs --sleeper .scratch/sleeper_history.sqlite --nv .scratch/nv_extract.sqlite \
  --out docs/evidence/2026-09-23/living-01a-output.json
```

## Baselines (measured first, same split)

| | 2021 | 2022 | 2023 | 2024 |
|---|---|---|---|---|
| flat per-manager Poisson, adds log-lik per team-week | -1.3832 | -1.3701 | -1.3427 | -1.3866 |
| win%-only checkout AUC | 0.592 | 0.602 | **0.630** | **0.639** |
| checkout rate (0 adds weeks 8 to end) | 0.195 | 0.205 | 0.181 | 0.170 |

The flat baseline is each manager's as-of adds per week, shrunk to the 2021-22 population rate
(1.250 adds per team-week) with the prior weight that maximises 2021-22 log-likelihood (1 week).

**The win%-only AUC differs from the unit's 0.565** (econometrics explorer). That number graded
checkout *onset* (first week >= 4 with 2+ dead starts that persists) on at-risk weeks; this unit's
label is the one it pre-registered: no adds from week 8 to the end of the regular season, scored with
data through week 7. This unit's baseline is used.

## Results

| | 2021 (fit) | 2022 (fit) | 2023 | 2024 |
|---|---|---|---|---|
| model adds log-lik per team-week | -1.3167 | -1.3056 | -1.2921 | -1.3450 |
| gain vs flat | +0.0665 | +0.0646 | **+0.0506** [+0.0443, +0.0576] | **+0.0417** [+0.0367, +0.0471] |
| checkout AUC | 0.959 | 0.962 | **0.949** [0.940, 0.955] | **0.959** [0.952, 0.966] |
| AUC minus win%-only | | | +0.318 [+0.301, +0.334] | +0.320 [+0.300, +0.338] |
| P(lineup error) slope | 1.120 | 1.010 | **1.021** [0.995, 1.043] | **0.973** [0.951, 0.993] |
| intercept | +0.210 | -0.009 | -0.218 | -0.164 |
| observed / predicted error rate | 0.280 / 0.272 | 0.279 / 0.282 | 0.229 / 0.258 | 0.244 / 0.261 |

Graded team-weeks: 68,826 (2023, 487 leagues) and 69,150 (2024, 485 leagues), weeks 2 to the end.

Calibration: the slope passes, but the 2023-24 **level** is about 2-3 points high (fewer lineup
errors in 2023-24 than in 2021-22; intercepts -0.22 / -0.16). The decile table in the JSON shows the
overprediction is in the middle deciles (0.11-0.20 predicted, 0.07-0.17 observed).

## Stress tests (reported, not gated)

A 0.95 AUC was checked before it was believed.

1. **Most of the checkout AUC is "he already stopped".** A one-feature rule, fewer adds in weeks 1-7,
   scores 0.918 (2023) / 0.941 (2024); adds in weeks 6-7 alone 0.893 / 0.914. The model still beats both
   (0.949 / 0.959). The win%-only comparator the unit named is weak for this label.
2. **Leagues where no one adds or trades all season** (abandoned, or a crawl gap): 122 / 120 team-seasons
   in 2023 / 2024. Without them: model 0.946 / 0.957, win%-only 0.644 / 0.656, adds weeks 6-7 0.888 / 0.909.
3. **Managers who added in week 6 or 7** (the non-obvious cases, 3.5% / 2.8% of whom stop): model
   **0.850 / 0.862**, adds-to-week-7 0.806 / 0.844, win%-only 0.599 / 0.579.
4. **Adds gain is not just the season's week profile.** Against the flat rate times the 2021-22 week-of-season
   profile, the gain is still +0.0430 (2023) / +0.0530 (2024) per team-week.
5. Served constants: `FITTED_PARAMS` equals this fit to a max relative difference of 2.7e-5 (rounding).

## Engine producer

- Field `activity.manager`, producer `activity`, version `living01a-1`, entity `league_team:<league>:<team>`,
  league-scoped. Registered with `registerField` in `activity-model.js`; the writer stays in that module.
- Inputs: ESPN transactions from `engine_events` (`espn.transaction`, as-of read), counted with #203's
  definitions (`manager-signals.js` `addsByTeam` / `completedTrades`); last week's dead starts read from
  #203's `manager_signals.lineup_dead_starts_last_week`, not recounted. No second activity number: the raw
  adds per week in the row is the same count #203 serves as `tx_adds_per_week`; the row adds the state and
  the shrunk rates.
- Served rates: `rates.adds_per_week.value`, `trades_per_week.value` and `lineup_error_rate.value` are each
  the manager's raw rate shrunk to the 2021-22 population rate, `shrunkRate(events, weeks, popRate, prior)`
  (adds: prior weight `alpha` = 8 weeks, pop 1.2501/week; e.g. 8 zero-add weeks -> 0.625, 3 adds/week for 8
  weeks -> 2.125). The state-relative multiplier `rho` feeds only `next_week` and `p_no_more_adds`. (Review
  fix on PR #220: the first head served `rho x popAddRate`, which is neither his rate nor a shrunk rate. The
  graded numbers below do not read this field, so they are unchanged.)
- Typed absence: adds are `null` (unknown) when no transaction for the league-season is in the log; lineup
  errors are unknown before last week (ESPN final lineups carry no play data in the log), and the reason chain
  says so. `next_week.p_lineup_error` is not bye-adjusted (`lineup_error_bye_adjusted: false`): there is no
  2026 bye share wired in.
- Reason chain: one entry per of the last two weeks, e.g. `drifting: week 2 0 adds, full lineup (+0.29)`
  (the move in the named state), `drifting: 0 adds in 2 weeks; P(checked out) 4%`, and the shrinkage line.
- Flag: `GRIDIRON_LIVING01A_ENABLED=1`, default off. `GRIDIRON_PREVIEW_UNCONFIRMED=1` turns it on through
  `preview-mode.js#previewUnconfirmed` (PREVIEW-01, PR #214) when that module is present, and labels each row
  `preview: true` with its reason; on a build without PREVIEW-01 only the unit's own flag turns it on.
- Nothing calls the producer on a schedule yet, and the server does not import it, so GET /api/engine/state
  answers `field_not_registered` for it until a runner imports it (the ENGINE-00b daemon or season-sim
  work, which own that wiring).

## ESPN 2026 live check (descriptive only, local copy)

Nick's 5 ESPN leagues, 46 teams, a local copy of `data.sqlite` taken 2026-09-23 with migration 075 and the
engine backfill applied to the copy (1,615 transaction events). Producer run as of 2026-09-23T21:00Z:

| through | engaged | drifting | checked out |
|---|---|---|---|
| week 2 (complete) | 17 | 28 | 1 |
| week 3 (partial: waivers still running) | 18 | 26 | 2 |

```
GRIDIRON_DB_PATH=<copy> GRIDIRON_LIVING01A_ENABLED=1 node scripts/living01a-fit.mjs --live --season 2026 --through 2 --as-of 2026-09-23T21:00:00Z
```

Two weeks of data is an anecdote, not a grade: most managers are "drifting" because two weeks cannot
separate a steady low-volume manager from one fading out. Recorded as ledger row F007.

## Not confirmed

- Transfer to ESPN: every graded number is Sleeper (public leagues, possibly more casual than Nick's).
  The ESPN check above has no outcome yet.
- "Dead" means no stat row; a player who played without a stat is counted dead (same definition as the
  R&D corpus). Unknown-mapping starters are 0.09% of slots.
- 67 league-seasons have no completed add or trade in the regular season; they are kept (stress test 2
  shows the result without them).

## Privacy

Aggregates only in anything committed: no league, roster, manager or user ids or names. The Sleeper file
was read only through a `.backup` copy; nflverse only through an immutable read; `data.sqlite` only through
a copy. 2025 was never opened (every query filters 2021-2024 or 2026).
