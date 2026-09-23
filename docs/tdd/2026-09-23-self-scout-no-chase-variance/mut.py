"""RL-15-2 mutation sweep. Run from the worktree root on the GREEN tree:
python3 docs/tdd/2026-09-23-self-scout-no-chase-variance/mut.py
Each mutant rewrites one file, runs the targeted test, restores the file."""
import subprocess, tempfile, os, pathlib

TE = 'server/services/trade-engine.js'
RT = 'server/routes/trades.js'
ANCHOR = "  // No \"Roster shape\" fix (RL-15-2)."
def block(cond, action, area='Roster shape'):
    return ("  if (" + cond + ") {\n"
            "    const rank = myRank <= 3 ? 'contender' : myRank >= rivals.length - 1 ? 'longshot' : 'bubble';\n"
            "    fixes.push({ priority: 'low', area: '" + area + "', issue: 'x',\n"
            "      action: " + action + " });\n  }\n")
ORIG = ("rank === 'contender' ? 'You are ahead — trade ceiling for floor and consistency to protect the lead.'"
        " : 'You need variance — target boom-rate players over steady ones; a median week does not win you the league from here.'")
COND = 'spread.floor != null && spread.coverage > 0.5'
MUTANTS = [
  ('M1 unit: restore original Roster shape block', TE, ANCHOR, block(COND, ORIG) + ANCHOR),
  ('M2 unit: keep contender half only', TE, ANCHOR,
   block(COND + " && myRank <= 3", "'You are ahead — trade ceiling for floor and consistency to protect the lead.'") + ANCHOR),
  ('M3 unit: variance advice for longshot only', TE, ANCHOR,
   block(COND + " && myRank >= rivals.length - 1", "'You need variance — target boom-rate players.'") + ANCHOR),
  ('M4 unit: variance advice under a new area name', TE, ANCHOR,
   block(COND, "'You need variance.'", area='Upside') + ANCHOR),
  ('M5 unit: fixes list emptied in the return', TE, "    fixes: fixes.sort(", "    fixes: [].sort("),
  ('M6 designed survivor: reworded upside advice, new area', TE, ANCHOR,
   block(COND, "'Target high-upside players over safe ones.'", area='Upside') + ANCHOR),
  ('M7 call site: route drops team_id', RT, "selfScout(lg, req.query.team_id)", "selfScout(lg, undefined)"),
  ('M8 not-applied control: pattern absent from source', TE, "THIS_STRING_IS_NOT_IN_THE_FILE", "x"),
]
for name, f, old, new in MUTANTS:
    p = pathlib.Path(f); src = p.read_text()
    applied = old in src
    if applied: p.write_text(src.replace(old, new, 1))
    try:
        d = tempfile.mkdtemp()
        env = dict(os.environ, SCHEDULER_DISABLED='1', GRIDIRON_DB_PATH=os.path.join(d, 'x.sqlite'))
        out = subprocess.run(['node', '--experimental-test-module-mocks', '--test', '--test-reporter=tap',
                              'test/self-scout-variance-advice.test.js'], capture_output=True, text=True, env=env).stdout
        fails = [l for l in out.splitlines() if l.startswith('not ok')]
        verdict = 'NOT APPLIED' if not applied else ('killed' if fails else 'SURVIVED')
        print(f"{name} | applied={applied} | {verdict} | {'; '.join(x.split(' - ',1)[0] for x in fails) or '-'}")
    finally:
        p.write_text(src)
