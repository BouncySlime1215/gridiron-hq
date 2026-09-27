---
name: cascade-multiplier-graded-refused
description: gridiron-hq's shipped cascade multipliers were graded walk-forward on 2026-09-20 (PR #72) and REFUSED in both seasons; the unbounded multiplier it found (x26.38 on a 0.11 base) is FIXED on that PR at a6975b8.
metadata:
  type: project
---

PR #72, branch `claude/project-thread-w45mur-cascade-grade`, commit 767b98f off
main at 791b131. Draft. Coordinator approved the work 01:26Z 2026-09-20.
Nothing shipped changed: `contingency.js` is untouched.

**The result: refused.** `contingency.js:cascades()` publishes, per starter,
each teammate's `base_opportunity` → `opportunity_without` and a `multiplier`.
Graded walk-forward (cascade for season s built `through: s-1`), the published
`opportunity_without` is no better than `base_opportunity` at predicting real
absence weeks, and both 90% player-clustered intervals straddle zero.

| | 2024 | 2025 |
|---|---|---|
| graded rows (distinct players) | 49 (14) | 77 (21) |
| `base_opportunity` MAE / bias | 5.771 / −1.919 | 5.024 / −3.692 |
| `opportunity_without` MAE / bias | 6.781 / +2.444 | 5.123 / +3.303 |
| 90% interval (without − with) | [−1.099, +3.141] | [−1.231, +1.207] |

**The informative part is the bias split:** with reads LOW on an absence week,
without reads HIGH, in both seasons. The published pair brackets the truth — the
direction is right (agrees with the vacated-share coefficients in
`docs/OPPORTUNITY-FINDINGS-2026-09-19.md`) and the published size is too large.

**n is small — 49 and 77 rows over 14 and 21 players.** Do not quote this as
proof the multiplier is worthless. It establishes that no evidence for it ever
existed, that the first look finds none, and that it reads high.

**DEFECT FOUND AND FIXED (a6975b8, RED at ed96531):** `cascades()` published an
unbounded multiplier — Jordan Whittington behind Puka Nacua **×26.38 on a 0.11
base**, a with-starter sample holding about one observed target. Mechanism:
`shrink(boosted/base, 1, without.n, 4)` is handed the number of games the starter
MISSED, never the divisor's sample size, and the pair is skipped only when BOTH
sides are under 0.5.

**A CAP WOULD HAVE BEEN WRONG** — Joe Flacco behind Joe Burrow is ×7.49 off
eleven observed attempts and that is true of a backup QB. The cases differ in how
much the divisor was estimated from, not in the size of the result.

Fix: `multiplier: null` when the with-starter side carries fewer than 9 observed
opportunities (a mean from k events has relative SE ≈ 1/√k; 9 is where that hits
one third), plus a published `denominator_opportunities`. `gain`,
`base_opportunity`, `opportunity_without` untouched. Not a clean line: Mac Jones
behind Brock Purdy is withheld at 8, one short. Withholds 15 of 203 in each of
2024 and 2025 (7.4%); largest surviving ratio ×26.38→×4.37 and ×10.57→×7.49.
No numeric consumer reads the field, so nothing moved — `handcuffValue` computes
`expected_points` from `gain`, Model.tsx reads only `starter`/`starter_miss_rate`,
draft-assist reads neither.

After the fix the grade still refuses: Test A unchanged by construction, Test B
2025 −68.32% → −46.72%. The remaining gap is the double-counting, not outliers.

**LIMIT worth knowing:** `cascades()` bounds each starter's window to his first
and last appearance, so a SEASON-ENDING absence contributes nothing — no later
appearance closes the window. Fixtures must put absences mid-season.

**A trap worth keeping:** applying the multiplier on top of a player's own
recent usage double-counts, because a backup who has already taken over has
recent usage that already reflects the absence. 37 of 77 graded 2025 rows are
QBs, exactly that population. Test B in the script measures that use error
mixed with the estimator and must not be read as a verdict on the estimator.

New files: `server/services/cascade-grade.js`,
`scripts/grade-cascade-multipliers.mjs`, two tests,
`docs/tdd/cascade-grade.tdd.md` (three mutations recorded failing).

See [[cascades-ungraded-vs-opportunity-graded]], [[opportunity-stage-findings]].
