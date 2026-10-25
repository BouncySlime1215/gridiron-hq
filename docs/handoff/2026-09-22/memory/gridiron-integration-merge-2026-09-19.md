---
name: gridiron-integration-merge-2026-09-19
description: Merging every open Gridiron HQ PR head locally on 2026-09-19 — what conflicted, and the git worktree trap that corrupts a PR branch while you do it.
metadata:
  type: project
  modified: 2026-09-19T20:25:28.557Z
---

Done 2026-09-19 to map the whole app at once (see [[gridiron-wiring-map]]).
Local only, never pushed, not a release rehearsal — the release thread owns
that ([[gridiron-scheduler-ship-plan]]).

**Merge order used, onto `claude/project-thread-3ldl77-docs`:** #33 tip
(`-o3wt2p-reentry`), #30 tip (`-5f9c3y-drafts`), #26, #25, #23, #22, #18, #24,
#15, #14, #34, #8.

**Everything merged clean except two:**
- **PR #34 is based on `cursor/betting-model-audit-fixes-1c85`** — below the
  whole `-3ldl77` stack, not on it — and conflicts in **26 files**, including
  `server/index.js`, `scheduler.js`, `lineup-brain.js`, `manager-identity.js`,
  `manager-signals.js`, `trade-proposals.js`, `waiver-wire.js`,
  `routes/trades.js`, `routes/leagues.js`, `routes/league-chat.js`,
  `client/src/App.tsx`, `navigation.ts`, `pages/Lineup.tsx`, `fly.toml` and
  three test files.
- **PR #14** conflicts in one file only: `scripts/start-smoke.mjs`.

Both were resolved `-X ours` for mapping purposes. That is not a proposal for
how to resolve them for real.

**#34 is the cheapest to defer.** Its two new modules (`injury-return.js`,
`nfl-roster-weekly.js`) are imported by nothing but their own test, so it
changes no served surface today.

**THE TRAP, worth not repeating:** `git worktree add -f <dir> <branch>` on a
branch that is ALREADY checked out in the main worktree does not refuse — and
committing in the worktree silently advances that branch's ref. Twelve merge
commits landed on the PR branch that way, and the main worktree then showed
hundreds of phantom deletions because its files no longer matched HEAD.
Nothing was pushed; `git worktree remove --force` then `git reset --hard <sha>`
fixed it. **Use a detached worktree for a throwaway integration build.**
