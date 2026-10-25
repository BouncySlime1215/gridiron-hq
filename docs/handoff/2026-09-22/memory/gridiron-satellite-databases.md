---
name: gridiron-satellite-databases
description: gridiron-hq reads four SQLite files besides the app DB, so "no CREATE TABLE in the tree" is EXPECTED for their tables and is not evidence of a phantom or an inert path.
metadata:
  type: project
  modified: 2026-09-22T04:01:24.180Z
---

**The app database is not the only database.** Besides `server/data.sqlite`,
production code opens these with their own `DatabaseSync` handles, each
env-overridable (`server/services/nfl-weekly-feature-store-v2.js:81-85`):

| file | env override | tables seen so far |
| --- | --- | --- |
| `data/line-history/nflverse.sqlite` | `NFLVERSE_DB_PATH` | `play_by_play`, `pbp_participation`, `adv_team_week`, `roster_weekly`, `snap_counts` |
| `data/line-history/line_history.sqlite` | `LINE_HISTORY_DB_PATH` | line history |
| `data/derived/player_value.sqlite` | `PLAYER_VALUE_DB_PATH` | `player_value_weekly` |
| the league chat corpus | `chatDbPath()` | `messages` — see [[gridiron-chat-corpus-two-databases]] |

Plus the sleeper-history (`sh_*`) and jev crawl (`jev_*`) databases, which
scripts create themselves.

**What this changes about a finding.** For a table in one of these, *no
migration creates it* is correct and expected, not a defect. A row for it is
never `referenced_but_never_created` — that status is for **app-DB** tables
nothing creates. The real question is whether the satellite FILE reaches
production, which is a deployment question. `data-file-not-in-the-image` is the
wiring-map rule that answers it, and as of 2026-09-22 it reports that the image
ships none of the three above.

**The failure this prevents, hit three times on 2026-09-22.** A finding arrives
as "these tables are created nowhere in the tree, so the module is an inert
path". The conclusion is usually right; the mechanism is wrong, and acting on
the stated reason sends someone to write migrations for tables that live in
another file instead of to the deployment where the answer is. Check how the
reading module got its handle before concluding anything: `h.prepare(sql)` on a
satellite handle, `satelliteRows(name, sql)`, or a `db`/`nflDb` arriving as a
function parameter all mean the query never touches the app DB.

**Also check whether the module is reachable at all.** `td-features.js` reads
two nflverse tables and is `module-imported-by-nothing`; its
`buildTdFeatures({ appDb, nflDb })` takes the handle as a parameter that
nothing supplies, because nothing calls it.

**The rule that finds these now.** `table-read-but-never-created` in
`scripts/wiring-map.mjs` (2026-09-22). It emits a satellite-only table as
`kind: 'context'`, weight 0, saying the schema is not this repository's to
create, and reserves the `orphan` kind for real app-DB phantoms. Filters that
earn their place: views, CTEs, DROP targets, SQLite builtins, foreign handles,
test-only names, and prose — SQL comments are blanked before matching, because
`-- one row per capture` is not a query.

**Related.** [[imported-by-nothing-is-not-unused]] is the same "true
observation, wrong mechanism" shape at the symbol level.
[[chat-corpus-not-on-this-machine]] and [[o4-corpus-not-in-the-image]] are two
more files whose absence is the expected state. See [[gridiron-failure-modes]].
