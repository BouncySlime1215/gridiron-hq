# RL-17-3: title odds on the finder's rest-of-season rate

Unit RL-17-3, BROKEN-NUMBERS row A (Title tab vs trade finder). Branch
`claude/cloud-rl-17-3-0u3dqi`, cut from origin/main `d861c11`.

## 1. Audit: extend or build

- **Two producers of a player's rate.** `season-sim.js#prepareSeason` sampled every
  outcome pool from `buildProjections({ through: SEASON - 1 })` (last season), in both
  the full runs and `tradeImpactWorld` (RL-19-2), and `tradeImpact`'s old path
  (`GRIDIRON_FAST_RESCORE=0`) built the same. The finder prices on `ros_ppg`
  (`trade-engine.js:333`, `ros-projection.js#buildRosProjections`), served on each
  asset of `assetUniverse`. Measured on the synced leagues before this unit (handoff
  WORK-QUEUE RL-17-3): the two orders agree at Spearman 0.796.
- **Extend, not build.** The sim already loads `assetUniverse(lg, formatKey)`, the
  finder's own universe, so each rostered player already carries the finder's
  `ros_ppg`. No second ROS build, no new table, no migration.

## 2. Change

- `prepareSeason` keeps last season's pool shape (volume mix, efficiency, dispersion)
  and scales each player's volume multiplier by `ros_ppg / ppg`. Expected points are
  linear in that multiplier (`projections.js#sampleWeekEvents`: every count is drawn at
  `mean x mult`, yards and TDs per count), so the pool mean per game played moves to
  `ros_ppg`. Game script, matchup multiplier and availability still apply on top.
- One place (`prepareSeason`), so the full runs, `tradeImpactWorld` and the old
  two-run path all read it; the RL-19-2 world's structure is unchanged. The world
  key gains `basis`, so a world built under one basis is never reused under the other.
- Flag `GRIDIRON_RL17_3_ENABLED`: `1` on, `0` off, unset = on only under
  `GRIDIRON_PREVIEW_UNCONFIRMED=1` (preview-mode.js), labelled `preview: true` +
  `preview_reason`. Off: the result is byte-identical to before (no new field).
- On: results carry `projection_basis: 'ros'`, `ros_scaled`, `ros_unscaled` (players
  with a projection but no usable `ros_ppg`/`ppg`, left on last season's rate and
  counted, not hidden).

## 3. RED -> GREEN

`test/rl-17-3-sim-ros-basis.test.js`, RL-19-2's league fixture with each player's
last-season ppg reordered against his `ros_ppg`.

| test | RED (base `d861c11`) | GREEN |
|---|---|---|
| sim per-player means vs finder `ros_ppg`, Spearman >= 0.95 | fail (no ROS basis) | pass: old basis 0.822, ROS basis 0.997, n 20 |
| off by default; preview on + labelled; `0` vetoes preview | fail | pass |
| player without a last-season projection: not simulated, in neither count (known limit, pinned) | fail | pass |
| RL-19-2 fast rescore == two full runs under the ROS basis (2 seeds x 3 deals) | fail | pass |
| a world from the other basis is not reused | fail | pass |

RL-19-2 (`test/rl-19-2-fast-rescore.test.js`) and RL-6-3
(`test/rl-6-3-trade-impact-paired.test.js`) pass unchanged.

## 4. Not confirmed

- The 0.796 -> >= 0.95 figure on the real synced leagues needs a local DB; this cloud
  session has none. Re-run `r17i_two_numbers.mjs` / `r17i_title_surrogate_eval.py`
  locally with `GRIDIRON_RL17_3_ENABLED=1`.
- Linearity is exact for the count/yard/TD draws; a league with yardage bonuses
  (non-linear scoring) would sit slightly off `ros_ppg`.
- A player the finder rates but `buildProjections` never built (no last-season
  params) is still not simulated: there is no pool shape to scale.
