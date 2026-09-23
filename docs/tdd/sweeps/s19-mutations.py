"""S-19 mutation sweep: apply each mutant to a clean tree, run test/hype-one-producer.test.js, restore.
Run from the worktree root: python3 docs/tdd/sweeps/s19-mutations.py"""
import os, subprocess, tempfile
H, PL, RT, WB = 'server/services/hype.js', 'server/routes/players.js', 'server/routes/trades.js', 'server/services/waiver-brain.js'
M = [
  ('M1 season gate removed', H, "r.sleeper_id !== id || r.season !== season ||", "r.sleeper_id !== id ||", 'killed'),
  ('M2 as-of week gate removed', H, "|| r.week > week) continue;", ") continue;", 'killed'),
  ('M3 hype made a SELL call', H, "    verdict: null,\n", "    verdict: 'SELL',\n", 'killed'),
  ('M4 no_sleeper_id guard removed', H, "if (sleeperId == null || sleeperId === '') return none('no_sleeper_id');", "", 'killed'),
  ('M5 served hype drifts from the table', H, "available: true, hype: hit.hype,", "available: true, hype: hit.price,", 'killed'),
  ('C1 call site: analyze no-key drops hype', PL, "return res.status(400).json({ hype,", "return res.status(400).json({", 'killed'),
  ('C2 call site: analyze AI branch drops hype', PL, "source: 'ai_evidence_selection', hype });", "source: 'ai_evidence_selection' });", 'killed'),
  ('C3 call site: analyze reads its own key', PL, "playerHype({ sleeperId: player.sleeper_id })", "playerHype({ sleeperId: String(player.id) })", 'killed'),
  ('C4 call site: market route reads its own key', RT, "hype: playerHype({ sleeperId: player.sleeper_id })", "hype: playerHype({ sleeperId: null })", 'killed'),
  ('C5 call site: sellHigh reads its own key', WB, "hype: playerHype({ sleeperId: p.sleeper_id })", "hype: playerHype({ sleeperId: String(p.id) })", 'killed'),
  ('C6 call site: sellHigh flags without the producer', WB, "readings.filter(x => x.hype.verdict === 'SELL').slice(0, limit)", "readings.slice(0, limit)", 'killed'),
  ('C7 heuristic resurrected in analyze (writes a verdict with no signal)', PL, "      if (!hype.verdict) {", "      if (false) {", 'killed'),
  ('M6 selection order flipped: earliest eligible week served', H, "if (!hit || r.week > hit.week) hit = r;", "if (!hit || r.week < hit.week) hit = r;", 'killed'),
  ('M7 first eligible row wins', H, "if (!hit || r.week > hit.week) hit = r;", "if (!hit) hit = r;", 'killed'),
  ('M8 last eligible row wins', H, "if (!hit || r.week > hit.week) hit = r;", "hit = r;", 'killed'),
  ('C8 trade-engine deal tag claims sell-high again', 'server/services/trade-engine.js', "tags.push('Sell the Veteran')", "tags.push('Sell High')", 'killed'),
  ('C9 served why string points at the removed sellHigh curve', 'server/services/trade-tactics.js', "NOT the trade-price hype in services/hype.js#playerHype", "NOT the market-price curve in waiver-brain#sellHigh", 'killed'),
  ('S1 designed survivor: tie-break >= on week (weeks are unique per player-season)', H, "if (!hit || r.week > hit.week) hit = r;", "if (!hit || r.week >= hit.week) hit = r;", 'survives'),
  ('N1 not-applied control', H, "THIS_TEXT_IS_NOT_IN_THE_FILE", "x", 'not-applied'),
]
def run():
    d = tempfile.mkdtemp()
    env = dict(os.environ, SCHEDULER_DISABLED='1', GRIDIRON_DB_PATH=os.path.join(d, 't.sqlite'))
    p = subprocess.run(['node', '--experimental-test-module-mocks', '--test', '--test-reporter=tap', 'test/hype-one-producer.test.js'],
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
