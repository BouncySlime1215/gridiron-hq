#!/usr/bin/env python3
"""One injection: hash the file, apply a literal substitution, run the named
tests, record the failures, restore, and prove the restore by hash.

Run it from the repository root, naming a spec file beside this one, and
optionally the rows to run:

    python3 docs/tdd/sweeps/mutation-sweep.py docs/tdd/sweeps/ledger.json
    python3 docs/tdd/sweeps/mutation-sweep.py docs/tdd/sweeps/catalog.json M12

The hashes are the point. A diffstat says something changed; a SHA-256 pair
says exactly which bytes the suite was run against, so anyone can reproduce
the row without guessing at the injection. A row whose anchor is absent is
reported NOT APPLIED rather than silently scoring zero failures, and each
spec file ends with a NO-OP control so that a zero in the failure column is
a measurement rather than a mechanism that quietly did nothing.

It writes nothing outside the file it is mutating and a <spec>.results.json
beside the spec, and it restores the file unconditionally.
"""
import hashlib, json, pathlib, subprocess, sys, os

ROOT = pathlib.Path(__file__).resolve().parents[3]

def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def run_one(spec):
    p = ROOT / spec['file']
    before_bytes = p.read_bytes()
    before = hashlib.sha256(before_bytes).hexdigest()
    text = before_bytes.decode()
    edits = spec.get('edits') or [[spec['old'], spec['new']]]
    for old, _ in edits:
        if text.count(old) != 1:
            return {**spec, 'status': f'NOT APPLIED (anchor x{text.count(old)})',
                    'before': before[:8], 'after': '-', 'fails': None, 'titles': []}
    for old, new_ in edits:
        text = text.replace(old, new_, 1)
    p.write_text(text)
    after = sha(p)
    env = {**os.environ, 'SCHEDULER_DISABLED': '1'}
    out = subprocess.run(['node', '--test', *spec['tests'].split()],
                         cwd=ROOT, env=env, capture_output=True, text=True)
    lines = [l for l in (out.stdout + out.stderr).splitlines() if l.startswith('not ok')]
    titles = [l.split(' - ', 1)[1] if ' - ' in l else l for l in lines]
    p.write_bytes(before_bytes)
    restored = sha(p)
    status = 'APPLIED' if restored == before else 'RESTORE FAILED'
    # Every title, not the first few: the seventh part of the standard asks
    # which tests a sweep leaves untouched, and that is the union of these
    # subtracted from the suite. A capped list makes the union look thinner
    # than it is, which is the flattering direction.
    return {**spec, 'status': status, 'before': before[:8], 'after': after[:8],
            'fails': len(lines), 'titles': titles}


def baseline(tests):
    """Every test title in these suites, with nothing injected."""
    env = {**os.environ, 'SCHEDULER_DISABLED': '1'}
    out = subprocess.run(['node', '--test', *tests.split()],
                         cwd=ROOT, env=env, capture_output=True, text=True)
    titles, failed = [], []
    for line in (out.stdout + out.stderr).splitlines():
        if line.startswith('ok ') or line.startswith('not ok '):
            if ' - ' in line:
                title = line.split(' - ', 1)[1]
                titles.append(title)
                if line.startswith('not ok'):
                    failed.append(title)
    return titles, failed

if __name__ == '__main__':
    if sys.argv[1] == '--baseline':
        titles, failed = baseline(sys.argv[2])
        print(json.dumps({'titles': titles, 'failed': failed}, indent=1))
        sys.exit(0)
    specs = json.loads(pathlib.Path(sys.argv[1]).read_text())
    only = sys.argv[2:] or None
    results = []
    for spec in specs:
        if only and spec['id'] not in only:
            continue
        r = run_one(spec)
        results.append(r)
        print(f"{r['id']}|{r['status']}|{r['before']}->{r['after']}|fails={r['fails']}|"
              f"{(r['titles'] or ['-'])[0]}", flush=True)
    out = pathlib.Path(sys.argv[1]).with_suffix('.results.json')
    prev = json.loads(out.read_text()) if out.exists() else []
    byid = {x['id']: x for x in prev}
    for r in results:
        byid[r['id']] = r
    out.write_text(json.dumps(list(byid.values()), indent=1))
