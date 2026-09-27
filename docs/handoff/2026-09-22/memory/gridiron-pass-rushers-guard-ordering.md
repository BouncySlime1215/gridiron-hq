---
name: gridiron-pass-rushers-guard-ordering
description: "QUEUED, do not build: the #87 pass_rushers guard unblocks when #92 merges, but the gate must come AFTER a participation re-ingest or it nulls the whole history."
metadata:
  type: project
  modified: 2026-09-22T17:56:08.711Z
---

**Status: queued, not started.** Recorded 2026-09-22 ~17:53Z from a Planner
finding relayed by the coordinator. Do not build it before its predecessor
merges.

PR #87 parked the `pass_rushers` guard because `nfl_play_formations` had no
dropback discriminator. That reason expires when **#92** merges: migration 070
writes `was_pressure` **only on dropbacks** (`server/services/nfl-formations.js:122-127`),
which is the discriminator that was missing. `nfl_play_charting` shares the
`(game_id, play_id)` primary key, so it is joinable already — no new key work.

**The trap, and why the order is not negotiable.**
`nfl-formations.js:86-88` says pre-070 rows only acquire those columns on
**re-ingest**. So a `was_pressure IS NOT NULL` gate applied before a
participation backfill would null out essentially the whole history — the gate
would read "no dropbacks on record" for every season already in the database,
which is the same false-absence shape the trade-engine unit spent the day on.

**Correct order:**
1. Merge #92.
2. Re-ingest participation for 2016–2025.
3. Only then apply the `was_pressure IS NOT NULL` gate.

Verify each line above against the current tree before building — the line
numbers are from 2026-09-22 and the files are under active change.

Related: [[gridiron-findtrades-cache-fixture-hole]], [[gridiron-missing-data-workaround-rule]].
