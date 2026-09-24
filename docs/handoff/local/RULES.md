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
