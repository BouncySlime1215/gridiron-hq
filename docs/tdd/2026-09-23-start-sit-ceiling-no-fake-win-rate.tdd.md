# "Chase the ceiling" stops printing a win rate it never measured (RL-3-4, C-18 / S-08)

Unit RL-3-4. Tree: branched from origin/main `89f69b3b`. Not a statistical unit: it removes a number and a label; it
adds no model number, so no pre-registration and no 2025 held-out look (no `HOLDOUT-LEDGER.md` row).

## 1. Audit (written before the first test): extend, not build

What exists on origin/main `89f69b3b`:

- `server/services/lineup-brain.js:576` `margin = p[key] - alt[key]`, where `key` is the objective actually solved on
  (`:470-496`). Under "Chase the ceiling" `key = 'ceiling'`, the player's weekly p90 (`trade-engine.js` asset
  `ceiling`), so `margin` is a gap between two p90s.
- `:578-582` labels that p90 gap Clear / Lean / Coin flip with `CLEAR_THRESHOLD` / `TIE_THRESHOLD` (`:328,339`),
  thresholds measured on week_points margins.
- `:585` `winRate = decisionWinRate(margin)`: the curve at `:268-302` whose source is
  `docs/evidence/2026-09-22/start-sit-decision-curve.md`, measured on mean-projection gaps.
- `:630-636` the `why` sentence prints "At a gap this size the higher projection has won about X% of the time"
  (or, for a gap under 1.5, "below 1.5 points the higher projection has won 53% of the time").
- `:674-675` the server already tags the response `confidence_basis: 'uncalibrated_for_<objective>'`.
- Reader check: `git grep -n "confidence_basis\|uncalibrated_for" -- client/src` returns nothing (control: the same
  grep over `server` returns `lineup-brain.js:674`). The page renders `c.why` verbatim (`Lineup.tsx:307`) and the chip
  from `c.confidence` (`Lineup.tsx:271`). So the tag exists and nobody reads it.
- One producer: `git grep -n "won about\|decisionWinRate" -- server client/src` returns only `lineup-brain.js:302`
  (definition), `:585` and `:635`. No second producer of this win rate or wording.
- Tests: `git grep -ln "objective: 'ceiling'\|objective: 'floor'" -- test` returns `test/eval-lineup-objectives.test.js`
  and `test/lineup-floor-objective.test.js`; neither asserts on `confidence_win_rate`, the label or the `why` text
  under a non-mean objective.

Decision: extend `lineupCall` (`:578-641` only; RL-4-2 owns `:446,481`) and `Lineup.tsx`. The R3 package's larger fix
(one "maximise my chance to win" solve on `lineup-posture.js`) and the hero "sum of good-week ceilings" are not in this
unit; see Known defects.
