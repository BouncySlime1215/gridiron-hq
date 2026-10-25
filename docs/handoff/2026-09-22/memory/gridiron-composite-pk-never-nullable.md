---
name: gridiron-composite-pk-never-nullable
description: Any table with a composite primary key needs NOT NULL on every key column and an explicit sentinel for "no value" — SQLite lets NULLs duplicate inside a PK, which silently kills dedup on resync.
metadata:
  type: project
---

Discovered 2026-09-22 ~04:35Z while specifying `nfl_route_splits` (route tree
splits keyed by season/week/player_id/kind). The spec had `week` nullable, with
NULL meaning "season aggregate". Integration caught it; verified directly on
node:sqlite before accepting it:

- three identical inserts with `week = NULL` into a table with
  `PRIMARY KEY (season, week, player_id, kind)` **all succeed** and leave three
  rows — SQLite treats NULLs as distinct inside a primary key
- the same insert with `week = 0` is correctly rejected by the UNIQUE
  constraint on the second attempt

**Why it matters here:** every sync in this repo is written as
`INSERT ... ON CONFLICT DO UPDATE` and re-runs on a schedule. A nullable key
column means the conflict never fires, so each resync appends another copy of
the same row and every downstream count, average and coverage figure is
silently wrong. It fails quietly, which is the worst shape for this project
given how much of tonight's work is about surfaces that lie.

**How to apply:** when specifying or reviewing any table in this repo, every
column in the primary key gets `NOT NULL`, and "no value" gets an explicit
sentinel rather than NULL. For season-vs-week tables the sentinel is **week 0**,
which is also nflverse's own convention — `server/services/nfl-advanced.js:106`
skips week 0 rows precisely because that is where the source puts season
aggregates.

Related: [[gridiron-dangers-inventory]], [[gridiron-file-allocation]].
