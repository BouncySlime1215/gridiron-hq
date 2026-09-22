---
name: gridiron-denominator-correction-2026-09-22
description: CANONICAL — projections.js in-season denominator is RAW plus prior seasons at 0.35^k; shipped n >= replication's raw count always; rho table by cutoff week; framing to refuse.
metadata:
  type: project
  modified: 2026-09-22T07:50:02.405Z
---

Split from [[gridiron-state-0744-2026-09-22]]. Both earlier versions of this were wrong; this one is canonical.

## THE DENOMINATOR CORRECTION
`projections.js:162` is `RECENCY = { seasonDecay: 0.35, weekHalfLife: null }`. `rowWeight` (:178) returns the season weight alone when weekHalfLife is null; `seasonWeight` (:169-173) is `0.35^(through - s)` = exactly 1.0 for the cutoff season. **The in-season denominator IS RAW, exactly as the comments say.** The comments are INCOMPLETE, not false — they omit that prior seasons are ADDED at 0.35 / 0.1225 / 0.042875. :155-161 explains why there is no within-season decay: every setting made it worse, trailing-3-week loses to season-to-date 4.753 vs 4.509.
- **Shipped n is therefore >= the replication's raw single-season count, ALWAYS** (equality only for a player with no prior seasons). §4 of `7a3b8262` argues the opposite and has the ratio on the wrong side of 1 — its arithmetic is fine, its input is inverted. **Redirect on §4 only, not a reject of the document**; its conclusion (no constant moves until the grader runs on real data) stands and is MORE strongly supported.
- **Ratio rho = 1 + 17·Sum(0.35^k, k=1..H)/(w-1)**, H = prior seasons. wk5: rookie 1.000 / 1 prior 2.487 / 2 priors 3.008 / 3 priors 3.190. wk9: 1.000 / 1.744 / 2.004 / 2.095. wk14: 1.000 / 1.458 / 1.618 / 1.674. **Systematic in cutoff week and career length, NOT noise around a mean — never quote a single ratio.** Weights exact; usage profile behind the table is a model, wants confirming against real `player_week_usage`. Sign is unconditional.
- **FRAMING TO REFUSE:** "shipped k behaves like k/rho so the under-shrink is twice as bad." NO. Shipped `observed` (:565, `a.receptions / a.targets`) pools prior seasons under the same weights. A larger n is CORRECT when observed rests on more data. The sweep compared two different estimators; neither rho nor k transports.

Owner of the §4 rewrite: Model evidence audit (cse_01RaKeP3tXctv8SXVFaMRZdd).
