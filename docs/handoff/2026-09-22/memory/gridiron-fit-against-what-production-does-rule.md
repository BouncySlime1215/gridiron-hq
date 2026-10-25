---
name: gridiron-fit-against-what-production-does-rule
description: "Standing gate-1 rule (Auditor R34-R36, 16:38Z): before fitting a constant, state what production does with the quantity read off the applying line, and fit against that — not against a pooled or convenient version of it"
metadata:
  type: feedback
  modified: 2026-09-22T16:40:28.009Z
---
**Rule:** before fitting any constant or prior, state — in the pre-registration,
in writing — exactly what the shipped code does with the quantity at the line
that will apply the fitted value (e.g. pooled vs per-position, weeks-played
vs DNP-inclusive, live vs replay). Then fit against *that*, not against
whichever version of the quantity is easiest to gather data for. An
identified-set method (report the flat range where the metric doesn't move,
not a point estimate) is now **mandatory** whenever a constant is graded
this way.

**Origin:** Auditor R34 found the earlier K.yards_per finding (34→64/70) does
NOT survive once checked this way — 34 sits inside the identified sets ypt
[31,232] / ypc [13,294], and the finding was fit on a **pooled** prior while
production serves a **per-position** one at `projections.js:562`
([[gridiron-k-yards-per-heldout-2026-09-22]]). Same round, R35 accepted the
target-share prior evidence on these terms precisely because it already
stated the production line (`projections.js:578`, weeks-played metric) before
fitting ([[gridiron-target-share-prior-gate1-answers]]).

**How to apply:** any gate-1 submission that fits a constant must open with
"production applies this value at `<file:line>`, as `<pooled | per-X>`,
against `<metric>`" before showing a number. No production-target statement
= auto-redirect, same as a missing evidence/incumbent pair under the existing
submission format.
