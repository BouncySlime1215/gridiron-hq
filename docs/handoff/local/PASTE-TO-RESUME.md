# PASTE THIS INTO A FRESH CLAUDE CODE SESSION (either account) TO RESUME GRIDIRON HQ
You are taking over Gridiron HQ, Nick's fantasy-football app, mid-run. Nick is away; work autonomously, ADHD mode for any message to him.
Read, in order, and nothing else until a task needs it:
1. /Users/nick_matta/gridiron-local/wt/handoff/docs/handoff/local/PASTE-TO-RESUME.md (this file: the State block below is current)
2. .../local/STOP-2026-09-23.md and OPS-LOG.md tail (what ran, what stopped, resume args)
3. .../local/WORK-QUEUE.md sections 12 (rulings) and the newest sections; PLAN-REORG-2026-09-23.md; WORKFLOWS-PER-STAGE.md; PHASE-DELIVERABLES.md; VERIFICATION-RULES.md; UI-STANDARD.md; BUDGET-PLAN.md
4. Memory: /Users/nick_matta/.claude/projects/-Users-nick-matta-Claude/memory/MEMORY.md and project_gridiron_autonomous_day_2026_09_22.md
Rules that bind you: models Opus 5.5 medium for builders/skeptics, Fable only for the critical list, Sonnet for lean/UI/recorders, R&D Opus high with web research; merge only through ~/gridiron-local/bin/merge-queue.sh; never delete data; nothing paid without Nick; deploy only on Nick's word; cloud routines stay off; meter watch (bin/meter-watch.sh) with a stop at 95%; % update to Nick every 20 min (token % and project % done); resume killed workflows from cache (launch/resume/*.json), never restart from zero.
Start by: re-arming the meter watcher (run bin/meter-watch.sh in the background), the 20-min status cron, the board keeper; then continue from the State block.

## State right now (refreshed 2026-09-23 ~12:55 PM ET / 16:55Z)
- Account A: weekly 78% (resets Mon 9/28 8:59 PM ET), 5-hour 49% (resets 10 AM ET). A stops launching at 87%. Account B full from 3 PM ET today: paste this file there.
- Merged today (since midnight): #97 #159 #160 #161 #162 #163 #167 #168 #169 #172 #173 #177 and more in the queue logs (~/gridiron-local/evidence/mq-*.log).
- Merge trains: big queue (log mq-big.log) then train 2 (mq-train2.log: 178 191 171 175 73 192 194 195 196 197 198 199). Rule: ONE merge-queue at a time; wait by PID, never by pgrep pattern.
- Held for Nick: migrations (#166 S-03 072, #170 FC-SNAP 073, #174 GR-01 071, #184 RL-3-2), #164 BLEND-01 (after #166), #165 HX-01 (FantasyPros yes/no), #193 glossary (no page consumer; do not merge to main alone), NICK-2025 (one ledgered 2025 look for the trade split test), NICK-WV01 exemption (streaming card), Jev cap, N1, N12.
- Loops: RL-9-3 roster-spot lineup value (w6b353mxs), S-20 snap loader + SS-01-F1 (w9wsnoehl), RL-11-1 activity receptiveness (new), R&D round 12 (new). Resume pointers: ~/gridiron-local/launch/resume/*.json.
- Plan: PLAN-V9-CORRECTIONS.md is the live plan (3 pillars; adjustments after every R&D round). Verified edges so far: lineup value vs paper value; fill-in borrowed role; final-week rest (league 1); activity = who says yes; 1-for-1 consensus edge pending a fresh test.
