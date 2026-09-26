#!/bin/bash
# verify2x-v4.sh -- canonical 2x-verify block for gridiron-hq.
#
#   usage: verify2x-v4.sh <commit-ish> [tag] [repo] [scratch-dir]
#
# Runs `npm run check` TWICE on one commit, in an isolated detached worktree,
# and prints a guard block either side. Two real runs, never one figure quoted
# twice. Exit status is read, not assumed.
#
# WHY EACH GUARD EXISTS -- every one of these was a real false reading:
#
# 1. MARKER FILE, not a clock. v2 used `find -newermt "@$(date +%s)"`.
#    -newermt matches mtime >= t0, so when `git worktree add` finished inside
#    the same wall-clock second as t0, the sweep counted the whole checkout:
#    1,353 = 1,328 tracked files + the 25 the build actually rewrites. That was
#    reported as "the suite rewrites 1,353 files" and was false. The boundary is
#    now a marker file touched after the worktree AND node_modules are in place,
#    with `find -newer`. Exact, and it cannot sweep the checkout.
#
# 2. EXPLICIT END MARKER after each porcelain capture. An empty porcelain and a
#    porcelain that never ran look identical in a log. The marker line makes
#    "clean" distinguishable from "did not happen".
#
# 3. NO `set -e` AROUND THE CHECK. `rc=0; npm run check || rc=$?` keeps the
#    after-capture running when the check FAILS, which is precisely when the
#    guard block is needed to explain the failure.
#
# 4. BOTH porcelain AND write-tree, before and after. `git write-tree` hashes
#    the INDEX, so it cannot see an unstaged edit landing mid-run; porcelain
#    cannot see gitignored paths. Neither alone is sufficient.
#
# 5. LOGS OUTSIDE THE REPO, so the sweep never trips over its own output.
#
# 6. node_modules HARD-LINKED and its mtime recorded either side: an install
#    anywhere in the container voids every source-isolated run at once, and
#    nothing fails visibly when it does.
#
# Isolation label to quote with the figures: SOURCE-ISOLATED -- own source tree,
# node_modules hard-linked from the primary tree (identical deps, no install).

set -u
HEAD_SHA="${1:?usage: verify2x-v4.sh <commit-ish> [tag] [repo] [scratch]}"
TAG="${2:-$HEAD_SHA}"
REPO="${3:-/home/user/gridiron-hq}"
SP="${4:-/tmp/claude-verify2x}"
mkdir -p "$SP"
WT="$(dirname "$REPO")/verify2x-v4-$TAG"
MARK="$SP/.sweep-marker-$TAG"

cd "$REPO" || exit 1
echo "=== GUARD BEFORE ==="
echo "PRIMARY status: $(git status --porcelain | wc -l) paths"
git status --porcelain
echo "---STATUS-BEFORE-END (empty above = clean)"
echo "PRIMARY write-tree: $(git write-tree)"
echo "HEAD: $(git rev-parse "$HEAD_SHA")"
echo "TREE: $(git rev-parse "$HEAD_SHA^{tree}")"
echo "node_modules mtime: $(stat -c %Y "$REPO/node_modules")"

rm -rf "$WT"; git worktree prune
git worktree add -q --detach "$WT" "$HEAD_SHA" || exit 1
cp -al "$REPO/node_modules" "$WT/node_modules" || exit 1
echo "WORKTREE tree: $(cd "$WT" && git rev-parse 'HEAD^{tree}')  (must equal TREE above)"
echo "tracked files in tree: $(cd "$WT" && git ls-files | wc -l)"

for RUN in 1 2; do
  sleep 1; touch "$MARK"        # boundary AFTER checkout and node_modules
  echo "===== RUN $RUN START $(date -u +%H:%M:%SZ) ====="
  rc=0
  (cd "$WT" && npm run check > "$SP/v4-$TAG-run$RUN.log" 2>&1) || rc=$?
  echo "RUN $RUN EXIT: $rc"
  grep -E "^# (tests|pass|fail|skipped)" "$SP/v4-$TAG-run$RUN.log" | tr '\n' ' '; echo
  echo "RUN $RUN smoke lines: $(grep -c 'smoke passed' "$SP/v4-$TAG-run$RUN.log")"
  echo "RUN $RUN worktree status: $(cd "$WT" && git status --porcelain | wc -l) paths"
  (cd "$WT" && git status --porcelain)
  echo "---STATUS-RUN$RUN-END (empty above = clean)"
  n=$( (cd "$WT" && find . -path ./.git -prune -o -path ./node_modules -prune -o -newer "$MARK" -type f -print) | wc -l)
  echo "RUN $RUN files written during the run (incl. gitignored): $n"
  (cd "$WT" && find . -path ./.git -prune -o -path ./node_modules -prune -o -newer "$MARK" -type f -printf '%h\n') | sort | uniq -c | sort -rn | head -5
  echo "---SWEEP-RUN$RUN-END (a count here is not a fault by itself: this repo"
  echo "    rewrites its committed client/dist bundle every run. A count whose"
  echo "    SHAPE changes between two runs on the same tree is worth reading.)"
done

cd "$REPO"
echo "=== GUARD AFTER ==="
echo "PRIMARY status: $(git status --porcelain | wc -l) paths"
git status --porcelain
echo "---STATUS-AFTER-END (empty above = clean)"
echo "PRIMARY write-tree: $(git write-tree)   (must equal the BEFORE value)"
echo "node_modules mtime: $(stat -c %Y "$REPO/node_modules")   (must equal the BEFORE value)"
echo "DONE"
