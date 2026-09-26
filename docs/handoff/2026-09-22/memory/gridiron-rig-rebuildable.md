---
name: gridiron-rig-rebuildable
description: "The measurement rig can be rebuilt from scratch in ~10s from free nflverse data with RIG-seed.mjs/RIG-fill.mjs/RIG-try.mjs; it is NOT the old rig (n=4361 vs 4343) so no magnitude carries over, and it has ONLY 000_legacy_schema."
metadata:
  type: project
---
Explorer, 2026-09-22. Scripts `/mnt/project-files/RIG-seed.mjs`, `RIG-fill.mjs`,
`RIG-try.mjs`; package `PACKAGE-RIG-REBUILD-2026-09-22.md`. Repo tree `654ff93`
[[gridiron-name-the-tree-rule]]. Data: nflverse-data CC BY 4.0
[[gridiron-nflverse-cc-by-attribution]]. **2025 never fetched** (holdout).

**Why the app's own path cannot do it:** `syncCrosswalk` (`nflverse.js:78`)
UPDATES existing `players`; it does not create them. The spine comes from ESPN
league rosters, so with no league there are no ids and `syncWeeklyUsage` matches
nothing — the real reason the old rig read zero [[gridiron-rig-blindness-six]].
`RIG-seed.mjs` seeds `players` straight from nflverse `players.csv`.

**Measured:** 1,749 players seeded (QB/RB/WR/TE, active 2021+), 17,473
`player_week_usage` rows 2022-2024, 5.4 MB. Replay runs: n=4361 graded,
98.2% coverage, 4s per arm. Season-long MAE model 4.742; weekly-config 4.928.

**NOT THE OLD RIG.** The historical rig graded n=4343. Direction reproduces
(config B worse) but **no previously quoted magnitude carries over** — re-derive
every figure here.

**INTERVENTION RESULT:** filling `nfl_snaps` (75,895), `player_week_snaps`
(20,114), `nfl_injuries` (16,852), `nfl_ngs` (7,079) changed the replay MAE by
**0.000** — confirms by experiment what
[[gridiron-weekly-replay-reads-only-four-tables]] established by tracing.

**THIRD CAUSE for `nfl_depth` = 0, found by running it:** `syncDepthCharts`
fails with "Depth charts downloaded but stored 0 rows: game_lines is empty...
Sync the schedule first." Not never-attempted, not download-failed, but
**dependency-ordering**. It records as an ERROR, so read the census's error TEXT,
not just its verdict. [[gridiron-optional-sources-never-trigger]]

**CRITICAL LIMIT — only `000_legacy_schema` is applied.** Importing
`server/db/index.js` (`:184-186`) runs the legacy schema ONLY; migrations 001-062
run on server boot. Measured on the rig: `migrations applied: 1`, `050` absent.
**Any finding on this rig that depends on post-000 schema is INVALID** — an
`entity_season` "defect" found this way was retracted before routing.

**Corrects the R49 premise:** the import runs the legacy-schema migration, not
the numbered migrations — and on a fresh file that creates **215 tables with 1
row in schema_migrations**, so the ambiguity is WIDER than stated. Corollary: a
"no such column" error seen through an import is an artifact of that path, never
evidence about production. [[gridiron-production-read-two-copy-rule]]

**Unblocks** model-mechanics work (configurations, heads, shrinkage, calibration,
ordering, power). **Does NOT** answer anything about production's own state.
