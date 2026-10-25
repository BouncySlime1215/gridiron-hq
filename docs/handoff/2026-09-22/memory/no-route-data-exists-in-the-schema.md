---
name: no-route-data-exists-in-the-schema
description: Yards per route run and route participation cannot be computed on this platform — no routes-run column exists anywhere in the schema, and there is no red-zone marker outside play-by-play's yards_to_endzone.
metadata:
  type: project
---

Measured 2026-09-22T08:55Z on `claude/project-thread-xiezr0-data-freshness` @ `071c6c1`,
while scoping the advanced-stats block for `client/src/pages/PlayerDetail.tsx`. The block
does not exist yet; this is what it would have to work with.

**Routes run: absent.** `grep -rci route server/db/schema/*.js` hits 23 times across four
files and **every hit is something else** — `server/routes/*.js` path strings in
core-and-fantasy.js (20), `routed_at` in nfl-a-to-m.js (1), and an HTTP `route` column plus
an index on it in nfl-n-to-z.js (2). Control in the same scan: `targets` hits
mlb-model-misc.js, which is the real `player_week_usage` definition, so the scan works.

So of the four stats that must never be shown as numbers:

- **Yards per route run** — no denominator exists. Not derivable. nflverse does not ship
  routes; it is PFF / Fantasy Points Data, which is paid, and **R&D: NOTHING PAID ever**.
- **Route participation** — same denominator, same answer.
- **Red-zone share** — no `red_zone`, `redzone`, `rz_` or `yardline_100` column in any
  schema file. The only thing close is `nfl_play_by_play.yards_to_endzone`
  (nfl-a-to-m.js:318), so a red-zone share would have to be **derived from pbp and
  attributed to a player**, which pbp's columns there may not support. Check before
  promising it.
- **Touchdown rate** — this one IS computable: `player_week_usage` carries
  `receiving_tds`, `rushing_tds`, `passing_tds`, `targets`, `carries`, `attempts`
  (mlb-model-misc.js:257-277). The honest problem is not availability but denominator and
  weekly sample size, which is a different argument from the other three.

`player_week_snaps` has only `offense_snaps` / `offense_pct`, so snap share is the nearest
real participation measure the platform actually has.

Do not surface any of the first three as a number, an estimate, or a snap-share proxy
relabelled. See [[gridiron-missing-data-workaround-rule]] and
[[a-report-is-not-a-shipped-fix]] for the scan-with-a-control habit this used.

**BUILT 2026-09-22T12:35Z, local commit `a27cc10`, not pushed.**
`server/services/player-advanced-stats.js` + `GET /api/players/:id/advanced-stats` +
`client/src/components/AdvancedStatsPanel.tsx`, mounted on `PlayerDetail.tsx`. It shows
target share, WOPR, snap share and a touchdown rate whose denominator is named on the
page (QB: passing TDs per attempt; everyone else: TDs per target **or carry**, together,
because splitting a receiving back describes neither half). The three absences are
**listed with their reason, never omitted** — an empty space makes no claim a reader can
argue with, so omitting them reads as a complete page.

The reasons live in one exported `UNAVAILABLE` constant so they cannot drift. **A reason
must describe the thing that is absent:** "no routes-run data exists on this platform"
(true, about the platform) not "this player has no routes on file" (false, about a
player). A mutation rewriting it to the second survived three assertions that compared
the constant against itself — pin the CLAIM, not the equality. Evidence:
`docs/tdd/player-advanced-stats.tdd.md`.

Known gap, not fixed: a QB gets a target-share row explained as "not populated" rather
than "not applicable to this position". `depth-chart.js` already draws that distinction
and this should borrow it.
