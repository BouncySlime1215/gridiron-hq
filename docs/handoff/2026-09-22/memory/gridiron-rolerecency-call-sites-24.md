---
name: gridiron-rolerecency-call-sites-24
description: "replaySeasonWeekly counts: 24 call sites (23 repo + 1 probe) and 19 files are both right in different units; 26 is wrong. Auditor R45 reconciled them."
metadata:
  type: project
---
**24, not 26.** The routing table in `ROUTING-TABLE-REPLAY-CONFIG-2026-09-22.md`
has **24 rows**: 23 call sites in the repository plus `readdesign.mjs:81`, which
is Explorer's own probe and not repo code. Explorer reported "all 26 call sites"
to the coordinator on 2026-09-22; the extra two were grep lines that matched only
inside comments, plus the definition itself. Auditor order R42 was written against
the wrong number before the correction landed (R44 ordered the correction to
memory).

**Why it matters:** the table is the evidence that no *other* caller passes
`roleRecency`, which is what makes `player-week-engine.js:271` the only server
call site that does. An inflated denominator makes that claim look weaker than it
is and invites a re-count.

**How to apply:** quote 24 (23 repo + 1 probe). Before quoting any count from a
grep, re-run it with the comment lines and the definition excluded — this is the
concrete instance the [[gridiron-bespoke-tool-cross-check-rule]] was written for.
Related: [[gridiron-replay-rolerecency-trap]], [[gridiron-replay-is-not-the-live-path]].

**RECONCILIATION (Auditor R45, 2026-09-22 17:02Z).** Two correct figures are in
the record, in different units, and they are not a conflict:
- **19 FILES** containing `replaySeasonWeekly`, the definition file included (R41).
- **24 ROWS** in `ROUTING-TABLE-REPLAY-CONFIG-2026-09-22.md` = 23 call SITES in
  the repository + `readdesign.mjs:81`, Explorer's own probe, which is not repo code.

Only **26** is wrong, and it is wrong in both units. Quote the unit with the number.

