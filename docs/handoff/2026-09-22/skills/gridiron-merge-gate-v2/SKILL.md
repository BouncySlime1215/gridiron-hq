---
name: "gridiron-merge-gate-v2"
description: "Use instead of gridiron-merge-gate: the self-audit run before pushing or opening a PR in gridiron-hq, with the liveness proof, Nick's five questions and the fresh-session rule."
---

# Gridiron HQ merge gate (self-audit), v2

Supersedes gridiron-merge-gate. Run this on the exact tree you are about to push. Every item is pass or fail; a fail means fix, not explain. Put the results in the PR body under a heading "Merge gate", with commands and exit codes. A PR merges when CI is green on that exact head on current main and the body carries sections 1 to 5 below. Model, projection, trade-valuation, lineup and inventory-number changes additionally go to the Independent Auditor before merge.

## 1. One guard run on one tree
1. `git fetch origin main && git merge origin/main` (merge, never rebase, on a branch someone else may have checked out or that already carries merge commits; on your own linear branch follow the repo convention).
2. `git status --porcelain` must be empty. Record `git write-tree`.
3. The guard run is CI on Node 22 (typecheck, lint, wiring check, tests, build, smoke) on the exact head that contains current main; nothing merges until it is green. Locally, run the unit's targeted test files and record tests / pass / fail / skip.
4. If package-lock.json changed, run `npm ci` in your worktree before trusting a local number.
5. Record `git write-tree` again; it must equal step 2. Nothing outside `client/dist` may change.
6. A wiring exit 1 on a branch that contains current main is your branch's own finding. Do not add accept-list entries in files you do not own; report them.
7. Never edit a shared guard script in place while any run may be using it; write a new versioned file.

## 2. TDD record with a liveness proof
- A RED commit whose test fails for the defect, a GREEN commit that makes it pass, and an evidence file under `docs/tdd/`.
- Cite RED and GREEN as `#N`, commit subject, and sha. Quote the RED's failing assertion inline. Both shas must be ancestors of the head you push. Update the shas in the same push that rewrites them. Never rewrite a merged evidence file.
- **Liveness proof, one per behaviour change:** show that the test fails against the unfixed code, or that a named mutant dies. A green test that also passes on the broken code proves nothing. Re-run RED after every assertion change, not only after writing it.
- Mutation sweep: mutate the unit AND the call site (the argument or predicate the caller passes). A rule that tests a predicate-taking function is not a rule about the predicate; pin the injected predicate directly and keep the call-site mutant as a standing row. A surviving mutation means the test is wrong or the code is redundant; record it as survived, then fix.
- Every mutation spec needs a designed surviving control and a designed not-applied control.
- Fix the implementation, not the test, unless the test is wrong.
- If the PR changes no code (docs only), write "not applicable" with the reason; never omit the section.

## 3. Claims
- Every figure names the commit or tree it was measured on. Prefer the population subtree hash over `write-tree` when the measured code is a subtree.
- Name the table and the writer function with `file:line`; near-homonyms exist (`nfl_snaps` is not `player_week_snaps`).
- A zero, empty, or success result from a bespoke check needs one known-nonzero case shown first.
- A page-reachability or grep-based claim needs a control that finds a known-reachable case.
- A local variable named `db` is resolved by the wiring map as the app database; name other handles (`chatDb`, `nflDb`).
- Never quote a number an auditor has withdrawn; say "not reproducible by command".
- Statistical claims state the configuration the run used (role recency, k override and where the fitted k comes from), the held-out season, the interval, and the sign convention of any signed error. No magnitude carries between rigs; direction may.
- An absence says which absence it is, from a field, not a sentence: unknown vs fresh, not_measured vs zero, table_absent vs empty.

## 4. Nick's five questions (the only five-questions list)
Answer in writing, in the PR body and the evidence file:
1. Well built?
2. Stats or made up?
3. How we know: backtest (seasons, metric, number), hand-set constant, or nothing.
4. Pointed anywhere else on the platform?
5. How it unifies.

Say "guess" plainly when it is one. Verify the consumer, not the producer. Cite `file:line` on origin/main.

Under the same heading also state, in one line each: the defect or gap fixed with `file:line` on a stated tree; the incumbent, by command; what the change does NOT cover; what would make it wrong.

## 5. Hard rules
- No secrets in the repo, commit, chat, or logs. Read presence, never value.
- No bare `catch {}`. Errors are handled or they throw. An inert layer must say so on its surface.
- Parameterised SQL only.
- Additive migrations only, each named in the PR body. Table drops, destructive migrations and data deletion need Nick's own word.
- Nothing paid. Licence check (LICENSE and LICENSE.md across master, main, gh-pages, plus README) before measuring any external data.
- One editor per file; a finding in another thread's file is reported, not edited.
- Nav is 8 tabs; never rebuild a deleted page.
- Commit messages `<type>: <description>` with attribution footers on.

## 6. Merge and after
- Draft PR on push. Only the local coordinator merges (merge-queue.sh: brings the PR up to current main, waits for CI on that exact head, checks sections 1 to 5, squash-merges, logs and writes the integration card). Builder and cloud sessions never merge, never mark ready, never subscribe to PR activity and never schedule check-ins. Retry a refused GitHub API call at most every ten minutes; never poll.
- Do not open a PR for a preservation snapshot as if it were a merge candidate; label it never-merge.
- Deploy, settings, and secrets need Nick's word every time.
- **Context hygiene:** once your current PRs are merged, write your handoff section (shipped, open, blocked, findings, lessons, files, next three steps) and ask the coordinator to restart you as a fresh session from it. A thread's history is the cost; the handoff is the memory.