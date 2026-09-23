#!/usr/bin/env python3
"""PROJ-02-a mutation sweep: mutate projections.js (unit and call site), run
test/proj-02-chain.test.js, restore. Run from the worktree root. Temp DB per run."""
import subprocess, tempfile, os, shutil, re, sys

SRC = 'server/services/projections.js'
TEST = 'test/proj-02-chain.test.js'
MUTANTS = [
    ('M1 unit: no normalization (raw share)', 'const targetShare = sum?.tgt > 0 ? c.rawTargetShare / sum.tgt : null;',
     'const targetShare = sum?.tgt > 0 ? c.rawTargetShare : null;', 'kill'),
    ('M2 unit: drop team target rate', 'targetShare * tv.pass_att * tv.target_rate', 'targetShare * tv.pass_att', 'kill'),
    ('M3 unit: roster = everyone on the team', 'roster: teamVol.has(a.team) && a.recentTeams.has(a.team),',
     'roster: teamVol.has(a.team),', 'kill'),
    ('M4 call site: script read for the cutoff week, not the predicted week',
     'const predictWeek = throughWeek != null ? throughWeek + 1 : null;',
     'const predictWeek = throughWeek != null ? throughWeek : null;', 'kill'),
    ('M5 call site: attachChain never called', '  attachChain(out, chainIn, { teamVol, leagueVol, through, throughWeek, scoring });\n', '\n', 'kill'),
    ('M6 unit: targets link served', 'targets: false, carries: false });', 'targets: true, carries: false });', 'kill'),
    ('M7 unit: pass/rush multipliers swapped', 'const passMult = gs?.pass_mult ?? 1, rushMult = gs?.rush_mult ?? 1;',
     'const passMult = gs?.rush_mult ?? 1, rushMult = gs?.pass_mult ?? 1;', 'kill'),
    ('M8 unit: ROSTER_WEEKS 3 -> 30', 'const ROSTER_WEEKS = 3;', 'const ROSTER_WEEKS = 30;', 'kill'),
    ('M9a unit: season-average plays recency-weighted (first sweep designed it as a survivor; the stale 2022 AAA rows make it die, so test 5 pins the plain average)',
     'season_plays: a.sN ? +((a.sAtt + a.sCar) / a.sN).toFixed(2) : null,',
     'season_plays: a.sN ? +((a.att + a.car) / a.w).toFixed(2) : null,', 'kill'),
    ('M9 DESIGNED SURVIVOR: incumbent pass-rate rounding 4 -> 5 decimals (test tolerance 1e-4, rounding not pinned)',
     'season_pass_rate: a.sN && a.sAtt + a.sCar > 0 ? +(a.sAtt / (a.sAtt + a.sCar)).toFixed(4) : null,',
     'season_pass_rate: a.sN && a.sAtt + a.sCar > 0 ? +(a.sAtt / (a.sAtt + a.sCar)).toFixed(5) : null,', 'survive'),
    ('M10 NOT-APPLIED CONTROL: pattern absent from the file', 'const THIS_TEXT_IS_NOT_IN_PROJECTIONS = 1;',
     'const X = 2;', 'not_applied'),
]

def run_test():
    d = tempfile.mkdtemp()
    env = dict(os.environ, SCHEDULER_DISABLED='1', GRIDIRON_DB_PATH=os.path.join(d, 'x.sqlite'))
    r = subprocess.run(['node', '--experimental-test-module-mocks', '--test', '--test-reporter=tap', TEST],
                       capture_output=True, text=True, env=env)
    shutil.rmtree(d, ignore_errors=True)
    fail = re.search(r'^# fail (\d+)', r.stdout, re.M)
    return int(fail.group(1)) if fail else -1

orig = open(SRC).read()
rows = []
try:
    for name, old, new, expect in MUTANTS:
        if old not in orig:
            got = 'not_applied'
            rows.append((name, expect, got, '-', got == expect))
            continue
        open(SRC, 'w').write(orig.replace(old, new, 1))
        fails = run_test()
        got = 'kill' if fails > 0 else 'survive'
        rows.append((name, expect, got, fails, got == expect))
finally:
    open(SRC, 'w').write(orig)
print('| mutant | expected | result | failing tests | as designed |')
print('|---|---|---|---|---|')
for r in rows:
    print(f'| {r[0]} | {r[1]} | {r[2]} | {r[3]} | {"yes" if r[4] else "NO"} |')
sys.exit(0 if all(r[4] for r in rows) else 1)
