---
name: gridiron-merge-reconciliations-2026-09-20
description: The three scheduler-branch merge collisions, each resolved AND tested before the morning merge — including the measured result that #48/#71 and the scheduler branch can land in either order.
metadata:
  type: project
  modified: 2026-09-20T08:40:00.000Z
---

Resolved and pushed 2026-09-20 to the NEW no-PR hold branch
**`claude/project-thread-o3wt2p-merge-resolutions-hold` head `64cb90e`**
(`8709ec6` → `0e0bb86` merge of #71 → `7462c4c` merge of #50 → `e852884` docs → `89cdb3a` hashes + check line → `64cb90e` injections quoted).
Full check on it: **3054 tests, 3013 pass, 0 fail, 41 skipped**, build and
start:smoke clean, exit 0. Nothing pushed to a PR branch and **no PR opened** —
the harness default of "always open a draft PR after a push" is overridden by
Nick's 01:58Z freeze, which is his own word and wins. Evidence file on the
branch: `docs/tdd/merge-reconciliations-2026-09-20.md`.

## 1. `server/services/scheduler.js` vs `d01df31` (#50) — take the UNION

Both edit the `league_rosters` registry line. The union is safe **and that was
checked, not assumed**: merge base is `791b131`, where the line has **no
`offThread`**, and `git log 791b131..d01df31 -- server/services/scheduler.js`
(two commits) never touches that key. So `d01df31` did not remove `offThread` —
it never had it. Result: keep their `espn_market` entry, keep this branch's
`offThread: true`.

**The general rule this is an instance of:** a union resolution is only safe
once you have looked at the merge base. If the base HAD carried `offThread`,
the same union would have been a silent revert of a deliberate removal, and it
would have looked identical in the diff.

## 2. `test/health-route-single.test.js` — three-way, take `caac88a`

Three branches independently made the same fix (drop the line number from the
assertion, keep it in the failure message): `63ca21e` (#56, merges first),
`caac88a` (wiring map), `73e0760`. "Semantically identical" was an assertion,
so it was **measured**: all three plus the original run against one tree
(`791b131`) under two hash-verified injections.

| version | clean | line shifted | 2nd registration |
|---|---|---|---|
| `791b131` original | pass | **FAIL** | FAIL |
| `63ca21e` / `caac88a` / `73e0760` | pass | pass | **FAIL** |

The shift (an unrelated comment at line 10, moving the registration 86→87) is
the bug all three fixed, reproduced. The duplicate is the guard the file exists
for, and none of the three weakened it. It is a **RESOLVE, not a clean merge**;
taking any of the three loses nothing. Take `caac88a` — fullest explanation.

## 3. `test/league-roster-schedule.test.js` vs `8b1a0363` (#71)

Orthogonal in intent, overlapping in text. This branch split the test (wiring
asserted on the registry; behaviour asserted by calling `refreshLeagueRosters`
directly instead of through `runIfStale`, which made the tests silently
conditional on the job running inline). `8b1a0363` added `espn_s2`/`swid` to the
same fixture INSERTs because `syncEspnLeague` now resolves credentials per
league and throws rather than fetching anonymously.

**Resolution: this branch's structure + their fixture columns**, both comments.

**MEASURED: the merge is order-independent.** The resolved file passes 3/3 on a
tree WITH `server/platform/espn-credentials.js` and 3/3 on `8709ec6` alone where
that module is **absent**. So #48/#71 and the scheduler branch may land in
either order with no broken intermediate state. That was an open assumption
before this was run — see [[gridiron-espn-credentials-not-on-main]].

## Why this exists

All three were going to be discovered at merge time, by whoever ran the merge,
on a morning that already has a deploy in it. Pre-resolving removes three
unknowns from the sequence; the merge ORDER in the release plan is unchanged.

Related: [[gridiron-o3wt2p-branch-ledger]] · [[gridiron-scheduler-stack-state]]
· [[gridiron-empty-diff-means-missing-ref]] ·
[[gridiron-stamp-and-kill-from-the-tool]]
