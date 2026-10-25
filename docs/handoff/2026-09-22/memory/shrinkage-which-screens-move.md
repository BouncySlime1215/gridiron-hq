---
name: shrinkage-which-screens-move
description: Which Gridiron screens actually move when the volume fit is promoted — ROS and News move, the draft board never showed our number, only the odds keep the old constants.
metadata:
  type: project
  modified: 2026-09-19T21:52:00.000Z
---

**A CALLER LIST IS NOT A SCREEN LIST.** The caller split in
[[shrinkage-promotion-blast-radius]] is correct; the hop from it to "these
SCREENS keep the old numbers" was wrong in two of three parts. Caught by the
UI-rebuild thread 21:50Z 2026-09-19, verified here in source, and Nick was
corrected in-thread. Tracing the function tells you what the code does; only
tracing the screen tells you what the user sees.

**A CALLER LIST IS NOT A SCREEN LIST (corrected 21:50Z by the UI thread).**
The caller split above is right; the hop from it to "these SCREENS keep the old
numbers" was wrong in two of three parts.
- **News MOVES — this was MISSED in the first pass (added 2026-09-20).** `/news`
  is routed (`client/src/App.tsx:135`) and the "Projected fantasy usage" panel is
  `news-fantasy-impact.js:118`, built from `buildPlayerWeekEngine`, which passes
  `WEEKLY_ROLE_RECENCY` (`player-week-engine.js:271-273`) and is therefore on the
  fitted path. Found by the Model evidence audit's grade (PR #68), not by me.
  **The lesson, twice over now: a caller list is not a screen list.**

- **The ROS list MOVES.** `trade-engine.js:281` builds the weekly engine and
  `:294` passes it INTO `buildRosProjections`; `ros-projection.js:370-376` takes
  `structural` straight off it, and the fallback `ros?.ros_ppg ?? weeklyPpg`
  (`trade-engine.js:366`) is the weekly number too. `ros-projection.js:331`'s
  season-long `buildProjections` builds a PRIOR, not the number — that is what
  misled this thread. Magnitude UNMEASURED: `rosUpdate` weights in-season
  evidence `n/(n+4)` against a `c_mkt` preseason prior, so at week 2 the prior
  dominates and the shift is attenuated.
- **The draft board never showed our number.** `draft-assist.js:431-435`: the
  projection is ESPN's; our model enters only as a ratio-normalised RELATIVE
  disagreement, clipped ±0.35, weighted by `MODEL_BLEND_WEIGHT`, normalised by
  `modelScale` (league-wide mean of ours/ESPN). A uniform shift largely cancels
  by construction. Also `modelProjections` (`:80-87`) is a per-process cache,
  never invalidated — it needs a restart regardless.
- **Only playoff/title odds (`season-sim.js`) and Trade Lab's championship
  ranking keep the old constants.** Those are what the UI thread labels.

**State the zero as a prediction, not a measurement.** `activeKVectorFor`
returns null for season-long callers, so `pickK` MUST take the hardcoded branch;
0 of 1,130 is what the code requires, and the measurement only confirms the read.
Stated as a bare number it invites "maybe it is a caching artifact".
