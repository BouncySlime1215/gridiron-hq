# START HERE: Gridiron HQ handoff for a new coordinator (2026-09-22)

For a coordinator on a NEW Claude account with zero context. Paths are relative to the repo root.

## a. What this is

Gridiron HQ is Nick's fantasy-football-only app: Express + node:sqlite server, React client, on Fly. Repo: https://github.com/BouncySlime1215/gridiron-hq. Live: https://gridiron-hq.fly.dev.

Deployed tree is c5ee3b54 (main at #99); everything after is NOT deployed. Deploy is Nick's word only. The deploy button on main (#127) needs FLY_API_TOKEN, which is set. The brake question (memory/brake-not-in-fly-toml.md) is unanswered, so nobody presses deploy.

## b. Read order

1. This file.
2. memory/MEMORY.md (index of 945 memory files; open only what it points you to).
3. Only the handoff of the thread you are restarting: handoff/<thread>-2026-09-22.md. HANDOFF-2026-09-22.md is the master and may be partly skeleton.

Both SKILL.md files under skills/ were copied from the synced store unchanged; nothing was reconstructed.

## c. Rules that survive

- Usage is priority one: hard cap 25% of the 5-hour meter per window, pause at 20%; one fresh session at a time; no auditors until Nick says. memory/gridiron-usage-priority-rule.md, USAGE-LEDGER.md.
- Merge gate v2: CI green on the exact head plus the self-check block; owning thread squash-merges. memory/gridiron-merge-gate-rule.md, skills/gridiron-merge-gate-v2/SKILL.md.
- Verify once; no guard re-run on an unchanged tree. memory/gridiron-verify-once-and-model-by-weight.md.
- Licence before measurement. memory/gridiron-licence-before-measurement-rule.md.
- Nothing paid, ever, without Nick's word. memory/gridiron-memory-detail-2026-09-22-standing-rules.md.
- Secrets never in chat, logs or commits; presence only. memory/coach-env-dump-key-exposure-2026-09-22.md.
- No table drops or data deletion without Nick's word. memory/gridiron-scheduler-cleared-of-delete-2026-09-22.md.
- Fantasy-only scope; MLB surfaces are being removed. memory/gridiron-memory-detail-2026-09-22-standing-rules.md.
- Never rebuild a deleted page; nav is 8 tabs. memory/gridiron-ui-redesign-build-order.md.
- ADHD output style: lead with the next action, end with a "Waiting on you" line. memory/gridiron-claude-rules-location.md and the repo CLAUDE.md.

## d. Project instructions to paste into the new project's settings

Nick has ADHD. Shape every message to him accordingly: Lead with the next action, a command, a path, a snippet. Context after. Number multi-step work, one bounded action per step, fewest steps that work. Restate where we are every turn; do not assume he is holding the plan. End with one concrete thing he can do in under two minutes. Give time estimates in concrete units, never 'some work'. Say what now works, in concrete terms, rather than burying it in a recap. State cause and fix on errors. Never 'uh oh'. Keep visible lists to about five items, most relevant first. No preamble, no recap, no closing pleasantries. Finish one thing before raising the next. Break these when he asks to be walked through something, when a destructive action needs confirming, or when the rule would delete the answer. Nick's standing rule for every number, feature and page: before calling anything done, answer in writing: Is this well built? Is it based on stats, or made up? How do we know? Should this data be pointed anywhere else on the platform? How does it unify with the rest? Where the answer is 'guess', say 'guess'. Verify the consumer, not the producer; cite file:line on origin/main. Threads work with the coordinator, not Nick. One editor per server file. Never rebuild a deleted page.

## e. Skills to re-save on the new account

Save with exactly these names (threads invoke them with the anthropic-skills: prefix):

- gridiron-merge-gate-v2: skills/gridiron-merge-gate-v2/SKILL.md
- gridiron-token-efficiency: skills/gridiron-token-efficiency/SKILL.md

## f. State of work

Main tip at writing (git ls-remote origin refs/heads/main): b600afa1f344a9fc431028155711218142460c6d. After the PR board's last line: #130 954462e, #147 532fe18, #131 b600afa.

Merged today (memory/gridiron-pr-board-2026-09-22.md): #91 #89 #111 #102 #114 #68 #95 #112 #86 #87 #109 #110 #108 #99 (deployed), then not deployed: #113 #115 #117 #119 #129 #124 #92 #137 #72 #85 #122 #123 #132 #127 #121 #90 #55 #62 #133 #106 #130 #147 #131.

Open PRs (same board file; git fetch and re-check heads before acting):
- #118 cf60f5e3 (UI): CI was in progress at the stop; confirm green, squash-merge. See handoff/ui-2026-09-22.md addendum.
- #128 5f9242d8 (Scheduler, MLB removal): merges on CI green; no tables dropped.
- Trade Brain chain #94 ff38f5a2, #100 29c825cf, #103, #120 a1164dd5: merge on green in that order.
- #125 9ed12b95 (Chat sync): re-check against main. #116 98129cbc (Opportunity): squash on green. #67 a3fc5e7 (retarget base to main) then #74 7a55f75. #146 5dfedb80 (Wiring map): merges on green. #135 advisory.
- Never merge: #136, #140 to #143 (snapshots, close once read), archive/w45mur-* branches. #138 waits on #79; #139 conflicts with #138; #134 stays draft. #77 needs main and a body; #84 stacks on #77. Drafts #66 #79 #80 #83 #144 #145: Nick's call.

Continuing threads and next unit (memory/gridiron-threads-directory.md):
- Scheduler: land #128, then officials and schedules ingest from nflverse-data (memory/gridiron-nflverse-cc-by-attribution.md).
- UI: land #118, then the freshness credit-line unit, then R45(1) ceiling target.
- Wiring map: land #146, then the Coach db binding form.
- Feature audit: #67 then #74, then addendum and stop.
- Model evidence audit: #121 merged, nothing in flight. Both auditors quiet until Nick says.

## The handoff button

Local pickup: `git pull`, run `claude` in the repo, first prompt "Read docs/handoff/2026-09-22/START-HERE.md then docs/handoff/CURRENT.md and continue from CURRENT.md; work one unit at a time; before stopping, rewrite CURRENT.md with where to pick up and push it."

Local finish: tell Claude "write the handoff". It rewrites CURRENT.md, commits "docs: handoff <date>", pushes to main or opens a docs-only PR.

Cloud pickup: Nick posts "pick up" in the project chat; the coordinator reads CURRENT.md from main and starts one fresh thread from it.

Cloud finish: the coordinator rewrites CURRENT.md the same way before going idle.

## g. First three actions

1. Read memory/MEMORY.md; open nothing else until a task needs it.
2. Start ONE fresh thread from handoff/scheduler-2026-09-22.md: confirm CI on #128 head 5f9242d8, squash-merge, then the officials and schedules ingest. Give it both skills and section d.
3. Ask Nick for a usage screenshot before the second thread; log it in USAGE-LEDGER.md.

Waiting on you: paste section d into project settings, save the two skills, start action 1.
