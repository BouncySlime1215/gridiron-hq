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

## 2. RED and GREEN

- **RED:** `test: RED for RL-12-2, Sleeper injury flag never clears and stale flags still penalise` `452e9fb3`. On origin/main code, 5 of 5 fail:
  - test 1: `assert.equal(flag(1)?.value, 0, 'healed player: flag must be cleared after the next sync')` -> `expected: 0, actual: 1`
  - test 2: `assert.equal(result.cleared, 0)` -> `actual: undefined` (the sync reports no clear count)
  - test 3: `assert.equal(av.get(10).available, twin, 'stale flag + snaps in the latest week: no x0.82 penalty')` -> `expected: 0.824, actual: 0.675`
  - tests 4-5: `ERR_MODULE_NOT_FOUND` for `server/services/injury-flags.js` (no producer existed)
- **GREEN:** `fix: RL-12-2 clear the Sleeper injury flag on sync and ignore stale flags` `0a800a9e`. 5 of 5 pass.
- **Hardening from the mutation sweep:** `test: RL-12-2 pin the stale-flag age check and every reader call site` `df857ae1`. The fresh-flag fixture moved from 1 to 5 days old (so only the age check keeps it), plus a structural call-site test and a `GET /rankings/:id/entries` route test. 7 of 7 pass.
- Command (each run): `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -u) node --experimental-test-module-mocks --test --test-reporter=tap test/sleeper-injury-flag-clears.test.js`
- Neighbouring targeted tests on `0a800a9e`, same command shape: availability-role 17/17, availability-honest-degradation 8/8, asset-universe-fingerprint 5/5, trade-engine-correctness 15/15, draft-assist-bestball 8/8.

## 3. What it does

1. **Writer** `syncSleeper()` (`server/routes/aggregates.js`, branch lines 65-96): collects the ids it matched and the ids Sleeper lists as injured. After the loop, for every matched id without an injury it runs `UPDATE player_metrics SET value = 0, fetched_at = datetime('now') WHERE player_id = ? AND source = 'injury_flag' AND value <> 0` and sums `changes`. Returns and logs `{ matched, ambiguous, flagged, cleared }`. Nothing is deleted. A player not matched by this pull keeps his flag.
2. **One reader** `server/services/injury-flags.js`: `injuryFlagState()` returns `{ active, ignored, latest }`; `activeInjuryFlagIds()` returns the set and `console.warn`s the ignored ids once per distinct set. A flag is ignored when all hold: `fetched_at` older than `STALE_FLAG_DAYS` (7, a guess), the player has `offense_snaps > 0` in the latest `(season, week)` of `player_week_snaps`, and that week's first `schedule_games.date` is after the day the flag was last confirmed.
3. **Readers switched to it:** `contingency.js` `availability()`, `trade-engine.js` `buildAssetUniverse()`, `players.js` `metricsFor()`, `draft-assist.js` player context, `rankings.js` `GET /:id/entries`. The stale comment "the app has no live injury feed" in `contingency.js` is corrected.

## 4. Mutation sweep (tree df857ae1)

Command: `python3 <scratchpad>/rl122/mutate.py` (applies one string mutation, runs the test file, restores the file).

| Mutant | Applied | Result |
|---|---|---|
| M1 unit: drop the clear loop | yes | KILLED (1) |
| M2 unit: clear unmatched players too | yes | KILLED (2) |
| M3 unit: DELETE instead of UPDATE | yes | KILLED (1) |
| M4 unit: drop the played-since condition | yes | KILLED (3, 4, 5) |
| M5 unit: drop the week-after-flag check | yes | KILLED (5) |
| M6 unit: drop the age check | yes | KILLED (3, 4, 7) |
| M7 unit: stale cutoff sign flip | yes | KILLED (3, 4, 7) |
| M8 call site: contingency back to the raw read | yes | KILLED (3, 6) |
| M9 call site: trade-engine back to the raw read | yes | KILLED (6) |
| M10 call site: players.js override removed | yes | KILLED (6) |
| M11 call site: rankings passes the raw flag | yes | KILLED (7) |
| M12 call site: draft-assist raw value | yes | KILLED (6) |
| S1 designed survivor: log wording changed | yes | SURVIVED (by design: tests do not pin the log text) |
| C1 not-applied control: pattern absent | no | SURVIVED (file unchanged, proves the harness restores and reports) |

