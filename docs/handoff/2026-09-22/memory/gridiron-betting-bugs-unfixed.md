---
name: gridiron-betting-bugs-unfixed
description: Two real betting-side bugs found on 2026-09-19 and deliberately left unfixed after Nick deprioritised the betting board — recorded so the diagnosis is not lost.
metadata:
  type: project
  modified: 2026-09-19T16:30:00.000Z
---

Both were diagnosed against the live app on 2026-09-19. Nick then said the
fantasy platform is the only priority and the betting board is explicitly not
wanted, so **no fix was written and no pull request was opened.** Keep it that
way unless he reopens it. The diagnosis is recorded here so nobody has to
redo it.

## 1. 2026 scores can never land, so the betting board cannot build

`syncCurrentLines` in `server/services/gamescript.js` has two write paths. The
INSERT-with-upsert path (`stmt`, around line 134) runs only when ESPN still
publishes an odds object for the game. The finals path (`finalStmt`, around
line 155) is **UPDATE-only**, keyed on `(season, week, team)`.

ESPN removes the odds object once a game is final. So any game that was
already final before this install's first line sync never got a row from the
INSERT path, and the UPDATE then matches nothing and writes nothing. On Fly
that is every game of 2026 weeks 1 and 2.

It reports success while doing this: the loop does `finals += 2` next to the
two `finalStmt.run(...)` calls without checking `.changes`, so the job returns
`finals_scored: 34` while `game_lines.team_score` stays null. Observable end
to end: `POST /api/nfl-betting/lines/sync-now` returns
`{"updated":508,"finals_scored":34}`, `/api/nfl-betting/evidence/coverage`
still reports `completed_games: 0`, and
`/api/nfl-betting/board/explained?season=2026&week=2` returns 409 "only 0
completed games with scores".

The smallest correct fix is to make the finals path able to create a row
(INSERT ... ON CONFLICT DO UPDATE on the score columns) and to count
`.changes` rather than attempts. The data-side repair already exists —
`syncHistoricalLines` INSERTs from nflverse `games.csv` including results —
but it is reachable only inside `POST /api/model/sync`.

## 2. `nfl_prop_calibration` throws on every run

`POST /api/mlb/sync/now?job=nfl_prop_calibration` returns
`error: "Cannot read properties of null (reading 'toFixed')"` after about
1.8 s. Not investigated further than that; it most likely reads a null out of
an empty prop table and formats it without a guard. It is in
`refreshNflPropCalibration` (`server/services/scheduler.js:932` registers it,
`server/services/nfl-prop-calibration.js` implements it).

See [[gridiron-fly-ingestion-limits]].
