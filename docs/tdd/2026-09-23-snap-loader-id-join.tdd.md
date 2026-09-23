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
