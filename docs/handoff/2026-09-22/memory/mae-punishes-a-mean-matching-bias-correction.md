---
name: mae-punishes-a-mean-matching-bias-correction
description: Standing rule — a multiplicative bias correction fitted to match means degrades MAE when the target is spiky at zero, because MAE rewards the conditional median, not the mean.
metadata:
  type: feedback
---

Adopted as a standing rule by the coordinator, 2026-09-22, after package #15.

**The rule:** a multiplicative bias correction fitted so that predicted means
match observed means will *degrade* an MAE score when the target distribution
is spiky at zero. MAE rewards the conditional **median**; matching the mean
moves the prediction away from it. Anyone tempted to "fix the bias" in a build
needs this before they start.

**Why it is in memory rather than a comment:** it produced a false positive
that survived a significance test. Package #15's first run reported
"game script makes it WORSE, +0.0414 [+0.0157, +0.0763], significant" — a
clean-looking, interval-excludes-zero result. It was wrong. The injury
multiplier scales ~88% of rows down by ~0.88, and the spread-bucket fit was
quietly correcting that level back up. The bucket label said "game script";
the number was recalibration.

**How to apply — two habits, both cheap:**

1. **Report every fitted multiplier relative to the overall ratio**, not raw.
   Divide each bucket's ratio by the pooled ratio. If the relative values are
   flat and unordered, the dimension is null however good the delta looks.
   ```js
   const raw = acc.map(a => a.den > 0 ? a.num / a.den : 1);
   const overall = acc.reduce((a,b)=>a+b.num,0) / acc.reduce((a,b)=>a+b.den,0);
   const rel = raw.map(v => v / overall);
   ```
2. **Read the parameters before the verdict.** #15's six bucket ratios all sat
   near 1.18, inside 0.07 of each other, non-monotone. That was visible in the
   fit and invisible in the p-value.

A significant delta on a feature whose own fitted parameters are flat and
unordered is a recalibration wearing that feature's name.

Related: [[gridiron-game-script-does-not-forecast-snaps]],
[[gridiron-conditional-calibration-2026-09-22]],
[[gridiron-depth-rank-rejected-2026-09-22]],
[[stale-calibration-not-stale-numbers]].
