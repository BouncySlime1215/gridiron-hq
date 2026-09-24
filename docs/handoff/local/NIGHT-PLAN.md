# NIGHT PLAN 9/24 (nonstop until Mon 9/28 9 PM ET): what runs, who refills it, how to restart
Plan of record: BUILD-PLAN.md (phases 0-4) + COACH-ANCHOR.md + WAR-ROOM-UI.md v3 + PEOPLE-FLOW.md. Rules: RULES.md (NO STOPPING, Mac load cap, two/three lanes, PR sweep every 20 min). Migrations: MIGRATIONS.md only.

## Lanes and their refillers
| lane | size | queue file | refilled by | survives app restart? |
|---|---|---|---|---|
| Build workflows (coordinator session) | 4 | ~/gridiron-local/lanes/build-queue.json | WORKFLOW KEEPER cron (10 min) + on each completion | NO (session cron) |
| R&D workflow | 1 (load under 14) | lanes/workflow-queue.json | same | NO |
| Cloud (main account) | 8 at once, 30 total, pauses at 70% 5-hour usage | lanes/cloud-queue.txt | lane-keeper.sh (5 min) | YES (nohup) |
| Local claude -p | 2 | lanes/local-queue.txt (+ .all, deferred) | lane-keeper.sh | YES |
| Merge train | batches | evidence/merge-order.txt, PR #278 (batch 1) | merge agent + auto-intake.sh (10 min) | intake YES / agent NO |
| PR sweep | every 20 min | lanes/sweep/ | PR SWEEP cron; lane-keeper-v2.sh once swapped in (below) | NO -> YES after the swap |
| Step-back | every 2 h while the coordinator has not written OPS-LOG for 3 h | docs/handoff/local/STEP-BACK-<t>.md | lane-keeper-v2.sh | YES after the swap |
| Data refresh + app | - | - | refresh.sh, run.sh | YES |
| No-sleep | 25 h | - | caffeinate (started 12:15 AM) | YES |
Events: lanes/EVENTS.log. Morning brief cron: 5:37 AM 9/24 (session-only).

## KEEPER SWAP (KEEPER-DURABLE, 9/24): v2 = v1 + REVIEW-ON-FINISH sweep (20 min) + step-back note (2 h when the coordinator is quiet 3 h)
Tested: `~/gridiron-local/bin/lane-keeper-v2.sh --dry-run` (one pass on a throwaway copy of lanes/, launches nothing). Swap (one line; running local jobs keep going, v2 adopts them from local-running.tsv):
`kill $(cat ~/gridiron-local/lanes/keeper.pid); sleep 2; cd ~/gridiron-local/lanes && CLOUD_MAX=8 LOCAL_MAX=3 CLOUD_TOTAL_MAX=30 nohup ~/gridiron-local/bin/lane-keeper-v2.sh > keeper.out 2>&1 &`
After the swap, delete the session PR SWEEP cron (else two sweeps run). Knobs: SWEEP_EVERY=1200 SWEEP_BATCH=12 SWEEP_QUIET=900 SWEEP_MIN_PR=164 SWEEP_TIMEOUT=3600 COORD_QUIET=10800 STEPBACK_EVERY=7200. Prompts: lanes/sweep/sweep-prompt.txt, lanes/stepback-prompt.txt (edit live, no restart). Ingest: bin/sweep-ingest.py (reviewed.tsv + one FIXPR unit per PR; local if any fix needs the Mac or .budget-hit, else cloud; priority high -> queue head).

## If the desktop app restarts (crons + in-session agents are lost)
Paste PASTE-TO-RESUME.md into a new session, then:
1. Recreate the crons: WORKFLOW KEEPER (3,13,...,53), PR SWEEP (7,27,47), HOURLY TICK (:17), STOP at Mon 9/28 21:00, MORNING BRIEF (if before 6 AM 9/24). Their texts are in RULES.md + this file.
2. pgrep -f lane-keeper.sh || (cd ~/gridiron-local/lanes && CLOUD_MAX=8 LOCAL_MAX=2 CLOUD_TOTAL_MAX=30 nohup ~/gridiron-local/bin/lane-keeper.sh > keeper.out 2>&1 &). Restart ONLY via: kill $(cat ~/gridiron-local/lanes/keeper.pid) then start (single-instance guard via keeper.pid; pkill -f would kill its child jobs).
3. pgrep -f auto-intake.sh || nohup ~/gridiron-local/bin/auto-intake.sh &
4. Relaunch 4 build workflows from build-queue.json and 1 R&D round; re-arm the Monitor on lanes/EVENTS.log.
5. Merge train: continue batch 1 (#278) -> batch 2 per evidence/merge-order.txt; the FIX rebaser puts each cloud FIX PR on FIX-03 (#272).

## Open issues right now
- WR-FREEZE (first in the local queue): the War Room page blocks the server for about 65 s in the preview.
- PR sweep chunk 0: 38 fixes (flip radar ignores the unreachable manager, a profile rebuild would wipe nick_override, migration clashes). They're ingested into the queues by the sweep cron.
- Morning deliverable: War Room on league 4 with real data, screenshots, MORNING-BRIEF.md.
