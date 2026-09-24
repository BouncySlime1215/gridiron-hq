# PROJ-04-a: Monday Autopsy

Unit PROJ-04-a (ENGINE-SPECS.md, `## PROJ-04: Monday Autopsy`, handoff package
`claude/handoff-package-2026-09-22`). Branch `claude/cloud-proj-04a-n401q7`, cut from main `12a6de9`.

## 1. What was built

- `server/services/autopsy-links.js` (pure): per player-week, the miss (actual - served projection)
  split by sequential substitution through the chain state, in a fixed order: script (pass rate at
  projected plays), volume (team plays, target rate), share, exit, efficiency, td. Three closing
  links make the identity exact: `news_missed` (the share link, moved there when a verified
  role/availability signal was published after our snapshot and before kickoff), `blend` (chain
  projection minus served projection), `other` (actual minus chain actual: fumbles, two-point tries).
  `IS_LUCK`: script, volume, exit, efficiency, td, other = 1; share, news_missed, blend = 0.
  Start/sit calls: each starter vs the highest-projected benched player at his position; decision =
  started the higher projection; on a reversal, `luck_share` = luck-link difference / reversal,
  >= 0.5 reads "right call, unlucky", else "model miss".
- `server/services/monday-autopsy.js`: loader, store, `runMondayAutopsy`, `storedAutopsy`,
  `refreshMondayAutopsy` (scheduler entry). Projected chain from PROJ-02-a `links`
  (`buildProjections({ through: season, throughWeek: week - 1 })`, #221) when present, else the
  player's and his team's prior weeks this season, else basis `none` (whole miss in `blend`).
- `server/migrations/082_projection_autopsy.js`: `projection_autopsy` (one row per
  league-season-week-player-link), `projection_autopsy_player`, `projection_autopsy_week`. Additive.
- `server/services/scheduler.js`: job `monday_autopsy` (daily, growth tier, off thread); writes the
  latest week with box scores once, never recomputes a stored week.
- `server/services/week-postmortem.js`: `link_split` field reads the stored autopsy (null until run).

## 2. RED / GREEN

- **RED** `d0997e4` "test: RED for PROJ-04-a Monday Autopsy link split, luck class, example line and
  job store". Run on a tree without the implementation: `pass 0, fail 1`,
  `ERR_MODULE_NOT_FOUND: Cannot find module '.../server/services/autopsy-links.js'`. The RED is the
  module's absence, not an assertion; the assertions were first exercised by GREEN.
- **GREEN** (next commit): `node --test test/proj-04a-monday-autopsy.test.js` -> `pass 8, fail 0`.
  1. identity to 1e-9 on five box-score shapes x three projections, plus the no-basis row;
  2. TD-only miss: td link = whole miss, luck share = 1, knowable = 0;
  3. fixture line `Missed X by 11: 6 from targets, 5 TD luck` (share -6, td -5 exactly);
  4. job: 2 players x 9 links = 18 rows, each player's rows sum to his miss, call graded
     "right call, unlucky" (luck share 11/13), Vegas detail `{spread -3, final_margin -7, vegas_off -10}`,
     news-missed detail, re-run replaces rather than duplicates; a thrown links builder is stored as
     `links_error` and printed in the summary.

## 3. Limits

- Exit is a snap-share read (< 50% of his prior-3-week average, prior >= 40%); no injury confirmation
  (the final roster snapshots carry no injury_status, per the RL-11-1 audit). PROJ-03-b owns a real one.
- Script is the pass/run mix shift at projected plays; the Vegas miss is recorded beside it, not
  regressed onto it.
- Rows use PPR (scoring.js) like the ledger, not each league's scoringItems.
- No route or My team card yet; `weekPostmortem` is the only reader.
