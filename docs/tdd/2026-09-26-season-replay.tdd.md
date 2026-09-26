# SEASON-REPLAY (plan item 30): E4 retro on Nick's leagues, as of each past week

Plan item 30 (batch D): "an as-of replay of past weeks for all 5 leagues to grade the planner
(E4 retro), bitemporal-safe (research E6)."

What exists: E4 (`scripts/eval/e4-planner-replay.mjs`) grades the planner on Sleeper history
at one decision week (7); E4-live (`planner_move_outcomes`) captures what was served going
forward. Neither replays Nick's own 2026 leagues at each past week. This unit does, with the
same arms, simulator, realized-outcome rule and grader (`e4-planner.js#summarize/#verdict`),
and adds the as-of read. Nothing served reads it; `GRIDIRON_SEASON_REPLAY=1` is required to run it.

## Pre-registration (written before any league data is read; the cloud thread has none)

- Sample: every ESPN league in `leagues` for 2026 that `simRulesProblem` passes, with one-week
  playoff rounds, 4/6/8 playoff teams, no median game and no division-winner seeding; Nick's
  team; decision weeks 2 .. regular-season end whose period W-1 is final. Others are listed
  as skipped with the reason.
- Metric: realized title gain vs doing nothing (expected over accept/decline, E4's assumed
  curve), once every period of the season is final. Interim co-report, never a verdict:
  realized starter points per week over played weeks after W.
- Pass bar: planner minus the best baseline, league-clustered bootstrap 95% CI > 0, and at
  least 5 complete leagues. Upper bound < 0 fails. Else not_enough_data.
- Expected outcome, said up front: five clusters and 0/1 titles -> most likely not_enough_data
  for 2026. The harness's own bar (below) is what this PR proves.

## Harness bar (proved by test/season-replay.test.js, fixture only)

| id | claim | test |
|---|---|---|
| B1 | no read of week >= W: tampering with every week >= W row leaves rosters, values and every arm at W identical | LEAK |
| B2 | no arm offers 160 / 80 / 277 or takes 290; a planner that tries is caught by the audit, not hidden | RULES, real planner |
| B3 | a row written after the week's cutoff marks the week reconstructed; `--strict` drops it; no cutoff is never "captured" | provenance, --strict |
| B4 | the title is not graded until the season is complete; < 5 leagues is not_enough_data | in-season, complete season |
| B5 | same inputs, byte-identical rows | determinism |
| B6 | the E4 refactor changes nothing at its defaults | test/eval-e4-planner.test.js 16/16 |

## RED

Commit `c9c507a8`: `test/season-replay.test.js` without the script ->
`ERR_MODULE_NOT_FOUND: .../scripts/eval/season-replay.mjs`.

## GREEN

`scripts/eval/season-replay.mjs`; 15/15 in the file. Full-suite numbers are in the PR body.

## Not confirmed here

- Real league numbers (needs the Mac: see the PR's "Needs local measurement").
- Nick's blue-chip-gets and overpay rules are the planner's own in-search filters; the replay
  adapter has no as-of blue-chip board, so only the pinned id rules are audited.
- Waiver adds between the last game of W-1 and W's kickoff are not seen (rosters are W-1's
  boxscore lineups).
- A league with a fixed (non-reseeded) bracket is played reseeded, and flagged per league.
