# CAL-MON: sim calibration monitor (batch D item 29)

Item 29: "weekly reliability of matchup win prob and title odds vs outcomes (Brier
decomposition, drift alarm) in Settings -> Health."

## Cause (origin/main c83033ca, read from the code)

1. **Matchup win probability is never logged.** Its one producer is
   `lineup-posture.js#lineupPosture` (`win_probability`), served on
   `GET /api/trades/:id/posture`. `serve-log.js` has no surface for it, so there is
   nothing to grade it against.
2. **Title odds are graded once, at week 7.** `eval/e3.js` E3-live picks one snapshot
   per team-season. Nothing reports reliability week by week, and nothing watches for
   drift.

## Change (flag `GRIDIRON_CAL_MONITOR`, '1' on, anything else off; not on under preview)

- `serve-log.js`: a `matchup_win` surface (entity `matchup:<week>:<roster>|<opponent>`,
  fields `win_prob` 0-1 and `edge`). The weekly snapshot logs every matchup, once per
  pair, from the same producer, only while the flag is on.
- `eval/calibration-monitor.js`: one grader, two shadow rows. `CAL-MATCHUP` grades the
  logged weekly win probability against `league_week_scores`. `CAL-TITLE` grades every
  weekly title-odds snapshot (`title_odds_snapshots`) once the season has ended. Each
  row carries a Murphy Brier decomposition, a per-week table and a drift alarm.
- The rows are `shadow_only`: `brain-rule.js` never lowers the risk mode on them and
  `brain-gate.js` keeps them out of the War Room. With the flag off the grader emits
  no rows.

## Pre-registered bar

- Matchup passes: n >= 100, Brier gain vs a coin flip with a league-week cluster
  bootstrap 95% CI above 0, slope 0.8-1.2, and no drift alarm.
- Matchup fails: a drift alarm, a gain CI wholly below 0, or a slope CI wholly outside
  0.8-1.2.
- Drift: a two-sided CUSUM on the weekly Spiegelhalter z, over weeks with >= 5 graded
  matchups, with k 0.5 and h 5.
- Title passes: >= 40 team-seasons, a playoff-odds gain vs the league's playoff share
  with CI above 0, and no snapshot week with |z| > 3.
- Title fails: any snapshot week with |z| > 3, or a gain CI wholly below 0.

## RED (commit 57c37962)

`test/eval-calibration-monitor.test.js`: ERR_MODULE_NOT_FOUND
`server/services/eval/calibration-monitor.js` (14 tests, 0 run).

## GREEN

The same file passes 14 of 14. Seeded simulation (25 matchups a week, 17 weeks,
200 seasons):

| case | result |
|---|---|
| honest model: false drift alarms | 2 of 200 seasons (1%) |
| honest model: row passes | 184 of 200 |
| +0.15 over-confidence from week 8: detected | 200 of 200, median 2 weeks after onset |
