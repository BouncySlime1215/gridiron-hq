---
name: gridiron-memory-oversize-backlog
description: Silo memory files over the 4,096 B recall limit as of 15:27Z 2026-09-22, to split into part2 files when the usage pause lifts
metadata:
  type: project
---
Recall reads only the first 4 KB of a file, so everything past 4,096 B is invisible. Measured 15:27Z 2026-09-22 (`find -size +4095c`); gridiron-audit-unit-1-verdict.md was already split the same way at 15:27Z (3,827 B + [[gridiron-audit-unit-1-verdict-part2]] 958 B). Not split yet because the 13:02Z pause holds.

**Rule when splitting:** move the tail verbatim into `<name>-part2.md` (same frontmatter shape, one-line description saying what moved and when), leave a one-line pointer `[[<name>-part2]]` in place of the moved text, grep-verify the moved sentences in part2, never delete or paraphrase text. MEMORY.md (11,534 B) is exempt; its cap is 12,000 B.

**Files (bytes):**
- chat-corpus-not-on-this-machine.md — 6408
- gridiron-cleanup-thread-stop-2026-09-22.md — 6063
- gridiron-planner-role-and-path-facts-2026-09-22.md — 5914
- gridiron-o3wt2p-branch-ledger.md — 4684
- ceiling-headroom-mae-derivation.md — 4534
- servedtables-is-coverage-not-timestamps.md — 4452
- mutation-run-catches-duplicated-reads.md — 4440
- gridiron-offline-measuring-rig-2026-09-22.md — 4438
- gridiron-explorer-paused-2026-09-22.md — 4382
- gridiron-held-branches-2026-09-20.md — 4229
- gridiron-offline-rig-evidence-line.md — 4185
- gridiron-merge-order-86-before-96.md — 4176
- process-exit-truncates-a-piped-report.md — 4166
- gridiron-scheduler-stack-state.md — 4096

gridiron-scheduler-stack-state.md sits exactly at 4,096 B; its last byte is the cut-off, so it goes in the same pass.
