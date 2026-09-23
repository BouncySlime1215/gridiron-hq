# S-20: the snap-count loader joins by id, not by name

Unit S-20 (plan item: Structure / data identity). Source: R&D round 7 internal package
`r7-internal-snap-ingest-name-join.md`. Tree: branch `claude/local-s-20-snap-loader-id-join` off origin/main `3ac59fea`.

## 1. Audit: extend or build

| Surface | What exists (origin/main `3ac59fea`) | Decision |
|---|---|---|
| Writer | `syncSnapCounts` `server/services/nflverse.js:287-318` writes table `player_week_snaps` (schema `server/db/schema/mlb-model-misc.js:279`). It reads `pfr_player_id` at `:290` and never uses it; it joins on `norm(name)|position` with a last-row-wins map (`:297-298`) and drops a miss silently (`:310`). Returns `{season, inserted}` only. | **Extend** this writer. It is the only writer of `player_week_snaps` (`git grep -n "INTO player_week_snaps" -- server` → `nflverse.js:300` only). |
| pfr → gsis bridge | `syncCrosswalk` `nflverse.js:95` already downloads nflverse `players/players.csv`, which carries `pfr_id` next to `gsis_id`, but discards `pfr_id`. `off_rosters.pfr_id` (`mlb-model-misc.js:356`) exists but holds 0 rows on the local copy (`select count(*) from off_rosters where pfr_id is not null` → 0). | **Extend** `syncCrosswalk` to keep the pfr → gsis map in memory; no new column, no migration. |
| gsis → player | `players.gsis_id`, stamped by `syncCrosswalk`; `syncWeeklyUsage` (`:255`) already joins on it. | Reuse (same `byGsis` map). |
| Name matching | `player-identity.js` `normalizePlayerName` / `findPlayerMatch` (refuses to guess on a collision). The snap loader has its own `norm`. | Name fallback keeps the loader's `norm` (so the backfill can recognise rows the old join wrote) but refuses ambiguous keys instead of last-row-wins, and aliases nflverse `HB`/`FB` to `RB`. |
| Tests | `git grep -n syncSnapCounts -- test` → 0 hits (control: `player_week_snaps` appears as fixture inserts in 4 test files). | Build `test/nflverse-snap-join.test.js`. |
| Queue overlap | D-10 (reconcile the two snap ingests) is about table ownership, not the join key. | No overlap in code; noted. |

Not a statistical unit: no model number is produced or selected, so there is no pre-registration.
No 2025 held-out season rows are graded (identity repair only), so there is no holdout look.

Holdout looks: none. The 2025 rows are re-attributed, not graded against outcomes; no model is fit or selected, so nothing goes in `docs/evidence/HOLDOUT-LEDGER.md`.

## 2. RED / GREEN

- **RED** `04855470` test: RED snap loader stores namesake, HB and nickname rows on the wrong player. On origin/main code, 7 of 8 fail. First failing assertion (namesake pair; the active Jr. gets nothing):
  ```
  test/nflverse-snap-join.test.js:93  assert.deepEqual(snapsFor(4).map(r => [r.week, r.offense_snaps]), [[1, 59], [2, 37]])
  + actual - expected
  + []
  - [[1, 59], [2, 37]]
  ```
  The one passing test was the null control (a player with no name issue).
- **GREEN** `1ec63b6a` fix: snap loader joins nflverse snap counts by pfr id, name only as fallback. 8/8 pass.
- **Hardening** `732ec696` test: snap loader refuses shared name keys, keeps same-name id targets, logs via syncAll. 11/11 pass.
  Command: `SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=$(mktemp -d)/t.sqlite node --experimental-test-module-mocks --test --test-reporter=tap test/nflverse-snap-join.test.js`.
  `test/nflverse-attribution.test.js` (same module) also passes, 4/4. The final 11 tests run against origin/main's `nflverse.js`: 1 pass (null control), 10 fail.
  The fixture uses made-up names and ids of the same shape; the two real cases are named only in the uncommitted R&D package.
