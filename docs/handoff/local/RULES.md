# Gridiron HQ: how we work (v3, 2026-09-23 5:25 PM ET)
Replaces every earlier process rule. Nick's ruling: "wipe our rules except how you directly interact with me; rules on how you work should be based off" two claude.dev posts:
- "Getting the most out of Opus 5.5" (how to ask, steer long runs, check results).
- "How we made claude.ai 3x faster in two weeks" (measure, parallel narrow threads, ratcheting gates, flags, be bold inside guardrails).
Old rules are archived in `rules-archive/` for reference only. They do not bind anyone.

## 0. Talking to Nick (unchanged)
ADHD mode from ~/.claude/CLAUDE.md, always on. Times in ET. Tell the truth, including declines.

## 1. Measure first
- Every unit starts from a NUMBER: the metric it moves, its current value, the command that measures it. If it can't be measured, make the measurement first (that is the unit).
- Prefer deterministic lab benchmarks (fixed seeds, frozen DB copy, held-out seasons) that track the real outcome. Validate in the lab, then confirm live.
- Held-out data stays held out: fit on older seasons, grade on newer ones, 2025 untouched unless ledgered. This is what makes a number trustworthy, not ceremony.

## 2. Ratchet, don't review by hand
- `BENCHMARKS.md` (this dir) lists every tracked metric with its best value and command. A PR may only hold or improve them. A regression is refused unless the PR body says why and Nick's goal is served.
- CI green on the exact head containing current main is the only merge gate. Automated checks beat reading.
- Before merge, one reviewer agent reads the DIFF (not the story) and reports real defects. Fix or drop what it finds.

## 3. Flags for anything risky
- New served numbers, models and page changes ship behind a default-off flag (GRIDIRON_PREVIEW_UNCONFIRMED shows them locally). Turn on when the benchmark says so. Remove flags once settled; no flag lives past ~2 weeks unused.

## 4. Many narrow threads, bold inside the guardrails
- One unit = one benchmark or one user journey, one PR. Run many in parallel on disjoint files; the CPU cap is the limit (~3 build loops + R&D on this 8-core Mac, load under ~20).
- Hand each agent the WHOLE task in one message: goal, the metric and target ("done" threshold), files, what it must not touch, when to stop. No "think carefully" filler.
- Be ambitious. A declined idea is a result; log it and move on.
- Drop low-impact work whose complexity isn't worth its gain.

## 5. The loop
measure -> reproduce -> PR (draft) -> CI -> diff review -> merge -> local app updated -> check live -> ratchet the benchmark -> next.
Keep Nick's local app current after each merge batch (ff clone, restart run.sh, health 200), and look at the changed pages.

## 6. Checking results
- Split big audits across subagents, then VERIFY each subagent's key claim yourself (re-run its command or a spot check) before it goes to Nick or into a plan. Subagent reports are leads, not facts.
- Analytical write-ups mark what could not be confirmed and where they looked.
- Show Nick what needs him first, then the summary.

## 7. Stopping conditions
Autonomous (just do it): builds, R&D, merges through the queue, specs, local restarts, plan changes, Jev calls (no cap; log spend, alert on runaways).
Needs Nick: deploys; settings/account changes; other paid services; merging #184 or #193; table drops, destructive migrations, data deletion; anything irreversible outside our own worktrees and DB copies.
Budget: stop launching at 94% weekly; finish in-flight work.

## 8. Guardrails (the only hard rules)
- Secrets never in chat, logs, commits. Never read espn_s2 / swid values.
- Delete only what we created. Never edit/checkout/npm in ~/Documents/GitHub/gridiron-hq; never write ~/gridiron-local/data.sqlite (use copies).
- Public repo: no league or manager names, Sleeper as aggregates only, no FantasyPros per-player data.
- Additive migrations only, numbered uniquely.
- PRs open as drafts; only the local merge queue marks ready and merges.

## 9. Memory that survives summarization
- `TASKS.md` (this dir) is the live checklist: what's running, what's next, what's blocked. Update it at every launch, merge and decision.
- OPS-LOG.md is the history. PASTE-TO-RESUME.md points here.

## Two lanes, always busy (Nick 9/23 ~10:35 PM: "you're not launching anything locally; you need to do both constantly and monitor both")
Every 15-minute tick checks BOTH lanes and refills whichever is idle:
- LOCAL lane (this Mac, desktop account): at least 1 R&D round (rnd-loop-v3, next NORTH-STAR-RND component) OR build loop running, plus the merge train (ordered, merge-order.txt) and local-checks.sh. Only one workflow at a time; check load with uptime (< 12) and run ~/claude-handoff/usage.sh first.
- CLOUD lane (other Max account): keep up to 6 sessions running from CLOUD-QUEUE.md.
Each tick logs one line: "local: <what's running> | cloud: <n running> | merged: <n>".
- Workflows (Nick 9/23 11:35 PM: "workflows opening on their own without me"): exactly one R&D/build workflow always running in the coordinator session. On every workflow-complete notification, verify + record, then IMMEDIATELY launch the next entry of ~/gridiron-local/lanes/workflow-queue.json. Backup: the 10-minute WORKFLOW KEEPER cron does the same if none is running.

## NO STOPPING (Nick 9/24 12:10 AM, standing until Mon 9/28 9 PM ET)
- Work never stops. Every lane refills itself the moment something finishes: build workflows (4) + R&D workflow (1) in the coordinator session, local claude -p jobs (5) via lane-keeper, sweep/fix agents. On any completion notice, immediately launch the next queued item before doing anything else.
- The other account's cloud is done (42 sessions, about $210 of $250). New cloud work goes through THIS account (Agent isolation 'remote'), with builds here as the fallback.
- Every 20 min: PR SWEEP. Read each new or updated PR's claims, its Not-confirmed section and its gaps, and queue the fixes.
- Scope for the night: Coach anchors everything (COACH-ANCHOR.md), the rest of the platform (BUILD-PLAN.md phases 0-4), the War Room UI v3.
- Mac load cap (Nick 9/24 12:05 AM: "Mac is super slow, push it but it needs to function"): local lane 2 jobs, 4 build workflows, R&D only when the 5-min load is under 14. Only ONE produce-plans run at a time on the Mac (each run is 2-3 min alone; 5 at once took 20+ min each, load 27). Heavy work goes to cloud (main account, usage guard 70%).

## CONVERGE GATE (coordinator step-back 9/24 12:45 AM, Nick: "step back, reconsider the structure, is the wiring loose?")
Finding: 75 open PRs; none of the north-star core (planner, reader, counterpart, War Room, engine spine, report card, Coach tools) is on main; 4 red spots, each a piece built twice or more. More stacking makes it worse.
Rule: NEW FEATURE builds are HELD (lanes/build-queue-held.json) until (a) merge batches 1+2 are merged, (b) the engine spine hub (#216 + #250) and ONE-READER, ONE-PLANNER and ONE-COUNTERPART are merged, each publishing its fields to the hub, (c) the War Room loads league 4 on main without freezing, (d) open cloud/local PRs number fewer than 35. Until then, build workflows run only CONVERGE units, fix units and merge work. Cloud runs only FIXB batches.
Step-back: every 2 h, redraw the platform model (sources -> readers -> brain -> screens, colored main / PR / loose) and re-check this gate, FIELD-REGISTRY.md, and whether the plan still fits the goal.
