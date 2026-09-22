---
name: gridiron-weekly-role-recency-saturation-cap
description: Canonical n-saturation cap under WEEKLY_ROLE_RECENCY is 7.4083-7.8177 at throughWeek 18 (7.2282-7.6985 at throughWeek 17); 7.55-7.89 withdrawn by Auditor unit 15 08:49Z 2026-09-22; not 8.13, not 8.62; always quote with throughWeek.
metadata:
  type: feedback
  modified: 2026-09-22T08:44:00.000Z
---
**CANONICAL (unit 15 08:49Z; 7.55-7.89 withdrawn):** **7.4083-7.8177 at throughWeek 18** (prior floors 43.4-44.7% K.share=6, 56.1-57.4% K.team_volume=10); **7.2282-7.6985 at throughWeek 17** (43.8-45.4% K.share=6). ALWAYS quote with throughWeek. The Auditor withdrew its own 7.55-7.89 as wrong at both ends (bye at week 1 assumed; week-14 bye never considered). Planner's 7.41-7.82 re-derivation (Plan 04, bye 5-14) was the closer one.

Derivation context: [[gridiron-authority-0745-2026-09-22]], evidence in `docs/tdd/shrinkage-crps-gate-and-volume-saturation-2026-09-22.tdd.md` (effk, commit da5738e).

**History of the number, corrected three times:**
1. Auditor's original relay: "~8.13" (rounded within-season limit).
2. Independent re-derivation: within-season infinite limit `Σ 0.5^(j/5) = 1/(1-0.5^(1/5)) = 7.7250` (right), prior-season term `GAMES · seasonDecay/(1-seasonDecay)` with GAMES=17 = 0.895 → total **8.62** (wrong: infinite-week limit is unreachable; `weeksAgo` in `rowWeight` is bounded by `throughWeek − 1`).
3. Auditor unit 8 (08:27Z): realized cap **7.55-7.89** by bye placement — WITHDRAWN unit 15 08:49Z, both ends wrong.
4. Auditor unit 15 (08:49Z): the canonical ranges above, stated per throughWeek.

The qualitative finding is unaffected by any of the four numbers: permanent saturation under WEEKLY_ROLE_RECENCY, ~43-45% / ~56-57% prior floors regardless of career length; only the second decimal of "how permanent" moves.

**Process lesson:** a from-scratch re-derivation that catches a real error (8.13) was itself wrong (8.62), the second check that caught it was itself wrong at both ends (7.55-7.89), and only the third independent pass fixed the bye assumptions. Quote the range with its throughWeek and its ruling id; see [[gridiron-atomic-verify-guard]] for the same rule on suite figures.
