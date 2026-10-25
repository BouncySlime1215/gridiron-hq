---
name: data-completeness-check
description: scripts/check-data-completeness.mjs (2026-09-19) — re-runnable expected-vs-actual audit of the tables the fantasy projection depends on, and the trap that made its first version useless.
metadata:
  type: project
  modified: 2026-09-19T20:58:00.000Z
---

Built because "the source reports ok" and "the table holds the rows" are
different claims, and the app trusted the first: every nflverse feed read
healthy while `player_week_usage` held **zero rows for the season being
played**, since the sync kept succeeding at fetching seasons that had not
changed. Run it with `node scripts/check-data-completeness.mjs` (`--json` for
machine output). Exits 1 only on a `blocks_projections` gap.

**How "expected" is defined, since it is a judgement and not readable anywhere.**
Three kinds, never mixed. *Season-and-week* tables are graded against the median
of their OWN completed seasons (floor 80%), which stays right when the league or
a position filter changes; fewer than two completed seasons prints CANNOT JUDGE
rather than inventing a number. *Identity* tables are graded on fill rate of the
columns others join on. *Model state* is graded on an exact count. Severity is
per finding, not per table — only `players.gsis_id` blocks a projection;
`espn_id` and `sleeper_id` each cost a feature, and marking all three blocking
made the BLOCKING line fire on a healthy database.

**THE TRAP, worth remembering generally.** The first version derived "weeks
played" from `MAX(week) FROM player_week_usage` — asking the possibly-broken
table how much data it ought to hold. Against a reproduction of the live gap it
concluded the season had not started and **reported ok on the exact defect it
existed to catch.** Now counted from `game_lines` final scores (the schedule
populates ahead of time), requiring 90% of a week's games scored before
demanding settled stats. *A completeness check must never take its baseline from
a table under test, and must be run against a deliberately broken copy, not only
a healthy one.*

**SCHEMA FACT that the column name hides:** `player_week_usage.player_id` (and
`player_week_snaps.player_id`) is a foreign key to **`players.id`**, the local
row id — NOT a gsis_id. Joining on gsis_id matches 0 of 29,755 rows and reports
a 100% orphan rate on a healthy database. The checker measures orphans AND
distinct players per season, because a `players` table too small to cover
retired players orphans nothing — the rows were never created, which no
integrity check can see. Rebuild baseline: **0 orphans, 577-633 distinct players
per completed season** (357 so far in 2026). Live `players` holds 965 rows, so
the first run against live decides whether that covers the stored history.

**It reports and never repairs**, deliberately: the `nfl_qbr_weekly` 2021-2024
gap it names is held open on purpose (see [[shrinkage-promotion-execution]]).

**Where the work is:** commits 661a651 and 434cbfb, on local branch
`data-completeness-check`, **not pushed**. The designated branch
`claude/project-thread-w45mur` was hard-reset back to 9db53ff so it stays
identical to what the merge train is merging. When the freeze lifts this goes on
its own branch off merged main as a new draft PR — NOT onto #15's branch, which
will be merged and closed by then. (That crosses the session instruction to stay
on the designated branch; the release-owning coordinator directed it and the
reasoning is sound, but say so openly rather than doing it silently.)

**Open, flagged not claimed:** live `players` reportedly holds 965 rows where a
rebuild from the same nflverse sources holds 8,294. If true, historical
player-weeks for anyone no longer rostered may not join, quietly shrinking every
backtest. `players.bye_week` is null everywhere but nothing reads it, so it is
deliberately out of the audit.
