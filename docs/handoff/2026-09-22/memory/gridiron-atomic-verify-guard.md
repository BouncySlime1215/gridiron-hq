---
name: gridiron-atomic-verify-guard
description: "Canonical pre-push guard: v4 script /mnt/project-files/verify2x-v4.sh (run `bash <path> <commit> [tag] [repo] [scratch]`); v3 block retained for history."
metadata:
  type: feedback
  modified: 2026-09-22T08:37:42.005Z
---

**v4 (08:35Z 2026-09-22) supersedes v3:** marker-file t0 (`find -newer "$marker"`, marker created after worktree+node_modules) and explicit STATUS-BEFORE-END echo after each porcelain; canonical script verify2x-v4.sh in /mnt/project-files when Opportunity delivers it. Baseline sweep noise = ~25 files under client/dist.

**Script delivered 08:35Z:** `/mnt/project-files/verify2x-v4.sh` (Opportunity, 4,528 B). Run with `bash`, never `./` (exec bit unreliable on the share). Prints porcelain + `---STATUS-BEFORE-END`/`-RUN1-`/`-RUN2-`/`-AFTER-` markers; a log without markers is distrusted. Sweep count baseline ≈25 (client/dist); a count whose SHAPE changes between runs on the same tree is the signal.

**v3 (history — use the v4 script above):**

**Use exactly this. Earlier forms are superseded.**

```
LOG=<scratchpad, OUTSIDE the repo>/run-N.log
( t0=$(date +%s); echo BEFORE; git status --porcelain; git write-tree; git rev-parse HEAD^{tree} HEAD; stat -c %Y node_modules
  rc=0; npm run check || rc=$?; echo "check-exit=$rc"
  echo AFTER; git status --porcelain; git write-tree; git rev-parse HEAD^{tree} HEAD; stat -c %Y node_modules
  find . -path ./.git -prune -o -path ./node_modules -prune -o -path ./client/dist -prune -o -newermt "@$t0" -type f -print; exit $rc ) > "$LOG" 2>&1; echo "guard-exit=$?"
```

**Why each part (who found it):**
1. ONE command — separate tool calls leave windows for the session's own writes to interleave (Model evidence audit).
2. `git status --porcelain` is LOAD-BEARING; `write-tree` only adds the staged-then-unstaged case; an untracked mid-run write is in neither (Model evidence audit).
3. NO `set -e` — a failing check would kill the subshell before the after-capture; `|| rc=$?` is the exemption (first Auditor, bash 5.2.21).
4. NO `| tee` — pipeline status becomes tee's, masking the check exit (first Auditor).
5. Log OUTSIDE the repo — inside it trips porcelain; gitignoring it disables the load-bearing half (UI thread).
6. `find -newermt` — porcelain skips gitignored paths (dist/, coverage/, data/) (first Auditor). Exclude client/dist: vite rewrites it every run; a guard that always fires gets ignored (Scheduler; server/data.sqlite mtime unchanged over four runs proved the suite stayed on its temp DB).
7. `node_modules` mtime — SHARED SYMLINK across all worktrees; one `npm ci` voids every run in flight. No `npm ci` during another thread's check without telling the coordinator (Scheduler).

**Best implementation:** Opportunity's runner — detached worktree, `cp -al` node_modules, `git status --porcelain` INSIDE the worktree after each run. First Auditor ruled it canonical where a worktree is used.

**Unchanged:** two INDEPENDENT full runs, never one figure twice; measured on the tree pushed. Runs recorded under earlier forms stand as evidence for what they prove, not what they claim. See [[write-tree-hashes-the-index-not-the-worktree]].
