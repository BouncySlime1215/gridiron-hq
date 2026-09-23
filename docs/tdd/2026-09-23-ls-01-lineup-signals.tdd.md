# LS-01: lineup-signal tracker (Trade Machine, human side)

Branch `claude/local-ls-01-lineup-signals`, cut from `origin/main` at `3ac59fea`.
Pre-registration: `docs/evidence/2026-09-23/ls-01-bwiu-trade-prereg.md`.
Real-row numbers below come from a local copy of the app database, not production.

## 1. Audit: extend or build (written before the first test)

What exists for this surface on `3ac59fea`:

| piece | where | what it does | verdict |
|---|---|---|---|
| weekly lineup history | table `league_roster_snapshots` (migration `server/migrations/058_league_roster_snapshots.js`), writer `writePeriod` `scripts/collect-roster-snapshots.mjs:109` (INSERT at :113), rows from `rowsFromEntries` :65 | every team's roster and lineup slot per ESPN scoring period; `final` rows from the boxscore, `live` for the current period | reuse as the only lineup source |
| a reader of that table for lineups by manager | none (`git grep league_roster_snapshots -- server` returns the migration only) | | build |
| current dead starters | `rosterSignals` `server/services/manager-signals.js:307`, metric `lineup_dead_starters` | counts starters whose CURRENT payload status is OUT/IR/DOUBTFUL, one snapshot, no history | different concept (a status right now vs a started player who did not play in a completed week). Kept; the new signal is named `dead_starter_left_in`, and both values on the same league are reported in section 5 |
| trade block | `leagues.payload` `teams[].tradeBlock.players` (`ON_THE_BLOCK` / `UNTOUCHABLE`) | stored by the ESPN sync | no server reader today; build the read in the producer |
| usage share | `player_week_snaps.offense_pct` (writer `syncSnapCounts` `server/services/nflverse.js:287`, INSERT :300) | snap share 0-1 | reuse; route share is not stored anywhere, so "usage" is snap share |
| weekly fantasy points for a free agent | `pprPoints` `server/services/offseason-data.js:544` over `player_week_usage` | PPR from a stat row | reuse for "last week's top scorer". A second producer, `pprPoints` `server/services/offseason-model.js:73`, omits fumbles lost; not touched here, named as a follow-up |
| byes | `schedule_games` (writer `syncSchedules` `server/routes/nfldata.js:117`), `team_id` = ESPN pro team id (`nfl_teams.id`) | a team with no row in a week is on bye | reuse |
| matchup strength | `matchups.js` `MATCHUP_SIGNAL_REASON` :72 | DvP multipliers held at 1 as not validated | not used; "bad matchup" is read from ESPN's own weekly projection (`league_roster_snapshots.projected_points`) against the player's earlier projections |
| the route | `GET /api/trades/:leagueId/brain/managers` `server/routes/trades.js:225` -> `managerProfiles` `server/services/league-brain.js:126` | Nick's typed tiers | extend the route response with `lineup_signals`; `league-brain.js` keeps its export list (a test pins it) |

Decision: **build** one producer `server/services/lineup-signals.js`, computed on
read (no new table, no migration), and **extend** the `/brain/managers` response.
A stored table would need Nick's approval and a writer job; the inputs are small
(about 800 rows a week per league) so on-read is enough.

## 2. RED

## 3. GREEN

## 4. What it does

## 5. Numbers (each with command and tree)

## 6. Mutation sweep

## 7. Known defects and limits

## 8. Holdout looks

## 9. Nick's five questions