- **Skeptic round 1 (wiring): the scheduled job path.** The job `nflverse_snap_counts` (`server/services/scheduler.js` JOBS, every 6 h, offThread) calls `refreshNflverseSnapCounts` → `syncSnapCounts(season)` alone in a job-worker, with no `syncCrosswalk` first. So the pfr map is cold there and `syncSnapCounts` fetches `players.csv` itself; a `players.csv` failure threw the whole job (0 rows written, failure backoff), where origin/main wrote name-joined rows.
  - **RED** `3e8b2850` test: new file `test/nflverse-snap-standalone.test.js` drives `JOBS.nflverse_snap_counts.run()` in its own process (cold map, as in the worker). On the pre-fix tree: 1 pass / 2 fail, first failure `error: 'players.csv -> HTTP 503'`.
  - **GREEN** `c8e77f35` fix: the crosswalk fetch is caught, logged with `console.warn`, returned as `crosswalk_error`, and the run falls back to the name join (still refusing shared name keys). The map is left unset, so the next run retries. The `scheduler.js` comment that said "matched on name+position, so no gsis_id needed" now describes the id join. 3/3 pass; `nflverse-snap-join` 11/11 and `nflverse-attribution` 4/4 still pass (same command as above, per file).
  - The tests pin the fetch sequence: players.csv down → fetches `snap_counts_2026.csv, players.csv`, `by_id` 0, unique name lands, the Jr. and his namesake both get nothing (`ambiguous_name` 1). Recovered → `players.csv` fetched again, `by_id` 3. Warm map in the same process → only the snap file is fetched.
  - **Not changed: one `players.csv` fetch per scheduled run.** Each 6-hourly job-worker starts cold, so it downloads `players.csv` once (the skeptic measured about 7 MB; I did not re-measure). The daily crosswalk job downloads the same file. Caching it across workers would need a new store (for example a `players.pfr_id` column filled by `syncCrosswalk`). That is an additive migration with its own reader, so it is left as a follow-up rather than added here.
  - `crosswalk_error` does not change the job's status: `statusFromDetail` (`scheduler.js:203`) reads `detail.error`, not `crosswalk_error`, so a degraded run records `ok` with the error in `last_detail`. That is on purpose, because the run did write rows.

## 3. What it does

`syncSnapCounts` (`server/services/nflverse.js`, writer of table `player_week_snaps`) now works like this:

1. **Id join first.** Each snap row goes `pfr_player_id` → `gsis_id` (nflverse `players.csv`) → `players.gsis_id`. `syncCrosswalk` keeps that pfr map from the `players.csv` it already downloads. A standalone snap sync fetches `players.csv` once.
2. **Name fallback only when the id does not resolve.** The key is `name|position`, with nflverse `HB`/`FB` aliased to `RB`. A key that two local players share is refused and counted in `ambiguous_name`. The old code let the last row win.
3. **Backfill by updates only.** A namesake row is moved to the id-resolved player with `UPDATE player_week_snaps SET player_id = ?` when all of these hold:
   - it has the same name key and exactly the same numbers in the same week;
   - that namesake is not himself an id-resolved target that week;
   - the right player has no row for that week.

   Nothing is deleted. A stale row that cannot be moved is counted in `namesake_rows_left`.
4. **Counts.** The sync returns `{inserted, by_id, name_fallback, unmatched, ambiguous_name, reassigned, namesake_rows_left, crosswalk_error}`. `syncAll` → `recordSync('nflverse_snap_counts', …)` writes it to `sync_log`.
   - The scheduled job `nflverse_snap_counts` (`scheduler.js` `refreshNflverseSnapCounts`) records the same object through the scheduler's own `record`; `test/nflverse-snap-standalone.test.js` covers that path.
   - The path reaches production through the route `POST /api/model/sync` (`server/routes/model.js:488`, `syncNflverse` at `:512`). The syncAll test covers it: `sync_log.last_detail` carries `"by_id":8`.

No migration: the pfr map lives in memory and no column is added.

## 4. Numbers (local copy, not production)

- **Tree:** this branch at `732ec696`. The replay ran on the same code before commit shas were rewritten to drop real player names from the fixture; the rewrite changed test names and one comment only.
- **DB:** `.local-db/data.sqlite`, a `.backup` of `~/gridiron-local/data.sqlite` taken 2026-09-23.
- **Source rows:** nflverse CSVs served from the read-only archive `gridiron-hq/data/line-history/nflverse.sqlite` (tables `snap_counts`, `players`) through a fetch stub.
- **Scripts:** in the session scratchpad, not committed (they name the two cases): `s20-local-replay.mjs` (2025, 2026) and `s20-local-replay-2021-2024.mjs`.
- **Coverage gap:** the archive holds 2026 week 1 only, so 2026 week 2 was not replayed.

The two named cases are case A (namesake pair) and case B (HB label). Player names are left out on purpose.

