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

For each test it turns red, a row records the file and line of the assertion
that actually threw, taken from the runner's own stack frame. Which assertion
caught an injection is not a detail: a row aimed at a negation can be killed
by a positive assertion standing beside it, in which case the positive is
measured twice and the negation not at all. The line makes that checkable from
the output instead of by reading the diff.

A row normally names one file. A row may instead name `files`, a list of
{file, edits} groups applied together, for the case where the behaviour under
attack is guarded twice and removing either guard alone changes nothing a
caller can see. That case is a finding in its own right, so the single-file
rows that measure it stay in the spec beside the two-file row.

It writes nothing outside the files it is mutating and a <spec>.results.json
beside the spec, and it restores every file it touched unconditionally.
"""
import hashlib, json, pathlib, re, signal, subprocess, sys, os, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]

# The same runner `npm test` uses. The module-mock flag and the offline guard
# matter for suites outside coach/ — test/page-explain.test.js mocks a module
# and fails to load without the flag — and both are harmless for the rest, so
# every sweep runs the same way rather than each knowing its own incantation.
NODE = ['node', '--experimental-test-module-mocks', '--test', '--test-concurrency=1']

# A row that has not finished in this long is hung, not slow: the slowest real
# row in this repository runs in about two minutes. An injection can hang the
# runner outright — deleting a route's guard sends a request down a path whose
# response never ends — and a sweep that stalls on one row overnight has
# measured nothing. A timeout is reported with `fails` left empty rather than
# scored as a zero, because a row that did not finish did not kill nothing; it
# did not run.
ROW_TIMEOUT_S = 600


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


FRAME = re.compile(r'\(file://(?P<path>[^)]*?):(?P<line>\d+):\d+\)')


def failures(text):
    """('not ok' lines, their titles, and where each assertion actually threw).

    The third is the point. node:test's TAP block carries a `stack:` whose
    first frame is the assertion that failed, so a row can say which line
    caught it rather than only which test did.
    """
    out_lines = text.splitlines()
    lines, titles, killers = [], [], []
    for i, line in enumerate(out_lines):
        if not line.startswith('not ok'):
            continue
        lines.append(line)
        titles.append(line.split(' - ', 1)[1] if ' - ' in line else line)
        # Scan to the end of this test's YAML block, not a fixed number of
        # lines: a failed deepEqual prints the whole diff between `not ok` and
        # the stack, which for a wide object is hundreds of lines. The first
        # parenthesised file:// frame under `stack:` is the throw site; the
        # unparenthesised `location:` field is the test's declaration line, and
        # the regex's required parenthesis skips it on purpose.
        where = '-'
        for follow in out_lines[i + 1:]:
            if follow.startswith('not ok') or follow.startswith('ok '):
                break
            if follow.rstrip() == '  ...':
                break
            m = FRAME.search(follow)
            if m:
                path = m.group('path')
                where = f"{path[len(str(ROOT)) + 1:] if path.startswith(str(ROOT)) else path}:{m.group('line')}"
                break
        killers.append(where)
    return lines, titles, killers


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
    timed_out = False
    lines, titles, killers = [], [], []
    # try/finally, not a restore at the end: an unhandled error here, a Ctrl-C
    # or a SIGTERM would otherwise leave the source file mutated. That is not
    # hypothetical — killing an earlier run of this harness mid-row left a
    # deleted guard in a file the sweep does not own.
    try:
        for (p, _), text in zip(gs, texts):
            p.write_text(text)
        after = '+'.join(sha(p)[:8] for p, _ in gs)
        try:
            out = subprocess.run(NODE + spec['tests'].split(), cwd=ROOT, env=test_env(),
                                 capture_output=True, text=True, timeout=ROW_TIMEOUT_S)
            lines, titles, killers = failures(out.stdout + out.stderr)
        except subprocess.TimeoutExpired:
            timed_out = True
    finally:
        for (p, _), before_bytes in zip(gs, originals):
            p.write_bytes(before_bytes)
    restored = '+'.join(sha(p)[:8] for p, _ in gs)
    status = 'APPLIED' if restored == before else 'RESTORE FAILED'
    if timed_out and status == 'APPLIED':
        return {**spec, 'status': f'TIMED OUT (>{ROW_TIMEOUT_S}s)', 'before': before,
                'after': after, 'fails': None, 'titles': [], 'killers': []}
    # Every title, not the first few: the seventh part of the standard asks
    # which tests a sweep leaves untouched, and that is the union of these
    # subtracted from the suite. A capped list makes the union look thinner
    # than it is, which is the flattering direction.
    return {**spec, 'status': status, 'before': before, 'after': after,
            'fails': len(lines), 'titles': titles, 'killers': killers}


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
    # SystemExit unwinds through run_one's finally, so a stopped sweep still
    # leaves every file it touched exactly as it found it.
    for _sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(_sig, lambda *_: sys.exit(1))
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
              f"{(r.get('killers') or ['-'])[0]}|{(r['titles'] or ['-'])[0]}", flush=True)
    out = pathlib.Path(sys.argv[1]).with_suffix('.results.json')
    prev = json.loads(out.read_text()) if out.exists() else []
    byid = {x['id']: x for x in prev}
    for r in results:
        byid[r['id']] = r
    out.write_text(json.dumps(list(byid.values()), indent=1))
