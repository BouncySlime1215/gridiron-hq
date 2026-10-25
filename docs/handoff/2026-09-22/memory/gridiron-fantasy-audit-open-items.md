---
name: gridiron-fantasy-audit-open-items
description: The four Gridiron HQ fantasy items the audit filed as "needing a decision" — none of them does; each has a default, settled 2026-09-19.
metadata:
  type: project
---

Part of [[gridiron-fantasy-audit-findings]]. Re-read out of the code
2026-09-19 20:55Z; line numbers pinned to `origin/main` at **791b131**. The
audit was wrong to file these as decisions for Nick. All four defaults were
accepted by the coordinator; none went to him. See [[gridiron-decision-routing]].

**1. `tradeWeekContext()` falling back to week 1 is a missed wire-up, not a
design question.** `server/services/league-week.js` already has
`leagueCurrentWeek(lg)` with a documented order of truth: `leagues.current_week`
(ESPN `status.currentMatchupPeriod`, captured by migration 056), then the stored
payload, then the schedule-derived week — its docstring says "Never a
hard-coded 1". It has **one importer**, `routes/trades.js:19`.
`tradeWeekContext()` (`trade-engine.js:172`) still reads
`MIN(week) FROM game_lines` — the *betting* table — then falls back to 1.
**The cache-fragmentation objection is dead:** `assetUniverse(lg, formatKey,
requested)` (`:260`) already takes the league and already accepts a week
override (`:261`), and the universe is already cached per league-week.
Fix: `tradeWeekContext(lg)` -> `leagueCurrentWeek(lg)`, keeping `game_lines`
only for the no-league call. Post-deploy PR, own branch off main.

**2. The `|| 2026` hardcodes are not urgent.** 35 sites, every one
`Number(process.env.NFL_SEASON) || 2026`, so one env var overrides all of them
and all are correct through the 2026 season. The real defect is an
**inconsistency**: `draft-assist.js:872` uses `|| new Date().getFullYear()`, so
on 2027-01-01 the draft room says 2027 while the other 34 say 2026. **Verified 2026-09-19 22:20Z: `NFL_SEASON` is NOT set in production** — `fly.toml [env]` on 791b131 holds only `HOST`, so every one of these sites is running on its fallback right now. Harmless today because 2026 is both the season and the calendar year; it stops being harmless on 2027-01-01, mid-playoffs, and `scheduler.js`'s new `espn_market` job would then skip permanently. Interim fix is one line in `fly.toml [env]`, not code, so it can ride any deploy. Then one exported SEASON module.

**3. `syncEspnMarket` — SETTLED, caller landed as PR #50 (draft, 2026-09-19).**
Was the sole writer of `espn_player_market` with no caller anywhere. Now a
12-hour growth-tier off-thread job: one league picked by `MAX(season)`, skipped
outright when that is not the current NFL season, `{ limit: 1000 }` in the
caller. Full shape and the reasoning in [[espn-market-caller-decision]]; the
hazard it guards in [[espn-adp-double-weight-on-draft-board]].
Corrections to what this file used to say: the readers are
`routes/aggregates.js:226`, `preseason-model.js:336`,
`manager-archetypes.js:166` and `consensus-weights.js:526` (not :220/:349/:525),
and the `limit: 800` -> 1,042 note belongs to `routes/espn.js:42` and
`routes/stats.js:29`, a different filter — see [[espn-player-endpoint-limits]].
`syncEspnMarket`'s own default was 400. **Still not read live:**
`SELECT season, COUNT(*), MAX(fetched_at) FROM espn_player_market GROUP BY season`,
on the post-deploy scheduler read.

**4. `players.bye_week` is vestigial and already worked around.** Every
consumer computes the bye from the schedule via `byeWeeks(season)`
(`draft-assist.js:183`): board, dossier, picks list; the scoring path reads the
board's computed value, not the column. Leave it, comment it, **do not write a
migration to drop it** — zero behaviour change is pure risk on this repo (see
[[gridiron-migration-number-collisions]]). The `bye_week` in
`offseason-data.js` is a different column on a different table and IS
populated — easy to conflate.
