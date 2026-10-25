---
name: gridiron-state-1231-2026-09-22
description: "16:51Z: Feature audit inventories the shared rig table-by-table (only 2 tables populated) and runs its local end-to-end half — a silent-inert availability banner, two raw-crash consumers, one self-aware feature, one post-deploy read probe"
metadata:
  type: project
  modified: 2026-09-22T16:54:08.104Z
---
- **16:51Z Feature audit, shared-rig inventory** (main 140d436b): full table-by-table result now in [[gridiron-rig-blindness-six]] — only `player_week_usage` and `players` populated, 15 named tables empty, `nfl_games` absent from the schema snapshot, no 2026 data. Explorer's separate rig differs (1,140 players, `nfl_player_week_features` + `shrinkage_fits` populated there).
- **16:51Z Feature audit, local end-to-end half** (8 feature functions probed): `availabilityPicture` (`football-context.js`) reports **"close to healthy" when `nfl_injuries` is empty** — a rig artefact (production has 28,411 rows) but exactly CLAUDE.md's silent-inert pattern; **unit assigned to Feature audit** (TDD, state-based wording, not a live bug). `trade-engine` and `waiver-brain` **crash with a raw `TypeError`** on missing league data — recorded for their owners. `teamTrends` is self-aware, returns "insufficient" correctly. **Post-deploy read probe queued**: `nfl_injuries` count by season + latest date.
Prev [[gridiron-state-1230-2026-09-22]]. Next [[gridiron-state-1232-2026-09-22]].
