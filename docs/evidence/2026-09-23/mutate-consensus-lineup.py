"""Mutation sweep for scripts/rnd/consensus_vs_humans_lineup.py (RL-8-2).

Unit mutants are judged by the unit tests; call-site mutants (inside main()) are judged by re-running the study and
diffing its pre-registered output lines against the committed output. The file is always restored.
Run from the worktree root:
  python3 docs/evidence/2026-09-23/mutate-consensus-lineup.py [--with-study --local-db .local-db/data.sqlite]
"""
import subprocess
import sys

SRC = 'scripts/rnd/consensus_vs_humans_lineup.py'
OUT = 'docs/evidence/2026-09-23/consensus-vs-humans-lineup-output.txt'
PY = '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3'
UNIT = [
    ('ties counted as losses', "q = [(x, y) for x, y in pairs if y != 0]", "q = list(pairs)"),
    ('disagreement sign flipped', "(x_con > 0) != (x_std > 0)", "(x_con > 0) == (x_std > 0)"),
    ('gate bar 0.55 -> 0.50', "rate >= 0.55", "rate >= 0.50"),
    ('gate drops week bound', "and lo_week > 0.50 ", "and True "),
    ('2-for-1 draws from r8 stream', "a = rng2.choice(rids)", "a = rng.choice(rids)"),
    ('2-for-1 give side sign', "- sum(v - repl[p] for v, p in give)", "+ sum(v - repl[p] for v, p in give)"),
    ('bootstrap resamples rows not clusters', "for r in by[keys[i]]])", "for r in by[keys[i]][:1]])"),
    ('DESIGNED SURVIVOR per_week <= -> < (weeks=0 still caught by `not weeks`)', "weeks <= 0", "weeks < 0"),
    ('NOT-APPLIED CONTROL (string absent)', "this string is not in the file", "x"),
]
CALL = [
    ('call site: gate graded on S1 not primary', "DG = block('2023-24 pooled', G, 'y_L', gate=True)",
     "DG = block('2023-24 pooled', G, 'y_F', gate=True)"),
    ('call site: r8 orientation seed 7 -> 8', "rng = random.Random(7)", "rng = random.Random(8)"),
]


def run_unit():
    p = subprocess.run([sys.executable, '-m', 'unittest', 'scripts/rnd/test_consensus_vs_humans_lineup.py'],
                       capture_output=True, text=True)
    return p.returncode != 0, (p.stderr.strip().splitlines() or [''])[-1]


def run_study(db):
    p = subprocess.run(['nice', '-n', '10', PY, SRC, '--local-db', db], capture_output=True, text=True)
    want = open(OUT).read().splitlines()[:38]
    got = (p.stdout + p.stderr).splitlines()[:38]
    return got != want, f'exit {p.returncode}; first differing line: ' + next(
        (g for g, w in zip(got, want) if g != w), '(output truncated)' if len(got) < len(want) else 'none')


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
    if '--with-study' in sys.argv:
        db = sys.argv[sys.argv.index('--local-db') + 1]
        sweep(CALL, lambda: run_study(db))
