# PLAYOFF-SEEDING (plan items 47 + 48): TDD record

<!-- prereg: docs/tdd/PLAYOFF-SEEDING-PREREG.md -->

Pre-registration: `docs/tdd/PLAYOFF-SEEDING-PREREG.md`, committed with the tests in the
RED commit, before any implementation was committed.

## RED

`test/playoff-seeding.test.js` against the tree without `server/services/playoff-path.js`:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/playoff-path.js'
not ok 1 - test/playoff-seeding.test.js
# tests 1  # pass 0  # fail 1
```

## GREEN

- `server/services/playoff-path.js`: the flag and the per-run collector (seed values by
  counterfactual bracket, win-target table, must-win leverage by forced win / forced loss).
- `server/services/season-sim.js#playSeasons`: an opt-in `{ playoffPath }` option feeds each
  run's week results, final records, field, champion and bracket scorer to the collector.
  Only `tradeImpactWorld`'s base season turns it on (when the flag is on); a deal's rescore
  never does. `simulateSeason` takes `playoffPath` for scripts and tests (default false).
- `server/services/campaign/planner.js`: `playoff_path` = Nick's block from the world base.
- `server/services/campaign/view.js`: written to `plans.json _run.inputs.playoff_path`.

`node --test test/playoff-seeding.test.js`: 10 pass, 0 fail.

## Bar (pre-registered B1-B5), measured on the made-up 10-team league

| bar | result |
|---|---|
| B1 exactness (equal teams, 4,000 runs) | pass: every team's title at seeds 1-2 within 3 SE of 1/4 and at seeds 3-6 within 3 SE of 1/8; bye value within 3 SE of 1/8; finish probabilities sum to P(playoffs) per team and to 1 per seed |
| B2 monotone | pass: 0 runs in which a forced win lowered playoff odds (all teams; playoff membership does not depend on the bracket) |
| B3 identity | pass (fixed and re-seeded bracket): 0 runs in which the replay at the actual seed disagreed with the served champion |
| B4 precision (1,200 runs) | pass: every playoff-level SE <= 0.015 (a binomial SE at 1,200 runs is at most 0.0144) |
| B5 off is off | pass: without the option the output is deep-equal to before, with no `playoff_path` |

Example block (team 1, +4 points a week over nine even teams, 1,200 runs, made-up):
playoff odds 0.766 (SE 0.012); title if seed 1 0.303 (0.013), seed 6 0.180 (0.011); a bye
is worth +0.125 title (0.010); 7 wins reach 50% playoffs (0.879, n 239); leverage per week
0.13-0.15 (SE 0.010). Cost: ~0.7 s for 1,200 runs x 10 teams on top of the sim.

These prove the arithmetic only. Calibration of the playoff odds themselves is SIM
CALIBRATION MONITOR's (#466); the league-4 run is under "Needs local measurement":

`SCHEDULER_DISABLED=1 GRIDIRON_PLAYOFF_SEEDING=shadow node scripts/campaign/produce-plans.mjs --leagues 4`
