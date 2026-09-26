---
name: o3wt2p-local-branches-2026-09-22
description: The four local unpushed branches the scheduler thread built off 654ff93 on 2026-09-22, and the two SHAs the older ledger mislabels as "the live-tier move".
metadata:
  type: project
---

All four are **local and unpushed**, built off `origin/main` **654ff93** under
Nick's 2026-09-22 01:25Z rule: nothing pushes, no PR, no merge, no deploy
without his explicit word first.

- `-live-tier-offthread` head **3ef535b** — the live-tier move plus the deploy
  runbook. Six cherry-picks (3902ba7, dc21d92, 0a198d7, a9511f6, bec666d,
  3d4ca74), **all clean, zero conflicts**, 10 files +1,277/-28. See
  [[live-tier-flag-belongs-on-the-job]].
- `-watchdog-names-job` head **c560307** — the kill line names the running job.
  6 files, +186/-14.
- `-stall-measurement` head **f318a17** — the 24-job harness and its evidence
  file. 2 files, +260.
- `-servedtables` head **aeded00** — the freshness contract. 2 files, +285.
- `-watchdog-names-job-presplit` **2ca1c7f** — keep-ref only. The last three
  above were split out of it; nothing was deleted. Proven disjoint and complete:
  the three branches' file sets equal 2ca1c7f's, and every blob matches.

**THE SHA CORRECTION.** The older held-branch ledger and the thread brief both
call something "the live-tier move" that is not:

- **8709ec6** is "report the sweep that paused, and drop what nothing reads" —
  dev routes, platform/jobs.js, platform/paths.js.
- **9c7cf68** is the ESPN transaction collector, tier `metered`, and it carries
  **migration 066**.
- The real live-tier move is **a9511f6** ("#59's boot fix does not survive the
  first live tick, for fourteen jobs") with **3902ba7** beneath it.

**Why this matters:** every merge conflict previously reported against 654ff93
came from 9c7cf68 and 8709ec6, not from the live-tier move, which rebases clean.
And a ledger calling a migration-bearing commit "the live-tier move" is how a
schema change ends up on a deploy branch by accident — which would void
[[deploy-654ff93-applies-no-schema]].

**How to apply:** verify a held SHA by reading the commit before acting on it.
Note 3902ba7 is also **PR #77's own head** — cherry-picking it does not touch
#77, and if #77 merges the cherry-pick no-ops. **Full-check figures, each closing against 654ff93 = 2,986 tests:** 902393a
**2,991** (+5); 2ca1c7f **2,996** (+10); a24692d **2,993** (+7); 3ef535b
**3,009** (+23 over six files, not decomposed). All 0 fail, exit 0, tree
unchanged either side, **source-isolated** (node_modules symlinked, NOT its own
`npm ci`). 2,993 vs 2,996 is two trees, not a contradiction.

## 03:11Z -- #56/#59/#61 closed unmerged, and NOTHING was deleted
Read directly 2026-09-22 03:12Z. All three closed within 25 seconds, base main
at 791b131, `mergeable_state: dirty`, `merged: false`:
`#61` 03:11:09Z (head `-abandoned-runs` a986f37) · `#56` 03:11:23Z
(`-watchdog-arming` 63ca21e) · `#59` 03:11:34Z (`-boot-offthread` b5b74b5).

**Correct on the merits** -- their content shipped inside #63. Verified by
reading 654ff93, not inferred: `recordStart` 5x and `reapAbandonedRuns` 4x in
scheduler.js, plus test/abandoned-run-backoff.test.js and
docs/tdd/boot-restart-cycle.tdd.md both present.

**No branch was deleted. 151 remote heads, unchanged.** All three head branches
survive, as do `claude/project-thread-f921do` (0bd4041) and
`cursor/betting-model-audit-fixes-1c85` (ff215a8) -- so the reversible half of
the held batch executed and the irreversible half did not.

**Who closed them is NOT knowable from GitHub.** Every Claude session here
authenticates as `BouncySlime1215`, the same account as Nick, so the actor field
names an account and never a person; the 11-14 second spacing fits a person
clicking Close as well as a script. Only Nick can answer it. Do not burn effort
on the actor field. See [[gridiron-hostile-relay-2026-09-22]].
