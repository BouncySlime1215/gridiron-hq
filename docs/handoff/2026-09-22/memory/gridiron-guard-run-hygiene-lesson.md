---
name: gridiron-guard-run-hygiene-lesson
description: "Lessons (Model evidence audit #121, 18:50Z): never pipe a guard run through a filter (sed buffering lost a run); when main moves mid-run, stop, merge main, spend ONE suite on the final tree; and the RESTART-BRIEF RULE — every restart brief tells the thread to cancel any PR check-in cron and unsubscribe PR activity on merged PRs (silent recurring spend)"
metadata:
  type: project
  modified: 2026-09-22T18:55:00.000Z
---
**Why:** on #121 one guard run was piped through `sed` for a tidier log; sed's output buffering meant the run's tail (the exit code line) never appeared and the run had to be repeated — a full suite spent on formatting. Separately, main moved (#92, then #127) while a guard was executing; a verdict on the pre-move tree is not a verdict on what will merge ([[gridiron-rebase-before-merge-lesson]]), so the honest move is to stop the run, merge main once, and run the suite ONCE on the final tree — not to let the old run finish and then run again ([[gridiron-verify-once-and-model-by-weight]]). Finally, the thread had a half-hourly PR check-in and a PR-activity subscription armed; after the merge both would have kept waking a finished thread. Under Nick's usage rule ([[gridiron-usage-priority-rule]]) that is silent recurring spend.

**Rules:**
1. Guard runs write to a file, unfiltered; read the file afterwards. Never `| sed`, `| grep`, `| head` on the run itself.
2. If main moves mid-run: stop, merge main, ONE suite on the final tree. Say so in the body's self-check block.
3. **Restart-brief rule:** every fresh-restart brief ([[gridiron-restart-fresh-from-handoff-rule]]) tells the thread to cancel any PR check-in cron and unsubscribe PR activity on merged PRs before doing anything else; the coordinator's own trigger list should show only the 30-min update. Origin [[gridiron-state-1297-2026-09-22]].
