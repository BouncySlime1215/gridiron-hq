---
name: a-branch-head-sha-is-the-whole-stack
description: The o3wt2p ledger names branches by head SHA, so reasoning about that SHA as one commit's content gives answers that are true of the commit and false of the branch.
metadata:
  type: feedback
---

Settled 2026-09-22. Two memory claims looked contradictory and both were right:

- "**#84 is where migration 066 lives**", describing #84 as opened from
  **8709ec6**'s content -- true, of the branch.
- "**8709ec6 is the sweep/dead-path commit and carries no migration; 9c7cf68
  carries 066**" -- true, of the individual commits.

`git merge-base --is-ancestor 9c7cf68 8709ec6` returns **yes**.
`origin/claude/project-thread-o3wt2p-scheduled-ingests` head **is** 8709ec6, and
`git cat-file -e <branch>:server/migrations/066_league_transactions_raw.js`
confirms 066 is on it. `git log --oneline 3902ba7..8709ec6` is **7 commits**,
`git diff --name-only` **18 files** -- matching the ledger's "7-commit/18-file"
exactly.

**Why:** the ledger names each branch by its head SHA, and a head SHA carries
the whole stack beneath it. Reading it as one commit's content made 8709ec6 look
migration-free (true of the commit, false of the branch) and made 9c7cf68 look
like "the live-tier move" (false of both -- that is a9511f6, with 3902ba7
beneath it).

**How to apply:** before acting on a held SHA, ask which question you are
answering. For "what does this commit change" use `git show`/`git diff <sha>^ <sha>`.
For "what does this branch carry" use `git log <base>..<head>` and
`git cat-file -e <head>:<path>`, never the head commit's own diff. When the two
answers differ, both can be right -- say which question each answers instead of
overwriting one with the other. #84 carries 066, so it must stay away from any
deploy: see [[deploy-654ff93-applies-no-schema]].
