---
name: gridiron-pr-board-detail-2026-09-22
description: Detailed per-PR notes for the main-CI-red regression and the Trade Brain stack, moved out of gridiron-pr-board-2026-09-22.md at 16:34Z to stay under cap
metadata:
  type: project
  modified: 2026-09-22T16:35:01.984Z
---
- **Main CI red root cause:** #89's leagueHistoryState() no-throw guard breaks #91's catch-based archetype-read-failure reporting in routes/trades.js — real regression, not the ENOTEMPTY race.
- **#111 (Trade Brain, the fix):** PUSHED 16:33Z, head 670feac9, branch claude/project-thread-3xqh5l-archetype-state (Chat sync diff + non-empty read_failed assertion; 4/4 mutations; full check 3111/3070/0/41; reproduced on clean 1a136145 27/26/1); CI running, squash-merge on green.
- **Trade Brain stack:** #94 f0fa58d7 → #103 81f5b09e → engine-fault 89de8326; #100 2ef11634 separate. CORRECTION 16:33Z: all four were rebased onto e3e76025, not current 1a136145 — re-rebase after #111 lands. #94's run-360 failure is byte-identical to main's (commented, not Trade Brain's bug). #100 carries a new fix: manager-signals.js transactionsCollected unguarded read throws on league_transactions_raw shape drift (4 call sites incl. routes/trades.js:484); RED/GREEN + 4/4 sweep, now read_state 'unreadable'. Merge order #111 → #94, #100, #103, engine-fault, 4b-port — after CI green + Evidence Auditor REAL.
- **#95 (Scheduler):** deploy-step plan: `fly secrets set SCHEDULER_DISABLED=1` → `fly deploy -a gridiron-hq` → confirm log line + uptime → `fly secrets unset SCHEDULER_DISABLED` only once #95 is in the image.
- **#68 target-share result:** 1.90→1.80 MAE held-out 2025 (n=2,367, CI [+0.068,+0.144], pre-registered).
- **#99 inventory:** canonical ladder settled 16:31Z at 183 wired / 116 route / 67 script-only (see MEMORY.md); the 112-123 range and 46/60 counts are superseded.
