# RL-12-2: the Sleeper injury flag now clears, and a stale flag is ignored

Unit RL-12-2 (plan item: Availability, URGENT; S-04 chance to play / SS-01 Start/Sit, TR-03 trade value inputs, TM-02 "Sell the Injury Risk", TradeCard, C-18). Source finding: R&D round 12 internal, `rnd/loop/r12-internal-injury-flag-never-clears.md` (local, not in the repo).
Base tree: origin/main `57a9ca1c`.

## 1. Audit (before the first test)

**Table:** `player_metrics`, rows with `source = 'injury_flag'` (key `(player_id, source)`).

**Writer:** `syncSleeper()` in `server/routes/aggregates.js:56-84` (origin/main 57a9ca1c). The only write is `:76-79`: when a Sleeper player has `injury_status`, upsert `value = 1`. There is no else branch and no reset, so a flag, once set, stays at 1 forever. `git grep -n "'injury_flag'" origin/main -- server` shows no other writer. Scheduled daily by `scheduler.js:1248-1250` (`sleeper_players`).

**Readers on origin/main (every one):**

| Reader | file:line | What the flag does there |
|---|---|---|
| `availability()` | `server/services/contingency.js:78-79`, `:110` | durability prior x0.82, which caps no-report players' chance to play (Start/Sit points, Lineup warning, waiver board, trade `adj_ppg`) |
| `buildAssetUniverse()` | `server/services/trade-engine.js:336-337`, `:482`, `:1324` | TradeCard ✚ and the "Sell the Injury Risk" tag |
| `metricsFor()` -> `playerEvidenceFacts()` | `server/routes/players.js:19-22`, `:155` | AI Buy/Sell fact "currently carries an injury flag" |
| `playerDraftContext()` area | `server/services/draft-assist.js:899`, `:979` | draft advisor prompt `injury_flag` |
| `GET /rankings/:id/entries` | `server/routes/rankings.js:34`, `:41` | "INJ" badge on the rankings table |

**Extend or build:** extend. The writer stays where it is (`syncSleeper`) and gains a clear step. The staleness rule is new, so it goes in one new producer, `server/services/injury-flags.js`, and every reader above switches from its own `SELECT ... value > 0` to that producer, so there is one definition of "this player is flagged". No new table, column or migration: clearing is `UPDATE ... SET value = 0`, never `DELETE`.

**Not statistical.** No model number is fit or selected. The stale window (7 days) is a hand-set constant, a guess: one game week, and the daily sync re-confirms a real flag every day, so a flag 7 days unconfirmed means the sync has not seen the injury for a week. No 2025 data is opened, so there are no holdout looks.

**Consumer counts before (local copy, not production; origin/main 57a9ca1c code):**
Command: `WT=$PWD SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$PWD/.local-db/data.sqlite node <scratchpad>/rl122/counts.mjs` (script counts only; reproduced in section 5).
```
injury_flag_rows 234 | rows_value_gt0 234 | readers_see_flagged 234
availability_entries 1139 | availability_penalised_x082 155
rostered_players 807 | rostered_flagged (trade ✚ / Sell tag inputs) 165
```
