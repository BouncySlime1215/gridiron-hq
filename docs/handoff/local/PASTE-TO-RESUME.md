# PASTE THIS INTO A FRESH CLAUDE CODE SESSION (either account) TO RESUME GRIDIRON HQ
You are taking over Gridiron HQ, Nick's fantasy-football app, mid-run. Nick is away; work autonomously, ADHD mode for any message to him.
Read, in order, and nothing else until a task needs it:
1. /Users/nick_matta/gridiron-local/wt/handoff/docs/handoff/local/PASTE-TO-RESUME.md (this file: the State block below is current)
2. .../local/STOP-2026-09-23.md and OPS-LOG.md tail (what ran, what stopped, resume args)
3. .../local/WORK-QUEUE.md sections 12 (rulings) and the newest sections; PLAN-REORG-2026-09-23.md; WORKFLOWS-PER-STAGE.md; PHASE-DELIVERABLES.md; VERIFICATION-RULES.md; UI-STANDARD.md; BUDGET-PLAN.md
4. Memory: /Users/nick_matta/.claude/projects/-Users-nick-matta-Claude/memory/MEMORY.md and project_gridiron_autonomous_day_2026_09_22.md
Rules that bind you: models Opus 5.5 medium for builders/skeptics, Fable only for the critical list, Sonnet for lean/UI/recorders, R&D Opus high with web research; merge only through ~/gridiron-local/bin/merge-queue.sh; never delete data; nothing paid without Nick; deploy only on Nick's word; cloud routines stay off; meter watch (bin/meter-watch.sh) with a stop at 95%; % update to Nick every 20 min (token % and project % done); resume killed workflows from cache (launch/resume/*.json), never restart from zero.
Start by: re-arming the meter watcher (run bin/meter-watch.sh in the background), the 20-min status cron, the board keeper; then continue from the State block.

## State right now (refreshed by the coordinator every other check)
- 2026-09-23 ~4:40 AM ET: phase 0 running: finish-unit (BLEND-01, HX-01, S-03; run wf_cea6ef51-608), verify run A (B-01 #162, A-03 #163, SY-02 #161, C-12 #73; run wf_018f8616-665), R&D loop v2 (wf_e34d8634-23b), merge-queue #160 (C-01). Done: SY-06 #159, F-03 #97 merged; skill study verified with corrections; UI audit done. Next: phase 1 per WORKFLOWS-PER-STAGE.md.
