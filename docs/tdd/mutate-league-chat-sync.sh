set -u
SRC=server/services/league-chat-sync.js
SUITES="test/chat-block-wiring.test.js test/chat-age.test.js test/league-chat-sync.test.js test/wiring-absent-states.test.js"
cp $SRC /tmp/claude-0/orig.js
BASE=$(sha256sum /tmp/claude-0/orig.js | cut -c1-16)
echo "UNMUTATED SOURCE sha256[0:16] = $BASE"
echo

run() {
  id="$1"; from="$2"; to="$3"; expect="$4"
  cp /tmp/claude-0/orig.js $SRC
  before=$(sha256sum $SRC | cut -c1-16)
  python3 - "$SRC" "$from" "$to" <<'PY'
import sys
p,f,t = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
if s.count(f) == 0: sys.exit(3)
open(p,'w').write(s.replace(f,t,1))
PY
  st=$?
  after=$(sha256sum $SRC | cut -c1-16)
  if [ $st -eq 3 ]; then
    echo "$id | before $before | after $after | NO EDIT MADE — pattern absent, suite NOT run | expected $expect"
    return
  fi
  if [ "$before" = "$after" ]; then
    echo "$id | before $before | after $after | HASH UNCHANGED — the edit did nothing | expected $expect"
    return
  fi
  node --test $SUITES >/tmp/claude-0/o.txt 2>&1
  rc=$?
  n=$(grep -c '^not ok' /tmp/claude-0/o.txt || true)
  if [ $rc -eq 0 ]; then res="SURVIVED (suite green)"; else res="CAUGHT by $n test(s)"; fi
  echo "$id | before $before | after $after | $res | expected $expect"
  grep '^not ok' /tmp/claude-0/o.txt | sed 's/^not ok [0-9]* - /    FAILED: /'
  grep -o "location: '[^']*'" /tmp/claude-0/o.txt | sed "s|location: '$PWD/|    IN: |;s|'$||" | sort -u
}

run M1_age_from_rollup "state?.newest_message ?? state?.as_of ?? null" "state?.as_of ?? state?.newest_message ?? null" CAUGHT
run M2_lag_direction "Date.parse(seenByRollup) < Date.parse(age) - 6e4" "Date.parse(seenByRollup) > Date.parse(age) - 6e4" CAUGHT
run M3_own_path_lookup "state?.path ?? chatDbPath()" "chatDbPath()" CAUGHT
run M4_drop_block_reason "state?.reason ? \` \${state.reason}.\` : ''" "''" CAUGHT
run M5_drop_path_source "state?.path_source" "false" CAUGHT
run M6_hasData_to_rows "if (!age && !hasData) {" "if (!age && !rows) {" CAUGHT
run M7_min_last_msg "MAX(last_msg) AS a" "MIN(last_msg) AS a" CAUGHT
run M8_drop_collector "out.collected_by = CHAT_COLLECTOR;" "out.collected_by = null;" CAUGHT
run M9_rollup_never_missing "if (!rows && !seenByRollup) rollup = 'missing';" "if (false) rollup = 'missing';" CAUGHT
run M10_no_iso_on_block "const age = isoStamp(" "const age = (x=>x)(" CAUGHT
echo
echo "--- CONTROLS ---"
run C1_pattern_that_cannot_match "out.rolled_up_at = isoStamp(" "out.rolled_up_at = null; //" "NO EDIT"
run C2_comment_only_edit "// EVERY FACT BELOW COMES OUT OF" "// EVERY SINGLE FACT BELOW COMES OUT OF" SURVIVED

cp /tmp/claude-0/orig.js $SRC
echo
echo "restored: sha256[0:16] = $(sha256sum $SRC | cut -c1-16)  (matches unmutated: $([ "$(sha256sum $SRC | cut -c1-16)" = "$BASE" ] && echo yes || echo NO))"
