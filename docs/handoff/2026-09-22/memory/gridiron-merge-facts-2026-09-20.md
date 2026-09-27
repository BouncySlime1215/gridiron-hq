---
name: gridiron-merge-facts-2026-09-20
description: Release facts for the six-PR fix stack of 2026-09-20 — ready marks, merge order and clean-sequence result, migration 066's home, and the one recurring test conflict.
metadata:
  type: project
---

**Six PRs are marked ready and Nick can merge them: #56, #59, #61, #63, #52, #49.** (The ready marks were set under the bad 13:19:44Z "Ok go" relay — see [[gridiron-authorisation-rule]]. They are marked; the emails went; the state below is what he now has.)

**Ancestry.** #56, #59 and #61 are ancestors of #63, so **#63 alone lands all four**. #52 and #49 are separate and follow, in that order.

**Merge result.** All six merge clean in sequence; both independent rehearsals produce **final tree 6944033** (a rehearsal's merge commit is minted per run and is not comparable — compare trees, never merge commits).

**Migration 066** (scheduler `league_transactions_raw`, the collector job) **is in #84 at 9c7cf68.**

**The one conflict to expect: `test/health-route-single.test.js` conflicts three ways.** Resolution: **keep whichever side is already in the tree, delete the other.**

**Per-PR suite counts against main's 2,950:** #56 2,956, #59 2,966, #61 2,975, #63 2,980, #52 2,952, #49 2,954 — deltas 6, 16, 25, 30, 2, 4. The first four RISE to 30 rather than summing past it, which is the nesting seen a fourth way; 30 + 2 + 4 = 36, matching the merged **2,986** exactly.

**2,986 is RELAYED, not measured.** It is one thread's figure, corroborated by that arithmetic but not yet independently reproduced. It stays marked relayed until a second clean-worktree run agrees.

**#63 adds FIVE tests across two files, not four** — which is why its suite is 2,980 against a body that claimed 2,979.

**#63's fifth test is in `test/loop-watchdog.test.js`, NOT `test/watchdog-arming-sources.test.js`.** #63's head 64f3ef2, "test: guard the early arm, which nothing did", touches four files and adds exactly ONE `test(` call: "an arm that arrives before the watchdog starts is not lost", in `test/loop-watchdog.test.js`. `test/watchdog-arming-sources.test.js` IS edited in that same commit, nine lines changed, but gains no test. Diffing #61's head against #63's across the whole `test/` tree gives five added tests: four in the new timer-tier file plus that one. So "five tests across two files" stands; only the filename was wrong. 2,975 + 5 = 2,980. Caught by the release thread, which read the commit instead of taking the coordinator's line.

**#49's body understates its own branch, and the original sentences STAY.** The body says "No product code, no test changes" and "there is nothing to unit test", but its head 3aed429 adds `test/fly-health-check-grace.test.js` with four assertions plus `docs/tdd/health-check-grace.tdd.md`. The release thread left the original sentences standing and added a correction blockquote naming the four assertions, because the reasoning is still right: nothing at runtime can observe `fly.toml`, so the assertions are on the file's text and the deploy log is what falsifies the change. A silent rewrite was DELIBERATELY REJECTED.

**The brake was verified on the MERGED tree of all six PRs, not on any single head.** Early return at `scheduler.js:1927`, with boot pass `:1940`, growth `:1964`, reports `:1968`, live tier `:2015` and background tier `:2016` all below it. The only two things above the return are `reapAbandonedRuns()` at `:1914` (parameterised SELECT over rows with status running, one parameterised UPDATE each, synchronous, bounded, no timer, no network) and `onBootComplete?.()` at `:1931` (sets a flag). Why it matters: Nick merges with the brake ON and deploys, so the deployed build must honour the switch or the loop is back before he reaches the unset. See [[gridiron-brake-survives-the-merge]].

See [[gridiron-held-branches-2026-09-20]] for held-branch heads and [[gridiron-pr-board-2026-09-19-night]] for the board.
