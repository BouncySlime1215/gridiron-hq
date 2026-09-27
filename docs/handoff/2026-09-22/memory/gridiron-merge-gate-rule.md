---
name: gridiron-merge-gate-rule
description: "Merge gate EFFECTIVE 18:06Z 2026-09-22 (Nick's GO 18:05:09Z): CI green on the exact head on current main + self-check block in the PR body → the owning thread squash-merges its own PR and sends the sha; Evidence Auditor no longer re-runs suites (read-only ledger + main watch); Independent Auditor only for model/projection/trade-valuation/lineup/inventory-number PRs. Replaces the serial Evidence Auditor gate"
metadata:
  type: project
  modified: 2026-09-22T19:12:00.000Z
---
**Authority:** Nick 18:05:09Z (cmsg_01YAsw8AnFv4ioRMQw8dfPmTFxMP9LnqiBLjwYRDmpMpWi) verbatim: "so this will do what i want - quality, token spend, wiring, and accruacy and speed are my main concerns / i want it to be good and build quick but in depth and thorugh and no mistakes" = GO on the coordinator's 18:03Z recommendation (cmsg_01YAsw8AnFv4ioRMQw8dfPmTFEYJVptsJu8YvUmyNcehxn). Reply cmsg_01YAsw8AnFv4ioRMQw8dfPmT8hCnDHHvrkRWUrRx5skCrT asked him to save the skill card and offered "keep the reader" to restore the Evidence Auditor if he wants it.

**Skill: threads load `gridiron-merge-gate-v2` (Nick saved 18:13:38Z; v1 `anthropic-skills:gridiron-merge-gate` superseded)** — section map [[gridiron-merge-gate-self-audit-skill]].

**The gate (every PR):**
1. Rebase onto current main; run the one guard (`npm run check`, six steps, wiring included) on the exact head you push.
2. CI green on that exact head (run id on the pushed sha, not an older one) [[gridiron-rebase-before-merge-lesson]]. **Gate-changing PRs** (wiring map, reach grader, contract check, tree-scanning tests) additionally merge current main and run that gate locally in the minute before merging [[gridiron-gate-pr-merge-main-first-lesson]].
3. **Self-check block in the PR body (four parts):** (i) guard command + exit code; (ii) RED/GREEN cited per R52.2 (#N + subject + sha, RED assertion inline) [[gridiron-evidence-citation-rule]]; (iii) the five questions — Nick's 2026-09-20 list is the ONLY list, the four PR facts (defect file:line, incumbent by command, not covered, what would make it wrong) under the same heading [[gridiron-five-questions-rule]]; (iv) **one liveness proof per behaviour change** — RED fails on the unfixed code, or a named mutant dies (Auditor R63, 18:10Z: CI green alone missed #130's two dead tests, #135's surviving mutant and #119's false note). Run `gridiron-merge-gate-v2` on yourself before pushing.
4. The owning thread squash-merges its own PR and sends the merge sha to the coordinator. Docs-only PRs: CI green alone.
5. **Evidence Auditor** no longer re-runs suites: keeps a merge ledger, watches main's push run after each merge, checks bodies for the self-check block and sha reachability — read only.
6. **Independent Auditor** (R63: scope = statistical claims) still GATES #121, #132 (final read on the rebased head), #106; ADVISORY on #130/#135/#133; #72/#62/#74 heads go to it before merge; old in-scope PRs #38/#40/#44/#43/#60/#15 are OUT of this pass. Everything else merges on 1-4.

**What was given up (told to Nick 18:01Z):** the RED re-run, the PR-text-vs-code check, and a second reader. Deploy stays his word, one deploy at the end of the pass, brake re-arm question first. Fleet cut that came with it: [[gridiron-state-1284-2026-09-22]]; thread status [[gridiron-threads-directory]].