| Measure | Before | After |
|---|---|---|
| Case A snap rows, 2024 / 2025 / 2026 | 0 / 0 / 0 | 17 / 12 / 1 (W1; W2 not in archive) |
| Case B snap rows, 2025 / 2026 | 0 / 0 | 17 / 1 (W1; W2 not in archive) |
| Retired namesake rows, 2024 / 2025 / 2026 | 17 / 12 / 2 | 0 / 0 / 1 (the W2 row, which moves when the live W2 CSV syncs) |
| Usage rows with 8+ targets+carries and no snap row, 2025 | 55 | 0 |
| Same measure, 2026 | 3 | 1 (case B W2, same archive gap) |
| Same measure, 2021 / 2022 / 2023 / 2024 | not measured before | 0 / 0 / 0 / 0 |
| `player_week_snaps` total rows | 40,890 | 42,188 after 2025-26, 48,459 after 2021-24 (never decreases) |

Before-counts for the named ids came from a second fresh `.backup`, deleted right after. Its total, 40,890, matches the replay's before total.

**Sync counts per season** (`by_id` / `name_fallback` / `reassigned` / `namesake_rows_left`):

| Season | by_id | name_fallback | reassigned | namesake_rows_left |
|---|---|---|---|---|
| 2021 | 8,866 | 15 | 54 | 0 |
| 2022 | 9,125 | 1 | 69 | 0 |
| 2023 | 9,671 | 0 | 86 | 0 |
| 2024 | 9,812 | 12 | 94 | 0 |
| 2025 | 9,824 | 18 | 94 | 0 |
| 2026 (W1) | 596 | 1 | 4 | 0 |

- **`unmatched`** (about 15-16k a season) is defensive and special-teams players who are not in the local `players` table. It is not a skill-position loss.
- **Skill rows** (QB/RB/HB/FB/WR/TE, REG, offense_snaps > 0) that resolve by id: 2025 6,590 of 6,604; 2026 389 of 391. This was a separate read-only node query over the copy and the archive.

**Null controls:**
- The first replay touched only 2025-26. All 31,231 rows for 2021-2024 were identical after it.
- Of the 40,890 pre-existing keys, 40,792 were unchanged, 98 were vacated by moves (= 94 + 4 `reassigned`), 0 had their values changed, and 1,396 keys were added.

**Consumers re-checked (counts only):**

