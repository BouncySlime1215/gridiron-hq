# E-XGB phase 1 — frozen pre-kickoff ESPN weekly projections

Branch `claude/local-exgb-phase1`.

## Why

Any claim that a model beats ESPN's weekly projection needs ESPN numbers that provably
existed before kickoff (evidence note M3; the Princeton thesis fetched ESPN after the
fact). Before this change the database held one such capture (week 2, 614 rows); weeks
1-3 in `league_roster_snapshots` were first seen 2026-09-22, after the games. Every week
not captured is lost.

## RED

`test/espn-weekly-projection-capture.test.js` plus migration 106, committed before the
service existed: the suite failed with `ERR_MODULE_NOT_FOUND` for
`server/services/espn-weekly-projection-capture.js`.

## GREEN

- `server/services/espn-weekly-projection-capture.js`: kona_player_info read per scoring
  config (ESPN PPR defaults, public; each ESPN league's own scoring with its own cookies,
  as `espn-market.js` does), parse of statSourceId 1 for the week, append-only insert,
  `late` leakage guard, capture windows, `frozenEspnForGrading`.
- Scheduler job `espn_weekly_projection_capture` (live tier, off-thread, 15-minute
  maxAge) and its entry in `scripts/refresh-live-data.mjs`'s `FANTASY_LIVE_JOBS`.
- `scripts/capture-espn-weekly-projections.mjs` for a manual or out-of-loop capture.

The 9 tests cover: projection vs actual stat selection; the late boundary (captured at
kickoff is late); the Tue / Sat / 2 h-before-each-kickoff windows; late flags for a game
already played; no cookie value in any stored row; UPDATE and DELETE refused; the graded
value is the latest pre-kickoff capture; one capture per window; a 503 recorded as an
error capture; the job's registration.

## Real run

On a clone of `snapshots/data-ro.sqlite` first, then on the live database
(2026-09-25 15:01:59Z, `--leagues 4`): week 4, 552 players with a projection per
scoring config, 1,104 rows, 0 late. Week 3 the same minute: 1,104 rows, 62 late (31 per
config: the Thursday game had kicked off), which the grading query excludes.
