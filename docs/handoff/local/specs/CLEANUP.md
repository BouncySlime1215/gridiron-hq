# CLEANUP: files, worktrees, branches and PRs

Nick asked for this on 9/27: "clean up all our files ... so much old shit ... our git shows it". The inventory below was taken 9/27 at about 12:15 AM ET.

**Rule:** everything is reversible.
- Local files go to ~/.Trash, never rm. Nick empties the Trash.
- Remote branches are deleted only when fully merged into main, so they are recoverable by sha. Record every sha in `evidence/cleanup-<date>.tsv` before deleting.
- PRs are closed with a comment, never deleted.
- Never touch ~/gridiron-local/data.sqlite, run.sh, refresh.sh, bin/*.sh (live), .env*, warroom/plans.json, or the 2 newest intact DB backups.

## Inventory
| Thing | Now | Target |
|---|---|---|
| ~/gridiron-local total | 22 GB | about 8 GB |
| Worktrees (~/gridiron-local/wt) | 218 dirs / 193 registered, 11 GB | only active ones |
| Remote branches | 795 | open-PR branches + main + handoff |
| Open PRs | 114 | only live work |
| Script backups (*.bak*) | 41 | last 2 per script |
| DB pre-migration backups | 3 (1.4, 1.7, 1.7 GB) | newest 2 |
| evidence/ | 962 MB | logs older than 7 days tarred |
| rnd/ | 1.2 GB | datasets kept (e.g. the 2025 pbp CSV that TEAMS-V2 needs); scratch archived |

## Steps (run HARNESS-HEALTH first; pause intake while working)
1. **Worktrees.**
   - For each registered worktree, remove it with `git worktree remove` (NO --force) ONLY IF all of these hold:
     - its branch is merged or its PR is closed;
     - `git status --porcelain` is empty;
     - nothing is unpushed.
   - List the rest (dirty or unpushed, e.g. jev-sink and shape2, which hold stale merge-gate staged changes) for review, and don't touch them.
   - Unregistered dirs: move to ~/.Trash after checking none is an active worktree.
2. **Open PRs.**
   - Use #511's CLEANUP report plus `gh pr list`. Close PRs whose work is on main or superseded, with a comment "superseded by #N / merged via #M".
   - Keep: anything referenced in the ACCOUNT-SWITCH queue, #534, and the HELD list in auto-intake (148, 184, 193).
3. **Remote branches.** Delete a branch only if `git merge-base --is-ancestor origin/<br> origin/main` or its PR is closed and merged. Log each sha first.
4. **Script backups:** keep the newest 2 per script; the rest go to ~/.Trash.
5. **DB backups:** keep the newest 2 intact ones (quick_check ok); the rest go to ~/.Trash.
6. **evidence/:** tar logs older than 7 days into `evidence/archive-<date>.tar.gz`, then move the originals to ~/.Trash. Keep OPS-LOG, ACCOUNT-SWITCH, CREDITS-BACK, the specs, hourly-app-check.log and auto-intake.log.
7. **Repo docs:** in one PR, move stale docs (TASKS.md, docs/FANTASY-ENGINE-MASTER-PLAN.md, docs/CLAUDE-NEXT-STEPS.md, docs/betting-model/, and old docs/evidence) into docs/archive/ with a README, and fix the links. Use ALLOW_REVERT only for declared moves.

## Report
Give Nick one table, before and after: GB freed, worktrees, branches, PRs, plus the list of anything left for review. Nick empties the Trash himself.
