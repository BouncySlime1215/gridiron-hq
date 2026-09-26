---
name: gridiron-trade-price-clamps
description: The three clamps in the Gridiron trade path and which one "±10%" refers to, so nobody re-derives a wrong number from a source cap.
metadata:
  type: project
  modified: 2026-09-20T03:35:00.000Z
---

Read on `origin/main` 791b131 plus tonight's Trade Brain branch, 2026-09-20.
Three clamps at three layers. Quoting the wrong one reads exactly like a
contradiction of the audit, which is how I nearly objected to a correct sentence.

1. **`perceptionFactorFor`, ±10% ON THE DEAL SCORE** —
   `trade-engine.js:1362-1366`, literally
   `1 + Math.max(-0.10, Math.min(0.10, shift / 100))`. **This is the binding
   constraint and the one the audit's "±10%" means.**
2. **`PLAYER_VALUATION_CAP` = 0.20**, per player —
   `counterparty-pricing.js:98`, applied in `playerValuation` as
   `Math.max(1 - cap, Math.min(1 + cap, raw))` on the multiplied factors.
3. **`PERCEPTION_CAP` = 0.15**, on the package-level multiplier —
   `counterparty-pricing.js:28`.

**The easy confusion:** four individual entries in `VALUATION_SOURCES` have
`cap: 0.10`. Those are per-source caps, not a clamp on any result.

**The audit's sentence is exact as "a read, not a price" + "±10% of a deal's
score".** Unqualified "±10%" needs those three words. The measured basis for "a
read, not a price" is [[trade-brain-counterparty-adds-nothing]] (B−A median
0.000 over 30 decided proposals; exactly 0.000 with zero-width interval on the
16 decided by someone other than Nick).
