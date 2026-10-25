---
name: gridiron-withdrawn-results-still-burn-data
description: Withdrawing a result does not un-read the data — a season read by ANY analysis of a quantity, including a retracted one, is no longer a clean held-out set for that quantity.
metadata:
  type: feedback
---

Auditor rule registered 2026-09-22 (§R31.4), on the kicker/efficiency K unit.

`EFFICIENCY-K-SPEC.md`'s figure of 115 for yards-per-carry was withdrawn as
in-sample — but the analysis that produced it **had read 2025**. The withdrawal
removes the claim; it does not remove what the analyst saw. So **2025 is no
longer a pristine held-out season for k selection on these quantities**, and a
later "confirmed on 2025" would be weaker than it reads.

**Why:** held-out validity is a property of the ANALYST'S information, not of the
surviving document. Once a season has informed any choice about a quantity —
even a choice later retracted — it can no longer independently confirm a choice
about that quantity. Retraction is a statement about the claim, not about the
information.

**How to apply:** track, per question, which seasons it has burned, and carry
that list with the number. For k selection on `projections.js:97` `yards_per`:
2023 (train), 2024 (held out), 2025 (partially burned by the withdrawn spec).
Before naming a season as held out, ask what has already been run against it for
this quantity, including work that was withdrawn. When every season is burned,
say so rather than reusing one.

Related: [[gridiron-auditor-thread-standing-2026-09-22]],
[[gridiron-k-yards-per-34-stands]], [[gridiron-mae-flat-changes-move-bias]].
