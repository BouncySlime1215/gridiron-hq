"""CE-05 mutation sweep. Run from the worktree root:
    python3 docs/evidence/2026-09-23/mutate-league-rules.py
Each mutant edits one file, runs test/league-rules.test.js and
test/league-rules-bracket-sim.test.js, records which tests fail (B<n> = the
bracket file's test n), and restores the file with `git checkout --`. A mutant whose pattern is
not found is reported NOT APPLIED (never counted as survived)."""
import subprocess, tempfile, re, os, sys
LR = 'server/services/league-rules.js'
SIM = 'server/services/season-sim.js'
MUTANTS = [
  ('M1 unit: division winners ignored', LR,
   "  if (!rules.seeding.division_winners_first) return sorted.map(s => s.id);",
   "  if (true) return sorted.map(s => s.id);"),
  ('M2 unit: points-for tiebreak dropped', LR,
   "  const cmp = (a, b) => b.w - a.w || b.pf - a.pf;",
   "  const cmp = (a, b) => b.w - a.w;"),
  ('M3 unit: missing playoffTeamCount defaults to 6', LR,
   "  sch.playoff_teams = need(ss, 'playoffTeamCount', SS, v => Number.isInteger(v) && v >= 2);",
   "  sch.playoff_teams = ss?.playoffTeamCount ?? 6;"),
  ('M4 unit: playoff round length ignored (one week per round)', LR,
   "    const len = sch.playoff_round_length;",
   "    const len = 1;"),
  ('M5 unit: unsupported tiebreaker seeded on points', LR,
   "  if (!SUPPORTED_TIEBREAKERS.has(tb)) throw new Error(`league rules: tiebreaker ${tb} is not implemented`);",
   ""),
  ('M6 unit: fixed bracket re-seeds anyway', SIM,
   "    if (reseed && r > 0) {",
   "    if (r > 0) {"),
  ('M7 unit: two-week round scored on its first week only', SIM,
   "    const weeks = roundWeeks[r];",
   "    const weeks = roundWeeks[r].slice(0, 1);"),
  ('M8 call site: sim seeds on plain wins-then-points', SIM,
   "    const seeded = seedStandings([...record.entries()].map(([id, r]) => ({ id, w: r.w, pf: r.pf })), rules);",
   "    const seeded = [...record.entries()].sort((x, y) => y[1].w - x[1].w || y[1].pf - x[1].pf).map(([id]) => id);"),
  ('M9 call site: sim ignores simRulesProblem', SIM,
   "  if (problem) return problem;",
   ""),
  ('M10 call site: sim passes reseed:true to playBracket', SIM,
   "    const bracket = playBracket(field, rules.schedule, (id, roundWeeks)",
   "    const bracket = playBracket(field, { ...rules.schedule, reseed: true }, (id, roundWeeks)"),
  ('M11 call site: trade-horizon keeps its own derivation (1 week per round)', 'server/services/trade-horizon.js',
   "    playoffWeeks: sch.playoff_weeks.flat(),",
   "    playoffWeeks: sch.playoff_weeks.map(w => w[0]),"),
  ('M12 call site: sim plays the bracket on the old fixed weeks 15-17', SIM,
   "    const bracket = playBracket(field, rules.schedule, (id, roundWeeks)",
   "    const bracket = playBracket(field, { ...rules.schedule, playoff_weeks: [[15], [16], [17]] }, (id, roundWeeks)"),
  ('M13 call site: carried-in record skips the median game', SIM,
   "  if (medianGame) for (const wk of weekScores.values()) addMedianResults(wk, out);",
   ""),
  ('M14 unit: median win needs only to tie the median', SIM,
   "    if (s > mid) r.w++; else if (s === mid) r.w += 0.5;",
   "    if (s >= mid) r.w++;"),
  ('S1 designed survivor (equivalent): division winners re-sorted although already in order', LR,
   "  const top = [...winners.values()].sort(cmp);",
   "  const top = [...winners.values()];"),
  ('N1 not-applied control: pattern absent', LR,
   "THIS LINE DOES NOT EXIST IN THE FILE",
   "x"),
]
def run_file(path):
    d = tempfile.mkdtemp()
    env = dict(os.environ, SCHEDULER_DISABLED='1', GRIDIRON_DB_PATH=os.path.join(d, 't.sqlite'))
    p = subprocess.run(['node', '--experimental-test-module-mocks', '--test', '--test-reporter=tap', path],
                       capture_output=True, text=True, env=env)
    subprocess.run(['rm', '-rf', d])
    return p.returncode, re.findall(r'^not ok (\d+) - ', p.stdout, re.M)
def run_tests():
    c1, f1 = run_file('test/league-rules.test.js')
    c2, f2 = run_file('test/league-rules-bracket-sim.test.js')
    return max(c1, c2), f1 + ['B' + n for n in f2]
only = sys.argv[1:]
for name, f, old, new in MUTANTS:
    if only and name.split()[0] not in only: continue
    src = open(f).read()
    n = src.count(old)
    if n != 1:
        print(f'{name}: NOT APPLIED (pattern count {n})'); continue
    open(f, 'w').write(src.replace(old, new))
    try:
        code, fails = run_tests()
    finally:
        subprocess.run(['git', 'checkout', '--', f])
    verdict = 'KILLED' if fails else 'SURVIVED'
    print(f'{name}: {verdict} (exit {code}; failing tests {",".join(fails) or "none"})')
