---
name: gridiron-package9-correction-2026-09-22
description: R&D's "package #9" on nfl-weekly-feature-store-v2.js satellites relayed with two false premises; cleanup thread caught both and found the real bug — nfl-model-growth.js:200 silently drops 2024/2025 formations.
metadata:
  type: project
  modified: 2026-09-22T05:23:06.005Z
---

**R&D delivered "package #9" ~05:20Z 2026-09-22** (Data & techniques R&D
thread): `nfl-weekly-feature-store-v2.js`'s gitignored SQLite satellite
dependencies (see [[gridiron-satellite-tables-correction-2026-09-22]])
should be rebuilt from data the repo already downloads via
`nfl-formations.js`'s `ingestFormations`/`ingestCharting`, rather than
shipped as external files.

**Coordinator relayed this to "R&D integration & cleanup"
(cse_01AkWVQyBHMgzzCWthGU6PNw), which caught two false premises before
acting:**

1. "v2 is unwired / nothing imports it" — **FALSE.**
   `scripts/backfill-feature-store.mjs:78` and
   `scripts/grade-feature-vector.mjs:58` both import it.
2. "`ingestFormations`/`ingestCharting` are never invoked" — **FALSE.**
   Invoked at `nfl-model-growth.js:200-201`,
   `routes/nfl-betting.js:1545-1546`,
   `scripts/nfl-2022-2025-rebuild.mjs:132/137`, and
   `test/ftn-charting.test.js`.

**The real find underneath:** `nfl-model-growth.js:200` gates
`ingestFormations` behind `if (season <= 2023)`, silently skipping 2024
and 2025 — the identical false belief ("participation ends after 2023")
this same thread already corrected once tonight, in a comment fix at
`nfl-formations.js` commit `1d8f6aa` (see
[[gridiron-participation-not-dead-after-2023]]). Verified directly via
HTTP range requests: participation 2022/2023/2024/2025 all return 206
(available); only 2026 (current season) 404s. Two full seasons of
already-ingestible free data are being silently dropped by one wrong
boundary constant.

**Disposition:**
- Coordinator granted the cleanup thread a narrow one-line fix at
  `nfl-model-growth.js:200` (file not previously in the allocation map)
  to correct the boundary constant, given its direct familiarity with
  this exact bug class. Recorded in [[gridiron-file-allocation]].
- Package #9 item 2 (widen `nfl_play_formations` with `was_pressure`,
  `time_to_throw`, `defense_man_zone_type`, `defense_coverage_type`) is
  confirmed — verified present in 10/10 target columns across all 4
  seasons — and proceeds, owned by the cleanup thread
  (`nfl-formations.js` + migration 069, both already theirs).
- Item 3 (wiring v2 itself) stays held, now with the corrected
  understanding that v2 has real consumers (the two backfill/grade
  scripts); whether the served/live model path consumes it is still
  unconfirmed either way.

**Lesson:** second time tonight a relayed package's stated premises were
wrong and caught only because the receiving thread verified independently
instead of trusting the relay (see also
[[gridiron-fourth-down-consumer-routing-2026-09-22]]'s 155-branch-grep
catch on the "already pushed" claim). Reinforces standing practice:
coordinator relays of another thread's self-reported claims are not
independently verified, and receiving threads should treat them
accordingly.
