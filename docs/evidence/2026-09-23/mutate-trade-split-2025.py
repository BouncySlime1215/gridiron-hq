"""Mutation sweep for scripts/rnd/trade_split_2025.py (RL-8-2b).

Unit mutants are judged by the unit tests. Call-site mutants (inside main()) are judged WITHOUT touching 2025: the
study runs in --smoke mode on 2024 (a season RL-8-2 already used; counts only, no rate is printed) and its output is
diffed against the unmutated smoke output from the same tree. The source file is always restored.
Run from the worktree root:
  python3 docs/evidence/2026-09-23/mutate-trade-split-2025.py --local-db .local-db/data.sqlite
"""
import subprocess
import sys

SRC = 'scripts/rnd/trade_split_2025.py'
PY = '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3'
UNIT = [
    ('verdict (a) > 0.55 -> >= 0.55', "rate > 0.55 and lo > 0.50 else", "rate >= 0.55 and lo > 0.50 else"),
    ('verdict (b) x_con <= 0.50 -> < 0.50', "con_rate <= 0.50", "con_rate < 0.50"),
    ('verdict (b) drops the x_con clause', "and con_rate <= 0.50", "and True"),
    ('drop tie -> higher rate', "(pts == cut_pts and r(p) < r(cut))", "(pts == cut_pts and r(p) > r(cut))"),
    ('needed spots never dropped', "    for _ in range(spots):", "    for _ in range(0):"),
    ('wire offers held players', "if fa in held or ps not in C.SKILL:", "if ps not in C.SKILL:"),
    ('fill picks highest rate, not biggest gain', "pts = points(cur + [fa])", "pts = r(fa)"),
    ('2-for-2 draws from the 2-for-1 stream', "a = rng3.choice(rids)", "a = rng2.choice(rids)"),
    ('pick_rate keeps model == 0', "for r in rows if r[mkey] != 0])", "for r in rows])"),
    ('skill_slots keeps K/DEF', "return [s for s in slots if s in SKILL_SLOTS]", "return list(slots)"),
    ('DESIGNED SURVIVOR per_week rounded to 3 dp (tests use whole numbers)', "before, 4)", "before, 3)"),
    ('NOT-APPLIED CONTROL (string absent)', "this string is not in the file", "x"),
]
CALL = [
    ('call site: wire not cleared of rostered players', "wire = [p for p in wire_for(r['s'], r['w']) if p not in rostered]",
     "wire = list(wire_for(r['s'], r['w']))"),
    ('call site: pre-trade roster keeps received players', "pre_a = [p for p in pa if p not in set(r['recv'])]",
     "pre_a = [p for p in pa]"),
    ('call site: trade week window 4-14 -> 3-14', "not (4 <= w <= 14)", "not (3 <= w <= 14)"),
    ('call site: C1 control threshold removed', "if len(D8) != 210 or round(est, 3) != 0.576:", "if False:"),
    ('DESIGNED SURVIVOR call site: arm (b) graded on x_con (rate-only; smoke prints no rate)',
     "rate_b, c_b = report('(b) PRIMARY lineup value', GB, 'D_LV', 'y_L')",
     "rate_b, c_b = report('(b) PRIMARY lineup value', GB, 'x_con', 'y_L')"),
]


def run_unit():
    p = subprocess.run([PY, '-m', 'unittest', 'scripts/rnd/test_trade_split_2025.py'], capture_output=True, text=True)
    return p.returncode != 0, (p.stderr.strip().splitlines() or [''])[-1]


def smoke(db):
    p = subprocess.run(['nice', '-n', '10', PY, SRC, '--local-db', db, '--season', '2024', '--smoke'],
                       capture_output=True, text=True)
    return (p.stdout + p.stderr).splitlines()


def sweep(muts, judge):
    orig = open(SRC).read()
    for name, a, b in muts:
        if a not in orig:
            print(f'NOT APPLIED  {name}')
            continue
        open(SRC, 'w').write(orig.replace(a, b, 1))
        try:
            killed, why = judge()
        finally:
            open(SRC, 'w').write(orig)
        print(f'{"KILLED  " if killed else "SURVIVED"}     {name}  | {why[:160]}')


if __name__ == '__main__':
    sweep(UNIT, run_unit)
    db = sys.argv[sys.argv.index('--local-db') + 1]
    base = smoke(db)
    print(f'smoke baseline (2024, counts only): {len(base)} lines')

    def judge():
        got = smoke(db)
        d = next((g for g, w in zip(got, base) if g != w), None)
        if d is None and len(got) != len(base):
            d = f'line count {len(got)} vs {len(base)}'
        return d is not None, d or 'identical smoke output'
    sweep(CALL, judge)
