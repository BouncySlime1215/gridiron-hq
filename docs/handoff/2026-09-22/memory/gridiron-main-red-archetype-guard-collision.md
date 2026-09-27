---
name: gridiron-main-red-archetype-guard-collision
description: main 1a13614 is CI-red on one test because #89's and #91's guards for the same bug are mutually exclusive; verified two-hunk patch and where it lives.
metadata:
  type: project
  modified: 2026-09-22T16:34:00.204Z
---

**2026-09-22 16:2xZ. `main` @ `1a1361456229524c3fe5abfe5f0c7ba130a82e41` is CI-red**
(run 35749244482: `# fail 1`, `# pass 3069`). One failing test:

    not ok 1126 - read: an archetype read that FAILED is reported, not served as a store that is empty
    test/manager-signals-api.test.js:842 · ERR_ASSERTION · operator match · actual ''

**This is NOT the ENOTEMPTY / `test/scheduler-off-thread.test.js` race, and PR #110
does not fix it.** Those strings appear nowhere in either log. The coordinator
relayed that attribution at ~16:1xZ; it was wrong. Reproduced deterministically
on a detached worktree at `origin/main`, that one file alone: 27/26/1.
The `no such column: espn_member_id` line in the log is the deliberate injection
from the NEXT test, which passes — a red herring that costs ten minutes.

**Cause — two guards for the same bug, merged from opposite ends:**
- `routes/trades.js:401-417` (#91, merged 15:32Z) catches the archetype read,
  `isMissingTable()` discriminates, serves `read_state:'table_absent'` +
  `read_failed`. Pinned by `manager-signals-api.test.js:842`.
- `manager-archetypes.js:1179` (#89, in `1a13614`, "second phantom-table guard")
  puts `if (!leagueHistoryState().present) return out;` ABOVE the query, so the
  read never throws, the catch never fires, `read_failed` stays null. Pinned by
  `league-history-absent.test.js:77`.

Mutually exclusive. Neither PR's CI could see it: each was green against a `main`
that lacked the other.

**Which side is wrong:** the #89 guard's own comment states its premise —
*"routes/trades.js wraps this call in a bare catch"*. True when written, false
since #91. So the test is the thing to change, not the route.

**Verified patch (two hunks): drop the early return in `archetypesFor()`; flip
`league-history-absent.test.js:77` from `doesNotThrow` to `throws(/no such
table/i)` with a restore-and-empty control.** On `origin/main` + that diff alone:
`npm run check` rc=0, 3111/3070/0 fail/41 skipped, smoke passed, `git write-tree`
identical before and after. **Full diff lives in
https://github.com/BouncySlime1215/gridiron-hq/pull/86#issuecomment-5780208576** —
take it from there, not from any session scratchpad.

**Owner:** `manager-archetypes.js` is Chat-sync's [[gridiron-file-allocation]].
UI (xiezr0) did not push it — landing another thread's files inside a
data-freshness PR would bury a repo-wide breakage in an unrelated diff.

**Why it matters:** while `main` is red, every PR's merge check is red, so
nothing merges green. This is the gate on everything else.

**The lesson, not the entry:** two threads fixing the same bug in the same call
chain will each go green alone and red together, and no PR's own CI can catch
it. When two PRs name the same defect, one of them has to read the other's diff
before merge — see also [[a-shape-mismatch-can-pass-every-guard]].
