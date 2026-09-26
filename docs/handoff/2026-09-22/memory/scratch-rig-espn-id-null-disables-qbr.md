---
name: scratch-rig-espn-id-null-disables-qbr
description: Scratch/rebuilt databases that leave players.espn_id NULL silently disable the QBR nudge, so any QB figure graded on them is invalid.
metadata:
  type: project
---

`qbrTrailingForPlayer(espnId, …)` returns `null` when the id is null
(`server/services/nfl-qbr.js:129`), so the QBR nudge is skipped with no error
and no log line. Every scratch rebuild checked so far leaves
`players.espn_id` NULL for **every** row — the R&D rig, and this thread's
1,483-player projection rig (1,483/1,483 NULL, verified 2026-09-22).

**Why:** a caller cannot tell "no QBR evidence" from "this rig never had the
join key", and the QB arm quietly runs without it.

**How to apply:** check `SELECT SUM(espn_id IS NULL) FROM players` before
grading anything that reaches the QBR path, and state the result in the
evidence file either way. On a paired A/B where the nudge is off identically
in both arms and QB projections differ by exactly 0, it cannot move the
comparison — say that rather than ignoring it. Any *absolute* QB figure from
such a rig is invalid until the builder populates the column.
