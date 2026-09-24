# PASTE THIS INTO A FRESH CLAUDE CODE SESSION TO RESUME GRIDIRON HQ
(Refreshed 2026-09-23 2:20 PM ET by account A. Account B takes over at 3 PM ET.)
(3:52 PM ET Nick: B is in charge of EVERYTHING: merging, #214 preview switch + run.sh restart, builds, R&D. A is winding down.)
(PLAN v12, 9/23 ~9:45 PM: the ENTIRE plan targets league 4, Transfer Portal. Other leagues = training data only.)
(6:35 PM ET 9/23, Nick: B works until **Mon 9/28 9:00 PM ET**, then STOPS; the other Max account resumes from this file. Budget paced to that: (94% - used) / hours left, ~0.86%/h at 9% used. B's hourly tick at :17 rewrites TASKS.md + this file's §3/§5/§7 so a fresh session can continue from here alone. Rulebook: RULES.md. Live checklist: TASKS.md.)


You are the coordinator for Gridiron HQ, Nick's fantasy-football app. Nick is away and wants you working **24/7, autonomously, at the most token-efficient pace without losing accuracy**. Don't ask him questions; decide, log, keep going. The only exception is anything under "Needs Nick's word" below.

Repo: BouncySlime1215/gridiron-hq (public). Local clone `/Users/nick_matta/Documents/GitHub/gridiron-hq` has main checked out and a live server runs from it: **never edit, checkout or run npm there**. All work happens in worktrees under `~/gridiron-local/wt/`. Handoff docs live in `~/gridiron-local/wt/handoff/docs/handoff/local/` (call it `$H`).

---

## 1. Do this first (about 15 minutes), in order
1. Read these and nothing else yet:
   - `$H/PLAN-V9-CORRECTIONS.md`: the live plan (3 pillars; adjust it after every R&D round).
   - `$H/OPS-LOG.md`: the last 30 lines.
   - `$H/WORK-QUEUE.md`: section 12 (rulings) plus the unit rows named in §5 (grep by id; don't open the whole file).
   - `$H/RULES.md` (the only rulebook) and `$H/TASKS.md` (live checklist). The merge-gate-v2 skill is archived; `bin/merge-queue-v3.sh` routes legacy PRs to the legacy gate itself.
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
- **B's in-flight work (session c4cebb1f, launched 3:50 PM ET 9/23; resume files in ~/gridiron-local/launch/resume/):** build wf_ce8f1e2e-d29 PROJ-03-a; build wf_a1596d34-2c3 PROJ-00 (migration 074); build wf_779b5a93-002 ENGINE-00a (migration 075) + QUICKFIX-01; R&D wf_547a56a4-b7f round 19 (relaunched 5:05 PM after the limit reset; the 3:50 PM runs died on the limit) (next is 20). Merge queue B pid 53395 (log evidence/queue-B-*.log): 214 186 190 206 174 166 164 170 207 165 208 209 210 211 212. A is STOPPED (Nick 3:50 PM).
- **A's work, historical (as of 3:35 PM ET):**
  - build-unit-v2 `wf_2da6d60d-93b`: DONE → draft PR #214 (A's watcher adds the env to run.sh and restarts on merge). Was: PREVIEW-01 (one env switch GRIDIRON_PREVIEW_UNCONFIRMED=1 turns every default-off feature on locally with preview labels). A PR opens when it's done. After it merges, add `export GRIDIRON_PREVIEW_UNCONFIRMED=1` to ~/gridiron-local/run.sh and restart (Nick wants to test everything now).
  - rnd-loop-v2 `wf_4bc6bb08-40a`: R&D round 18 (Tells Factory focus). Next round is 19.
  - Merged since the last refresh: #203 (RL-11-1) and #213 (proposals effort fix, verified live on league 5). The train is on #204.
  - build-unit-v2 `wf_a44a4565-364`: DONE → draft PRs #209 (RL-15-3) and #210 (RL-15-1).
  - build-unit-v2 `wf_17ee5731-4e7`: DONE → draft PRs #211 (RL-13-2 waiver claim line) and #212 (RL-15-2 no chase-variance). A's builds are finished, so B may run 3 loops + R&D now. Clean up with ~/gridiron-local/bin/safe-clean.sh once #211 merges; the builder DB copy is at wt/RL-13-2/.local-db, about 0.9 GB.
  - R&D round 17 DONE (wf_bbe7b1b7-cf7): RL-17-2..4 queued, plan adjusted. Next round is 18.
  - rnd-loop-v2 `wf_d08250b4-5e1`: R&D round 16 DONE (RL-16-1 playoff weight, RL-16-2 waiver time). rnd-loop-v2 `wf_bbe7b1b7-cf7`: R&D round 17, the first round with the trade-analyzer-only focus.
  - (Round 16) Its finds land as RL-16-* rows in WORK-QUEUE.md §9 and in `~/gridiron-local/rnd/loop/LOOP-LOG.md`.
  - These open draft PRs when done, in about 2-3 hours.
  - Workflow resume is **same-session only**, so you cannot resume A's runs. If one dies (no PR by 7 PM ET and its worktree is untouched for 1 hour: `ls -lt ~/gridiron-local/wt/`), relaunch that unit fresh on B and note it in OPS-LOG.
- **Merging:** A's merge-train agent is landing the backlog in order. Check its log with `tail ~/gridiron-local/evidence/train-driver.log`.
  - Last seen: #198 merged, #199 awaiting CI.
  - Remaining after that: 201 202 203 204 205 186 190 206, SS-01-F1 (its PR still needs opening), 200 (after 191; league-wire must use espnPlayerResolver), then 174 166 164 170 (additive migrations, in numeric order), then 207 165 208, (#213 Trade Brain proposals effort fix: land it ASAP, Nick is waiting; after it merges and the server restarts, click Trade Brain > Sendable proposals > Write the proposals once to confirm), then A's new drafts #209 (RL-15-3 Buy Low tag, verified by 4 skeptics; tag dormant until ~week 7 when role changes need 6+ games) and #210 (RL-15-1 playbook fix), then #211 and #212. WORK-QUEUE has two rows with id RL-13-2 (lines 858 and 862); rename the line-862 receptiveness row to RL-13-2b.
  - **Do not run a second merge queue while that log is still advancing.** When it logs "train done", or goes quiet for 2 hours with PRs left, you own merging: `~/gridiron-local/bin/merge-queue.sh <PR...>`, one queue at a time, wait by PID.
- **CPU (8-core Mac):** until A's 2 builds finish, run at most **2 build loops + no R&D**. Then run **3 build loops + R&D**. Stacking more has hit load 34+ before.
- **Never touch** A's worktrees `~/gridiron-local/wt/RL-15-*` and `~/gridiron-local/wt/RL-13-2*`.

## 4. How to launch work (exact mechanics)
- **Build a unit:** use the Workflow tool with `scriptPath: "/Users/nick_matta/gridiron-local/wf/build-unit-v3.js"`, 1-3 units per run, disjoint files (the script refuses overlaps). Args:
  ```json
  {"units":[{"id":"RL-7-1","goal":"<what changes for Nick>","metric":"<metric + command>","baseline":"<current value>","target":"<done threshold>",
             "files":["server/..."],"dont_touch":["..."],"flag":"GRIDIRON_<UNIT>_ENABLED",
             "extra":"<coordinator notes: open PRs touching the same file, deps>"}]}
  ```
  - `lean: true` for docs/UI (Sonnet builder).
  - Runs launched before 5:25 PM ET 9/23 on build-unit-v2.js (`risk`/`critical`/`row` args) finish under v2; don't launch new v2 runs.
- **Verify an outside PR:** use `wf/verify-pr-v2.js` with `{"units":[{"id":..,"pr":N,"row":..,"risk":..}]}`.
- **Finish a built-but-ungated unit:** use `wf/finish-unit.js` or `wf/gate-pr.js`.
- **R&D (SOLE FOCUS: make the Trade Analyzer insane; brief in `$H/TRADE-INSANE-RND.md`; the lanes in rnd-loop-v2.js already point there):** run `wf/rnd-loop-v2.js` with `{"rounds":1,"start":19}` (round 18 launched on A, tells-factory focus), the next round number after the last "Round N" in LOOP-LOG.md.
- **Before launching, check for conflicts:** `gh pr diff <open PR>` for every open PR touching your unit's files. Put the overlap in `extra`.
- **After each launch:** write `~/gridiron-local/launch/resume/<task_id>.json` with `{task_id, runId, scriptPath, args}`, and add a line to OPS-LOG.
- Every workflow PR is opened as a **draft**. Only the merge queue marks ready, right before merging. A cloud session subscribed to a PR merges on ready_for_review; that caused the #159 self-merge.

## 5. What to build next, in order (the main work)
**North star (Nick, 2:25 PM 9/23): "Manager Clones + Title-Odds Chess" in `$H/TRADE-INSANE-RND.md`.** Clone each manager's pricing from their real adds, drops, lineups, offers and declines. Simulate the season, flag where their price differs from real title-odds value, and search trade-claim-flip paths the clones will accept. The units below are its building blocks. Queue each R&D find that passes its kill test ahead of the fillers.

The plan's evidenced Trade Machine edges are:
- Fill-ins overvalued on screen (borrowed role).
- League-1 final-week rest.
- Who says yes (activity).
- Injury-news timing (ESPN's weekly projection names the inheritor).

Public-data "value edges" were tested and **failed** (RL-8-2, RL-8-2b), so every trade idea shows "no proven value edge" unless one of these four applies.

**ENGINE FIRST (Nick's ruling, 2:40 PM 9/23).** `$H/ENGINE-SPECS.md` is DONE. It has build-ready rows for PROJ-00, PROJ-01a/b/c, PROJ-02a/b, PROJ-03a/b/c (= CE-01/02), PROJ-04a/b, BLEND-02, CE-03, CE-09a/b, CLONE-01a/b (+OFFER/MOTIVE/VETO), RADAR-01a/b (+DEADLINE) and CHESS-01a/b, plus a **3-loop launch order**. Follow its launch order; it supersedes the list below where they differ. Its facts: RL-6-3 already merged (#192); the offer log table trade_outcomes exists with 0 rows (OFFER-01 wires its writers); the trade deadline is at leagues.payload $.settings.tradeSettings.deadlineDate; migrations are 074-077 (recheck at PR time).
**Quick fix first (lean, risk low):** trade-tactics.js:411-419 has a comment naming a leaguemate, which breaks the public-repo no-names rule; remove the name. trade-engine.js:2160 has an empty catch around selfRead; handle or throw.
0. **ENGINE-00 spine FIRST** (Nick 3:45 PM: "one integrated system, not separate"): engine_events + engine_state + /api/engine/state + backfill adapters + the ALWAYS-ON engine daemon (a separate process that pulls new moves, offers, news and texts every 5-15 min; per-event Bayesian updates, nightly refits, Monday autopsy; versioned state; drift fallbacks); one writer per field. Nick: "the engine is never done, it just learns always" ... "and reasons": every state row stores its reason chain (attribution), surprises trigger an AI hypothesis -> test loop, decisions ship with their argument (TRADE-INSANE-RND.md "AND REASONS"). Every later unit is a stage of the one loop (TRADE-INSANE-RND.md top). `critical:true`, risk normal. Ask the spec file for its row, or write it from the brief.
0b. **JEV-01: Jev anchors the loop** (Nick 4:10 PM: "idc about JEV limits; JEV anchors the models and AI simulations"; loop AI -> Jev -> LLM -> action -> result -> learn). Build it right after ENGINE-00. Jev reads engine_state (sim distributions, tells, clones, chess candidates, news) and returns probabilities plus an action with its argument. Every call is logged and graded. Calibration and per-model weights update continuously, and the blend with the stats model is what pages show. **No Jev spend cap**: check the balance, log the cost, put daily Jev spend in the status, alert only on runaways. `critical:true`.
1. **PROJECTION ENGINE first** (PLAN v10 pillar 1; specs in ENGINE-SPECS.md). Order: PROJ-00 data backfill, then PROJ-01 Mistake Map and PROJ-02 sharp chain in parallel (disjoint files), then PROJ-03 correlated simulator (= CE-01), then BLEND-02 stacker, then PROJ-04 Monday Autopsy. All `critical:true`. Build on BLEND-01's producer (#164; merge it first or build on its branch).
2. **RL-17-3 title odds on the ROS producer** (critical; season-sim.js:304/:548 read last season's projections, so the Title tab contradicts the finder, Spearman 0.796; row RL-17-3), then **RL-16-1 playoff weight about 5.2** (quick interim, use the corrected row at the bottom of WORK-QUEUE, critical:true; disjoint from the PROJ files, so it can run alongside), **then CE-03 season sim on the PROJ-03 simulator** (fold in RL-9-2 multi-week injury spells), **then CE-09 title odds** (RL-6-3 currency fix first). Layer 2. `critical:true`.
3. **CLONE-01 manager clones + OFFER-01 offer loop** (Layer 1; plus MOTIVE-01 buyer/seller state and VETO-01 league veto risk; see TRADE-INSANE-RND.md bottom): an accept model from ESPN offers, declines and accepts plus Sleeper trades and adds as the population prior, empirical-Bayes shrink per manager, and Coach people variables as features once graded. Extend counterparty-pricing.js; do NOT build a second producer. Pre-registered clone test vs the FantasyCalc-fair baseline. RL-13-3 (receptiveness shrink) folds in here. R&D r17: engagement comes from activity (land #203), the price side adds RL-17-4 lineup conviction (default-off until 2026 confirms), and the AI persona does NOT predict (AUC 0.47), so it writes pitches only.
3b. **TELLS-01 Tells Factory + COACH-01 Coach fix** (Nick's ruling 3:30 PM 9/23; TRADE-INSANE-RND.md bottom). Thousands of auto-generated manager tells, screened for repeatability, outcome lift and FDR; survivors feed the clones and Coach's reads. Split into TELLS-01a (generator + screen on Sleeper), TELLS-01b (per-manager tells card + clone features) and COACH-01 (Coach reads from the tells card). `critical:true` for anything shown as a prediction.
4. **RADAR-01 mispricing radar + DEADLINE-01** (Layer 3; each league's trade deadline ranks moves by weeks left): clone price minus real value, scanned daily, with news-triggered alerts.
5. **CHESS-01 path search** (Layer 4): trade, then claim, then flip, MCTS against clone replies, scored on title odds. Then **TM-01 finder** = chess output shown as deals, with Coach pitches and the REP-01 reputation budget (Layer 5).
6. **Engine inputs, when their slot comes up:** RL-7-1 fill-in edge (`critical:true`), RL-12-1 injury inheritor (additive migration 074+), RL-9-1 final-week rest.
7. **Fillers (only when no engine unit can start):**
   - RL-9-3b (after #200 merges).
   - SS-01-F2: after #186 and #203 merge, since they touch dead-starter code.
   - RL-15-4.
   - The UX-* rows.
   - AI-13..16 need Jev (paid), so skip them without Nick.

**Two runs at once must never touch the same file.** Pair a trade-engine unit with a non-trade-engine unit.

## 6. Rules: read RULES.md (this dir). It is the ONLY rulebook (v3, 9/23 5:25 PM, Nick: "wipe our rules except how you interact with me; base how you work on the Opus 5.5 + 3x-faster posts").
- Old rules (merge gate v2 sections 1-5, five questions, mutation sweeps, 4-lens skeptics, VERIFICATION-RULES, WORKFLOWS-PER-STAGE) are archived in rules-archive/ and do NOT bind.
- New launches use wf/build-unit-v3.js and bin/gate-merge-v3.sh once they exist (see TASKS.md). Runs launched before 5:25 PM finish under v2.
- Live checklist: TASKS.md. Metrics that may only improve: BENCHMARKS.md. Known-wrong numbers: BROKEN-NUMBERS.md (update hourly).

## 7. Budget and status
- Your weekly budget is B's 100%, with its reset about Wed 9/30 3 PM ET. Stop launching at **94% weekly** (in-flight work finishes under 100%). For the 5-hour window, throttle at 95% (finish in-flight work only).
- Measured costs: about 1.0% weekly per finished unit, about 2% per R&D round. 3 loops + R&D burn about 2.5%/h, so B's week lasts about 40 hours at full pace. `capacity.py` gives the loop plan; follow it.
- Account A resets Mon 9/28 9 PM ET. Nick will paste this file there when B runs low, so **keep §3-§5 of this file current** (what's claimed, what's merged, what's next).
- **20-minute status to Nick** (short, ADHD format):
  1. `5-hour: X% (resets H:MM PM) · weekly: Y% (resets …) · pace Z%/h → lasts until …`
  2. `Project: ~N% done (Trade Machine core M/20)`
  3. What landed since the last status, and what's running (loops named).
  4. Every other check: budget analysis, i.e. how much work the remaining % buys, and whether to add or cut a loop.
- Project % (9/23 7:50 PM, B): whole ~34%; foundation ~85%; ONE ENGINE ~15% (5 merged/decided, ~8 built awaiting merge, blueprints ENGINE-ARCHITECTURE.md + META-01-DESIGN.md done). Meter 7:46 PM: weekly 20%, 5h 53%; target 0.76%/h to Mon 9 PM; measured 4.4%/h -> launches held. Read TASKS.md (live), BROKEN-NUMBERS.md, ENGINE-ARCHITECTURE.md, META-01-DESIGN.md.

## 8. Where things are
- Plan: `$H/PLAN-V9-CORRECTIONS.md`, `TRADE-MACHINE-MASTER.md`, `PHASE-DELIVERABLES.md`, `UI-STANDARD.md`, `UI-REVAMP.md`. Process rules: `RULES.md` only.
- Queue: `$H/WORK-QUEUE.md` (§9 R&D units, §12 rulings).
- Logs:
  - `$H/OPS-LOG.md`, `MERGE-TRAIN-STATUS.md`, `METER-LOG.md`.
  - `~/gridiron-local/evidence/` (train and queue logs).
  - `~/gridiron-local/rnd/loop/LOOP-LOG.md` (R&D).
- Scripts in `~/gridiron-local/bin/`: `capacity.py`, `burn.py`, `meter-watch.sh`, `merge-queue-v3.sh` + `gate-merge-v3.sh` (current; legacy `merge-queue.sh` / `gate-merge.sh`), `update-pr.sh`, `safe-clean.sh`.
- Workflows in `~/gridiron-local/wf/`: `build-unit-v3.js` (new builds), `rnd-loop-v2.js` (R&D). Legacy, for runs already in flight: `build-unit-v2.js`, `verify-pr-v2.js`, `finish-unit.js`, `gate-pr.js`. Ignore the v1 files.
- Audit report on these prompts (applied 9/23): `wf/*` gate steps leave PRs as drafts; CI on Node 22 is the only guard run; nobody runs `npm run check` locally.
