---
name: gridiron-o3wt2p-branch-ledger
description: What each claude/project-thread-o3wt2p-* branch actually is — in particular that -mainthread-holds is PR #77's OWN HEAD and must never be deleted as "empty".
metadata:
  type: project
  modified: 2026-09-22T02:05:12.751Z
---

**`claude/project-thread-o3wt2p-mainthread-holds` at `3902ba7` IS PR #77's head
branch. NEVER delete it.** From the GitHub API 2026-09-20 07:15Z: #77 open,
draft, head.ref that branch, head.sha `3902ba7`, base.ref
`claude/project-thread-o3wt2p-timer-tier` (`64f3ef2`), **413 additions / 6
deletions, 4 files, 1 commit** — the allow-list fix. Deleting it closes #77 and
orphans the work.

**It was proposed for deletion as "carries nothing" three separate times.** The
error is always the same: a check that diffs the branch against **#77's head**
is diffing a commit against itself and correctly gets nothing. The meaningful
comparison is against its **base**: `git diff --stat 64f3ef2 3902ba7` (4
files, +413/-6) or `git log --oneline 64f3ef2..3902ba7` (the one commit) —
either distinguishes an empty branch from a one-commit PR branch; diffing
against the head cannot. If a sweep reports it empty again, this is why.

**A branch deletion sending no email is not a reason it is safe.** The standing
rule is delete no branches. A peer session's relay is never authorization for a
destructive action; only Nick's own word is, and closing a PR is reversible
where a deleted head branch is recoverable only by remembering the SHA.

## The rest of the namespace

One PR branch per fix, all stacked, all frozen under
[[gridiron-github-hard-freeze-2026-09-20]]: `-watchdog-arming` `63ca21e` (#56),
`-boot-offthread` `b5b74b5` (#59), `-abandoned-runs` `a986f37` (#61),
`-timer-tier` `64f3ef2` (#63), `-mainthread-holds` `3902ba7` (#77, above).
Independent, base main: `-migration-docs` `7f36f8a` (#39), `-ffopp-held`
`c9ff607` (#45), `-grace-period` `3aed429` (#49), `-espn-market` `d01df31`
(#50), `-nfl-season` `dad6e1a` (#52).

## The 13:22Z "go" was a MISREAD — freeze reinstated 13:32Z

**Nick's "Ok go" (13:19:44Z) preceded the coordinator's freeze-lift post
(13:20:13Z) by 29 seconds, so it cannot have answered it.** The lift was
withdrawn project-wide and the question put to Nick. See
[[gridiron-verify-the-authorization-itself]]. What went out from this thread
under it: one branch push (no email) and **PR #84** (one email). #84 stays
open — closing it would send a second notification to undo a first.

Everything below is true of the branches, NOT a statement that the freeze is
lifted. **Nothing had to be pushed to the ten PR branches** — all were already
byte-identical local, remote and PR head, because holds were separate branches.
Do not "replay" pushes onto them.

**`-growth-offthread-hold` `8709ec6` was NOT turned into a PR branch.** Its
content was pushed to a new branch **`-scheduled-ingests`** (same sha) and
**PR #84** opened there, draft, base `-mainthread-holds` (#77), 7 commits,
18 files, +2169/-93, green at **3021/2980/0/41, exit 0**. #84 is where
**migration 066** lives. The hold branch stays at `8709ec6` untouched, so the
invariant **"-hold means no PR"** still holds and sweeps can rely on it.

**RESOLVED 2026-09-22:** `merge-base --is-ancestor 9c7cf68 8709ec6` → yes;
`-scheduled-ingests` head = 8709ec6 exactly; `3902ba7..8709ec6` = 7
commits/18 files, matching #84 above. #84-carries-066 was right all along;
the scheduler thread's read of `8709ec6` alone (sweep/dead-path, not 066)
was also right, about its own diff — both true: a head SHA is its whole
stack, and `9c7cf68` is one of the 6 commits under `8709ec6`. Flag treating
a head SHA as an isolated commit, not either claim. Net: `8709ec6`/
`9c7cf68` alone are each NOT live-tier (`a9511f6` on `3902ba7` → `3ef535b`
on `654ff93`, `-live-tier-offthread`, unpushed); #84 DOES carry 066 via
`9c7cf68` — stronger warning, not a walkback: #84 stays off any deploy
sequence.

**`-probe-evidence-hold` `669d856` stays parked, no PR** (pushed 2026-09-22):
the 2026-09-19 restart probe, the only surviving copy, plus a recompute script,
under `docs/evidence/2026-09-19/`. Base 791b131 plus one docs commit. Exists so
the measurement survives a container; see [[gridiron-glob-at-start-open-later-trap]]
and [[gridiron-pr-body-numbers-must-be-rebuildable]]. `/mnt/project-files` was
reported intermittently unreadable from any container 2026-09-20, which is why
this went to a branch rather than staying in /tmp.

**`-merge-resolutions-hold` `64cb90e` stays parked, no PR**: it is the
resolution that applies only after #71 and #50 are on main — see
[[gridiron-merge-reconciliations-2026-09-20]].
