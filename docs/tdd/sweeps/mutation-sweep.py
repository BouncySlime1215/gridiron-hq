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

A row normally names one file. A row may instead name `files`, a list of
{file, edits} groups applied together, for the case where the behaviour under
attack is guarded twice and removing either guard alone changes nothing a
caller can see. That case is a finding in its own right, so the single-file
rows that measure it stay in the spec beside the two-file row.

It writes nothing outside the files it is mutating and a <spec>.results.json
beside the spec, and it restores every file it touched unconditionally.
"""
import hashlib, json, pathlib, subprocess, sys, os, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]

# The same runner `npm test` uses. The module-mock flag and the offline guard
# matter for suites outside coach/ — test/page-explain.test.js mocks a module
# and fails to load without the flag — and both are harmless for the rest, so
# every sweep runs the same way rather than each knowing its own incantation.
NODE = ['node', '--experimental-test-module-mocks', '--test', '--test-concurrency=1']


def test_env():
    return {**os.environ, 'SCHEDULER_DISABLED': '1',
            'NODE_OPTIONS': '--import ./test/offline-guard.mjs',
            'GRIDIRON_DB_PATH': tempfile.mktemp(prefix='gridiron-sweep-', suffix='.sqlite')}


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def groups(spec):
    """[(path, [(old, new), ...]), ...] — one group per file the row touches."""
    if spec.get('files'):
        return [(ROOT / g['file'], [tuple(e) for e in g['edits']]) for g in spec['files']]
    return [(ROOT / spec['file'],
             [tuple(e) for e in (spec.get('edits') or [[spec['old'], spec['new']]])])]


def run_one(spec):
    gs = groups(spec)
    originals = [p.read_bytes() for p, _ in gs]
    before = '+'.join(hashlib.sha256(b).hexdigest()[:8] for b in originals)
    texts = []
    for (p, edits), before_bytes in zip(gs, originals):
        text = before_bytes.decode()
        for old, _ in edits:
            if text.count(old) != 1:
                where = '' if len(gs) == 1 else f' in {p.name}'
                return {**spec, 'status': f'NOT APPLIED (anchor x{text.count(old)}{where})',
                        'before': before, 'after': '-', 'fails': None, 'titles': []}
        for old, new_ in edits:
            text = text.replace(old, new_, 1)
        texts.append(text)
    for (p, _), text in zip(gs, texts):
        p.write_text(text)
    after = '+'.join(sha(p)[:8] for p, _ in gs)
    out = subprocess.run(NODE + spec['tests'].split(),
                         cwd=ROOT, env=test_env(), capture_output=True, text=True)
    lines = [l for l in (out.stdout + out.stderr).splitlines() if l.startswith('not ok')]
    titles = [l.split(' - ', 1)[1] if ' - ' in l else l for l in lines]
    for (p, _), before_bytes in zip(gs, originals):
        p.write_bytes(before_bytes)
    restored = '+'.join(sha(p)[:8] for p, _ in gs)
    status = 'APPLIED' if restored == before else 'RESTORE FAILED'
    # Every title, not the first few: the seventh part of the standard asks
    # which tests a sweep leaves untouched, and that is the union of these
    # subtracted from the suite. A capped list makes the union look thinner
    # than it is, which is the flattering direction.
    return {**spec, 'status': status, 'before': before, 'after': after,
            'fails': len(lines), 'titles': titles}


def baseline(tests):
    """Every test title in these suites, with nothing injected."""
    out = subprocess.run(NODE + tests.split(),
                         cwd=ROOT, env=test_env(), capture_output=True, text=True)
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
