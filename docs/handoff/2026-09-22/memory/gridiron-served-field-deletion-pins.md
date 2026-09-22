---
name: gridiron-served-field-deletion-pins
description: The served-field deletion sweep found selfScout's `week` unpinned; the pin lives on hold branch claude/project-thread-5f9c3y-trade-week-hold (eb55f1d), and the general lesson is that a producer's unit test cannot catch a consumer-contract defect.
metadata:
  type: project
  modified: 2026-09-20T03:10:55.612Z
---

**2026-09-20, from the wiring map's served-field deletion check on PR #60.**
Of the three client-read fields that stack adds, `week` at
`trade-engine.js:2591` (on #57's base; `selfScout`'s return) was unpinned —
deleting it left the whole suite green.

**Why it mattered.** `client/src/pages/MyTeam.tsx:233` reads it as
`week={scout?.week ?? 1}`. That `?? 1` is why the field exists and also why
losing it is invisible: the ceiling tab renders week 1 for the rest of the
season, full lineup, real-looking numbers, no error. Same shape as the
`leagueCurrentWeek` docstring's own warning — "that is how the app spent two
weeks showing week-1 lineups".

**The pin.** `test/self-scout-serves-the-week.test.js`, 5 tests, on
`GET /api/trades/:leagueId/scout` — the served JSON, where the client reads
it, not the function's return value. Evidence
`docs/tdd/self-scout-serves-the-week.tdd.md`. Four applied mutations, each
turning four of five red: the deletion itself; the field hardcoded to 1; the
pre-#57 zero-argument `tradeWeekContext()`; `NFL_WEEK` standing in for the
league's matchup period. No server code changed.

**Where it is.** Hold branch `claude/project-thread-5f9c3y-trade-week-hold`,
head **eb55f1d**, one commit on top of `7c27517` (#57's head, final on origin).
Pushed 2026-09-20 under the GitHub freeze — new branch, no PR, no email. At
Nick's go it fast-forwards onto #57's branch, or rides whatever #57 becomes.
Full local check on it: 2,978 tests, 2,937 passed, 0 failed, 41 skipped; lint
879 files; build 3.39s; start:smoke passed.

**The general lesson, which outlives this field.**
`test/trade-week-context-league.test.js` already existed and passes on both
sides of the defect, because it tests the week `tradeWeekContext` *computes*.
A unit test on the producer cannot see a defect in the consumer's contract.
Every served field a client reads is unpinned by default; this fixes one row
of the sweep, not the class. A deletion sweep over served fields is the cheap
way to find the rest.

Related: [[feature-audit-shipped-prs-55-57]],
[[gridiron-confident-numbers-from-searches-that-never-ran]],
[[gridiron-test-fixture-traps]], [[github-actions-freeze-2026-09-20]],
[[gridiron-held-branches-2026-09-20]].
