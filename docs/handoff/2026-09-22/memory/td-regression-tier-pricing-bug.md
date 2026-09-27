---
name: td-regression-tier-pricing-bug
description: Real bug, found by R&D on existing PBP (no new data) — td-regression.js prices its middle red-zone TD tier at one flat rate that actually hides up to an 11.6x range. Fix spec pending "R&D integration & cleanup"'s ownership gate.
metadata:
  type: project
  modified: 2026-09-22T04:27:01.274Z
---

2026-09-22 ~04:24Z, R&D thread, no new data needed (existing play-by-play,
already ingested).

td-regression.js prices its middle TD tier — "red-zone carries that aren't
goal-line" — at one flat rate, 6.6%. Four seasons of PBP show two very
different sub-rates it's flattening together:

- Rushes: non-goal-to-go inside-the-10 scores 16.4% vs 11-to-20-yard-line
  4.5% (3.6x apart), priced identically.
- Targets: 28.8% vs 13.5% (same tier, same flattening).
- Unconditionally, a rush from inside the 2 scores 53.3% vs 4.6% from the
  15 — an 11.6x range collapsed into one counter at nfl-pbp.js:248.

**Fix spec:** add inside-10 counters beside the existing ones, refit
league rates from history. Not yet applied — spec is with the "R&D
integration & cleanup" thread, pending its normal ownership/build gate for
td-regression.js and nfl-pbp.js.

Sibling finding to [[fourth-down-rate-unit-mismatch]]: same danger class,
a flattened/mixed rate in nfl-pbp.js feeding a downstream model as if it
were one clean quantity.

Related reclassification from the same evidence run:
[[red-zone-reclassified-to-luck]].
