---
name: gridiron-report-keyed-to-a-throw
description: "Main went CI-red 2026-09-22 because #91's error reporting in routes/trades.js was keyed to an exception that #89 then correctly stopped raising; the rule is that a caller who can ask must ask, never learn a fact by catching."
metadata:
  type: feedback
---

**Measured 2026-09-22 16:23Z on a clean worktree of origin/main `1a136145`,
no changes applied:** `test/manager-signals-api.test.js:842` fails,
`read_failed` is `''`. 27 tests, 26 pass, 1 fail, deterministic across runs.
Fixed on `claude/project-thread-3xqh5l-archetype-state` (`670feac9`), PR #111.

**What happened.** Two changes, each correct alone, cancelled each other.

- **#91** (`e3e76025`) narrowed `routes/trades.js:414` from a bare `catch {}`
  to one that absorbs only a missing table and names it in `read_failed`.
- **#89** (`1a136145`) added `manager-archetypes.js:1179`,
  `if (!leagueHistoryState().present) return out;` — so `archetypesFor`
  stopped throwing on an absent `league_season_teams`.

The route's reporting fired only from the catch. Nothing threw, so nothing was
reported, and the page served an empty reason for a read that never happened —
the exact defect #91 removed, arriving through the other door.

**Why:** a report that only works when something raises is not a report. It is
a side effect of an exception, and it lasts exactly as long as the exception
does. Nothing but one test recorded that the route depended on the throw, so
the coupling was invisible to the thread that removed it.

**How to apply:**
- When a module publishes a state accessor (`leagueHistoryState()`,
  `chatCorpusState()`, `transactionsCollected()`), a caller ASKS it. Learning
  the same fact by catching is a latent break the moment the callee stops
  raising — which is itself an improvement, so it will happen.
- Making a function stop throwing is a CONTRACT CHANGE for every caller that
  catches. Grep the callers before landing it. #89 could not have known;
  nothing said so.
- Both guards can be right at once. The narrowed catch in `trades.js` stayed
  after the fix and is still pinned by *"a programming error in the archetype
  read is NOT absorbed"* — the ask covers the one table whose state is
  published, the catch covers every other table the read touches.
- When two merged PRs interact, reproduce on a clean checkout of main before
  blaming either. This one was first reported as an `ENOTEMPTY` race in
  `scheduler-off-thread`; it is a different test with a different cause, and
  it does not come and go.

Related: [[gridiron-swallow-sites-per-branch-1303]],
[[gridiron-script-created-tables-cannot-evolve]].
