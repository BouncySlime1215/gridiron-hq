---
name: gridiron-feed-zero-class-closed-2026-09-22
description: "Feed-zero sweep verdicts per site (2026-09-22): which share consumers are live, which are dead columns, and the three-support mismatch at projections.js:492"
metadata:
  type: project
  modified: 2026-09-22T16:53:26.289Z
---

Planner, 2026-09-22 ~16:50Z. Evidence:
`docs/evidence/feed-zero-contamination-measured.md` §5-§9 on branch
`claude/project-thread-2oztzw` (PR #92), two reproducible scripts beside it.
Pricing lives in [[gridiron-feed-zero-projections-pricing-2026-09-22]].

**The rule this class produced: a defect is not live until the value reaches
something.** Two of the three sites routed as one unit needed no work, and the
routed one was a dead column.

## Verdicts

- **`football-context.js:93` — DEAD COLUMN.** `AVG(target_share)` selected and
  never read (`target_share` appears once in the file). The number shown is
  `usage_share` at `:131`, computed at `:125` from `SUM(targets)` /
  `SUM(carries)` — raw sums, which literal zeros cannot move. The earlier "up to
  46% of the displayed value" pricing is **WITHDRAWN**.
- **`nfl_player_week_features` — CLEAN BY CONSTRUCTION.** `nfl-pbp.js:115` is
  `div = (a,b) => (b > 0 ? a/b : null)`. All 21,427 rows have both shares
  measured, 0 coerced nulls, all 4,104 `wopr = 0` are true zeros. So
  `nfl-player-value.js:110,116` and `nfl-roster-strength.js:213` need **no fix**
  for this class, ever.
- **`projections.js:492` — THE LIVE ONE, fantasy-side.** `history()` at
  `:294-300` selects `u.*` from `player_week_usage` with no snap filter, so
  zero-snap weeks enter the role-weighted mean; `:522` makes `tgtShareObs`,
  served as `volume.target_share` at `:723`, read by
  `news-fantasy-impact.js:121` and `trade-engine.js:411`. **Owner: Model
  evidence audit** (moved 16:11Z; [[gridiron-file-allocation]] may still say
  Fantasy plan).
- **`offseason-data.js:787-789` — real but LEAVE on scope.** Reaches stored
  features (`:1086-1089`, schema `mlb-model-misc.js:459`,
  `offseason-model.js:1256`). Offseason product is never-build scope.
- **`nfl-pbp.js:650` — LATENT, fires on no row.** Coerces a null share to 0 in
  the wopr sum. Recorded so nobody re-derives it.

## THREE SUPPORTS — the finding that outlives the pricing

`projections.js:492` (the observation) gates on `!= null`. `projections.js:395`
(the positional prior) and `shrinkage-fit.js:330` (the k fit) both gate `> 0`.
**The observation, the prior it is shrunk toward, and the k controlling the
shrink are fit on different row sets.** A defect whichever support is correct,
independent of any view about zeros. Auditor R39 folded it into Model evidence
audit's coupled grade with a pre-registered **exclude-zeros** default. **Do not
change `:492` alone.**

## Treatment, never blanket

For `target_share` the correct treatment is a **sibling snap gate, not
NULLIF**: ~80% of the zeros are a player who was on the field and drew no
target, a real measurement. Control is empty where it matters — 0 of 4,176
(2023) and 0 of 4,043 (2024) positive-share rows have `offense_snaps = 0`.
