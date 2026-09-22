# Evidence: `nfl_snaps.offense_pct = 0` is NOT feed-zero contamination

Source: Auditor's Plan 02 gate, relayed by the coordinator 2026-09-22 08:34Z,
following the feed-zero fix in PR #87. Ask: count residual feed-zero
contamination inside the filtered population of the feature store's snap
data — how many SKILL-position (QB/RB/WR/TE) player-week rows carry a
literal `offense_pct = 0`, and how many of those are players who did play
that week (had a usage row or a snap elsewhere), per season. LLM spend: $0 —
public nflverse CSV downloads and a plain Node script, no model calls.
Nothing deployed, no league data touched, no betting logic changed, no code
changed (this is a measurement, not a fix).

Runner:

    node offense-pct-zero-check.mjs 2022 2023 2024 2025

(script and raw CSVs in the session scratchpad, not committed — see
"How this was measured" below for exact commands to reproduce)

## Five questions

1. **Well built?** Yes — the count is over real, freshly downloaded files, not
   assumed by pattern-matching PR #87's FTN/participation finding onto a
   third, unrelated feed.
2. **Stats or made up?** Measured. This corrects an implicit assumption (that
   "any column co-occurring with a feed-zero pattern is probably
   contaminated the same way") rather than confirming it.
3. **How we know:** exact counts below, from `snap_counts_<season>.csv`
   (nflverse, the source of `nfl_snaps.offense_pct` — see
   `server/services/nfl-advanced.js:174-199`, `syncSnaps`) cross-referenced
   against `stats_player_week_<season>.csv` (source of `player_week_usage`
   — see `server/services/nflverse.js:228-260`, `syncWeeklyUsage`) for the
   same player/week/team having real usage (attempts/carries/targets/
   receptions > 0).
4. **Pointed anywhere else?** `offense_pct` feeds `AVG(offense_pct)
   avg_offense_participation` in `nfl-weekly-feature-store.js:130` (and its
   v2 mirror) — the same `teamHistory()` this whole unit has been auditing.
   This measurement settles that one column for that consumer.
5. **How it unifies:** completes the audit of every `nfl_snaps`-sourced
   column `teamHistory()` averages, alongside the two FTN/participation
   columns already fixed in PR #87.

## The question

PR #87 fixed two feeds (FTN charting/formations, nflverse `pbp_participation`)
that both write a literal `0` — not a blank cell — for a play they did not
measure, contaminating `AVG()` over `defenders_in_box` / `defense_box` /
`number_of_pass_rushers`. `teamHistory()` also averages `nfl_snaps.offense_pct`
(`nfl-weekly-feature-store.js:130`) from a THIRD feed (`snap_counts`,
nflverse). The question: does `snap_counts` fail the same way?

## The measurement

Downloaded `snap_counts_<season>.csv` and `stats_player_week_<season>.csv`
directly (`api.github.com` is blocked by this session's org egress policy;
`github.com/nflverse/nflverse-data/releases/download/...` is not — see
[[network-egress-nflverse-releases]]), for 2022–2025 (four complete regular
seasons). Filtered `snap_counts` to `SKILL_POSITIONS` (`QB`/`RB`/`WR`/`TE`,
matching this codebase's own definition — `preseason-model.js:69`,
`opportunity-model.js:42`) and `game_type = 'REG'`. For every row with
`offense_pct === 0` (a literal zero, parsed the same way `n()` in
`nfl-advanced.js:81` parses it — empty/NA stays `null`, `"0"` becomes `0`),
looked up the matching `(week, team, player)` row in `stats_player_week`
(joined by normalized display name — no shared id between these two nflverse
releases) and checked whether the player had any real usage that week.

    season | skill rows | offense_pct=0 | had real usage (contradiction) | no usage row found | genuinely NULL/blank offense_pct
    2022   | 6817       | 414           | 2                              | 221                 | 0
    2023   | 6852       | 366           | 2                              | 209                 | 0
    2024   | 6868       | 400           | 0                              | 184                 | 0
    2025   | 6804       | 410           | 0                              | 153                 | 0

## Reading the table

- **`offense_pct` is never genuinely blank/NULL in this feed** — 0 across
  every season, every row is a real number. Different shape from FTN and
  `pbp_participation`, which both had a small genuine-NULL population
  alongside their much larger sentinel-zero population.
- **`offense_pct = 0` on its own is common (~6% of SKILL rows/season) and is
  not itself evidence of anything wrong.** A healthy scratch, a player active
  but limited to special teams, or a rostered player who did not dress will
  correctly show 0% offensive snaps. This is expected, real football, not a
  sentinel.
- **The actual contradiction test — 0% offensive snaps despite a recorded
  catch, carry, or pass attempt that same week, which is not possible in
  real football — found 4 rows in 27,341 SKILL-position rows across four
  seasons (0.015%), all four a single touch (1 target+1 reception, or one
  carry, or one attempt) against `offense_snaps=0`:**

      2022 wk12 LA  Jacob Harris   WR  offense_snaps=0 | usage: tgt=1 rec=1
      2022 wk15 TB  Giovani Bernard RB offense_snaps=0 | usage: car=1
      2023 wk5  MIN Ty Chandler    RB offense_snaps=0 | usage: car=1
      2023 wk7  ARI Clayton Tune   QB offense_snaps=0 | usage: att=1

  Each is a single-play edge case (a trick play, a mid-series substitution,
  or a one-off reporting quirk in the PFR-sourced snap feed) at a rate two
  orders of magnitude below PR #87's ~20% contamination rate for FTN/
  `pbp_participation`. This is not the "measured nothing, write 0
  everywhere" signature those two feeds showed — it is noise at a scale a
  data source this size will always carry.
- 153–221 zero-offense_pct rows per season have no matching usage row at
  all — expected for a player who did not touch the ball, and consistent
  with (not contradicting) a real 0% offensive snap share.

## Decision: no fix

`AVG(offense_pct)` in `teamHistory()` is **not** guarded, and should not be.
Unlike `defenders_in_box`/`defense_box`/`number_of_pass_rushers`, `0` here is
overwhelmingly a real, correctly-measured value (an inactive or ST-only
week), and `NULLIF(offense_pct,0)` would be actively wrong: it would strip
~400 genuine zero-snap weeks per season out of the average for every
SKILL-position player, inflating `avg_offense_participation` for exactly the
players (healthy scratches, committee backs, injury-limited receivers) whose
low offensive share is the real, useful signal the metric exists to carry.

## What this does NOT settle

- The 4 contradiction rows are not explained beyond "a single-play edge
  case" — nobody has traced them to the underlying charting decision that
  produced `offense_snaps=0` alongside a recorded touch. They are too few to
  matter to any average, so this was not pursued further.
- `defense_pct` and `st_pct` in the same `nfl_snaps` table were not measured
  the same way — this pass was scoped to `offense_pct`, the column
  `teamHistory()` actually reads via `avg_offense_participation`.
  `avg_defense_participation` (`AVG(defense_pct)`) is a live, unaudited
  question for anyone who picks it up next.
- Seasons before 2022 (`TRUSTED_HISTORY_START` floor) and 2026 (in progress)
  were not measured.
