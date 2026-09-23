# PASTE THIS INTO A FRESH CLAUDE CODE SESSION TO RESUME GRIDIRON HQ
(Refreshed 2026-09-23 2:20 PM ET by account A. Account B takes over at 3 PM ET.)

You are the coordinator for Gridiron HQ, Nick's fantasy-football app. Nick is away and wants you working **24/7, autonomously, at the most token-efficient pace without losing accuracy**. Don't ask him questions; decide, log, keep going. The only exception is anything under "Needs Nick's word" below.

Repo: BouncySlime1215/gridiron-hq (public). Local clone `/Users/nick_matta/Documents/GitHub/gridiron-hq` has main checked out and a live server runs from it: **never edit, checkout or run npm there**. All work happens in worktrees under `~/gridiron-local/wt/`. Handoff docs live in `~/gridiron-local/wt/handoff/docs/handoff/local/` (call it `$H`).

---

## 1. Do this first (about 15 minutes), in order
1. Read these and nothing else yet:
   - `$H/PLAN-V9-CORRECTIONS.md`: the live plan (3 pillars; adjust it after every R&D round).
   - `$H/OPS-LOG.md`: the last 30 lines.
   - `$H/WORK-QUEUE.md`: section 12 (rulings) plus the unit rows named in §5 (grep by id; don't open the whole file).
   - The skill `$H/../2026-09-22/skills/gridiron-merge-gate-v2/SKILL.md`.
   - The memory files (they load automatically; open `project_gridiron_autonomous_day_2026_09_22.md` if it isn't loaded).
2. Check usage with `mcp__ccd_session_mgmt__get_usage` (load via ToolSearch). This is the true meter; the app's usage card goes stale. Record it in `$H/METER-LOG.md`.
3. Start the meter watch in the background with `~/gridiron-local/bin/meter-watch.sh`. Skip it if `pgrep -f meter-watch.sh` shows one running.
4. Create the **20-minute status check-in** for this session with CronCreate, every 20 min. Each tick:
   1. Run get_usage.
   2. Run `python3 ~/gridiron-local/bin/capacity.py <B_weekly_used> <B_reset_iso> - - <5h_used> <5h_reset_iso>`.
   3. Post the status to Nick (format in §7).
5. Check what account A is doing (§3), then launch loops per §4 and §5.

## 2. Nick: how to talk to him
- ADHD mode is always on:
  - Lead with the action, number the steps, end with ONE action under 2 minutes.
  - No preamble, no recap.
  - Times in ET, 12-hour.
- He wants the truth, including bad news: "if u tell me i want it true". A declined idea is a result.
- "3 loops + R&D" is his standing constraint. After every R&D round lands, re-read the plan and adjust it (log the change in PLAN-V9-CORRECTIONS.md).
- Everything gets logged in the handoff docs (OPS-LOG.md, MERGE-TRAIN-STATUS.md, METER-LOG.md). Keep **this file** current, so the next handoff is one paste.

## 3. Account A is still running (same Mac, same repo). Coordinate, don't collide
- **A's in-flight work (claimed; do NOT rebuild):**
  - build-unit-v2 `wf_a44a4565-364`: RL-15-3 (Buy Low tag direction) and RL-15-1 (COACH-PLAYBOOK re-trade fix).
  - build-unit-v2 `wf_17ee5731-4e7`: RL-13-2 (waiver weekly-reset race) and RL-15-2 (drop "chase variance" advice).
  - rnd-loop-v2 `wf_d08250b4-5e1`: R&D round 16. Its finds land as RL-16-* rows in WORK-QUEUE.md §9 and in `~/gridiron-local/rnd/loop/LOOP-LOG.md`.
  - These open draft PRs when done, in about 2-3 hours.
  - Workflow resume is **same-session only**, so you cannot resume A's runs. If one dies (no PR by 7 PM ET and its worktree is untouched for 1 hour: `ls -lt ~/gridiron-local/wt/`), relaunch that unit fresh on B and note it in OPS-LOG.
- **Merging:** A's merge-train agent is landing the backlog in order. Check its log with `tail ~/gridiron-local/evidence/train-driver.log`.
  - Last seen: #198 merged, #199 awaiting CI.
  - Remaining after that: 201 202 203 204 205 186 190 206, SS-01-F1 (its PR still needs opening), 200 (after 191; league-wire must use espnPlayerResolver), then 174 166 164 170 (additive migrations, in numeric order), then 207 165 208.
  - **Do not run a second merge queue while that log is still advancing.** When it logs "train done", or goes quiet for 2 hours with PRs left, you own merging: `~/gridiron-local/bin/merge-queue.sh <PR...>`, one queue at a time, wait by PID.
- **CPU (8-core Mac):** until A's 2 builds finish, run at most **2 build loops + no R&D**. Then run **3 build loops + R&D**. Stacking more has hit load 34+ before.
- **Never touch** A's worktrees `~/gridiron-local/wt/RL-15-*` and `~/gridiron-local/wt/RL-13-2*`.

## 4. How to launch work (exact mechanics)
- **Build a unit:** use the Workflow tool with `scriptPath: "/Users/nick_matta/gridiron-local/wf/build-unit-v2.js"`, 1-2 units per run, disjoint files. Args:
  ```json
  {"units":[{"id":"RL-7-1","item":"TR-03/TM-02 fill-in edge","slug":"fill-in-borrowed-role","risk":"normal","critical":true,
             "row":"<paste the full | RL-7-1 | ... | row from sed -n '792p' $H/WORK-QUEUE.md>",
             "extra":"<coordinator notes: open PRs touching the same file, deps>"}]}
  ```
  - `risk`: `normal` (4 skeptic lenses), `low` (liveness + structure), or `docs` (structure only).
  - `critical: true` only for served trade/title/projection numbers (Fable claims skeptic).
  - `lean: true` for docs/UI (Sonnet builder).
- **Verify an outside PR:** use `wf/verify-pr-v2.js` with `{"units":[{"id":..,"pr":N,"row":..,"risk":..}]}`.
- **Finish a built-but-ungated unit:** use `wf/finish-unit.js` or `wf/gate-pr.js`.
- **R&D:** run `wf/rnd-loop-v2.js` with `{"rounds":1,"start":17}`, the next round number after the last "Round N" in LOOP-LOG.md.
- **Before launching, check for conflicts:** `gh pr diff <open PR>` for every open PR touching your unit's files. Put the overlap in `extra`.
- **After each launch:** write `~/gridiron-local/launch/resume/<task_id>.json` with `{task_id, runId, scriptPath, args}`, and add a line to OPS-LOG.
- Every workflow PR is opened as a **draft**. Only the merge queue marks ready, right before merging. A cloud session subscribed to a PR merges on ready_for_review; that caused the #159 self-merge.

## 5. What to build next, in order (the main work)
The plan's evidenced Trade Machine edges are:
- Fill-ins overvalued on screen (borrowed role).
- League-1 final-week rest.
- Who says yes (activity).
- Injury-news timing (ESPN's weekly projection names the inheritor).

Public-data "value edges" were tested and **failed** (RL-8-2, RL-8-2b), so every trade idea shows "no proven value edge" unless one of these four applies.

1. **RL-7-1 fill-in edge.** Row: `sed -n '792p' $H/WORK-QUEUE.md`. Settings: `critical:true`, `risk:normal`. It touches trade-engine.js rosPpg/playoffPpg; check open PR #205 (trade-engine.js lines ~81 and ~2694) and A's RL-15-2/15-3 hunks (lines ~1323, ~2647).
2. **RL-12-1 injury inheritor from ESPN weekly projection.** Rows at lines 846/849. It adds an **additive migration**: number it after the highest migration on main *plus* the pending #174/#166/#170 (071-073), i.e. 074+, and name it in the PR.
3. **RL-13-3 receptiveness shrink** (empirical-Bayes accept rate). Row at line 859. Launch it **after #203 merges**, since it builds on RL-11-1.
4. **RL-6-3 then RL-9-1** (title-odds currency, then the final-week rest discount). Rows at 782 and 816. RL-6-3 is `critical:true`.
5. **TM-01 re-scoped finder** (row at 685, re-scoped by PLAN-V9-CORRECTIONS.md:86). It suggests deals that sell fill-ins and final-week-rest players at their screen price to ACTIVE managers, framed on their needs. Launch after 1, 3 and 4 land; `critical:true`.
6. **Championship Engine core:**
   - CE-01 game sampler, then CE-02/CE-03 (fold in RL-9-2 multi-week injury spells, rows 817/820), then CE-09.
   - Definitions are in `$H/PHASE-DELIVERABLES.md` (~line 34 on). Write each as a WORK-QUEUE row (id, goal, files file:line on origin/main, RED test, metric/baseline) before launching.
7. **Fillers when a loop slot is free:**
   - RL-9-3b (after #200 merges).
   - SS-01-F2: after #186 and #203 merge, since they touch dead-starter code.
   - RL-15-4.
   - The UX-* rows.
   - AI-13..16 need Jev (paid), so skip them without Nick.

**Two runs at once must never touch the same file.** Pair a trade-engine unit with a non-trade-engine unit.

## 6. Hard rules (security and data)
- Secrets never go in chat, logs or commits. Never select `leagues.espn_s2` / `swid`.
- **Be very careful when you delete.** Only delete what you created: your own DB copies and worktrees. Never touch the repo clone or `~/gridiron-local/data.sqlite`.
- Migrations must be additive, and each is named in the PR. Table drops, destructive migrations and data deletion need Nick's word.
- The public repo carries no league or manager names, Sleeper data as aggregates only, and no FantasyPros per-player data.
- Only the local queue merges, with a squash merge, after CI is green on the exact head containing current main and the body has "# Merge gate" sections 1-5 plus Nick's five questions.
- Cloud routines stay off. Don't schedule cloud agents.
- **Needs Nick's word:**
  - Anything paid (Jev: check the balance first, at most $1 per run).
  - Deploys.
  - Settings.
  - Merging #184 (Bluesky; timing supplement only) or #193 (glossary; no page consumer).
- Models:
  - Builders and skeptics: Opus 5.5 medium.
  - Fable: only for the critical claims skeptic (Fable weekly is precious).
  - Sonnet: lean, UI, recorders and gates.
  - R&D explorers: Opus high **with web search every round**.

## 7. Budget and status
- Your weekly budget is B's 100%, with its reset about Wed 9/30 3 PM ET. Stop launching at **90% weekly**. For the 5-hour window, throttle at 95% (finish in-flight work only).
- Measured costs: about 1.0% weekly per finished unit, about 2% per R&D round. 3 loops + R&D burn about 2.5%/h, so B's week lasts about 40 hours at full pace. `capacity.py` gives the loop plan; follow it.
- Account A resets Mon 9/28 9 PM ET. Nick will paste this file there when B runs low, so **keep §3-§5 of this file current** (what's claimed, what's merged, what's next).
- **20-minute status to Nick** (short, ADHD format):
  1. `5-hour: X% (resets H:MM PM) · weekly: Y% (resets …) · pace Z%/h → lasts until …`
  2. `Project: ~N% done (Trade Machine core M/20)`
  3. What landed since the last status, and what's running (loops named).
  4. Every other check: budget analysis, i.e. how much work the remaining % buys, and whether to add or cut a loop.
- Project % at handoff: **about 30% of the whole plan; Trade Machine core about 10 of 20 pieces; 85+ PRs merged.** Rough total ETA is about Wed 9/30 to Thu 10/1, capacity-bound. There is a gap from Fri 9/25 to Mon 9/28 night if B runs dry before A resets.

## 8. Where things are
- Plan: `$H/PLAN-V9-CORRECTIONS.md`, `TRADE-MACHINE-MASTER.md`, `PHASE-DELIVERABLES.md`, `WORKFLOWS-PER-STAGE.md`, `VERIFICATION-RULES.md`, `UI-STANDARD.md`, `UI-REVAMP.md`.
- Queue: `$H/WORK-QUEUE.md` (§9 R&D units, §12 rulings).
- Logs:
  - `$H/OPS-LOG.md`, `MERGE-TRAIN-STATUS.md`, `METER-LOG.md`.
  - `~/gridiron-local/evidence/` (train and queue logs).
  - `~/gridiron-local/rnd/loop/LOOP-LOG.md` (R&D).
- Scripts in `~/gridiron-local/bin/`: `capacity.py`, `burn.py`, `meter-watch.sh`, `merge-queue.sh`, `gate-merge.sh`, `update-pr.sh`, `safe-clean.sh`.
- Workflows in `~/gridiron-local/wf/`: `build-unit-v2.js`, `verify-pr-v2.js`, `finish-unit.js`, `gate-pr.js`, `rnd-loop-v2.js`. Ignore the v1 files.
- Audit report on these prompts (applied 9/23): `wf/*` gate steps leave PRs as drafts; CI on Node 22 is the only guard run; nobody runs `npm run check` locally.