On `0a800a9e` (before hardening) M6, M7 and M11 survived; that is why `df857ae1` exists. M9, M10 and M12 are killed by the structural test only (a grep pin, not behaviour).

## 5. Numbers (local copy, not production)

Copy: `sqlite3 ~/gridiron-local/data.sqlite ".backup '<worktree>/.local-db/data.sqlite'"`, 2026-09-23. Counts command: `WT=$PWD SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$PWD/.local-db/data.sqlite node <scratchpad>/rl122/counts.mjs` (it imports `availability()` and counts flagged ids among its entries and among rostered players; no names). Sync command: `node <scratchpad>/rl122/sync.mjs` (calls the branch `syncSleeper()` once against the copy; one public Sleeper `/players/nfl` request, a source the app already calls daily and Nick cleared for Sleeper units, section 6 of the queue; no licence file applies to the API, aggregates only).

| State | flag rows | value > 0 | stale ignored | availability entries penalised x0.82 (of 1139) | rostered players flagged (trade ✚ / Sell tag input, of 807) |
|---|---|---|---|---|---|
| origin/main 57a9ca1c code, copy as taken | 234 | 234 | n/a | 155 | 165 |
| branch df857ae1 code, before sync | 234 | 234 | 0 | 155 | 165 |
| branch df857ae1 code, after one sync | 236 | 187 | 0 | 132 | 121 |

- Sync result: `{"matched":1628,"ambiguous":21,"flagged":187,"cleared":49}`. This reproduces the R&D finding's prediction (49 stale, 187 correct, 2 new rows).
- 236 rows = 187 on + 49 cleared to 0; nothing deleted.
- **Stale guard on real data = 0, and why:** every flag on the copy was confirmed on 2026-09-22 or 2026-09-23, and the latest loaded week (2026 week 2) started 2026-09-18, before that; no week has started since, so no flag can qualify. The known-nonzero case is fixture test 4 (player 10 ignored). This is structural, not a measured absence.
- Migrations: `git diff origin/main -- server/migrations server/db/schema | wc -l` -> 0 (control: `git diff --stat origin/main...HEAD` -> 9 files changed).

## Holdout looks

None. No model was fit or selected; 2025 was not opened.

## 6. Known defects and limits

- `STALE_FLAG_DAYS = 7` is a hand-set guess, not fitted.
- The stale guard uses the week's earliest game date league-wide, not the player's own game date; a flag confirmed mid-week (after Thursday) on a player who played that Sunday is not treated as "played since" until the next week loads. Conservative direction (keeps the flag).
- The flag is still a bit: "IR" and "Questionable" read the same. Storing the status text (R&D fix 2) and retiring the x0.82 live-week penalty (fix 3) are not in this unit; they change a model number and belong in their own unit with the Auditor.
- Trade-engine results are cached by a data fingerprint (`compute-cache.js`); a flag that turns stale by the clock alone, with no table change, may not show until the next data change invalidates the cache. Guess: the daily Sleeper sync touches `player_metrics` every day, so in practice this is at most a day.
- Decision grading (start/sit win rate vs the dumb baseline, walk-forward over past seasons) was not run: the unit fixes a data defect, it does not introduce a model. The R&D finding's 2023-24 proxy (exposed players played 88% of flagged no-report weeks) is its evidence, not re-measured here.

## 7. Nick's five questions

1. **Well built?** The writer now switches the flag off with an UPDATE for every player Sleeper matched without an injury, and reports the count. One new module is the only reader of the flag, and all five readers use it. 7 tests, 12 of 12 real mutants killed, no migration.
2. **Stats or made up?** No stats. The clearing rule is Sleeper's own contract (null `injury_status` = healthy). The 7-day stale window is made up (a guess).
3. **How we know:** fixture tests (RED -> GREEN above), plus one sync on the local copy: 49 flags cleared, 187 left, which matches the R&D finding. No backtest; none applies.
4. **Pointed anywhere else?** Yes, every reader: chance to play (`availability()` -> Start/Sit, Lineup warning, waiver board, trade value), TradeCard ✚ and "Sell the Injury Risk", AI Buy/Sell fact, draft advisor, rankings "INJ" badge.
5. **How it unifies:** before, five files each ran their own `SELECT ... value > 0` (or read the raw value). Now `services/injury-flags.js` is the one producer; the structural test fails if a reader goes back to a raw read.
