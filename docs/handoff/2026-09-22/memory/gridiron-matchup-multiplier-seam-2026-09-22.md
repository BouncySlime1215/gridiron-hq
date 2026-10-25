---
name: gridiron-matchup-multiplier-seam-2026-09-22
description: "The fantasy weekly projection has a fully wired opponent-matchup multiplier that returns exactly 1, with a published baseline and four already-failed arms — the one place a fantasy feature can be tested end to end (2026-09-22)"
metadata:
  type: project
---

Found while clearing Auditor R56's BLOCKING 1 (scope). Verified on
`claude/project-thread-2oztzw` at `4a8085c`.

## The seam

`matchups.js:365`:

```js
export function gameMultiplier(opponent, home, position) {
  return dvpFor(opponent, position).mult * homeFieldFactor(home);
}
```

`DVP_MULTIPLIER_ENABLED = false` (`:66`), `HOME_FIELD_MULTIPLIER_ENABLED = false`
(`:67`). **Every multiplier is exactly 1.** Two other services say so
independently in their own comments: `trade-engine.js:356-359` and
`season-sim.js:218-220`.

## Why it matters

It is **wired and fantasy-scoped**, unlike `nfl_team_week_features`, whose only
predictive reader is the betting game model (Auditor R56) — so a feature routed
there is NOT built under Nick's scope rule.

Call-reach, hop by hop, no scheduler:
`routes/trades.js:19` → `matchups.js` → `trade-engine.js:60` (`thisGame.mult` at
`:359`, passed at `:399`/`:408`) → `player-week-engine.js:802 sampleWeeks(...,
mult)` → `projections.js:945` → `:825 sampleWeekEvents`, where `mPass`/`mRush`
scale attempts, carries and targets. Also `routes/nfldata.js:3` →
`scheduleOutlook()` → `games[].mult` (`:414-419`), and `season-sim.js:24` →
`:227`. `ceiling-lineup.js:34` is UI's file.

## The incumbent is already published

`MATCHUP_EVIDENCE` (`matchups.js:76`): 2025 baseline MAE **4.333**, Spearman
**0.6789**, DNP MAE 4.730, CRPS 3.107. Method: `weekly-backtest
replaySeasonWeekly`, weeks 5-18, fit 2023+2024, validate 2025 once, paired
bootstrap clustered by player, 90% CI.

**Four arms already tested and all failed** — home/away live 0.02, home fitted
0.0425, home fitted per position, DvP K=200 recency 0.5. All four point
estimates are slightly WORSE than no adjustment. DvP's stated reason:
first-half→second-half r = **+0.027**, so the thing barely persists.

## The untested arm

All four failures are **outcome** aggregates. Charting rates (blitz rate, rushers
sent) are **behavioural**. Whether they persist better is the open question —
and it is answerable on the feature alone, before any outcome is touched, which
is a cheaper falsification than the full backtest.

Related: [[gridiron-070-vs-059-serving-gap-2026-09-22]],
[[gridiron-feed-zero-class-closed-2026-09-22]].
