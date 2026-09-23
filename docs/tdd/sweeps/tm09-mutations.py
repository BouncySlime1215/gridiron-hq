"""TM-09 mutation sweep: apply each mutant to a clean tree, run test/trade-market.test.js, restore.
Run from the worktree root: python3 docs/tdd/sweeps/tm09-mutations.py"""
import os, subprocess, tempfile
SVC, RT = 'server/services/trade-market.js', 'server/routes/trades.js'
M = [
  ('M1 weekBin edge', SVC, "w <= 4 ? '1-4'", "w < 4 ? '1-4'", 'killed'),
  ('M2 sizeBin edge', SVC, "n <= 13 ? '12'", "n <= 12 ? '12'", 'killed'),
  ('M3 H1 ship gate removed', SVC, "table.results?.h1?.passed !== true", "table.results?.h1?.passed === 'never'", 'killed'),
  ('M4 position fallback removed', SVC, "if (posRatio != null) {", "if (false) {", 'killed'),
  ('M5 missing ratio served as 1.0', SVC, "price_to_value: null, source: null, n: 0, reason: 'no_cell_or_position_ratio'", "price_to_value: 1, source: null, n: 0, reason: 'no_cell_or_position_ratio'", 'killed'),
  ('M6 history order dropped', SVC, ".sort((a, b) => a.season - b.season || a.week - b.week)", ".sort(() => 0)", 'killed'),
  ('M7 no_sleeper_id check removed', SVC, "if (sleeperId == null || sleeperId === '') return", "if (false) return", 'killed'),
  ('M8 label flipped', SVC, "status: 'unconfirmed forward'", "status: 'confirmed'", 'killed'),
  ('C1 call site: league size ignored', RT, "teams: lg.team_count ?? null", "teams: 10", 'killed'),
  ('C2 call site: week hard-coded', RT, "week: leagueCurrentWeek(lg)", "week: 1", 'killed'),
  ('C3 call site: sleeper_id not selected', RT, "SELECT id, name, position, sleeper_id FROM players WHERE id = ?", "SELECT id, name, position FROM players WHERE id = ?", 'killed'),
  ('C4 call site: 404 guard removed', RT, "if (!player) { res.status(404).json({ error: 'player not found' }); return; }", "", 'killed'),
  ('S1 designed survivor: memo cache disabled (behaviour-equivalent)', SVC, "if (file === TABLE_PATH && cached) return cached;", "if (false) return cached;", 'survives'),
  ('N1 not-applied control', SVC, "THIS_TEXT_IS_NOT_IN_THE_FILE", "x", 'not-applied'),
]
def run():
    d = tempfile.mkdtemp()
    env = dict(os.environ, SCHEDULER_DISABLED='1', GRIDIRON_DB_PATH=os.path.join(d, 't.sqlite'))
    p = subprocess.run(['node', '--experimental-test-module-mocks', '--test', '--test-reporter=tap', 'test/trade-market.test.js'],
                       env=env, capture_output=True, text=True)
    fails = [l for l in p.stdout.splitlines() if l.startswith('not ok')]
    return p.returncode, fails
for name, f, a, b, want in M:
    src = open(f).read()
    if a not in src:
        got, detail = 'not-applied', ''
    else:
        open(f, 'w').write(src.replace(a, b, 1))
        try:
            rc, fails = run()
        finally:
            open(f, 'w').write(src)
        got = 'killed' if rc != 0 else 'survives'
        detail = '; '.join(x.split(' - ', 1)[1] for x in fails[:3])
    print(f"{name} | expected {want} | got {got} | {'OK' if got == want else 'MISMATCH'} | {detail}")
