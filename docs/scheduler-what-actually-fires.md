# What actually fires on the deployed build, and what never has

Written 2026-09-20 while the live app was restarting roughly every three
minutes. It answers one question plainly — **which scheduled jobs have never
run once on this build, and why** — from the source, not from the live
`sync_log`, which cannot be trusted for this: a process killed mid-job writes
nothing at all, so an absent row and a job that was never called look
identical.

## The timeline of one process life

`server/index.js:83` starts the scheduler with `intervalMinutes: 5`. The
signature's default is 30 and the deployment does not use it; reading the
default rather than the call site is how an account of the live machine ends
up describing a different one.

| t | What fires | How many jobs |
|---|-----------|---------------|
| 20 s | the boot catch-up pass (`BOOT_JOBS`) | 20 |
| 90 s | `nfl_model_growth`, its own delayed timer | 1 |
| 90 s | first live-tier pass, then every 90 s | 24 |
| 150 s | `nfl_reports`, its own delayed timer | 1 |
| **300 s** | **first background pass, then every 300 s** | **growth + metered + heavy** |

Every one of those is `setTimeout` or `setInterval`. `tier()` has no leading
call, so nothing in a tier runs before its first tick. The constants are pinned
in `test/scheduler-first-pass-timing.test.js`, because this whole document is
arithmetic on them.

## Measured against that: the process does not reach 300 seconds

From the overnight health log (60-second samples, 22:53Z onward): 46 restarts
in 2 h 16 m, a **mean interval of about 177 seconds**. The longest continuous
uptime *observed* in that log is 65 s, which is a smaller number for a sampling
reason rather than a different measurement — a life shorter than the gap
between samples is only partly visible. The honest statement is the mean: the
process has been living under three minutes and the background tier first fires
at five.

**So the background tier has never fired.** Not "rarely". The first tick comes
after the process is already gone, every time.

## The jobs that have therefore never run

**22 background-tier jobs**, 18 growth and 4 metered:

```
growth   nflverse_crosswalk            off-thread
growth   nflverse_weekly_usage         off-thread
growth   nflverse_snap_counts          off-thread
growth   espn_depth_chart              off-thread
growth   espn_season_stats             off-thread
growth   sleeper_players               off-thread
growth   espn_rosters                  off-thread
growth   nfelo_sync                    off-thread
growth   nfl_external_ratings          REQUEST THREAD
growth   nfl_qbr_weather               REQUEST THREAD
growth   nfl_learned_shadow            REQUEST THREAD
growth   nfl_offseason_depth_injury    off-thread
growth   nfl_decision_ledger           REQUEST THREAD
growth   trade_asset_universe_warm     REQUEST THREAD
growth   manager_signals               REQUEST THREAD
growth   decay_watch                   REQUEST THREAD
growth   nfl_coaches                   off-thread
growth   ffopportunity                 off-thread
metered  nfl_line_snapshots            REQUEST THREAD
metered  nfl_sgo_snapshot              REQUEST THREAD
metered  nfl_prop_capture              REQUEST THREAD
metered  twitter_insiders              REQUEST THREAD
```

Two background-tier jobs are **not** in that list because they are also on the
boot pass and therefore do fire at t+20 s: `nfl_prop_feeds` and
`beat_the_close`. Two more have their own delayed timers and fire at 90 s and
150 s: `nfl_model_growth` and `nfl_reports`.

**Plus 12 heavy jobs**, which have run zero times for a completely different
and correct reason: `AUTO_HEAVY_SYNC` is unset, and
`scheduler.js` builds the heavy list as `process.env.AUTO_HEAVY_SYNC === '1' ?
jobsInTier('heavy') : []`. That is the flag doing its job. `mlb_logs`,
`mlb_tomorrow_picks`, `nfl_forecast_history`, `press_conferences`,
`nfl_weekly_learning`, `nfl_prop_calibration`, `fantasy_coordinator_refit`,
`manager_archetypes`, `nfl_model_watch`, `nfl_rookie_public`,
`cfbd_rookie_usage`, `team_analyses`.

**34 of 62 jobs have never run on this build.** 22 because the process dies
before the tier that owns them ticks; 12 because a flag says not to.

## A number I had wrong, corrected here

I have been saying "19 jobs come due at once at t+300 s". That was the count of
growth and metered jobs *on the request thread*, which is a different set. The
number that matters for the 900-second proof after the brake comes off is
**22**, and after the six ingests in this branch moved, **10 of those 22 are
still on the request thread** rather than 16.

That is the thing the 900-second window actually measures. It is not the boot
fix. At t+300 s, 22 jobs that have never run come due in one sequential pass,
ten of them inline. A death between 300 and 900 seconds is in that burst, not
in the boot path, and diagnosing it as a boot regression would send the next
person to the wrong four PRs.

## Why the live sync_log cannot answer this

`record()` runs only after `job.run()` returns, so a process killed mid-job
writes nothing: no row, no error, no `consecutive_failures` increment. An
absent row means "never called" and "called and killed" equally, and the
recorded failure count is a floor rather than a count — the same shape as the
restart count itself.

That is what `recordStart` and `reapAbandonedRuns` (#61) change. After that
lands, a job killed mid-run leaves a `running` row that the next boot names and
backs off, so this burst becomes self-describing instead of invisible. Until
then, the source is the only honest answer and this document is it.

## What would change these numbers

- The scheduler stack (#56, #59, #61, #63) letting the process live past 300 s.
  The 22 then run — for the first time, all at once.
- `AUTO_HEAVY_SYNC=1`, which adds the 12 to the same pass. That is why it is
  the last step of the morning sequence and not an earlier one.
- Any further job moved off the request thread, which lowers the 10.
