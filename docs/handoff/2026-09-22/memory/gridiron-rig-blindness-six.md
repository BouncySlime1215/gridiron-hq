---
name: gridiron-rig-blindness-six
description: "The six known ways a rig/scratch database hides real production behaviour from a trace, PLUS the actual table-by-table inventory of the shared rig on main (Feature audit, 16:51Z) — read before trusting any 'table X not read/populated' claim from a rig run; multiple, differing rigs exist"
metadata:
  type: project
  modified: 2026-09-22T16:52:13.172Z
---
Six distinct rig blindnesses found on this project, 2026-09-22. Each one makes
a rig trace under-report what production actually does — check every one
before trusting a rig-based reach/reads claim [[gridiron-table-reach-taxonomy]].

1. **`nfl_snaps`** — Condition B, not reachable on the weekly projection path
   (128,146 production rows, unreachable regardless of rig data).
2. **`nfl_injuries`** — Condition B, not reachable on the weekly projection
   path (28,411 production rows).
3. **`nfl_qbr_weekly`** — Condition B, reachable-but-absent: the query would
   fire on a populated database, but short-circuits because of blindness #5.
4. **`nfl_depth`** — Condition B, not reachable on the weekly projection path
   (production count 0 anyway, so this one is doubly invisible).
5. **`players.espn_id` NULL for every row** on every scratch rebuild checked
   so far — silently disables the QBR nudge and any espn_id join, with no
   error [[gridiron-scratch-rig-espn-id-null-disables-qbr]].
6. **Four live-path tables at 0 rows on the rig** — `player_week_snaps`,
   `nfl_news_signals`, `game_lines`, `nfl_engine_artifacts` — found via the
   16:33Z nfl_snaps trace: the *live* engine's 28-statement, 23-table read
   set includes these, the replay's 3-statement, 4-table read set does not,
   and on the rig all four return nothing either way, so "reachability
   proven, behaviour not" for this whole group
   [[gridiron-replay-is-not-the-live-path]].

**Why this matters:** blindnesses #1-#4 hide from a *reach* trace (the query
never fires); #5 hides from a *data* trace (the query fires, gets nothing,
looks identical to "no such join"); #6 hides from a *behaviour* trace (the
query fires correctly, on both live and replay paths where applicable, but
the rig has never populated the tables that would let anyone see it diverge).
Naming which of the six is in play is part of any submission that claims a
table "isn't read" or "doesn't matter" on this project's rig.

**MULTIPLE, DIFFERING RIGS EXIST — check which one before citing a count.**

**Shared rig on `main` ac31922d (Feature audit, 16:51Z inventory):** only
`player_week_usage` (11,851 rows, 2023+2024) and `players` (738 rows, all
`espn_id` NULL — blindness #5) are populated. **EMPTY:** `leagues`,
`roster_players`, `nfl_snaps`, `nfl_injuries`, `nfl_qbr_weekly`, `nfl_depth`,
`player_week_snaps`, `nfl_team_week_features`, `nfl_player_week_features`,
`nfl_play_formations`, `nfl_play_charting`, `dynasty_values`,
`player_season_stats`, `nfl_teams`, `game_lines`. `nfl_games` does not exist
in this schema snapshot. No 2026 data.

**Explorer's rig differs**: 1,140 `players` rows, and
`nfl_player_week_features` + `shrinkage_fits` are populated there — both
empty on the Feature-audit rig above. Treat every rig-based count as
tied to its specific rig, not the project as a whole.
