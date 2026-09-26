#!/bin/bash
# Generic mutation sweep for gridiron-hq, merge-gate v2 section 2.  v1, 2026-09-22.
#
# NEVER edit this file in place — a run may be using it. Write mutate-run-v2.sh.
#
#   bash /mnt/project-files/mutate-run-v1.sh <sha> <tag> <spec-file>
#
# Runs in an isolated detached worktree of <sha> with node_modules hard-linked
# from /home/user/gridiron-hq; the primary tree is never touched. Each mutant is
# applied, VERIFIED to have changed the file exactly once, tested, then reverted.
# An anchor that matches 0 times OR MORE THAN ONCE is reported NOT-APPLIED rather
# than landing on the wrong line — that case is real, not theoretical: #55's
# call-site mutant anchored on `const season = ...`, which occurs three times in
# server/routes/aggregates.js.  Results go to /tmp/claude-0/mutation-<tag>.txt and
# open with a BASELINE line (the unmutated head) so a suite that is already red
# cannot be mistaken for a kill.
#
# SPEC FORMAT — first line, then six lines per mutant with ONE BLANK LINE between:
#
#   TESTS: test/one.test.js test/two.test.js
#   <blank>
#   M1                                  <- id
#   server/services/thing.js            <- file, repo-relative
#   the exact text to replace           <- from (one line, must occur EXACTLY once)
#   what to replace it with             <- to
#   KILLED                              <- expect: KILLED | SURVIVED | NOT-APPLIED
#   why this mutant matters             <- note, printed beside the verdict
#   <blank>
#   ...
#
# Every spec needs a designed SURVIVED control (a comment-only edit) and a
# designed NOT-APPLIED control (an anchor absent from the file), so the run
# proves the harness can detect both. Mutate the unit AND the call site: the
# argument or predicate the caller passes is its own row.

set -u
SHA="${1:?usage: mutate-run.sh <sha> <tag> <spec>}"
TAG="${2:?}"; SPEC="${3:?}"
WT="/home/user/mut-$TAG"
REPO=/home/user/gridiron-hq
OUT="/tmp/claude-0/mutation-$TAG.txt"
CNT=/tmp/claude-0/.mutcount-$TAG

cd "$REPO" || exit 1
rm -rf "$WT"; git worktree prune
git worktree add -q --detach "$WT" "$SHA" || exit 1
cp -al "$REPO/node_modules" "$WT/node_modules" || exit 1

TESTS=$(sed -n 's/^TESTS: //p' "$SPEC")
: > "$OUT"
echo "sha: $SHA" >> "$OUT"
echo "worktree tree: $(cd "$WT" && git rev-parse 'HEAD^{tree}')" >> "$OUT"
echo "tests: $TESTS" >> "$OUT"
echo "" >> "$OUT"

baseline=$(cd "$WT" && node --test $TESTS 2>&1 | grep -E "^# (pass|fail)" | tr '\n' ' ')
echo "BASELINE (unmutated head): $baseline" >> "$OUT"
echo "" >> "$OUT"

run_mutant () {
  local id="$1" file="$2" from="$3" to="$4" expect="$5" note="$6"
  cd "$WT" || return
  FROM="$from" TO="$to" python3 - "$file" "$CNT" <<'PY'
import sys, os
p, cnt = sys.argv[1], sys.argv[2]
a, b = os.environ['FROM'], os.environ['TO']
s = open(p).read()
n = s.count(a)
open(cnt,'w').write(str(n))
if n == 1:
    open(p,'w').write(s.replace(a,b))
PY
  local n; n=$(cat "$CNT")
  if [ "$n" != "1" ]; then
    printf '%-4s %-11s NOT-APPLIED (anchor matched %s times)  %s\n' "$id" "$expect" "$n" "$note" >> "$OUT"
    (cd "$WT" && git checkout -- "$file")
    return
  fi
  local res; res=$(cd "$WT" && node --test $TESTS 2>&1 | grep -E "^# (pass|fail)" | tr '\n' ' ')
  local fails; fails=$(echo "$res" | sed -n 's/.*# fail \([0-9]*\).*/\1/p')
  local verdict
  if [ "${fails:-0}" -gt 0 ]; then verdict=KILLED; else verdict=SURVIVED; fi
  local flag=" "
  [ "$verdict" = "$expect" ] || flag="<-- UNEXPECTED"
  printf '%-4s expect=%-11s got=%-11s %s %s %s\n' "$id" "$expect" "$verdict" "$res" "$flag" "$note" >> "$OUT"
  (cd "$WT" && git checkout -- "$file")
}

# read the spec: six lines per record, blank line between
while IFS= read -r id && IFS= read -r file && IFS= read -r from \
   && IFS= read -r to && IFS= read -r expect && IFS= read -r note; do
  [ -z "$id" ] && continue
  run_mutant "$id" "$file" "$from" "$to" "$expect" "$note"
  IFS= read -r _blank || true
done < <(sed '1,2d' "$SPEC")

cd "$REPO"
git worktree remove --force "$WT" 2>/dev/null
git worktree prune
echo "" >> "$OUT"
echo "SWEEP DONE" >> "$OUT"
cat "$OUT"
