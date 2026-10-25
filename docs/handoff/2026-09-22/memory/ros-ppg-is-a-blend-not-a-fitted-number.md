---
name: ros-ppg-is-a-blend-not-a-fitted-number
description: "ROS moves with the fit" is right, but ros_ppg blends a fitted structural term with a prior that does NOT move; a player with no preseason market value carries a constants-derived term.
metadata:
  type: project
---

Walked on 791b131, independently of the opportunity thread's citation, after the
coordinator asked that the trace not stay one thread's reading.

**Confirmed.** `trade-engine.js:281` builds `weekly` from
`buildPlayerWeekEngine`; `:293` passes it into `buildRosProjections`;
`ros-projection.js:370` iterates `weekly` and `:376` takes
`structural = proj.structural_ppg` straight off it. The `ros?.ros_ppg ??
weeklyPpg` fallback at `trade-engine.js:366` is the same engine, so a player
with no ROS entry moves too. There is no path by which ROS stays wholly on the
old constants.

**What the agreed statement leaves out.** `ros_ppg` is a BLEND — structural,
season-to-date, and a prior — and the prior does not move with the fit.
`rosPriorMap` (`ros-projection.js:331`) calls
`buildProjections({ through: season - 1 })` to build `c_struct`, which is the
season-long path on the old constants. `priorSource` at `:381` takes `c_mkt`
when the player has a preseason market value and `c_struct` otherwise. So a
player with no market prior carries a constants-derived term in his ROS number,
attenuated by the `n/(n+4)` weighting that at week 2 puts most of the weight on
the prior.

So: "ROS moves with the fit" is right. "ROS is on the fitted path" overstates
it, and at an early week it overstates it most.

**Why:** this is the file that misled the opportunity thread in the other
direction — they saw the season-long `buildProjections` call at `:331` and
concluded ROS was NOT fitted. Both readings come from stopping at one call in a
function that has two. Read `rosUpdate`'s three inputs, not one.

**How to apply:** do not label ROS surfaces as either wholly fitted or wholly
constants. Related: [[projection-basis-split-by-recency]].
