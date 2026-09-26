---
name: gridiron-awaiting-nick-0744-2026-09-22
description: The five "awaiting Nick" items at 07:44Z 2026-09-22 with the Scheduler 5-branch rundown figures; items 2 and 3 moved to the coordinator at 07:45Z.
metadata:
  type: project
  modified: 2026-09-22T07:49:53.589Z
---

Split from [[gridiron-state-0744-2026-09-22]]. Cycle fired 07:40:58Z, trigger `trig_01YEHMn2dCcAQsDcN293x97b`, re-armed for 07:58:00Z.

**Authority update:** items 2 and 3 below are now the coordinator's per [[gridiron-authority-0745-2026-09-22]] (Nick 07:45:57Z). Only key rotations (1), the live DB read (4) and deploy + unset brake (5) remain Nick's.

## AWAITING NICK (nothing else is blocked)
1. **Key rotations** — three exposed credentials, zero rotations confirmed, open since the 18th. The only item he can act on right now.
2. **Scheduler's 5 held branches** (now coordinator's call) — 3 of 5 rundowns done, all exit 0: `-servedtables` a24692d 2993/2952/0/41, `-watchdog-names-job` c560307 2991/2950/0/41, `-stall-measurement` f318a17 2986/2945/0/41. `-watchdog-names-job-presplit` running, then `-live-tier-offthread`, then the epoch branch as a sixth. ~9 min each. Hold releases on the coordinator's read of the complete six-row table (was: table posted AND Nick says yes).
   - Note: 2986 on `-stall-measurement` is exactly the 654ff93 baseline, which is correct — that branch adds no tests. Previously reported "by construction"; now measured and it agrees.
3. **Four PRs** (now coordinator's call; authorised as drafts 07:47Z) — Google sign-in 60d1378, Chat sync 42478b1, Trade Brain 3c949d9, UI freshness 3d92ccb. All drafts, none opened at 07:44Z.
4. **Live DB read** (two read-only queries) — Nick's.
5. **Deploy + unset brake** (`SCHEDULER_DISABLED=1`) — Nick's.
