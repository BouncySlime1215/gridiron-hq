---
name: gridiron-satellite-tables-correction-2026-09-22
description: Correction to the "nfl-weekly-feature-store-v2.js reads never-created tables" finding in [[gridiron-missing-data-log-2026-09-22]] item 3 — right instinct, wrong mechanism.
metadata:
  type: project
  modified: 2026-09-22T04:04:54.565Z
---

**CORRECTION (~04:00Z, wiring map RED 866032e/GREEN 4937719).** Item 3's
listing of `nfl-weekly-feature-store-v2.js` alongside `td-features.js` as
reading a table with "no migration/schema anywhere" was wrong in mechanism,
though right-ish in instinct.

Investigated properly: `adv_team_week`, `roster_weekly`, `snap_counts`,
`player_value_weekly` (read at nfl-weekly-feature-store-v2.js:175/223/400/443)
are NOT phantom/never-created. They live in satellite SQLite files
(`data/line-history/nflverse.sqlite`, `line_history.sqlite`,
`data/derived/player_value.sqlite` — env-overridable, SATELLITES const at
:81-85) that this Docker image simply doesn't ship — same class as
[[o4-corpus-not-in-the-image]] / [[chat-corpus-not-on-this-machine]]. The
module (:99) explicitly degrades honestly when a satellite is missing — the
OPPOSITE of silently_broken.

`play_by_play` and `pbp_participation` (read by td-features.js:188,310) ARE
real phantoms — no migration/schema creates them — but that module is
already dead/inert for an unrelated reason (`buildTdFeatures` takes a db
handle nothing supplies). `nfl-formations.js:10`'s read is unaffected.

New "read-but-never-created" detection rule is real and shipped: 7 names
survived its filter, only 3 are true phantoms (`league_draft_picks` — a NEW
finding, read unguarded at manager-archetypes.js:526 and
scripts/backfill-league-history.mjs:149; plus `play_by_play`/
`pbp_participation` above). Inventory now 880 rows: 72 wired/183
half_done/15 dead/3 silently_broken/10 referenced_but_never_created/56
model-blank/541 unclassified. Evidence:
`docs/tdd/table-read-but-never-created.tdd.md`.
