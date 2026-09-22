---
name: gridiron-four-ceilings-name-which-one
description: Four different quantities are called "the ceiling" in Gridiron HQ — every share states which one it divides by and of which kind, because a volume feature and a share feature need different denominators.
metadata:
  type: project
---

Auditor ruling R14, 2026-09-22, applied across the Explorer's spec files the
same day. A bare "X% of the ceiling" is unreadable here, because four unrelated
quantities carry the name.

| ceiling | value | units | kind |
|---|---|---|---|
| weekly model headroom | bracket [+0.0895, +0.5940], est. +0.4258 | fantasy points | **model** ceiling — bounds what a better projection can do |
| #13 targets | **0.440452** | targets/player-week | **opportunity-forecasting at fixed share** |
| #14 carries | **0.626455** | carries/player-week | **opportunity-forecasting at fixed share** |
| participation | `ONFIELD-SPEC.md` §3 | snaps | perfect-participation ceiling |

**The distinction that R14 turns on.** 0.440452 and 0.626455 are what a
**perfect snap forecast** buys with the player's on-field *share* held at its
realised value. They are **not model ceilings**: they do not bound what a
better projection could achieve, only what better *volume* forecasting could.
So they are the right denominator for a **volume-side** feature (snaps, injury
availability, depth rank) and the **wrong** one for anything that moves
**share** — a share-side feature graded against them is graded against a
ceiling it cannot spend.

**Canonical shares, after the predA level channel is priced out:** #13
targets **14.55%** information (21.013% total), #14 carries **7.58%**
information (11.226% total). The Auditor's earlier 0.4410 / 0.6277 were
inversions of rounded shares and are superseded by the six-decimal gaps above.

**How to apply.** Write the kind into the sentence, not into a footnote:
"14.55% of the opportunity-forecasting ceiling at fixed share". Never carry a
share from one denominator to another. And never compare the R&D rig's 4.757
with the shipped harness's 4.8062 — different harness and population; see
[[ceiling-headroom-mae-derivation]].

Related: [[ceiling-headroom-mae-derivation]], [[a-benchmark-is-not-a-ceiling]],
[[gridiron-preda-level-confound]],
[[a-recovery-fraction-needs-both-denominators]].