`contingency.roleStates(2026, 3)` is the snap share that WV-02 (#178, open, not merged) ranks by with `sameTeamOrder: 'snap_share'`. The same numbers feed the availability role tier.

| Measure | Before | After |
|---|---|---|
| Players | 716 | 714 (4 left, 2 joined) |
| `unknown` tier | 52 | 16 |
| Tier changed, players in both maps | | 39 |
| Players whose entry changed (39 + 4 left + 2 joined) | | 45 |
| `unknown` → known (players in both maps) | | 36 |
| Case A | `unknown` | `rotation` |
| Case B | `unknown` (derived, see below) | `starter` |

- The 4 who left are WRs (local ids 4666, 5682, 7774, 8446) with 0 `player_week_usage` rows in 2025+ and 10-14 snap rows each that the old name join had put on them. Their before tiers were fringe, rotation, starter and starter. So the bug listed four same-name WRs who never played as fringe-to-starter, two of them as starters. That is what WV-02's `snap_share` order would have shown. After the fix they have no snap rows and no usage, so they drop out of the map.
- The 2 who joined are RBs (local ids 708, 740). Each has 0 usage rows and 1 snap row in 2025+ after the replay (after tiers rotation and fringe). They are rows moved to their id owner, and they come in only through the snap side of `roleStates`.
- A correction: an earlier version of this table said "714 (two namesake rows lost all their appearances)" and "41 tier changed". The 41 was the 39 changed plus the 2 joiners, and it left out the 4 who left. The counts above come from the command below.
- Command (local copy, not production; tree 1e2c02c3): `sqlite3 ~/gridiron-local/data.sqlite ".backup '<scratch>/fresh/data.sqlite'"`, then scratchpad `s20-role-dump.mjs` run with `GRIDIRON_DB_PATH` set to the fresh backup (before) and to the replayed `.local-db/data.sqlite` (after), then a union diff of the two JSON dumps. Output: `before 716 after 714 removed 4 added 2 changed_both 39 total 45`, `unknown before 52 after 16`, `unknown->known (both) 36`. The fresh backup was deleted after the dump.
- Case B before: `roleStates` takes share only from `player_week_snaps` (`contingency.js:379-383`). The fresh backup held 0 snap rows for case B in 2025-26, so his share was `null` and his tier `unknown`. That is derived from the code, not measured: the replay's own case-B line had looked up the wrong gsis and was discarded. After: measured on the copy with a separate `roleStates(2026, 3)` call (case A share 0.56, case B share 0.64).
- WV-02 ships snap-share order default-off (projection order is the default), so this changes the `snap_share` field shown and the opt-in order, not the default list.

## 5. Mutation sweep

Script: scratchpad `s20-mutants.py`. It applies each mutant to `nflverse.js`, runs the test file, and restores the file. `git status` was clean afterwards.

| Mutant | Result |
|---|---|
| M0 not-applied control (no change) | 0 failing (expected) |
| M1 id lookup disabled (name only) | killed, 9 failing |
| M2 **designed survivor**: HB/FB alias removed | survived. The fixture's HB back resolves by id; the alias only matters on the fallback path. |
| M3 name map last-row-wins again | killed, 4 |
| M4 id-target guard removed | killed, 4 |
| M5 number-equality guard removed | killed, 4 |
| M6 call site: the snap sync never loads the pfr crosswalk | killed, 9 |
| M7 call site: `syncAll` skips the snap sync | killed, 1 |
| M8 backfill move removed (upsert only) | killed, 4 |

## 6. Known defects / follow-ups

1. **Production is not corrected until the next sync.** It needs `syncAll` / `POST /api/model/sync` over 2021-2026 on production (N5 territory). That run fixes 2026 W2 too, which the archive could not replay here.
2. **Case B's before tier is derived, not measured.** It is `unknown` because he had 0 snap rows. It was derived from the code (see section 4) because the first replay's case-B lookup used a wrong gsis.
3. **Nothing re-fits S-04.** S-04's role cells (`scripts/fit-availability.mjs:260`) were fit on the name-joined rows. S-04 should re-fit on corrected rows before it serves.
4. **One stale doc line.** `docs/tdd/play-chance.tdd.md:120` still blames "nfl_snaps has him by name". It belongs to another thread, so it is reported here, not edited.
6. **Per-run players.csv fetch in the scheduled job.** Each worker run downloads it once (see section 2, skeptic round 1). A `players.pfr_id` column filled by `syncCrosswalk` would remove it; follow-up.
5. **Two snap ingests remain.** D-10 (`nfl-advanced.js` vs `nflverse.js`) still owns that. This unit touches `nflverse.js` only.

## 7. Nick's five questions

1. **Well built?** One writer is changed, in place. The id join reuses the existing `players.csv` download and the `byGsis` map. There is no migration and no new table or column, SQL is parameterised, and every error path rolls back and rethrows (no bare catch). 11 tests cover it, and the mutation sweep killed 7 of 7 non-designed mutants.
2. **Stats or made up?** No model number here. Every count above comes from a named script run on the local copy, labelled local copy, not production.
3. **How we know?** RED reproduced the wrong attribution in a fixture (an active Jr. and a retired namesake, an HB back, a nickname). On the local copy both named cases moved from 0 rows to full seasons, and the retired namesake emptied except for one W2 row that the archive cannot replay.
4. **Pointed elsewhere?** Readers of `player_week_snaps` are unchanged, and they now read the right player's rows:
   - `contingency.roleStates` (availability tier, WV-02 snap share)
   - `player-advanced-stats`, `role-changepoint`, `beat-reporter-accuracy`, `opportunity-model`, `trade-engine`
5. **How it unifies?** There is still one producer of snap share (`player_week_snaps` via `syncSnapCounts`), and it now uses the same gsis identity as `player_week_usage`, so the usage and snap rows for a player-week agree on who he is.

- **Defect fixed:** `server/services/nflverse.js:294-310` on origin/main `3ac59fea`. The name|position join (last row wins) left `pfr_player_id` (`:290`) unused.
- **Incumbent:** the name join itself. Before measurements came from `s20-local-replay.mjs` on the fresh local copy (section 4).
- **Not covered:**
  - the production DB (it needs a sync run);
  - 2026 W2 on the copy;
  - the S-04 re-fit;
  - D-10's second ingest;
  - any grading of start/sit decisions. No decision number changes in this unit, so there is no decision-rate or walk-forward claim.
- **What would make it wrong:**
  - nflverse `players.csv` binding one `pfr_id` to the wrong `gsis_id`;
  - a wrong `players.gsis_id` binding from `syncCrosswalk`;
  - a genuine namesake whose own row failed the id join and happens to carry byte-identical snaps and pct in the same week. That row would be moved. It is guarded but possible, and `reassigned` counts it.
