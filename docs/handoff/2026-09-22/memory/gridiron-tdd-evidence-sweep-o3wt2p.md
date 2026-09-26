---
name: gridiron-tdd-evidence-sweep-o3wt2p
description: The docs/tdd evidence files written for the scheduler thread's PRs #39 #45 #49 #50 #52 on 2026-09-20, each head, and the two defects the sweep itself turned up.
metadata:
  type: project
  modified: 2026-09-20T03:05:00.000Z
---

All five pushed 2026-09-20, each after a full `npm run check` (typecheck, lint,
suite, build, start:smoke) since **CI is off until October 1**
([[gridiron-actions-limit-2026-09-20]]).

| PR | head | evidence file | local check |
|----|------|---------------|-------------|
| #39 | `7f36f8a` | `docs/tdd/migration-name-lint.tdd.md` | 2958 / 0 fail / 41 skip |
| #45 | `c9ff607` | `docs/tdd/ffopportunity-season-completeness.tdd.md` | 2954 / 0 / 41 |
| #49 | `3aed429` | `docs/tdd/health-check-grace.tdd.md` | 2954 / 0 / 41 |
| #50 | `d01df31` | `docs/tdd/espn-market-schedule.tdd.md` | 2957 / 0 / 41 |
| #52 | `dad6e1a` | `docs/tdd/fly-env-season.tdd.md` | 2952 / 0 / 41 |

All five still base `main` (791b131), all drafts. #49 and #52 both edit
`fly.toml` and were re-probed after these commits: **clean in either merge
order**, result carries both `NFL_SEASON = "2026"` and `grace_period = "300s"`.

Every file is the **retroactive form** ([[gridiron-boot-restart-loop-fixes]]),
precedent `docs/tdd/week2-numbers.tdd.md`: each guarded rule named, each shown
failing under a mutation that was run, with output pasted. Mutation counts:
#39 eight, #45 six, #49 four, #50 seven, #52 four.

## Two things the sweep found that reading would not have

**A mutation that never applied read as a clean sweep.** #50's first
`offThread: true` injection reported 7 pass / 0 fail — the exact signature of a
test that guards nothing, which is what this thread had already been burned by
([[gridiron-a-cited-proof-is-not-a-proof]]). It was a no-op: the substitution
pattern ended in `offThread: true, ` with a trailing space, and in the file the
entry wraps, so the text is `offThread: true,\n`. Re-run against a pattern
verified to have changed the file, the rule failed correctly. **Check that the
injection changed the file before believing its result** — the #52 harness now
prints `applied` / `NO-OP` per mutation, and that is the form to copy. A silent
no-op injection is a stronger false claim than running no sweep at all.

**`\Z` is a literal Z in JavaScript.** `test/fly-env-season.test.js` (#52)
scanned the `[env]` table with `(?=^\[|\Z)`, which only ever terminated on the
next `[`. It worked purely because `[[mounts]]` follows `[env]`. The same idiom
copied into #49's health-check test, where the scanned table **is** last in the
file, broke three tests outright, which is how it was found. Fixed on #52 with
an explicit end-of-input lookahead `(?=^\[|(?![\s\S]))` and a comment. It fails
safe, but it fires about a missing `[env]` table when the cause is the pattern,
which sends the next maintainer to the wrong file.

## What each file says it does NOT settle
- #45 — whether the live DB holds a half-ingested ffopportunity season:
  `SELECT season, COUNT(DISTINCT week) FROM nfl_ffopportunity_weekly GROUP BY season;`
- #49 — whether 300 s clears the real cold start. That is a deploy, not a test.
- #50 — whether `espn_player_market` currently holds a stale season:
  `SELECT season, COUNT(*) FROM espn_player_market GROUP BY season;`
- #52 — whether `MAX(season)` in `game_lines` is 2026. Pinning `NFL_SEASON`
  changes `availableSeason()` from measured to declared; those agree only if it is.

Stack state: [[gridiron-scheduler-stack-state]]. Board:
[[gridiron-pr-board-2026-09-19-night]].
