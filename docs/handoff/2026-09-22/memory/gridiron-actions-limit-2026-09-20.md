---
name: gridiron-actions-limit-2026-09-20
description: The GitHub Actions minutes limit on gridiron-hq was hit ~01:00Z 2026-09-20 — CI is FROZEN by Nick, and every red check from that window is the quota, not the diff.
metadata:
  type: project
  modified: 2026-09-20T01:12:00.000Z
---

**Nick, 01:04Z 2026-09-20: his GitHub Actions limit is hit. HARD FREEZE** —
no push, no new PR, no workflow re-run, no marking a draft ready, no base
change, nothing that triggers CI, until the coordinator lifts it. Local work
only: tests, working-tree docs, memory. He is cancelling queued runs and
disabling the repo's workflows.

**I first read the symptom as an Actions outage. It was the quota.** Recording
the correction because the symptom does not say which: the job simply never
starts, `started_at` and `completed_at` 2-20 s apart, `runner_id` 0,
`runner_name` empty, and logs 404 because none were produced. Nothing ran — not
checkout, not install, no test body. That reads exactly like an infrastructure
outage, and it is the account running out of minutes.

**So the drive-to-green "it died before any test body ran, re-run it once" rule
is actively harmful here**: a re-run spends minutes that do not exist and
cannot succeed. Check whether the whole repo is failing that way before
re-running anything, and prefer asking over spending.

**Measured across four unrelated branches**, which is what shows it is not a
diff: #58 at 01:00:24 (5 s), #63 at 01:00:36 and again on re-run at 01:01:43
(2 s each), #64 at 01:00:45 (19 s), #35 at 01:03:30 (3 s). The last normal runs
were 23:03-23:15Z, green, 7-9 minutes, including #59 and #61.

**A red check from a run that actually executed** — minutes long, with logs —
is still a real failure. Read the elapsed time and the runner fields first.

Local evidence stands in for CI while this holds: #63's head 01b7a2f is
2979/0 with lint, typecheck and start:smoke clean, and #63 carries a comment
saying so.

See [[gridiron-ci-blockers]] and [[gridiron-pr-board-2026-09-19-night]].

RETIRED 15:24Z: Nick re-enabled Actions himself 14:52Z; public repo, free; 15:45Z Nick: 'UNLIMITED ACTIONS'.
