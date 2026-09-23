"""RL-11-1 mutation sweep. Run from the worktree root:
    python3 docs/evidence/2026-09-23/mutate-activity-receptiveness.py
Each mutant edits one file, runs test/receptiveness-activity.test.js, records
which tests fail, and restores the file with `git checkout --`. A mutant whose
pattern is not found is reported NOT APPLIED (never counted as survived)."""
import subprocess, tempfile, re, os
CP = 'server/services/counterparty-pricing.js'
MS = 'server/services/manager-signals.js'
MUTANTS = [
  ('M1 unit: activity sign flipped', CP,
   "  const effect = Math.max(-ACTIVITY_CAP, Math.min(ACTIVITY_CAP, relative * SCORE_PER_RELATIVE));",
   "  const effect = Math.max(-ACTIVITY_CAP, Math.min(ACTIVITY_CAP, -relative * SCORE_PER_RELATIVE));"),
  ('M2 unit: five-week gate removed', CP,
   "  if (weeks < ACTIVITY_MIN_WEEKS) {", "  if (weeks < 0) {"),
  ('M3 unit: inactive manager dropped (no adds -> no metric)', MS,
   "  const adds = (tx.adds.get(me) ?? []).filter(p => p <= through).length;",
   "  const adds = (tx.adds.get(me) ?? []).filter(p => p <= through).length;\n  if (!adds) return [];"),
  ('M4 unit: zero points counted as did-not-play', MS,
   "  const dead = zero.filter(s => !played(s.player_name));", "  const dead = zero;"),
  ('M5 unit: vetoed trades counted', MS,
   "    if (t.type !== 'TRADE_ACCEPT' || t.execution_type !== 'PROCESS' || t.status !== 'EXECUTED') continue;",
   "    if (t.type !== 'TRADE_ACCEPT') continue;"),
  ('M6 unit: adds after the last completed week counted', MS,
   "  const adds = (tx.adds.get(me) ?? []).filter(p => p <= through).length;",
   "  const adds = (tx.adds.get(me) ?? []).length;"),
  ('M7 call site: activity effect never added to the score', CP,
   "    if (Number.isFinite(activityTerm?.effect)) score += activityTerm.effect;", ""),
  ('M8 call site: flag ignored, always on', CP,
   "  const activityOn = activity ?? process.env[ACTIVITY_FLAG] === '1';", "  const activityOn = true;"),
  ('M9 call site: signal build skips activity', MS,
   "        ...activitySignals(tx, rosterId, lastCompleted),\n", ""),
  ('M10 call site: board stops rendering factors', 'client/src/components/brain/ManagerBoard.tsx',
   "              <ReceptivenessFactors factors={factors} />", ""),
  ('S1 DESIGNED SURVIVOR: activity cap 0.5 -> 0.45 (magnitude is graded by the script, not unit tests)', CP,
   "const ACTIVITY_CAP = 0.5;", "const ACTIVITY_CAP = 0.45;"),
  ('C1 NOT-APPLIED CONTROL: pattern that does not exist', CP,
   "const ACTIVITY_CAP = 0.55;", "const ACTIVITY_CAP = 0.1;"),
]
def run_tests():
  env = dict(os.environ, SCHEDULER_DISABLED='1', GRIDIRON_DB_PATH=tempfile.mktemp(suffix='.sqlite'))
  out = subprocess.run(['node', '--experimental-test-module-mocks', '--test', '--test-reporter=tap',
                        'test/receptiveness-activity.test.js'], capture_output=True, text=True, env=env).stdout
  return re.findall(r'^not ok \d+ - (A\d+b?)', out, re.M), len(re.findall(r'^ok \d+', out, re.M))
base_fail, base_ok = run_tests()
print(f'baseline: {base_ok} ok, failing {base_fail}')
for label, f, old, new in MUTANTS:
  src = open(f).read()
  if old not in src:
    print(f'{label}: NOT APPLIED'); continue
  open(f, 'w').write(src.replace(old, new, 1))
  try:
    failed, ok = run_tests()
  finally:
    subprocess.run(['git', 'checkout', '--', f], check=True)
  print(f"{label}: {'KILLED by ' + ','.join(failed) if failed else 'SURVIVED'}")
