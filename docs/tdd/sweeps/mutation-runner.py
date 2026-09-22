"""
Mutation runner, second version.

What the first one could not prove, and this one does:

  * APPLIED is decided by `count(old) == 1`, not by `old in src`. An anchor
    that matches twice lands on whichever site comes first, which is how a
    mutation reads as applied while the site the test watches is untouched
    (the NO-OP-that-matched-elsewhere failure). An anchor with any count but
    one is reported NOT APPLIED with its count, never mutated.
  * The file's SHA-256 is recorded before the edit, after the edit, and again
    after the restore. A row whose after-hash equals its before-hash did not
    change the file whatever the runner believed, and a restore that does not
    return the before-hash is reported rather than assumed. The first version
    proved application with `git diff --numstat`, which is blind to untracked
    files and reported ten real mutations as no-ops.
  * The exact old and new text is carried into the row, so the evidence table
    is generated from what ran rather than retyped from a description.

Both outcomes are reportable, which is the property a verification step has to
have before its green means anything: a row can come back NOT APPLIED (wrong
anchor count), SURVIVED (applied, hash moved, no test failed) or killed (named
failures). The no-op control rows exercise the first of those on purpose, and
the runner's own hash column exercises the second — a row cannot be recorded
as killed without a hash change proving the file differed when the suite ran.
"""
import subprocess, os, json, sys, hashlib, tempfile

MUTS_PATH, OUT_PATH = (os.path.abspath(p) for p in sys.argv[1:3])

# The repository root, asked rather than hardcoded, so this runs from a fresh
# clone: `python3 docs/tdd/sweeps/mutation-runner.py <mutations.json> <out.json>`.
WT = subprocess.run(['git', 'rev-parse', '--show-toplevel'],
                    capture_output=True, text=True).stdout.strip()
assert WT, 'not inside a git working tree'
os.chdir(WT)
SHA = subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], capture_output=True, text=True).stdout.strip()

MUTS = json.load(open(MUTS_PATH))
FILES = sorted({m['file'] for m in MUTS})
BK = {f: open(f).read() for f in FILES}

def h(text):
    return hashlib.sha256(text.encode()).hexdigest()[:12]

def restore():
    for f, c in BK.items():
        if open(f).read() != c:
            open(f, 'w').write(c)

def run(tests):
    env = dict(os.environ, GRIDIRON_DB_PATH=os.path.join(tempfile.gettempdir(), 'gridiron-mutrun.sqlite'), SCHEDULER_DISABLED='1',
               NODE_OPTIONS='--import ./test/offline-guard.mjs')
    r = subprocess.run(['node', '--experimental-test-module-mocks', '--test',
                        '--test-concurrency=1', *tests], capture_output=True, text=True, env=env)
    out = r.stdout
    def num(k):
        for l in out.splitlines():
            if l.startswith(f'# {k} '):
                return int(l.split()[-1])
        return None
    titles = [l.split('- ', 1)[1].strip() for l in out.splitlines() if l.startswith('not ok')]
    return num('pass'), num('fail'), titles

rows = []
for m in MUTS:
    restore()
    src = BK[m['file']]
    before = h(src)
    count = src.count(m['old'])
    row = {**{k: m[k] for k in ('name', 'file', 'tests', 'old', 'new')}, 'sha': SHA,
           'aimed_at': m.get('aimed_at'), 'kind': m.get('kind', 'mutation'),
           'count': count, 'hash_before': before}
    if count != 1:
        row.update({'applied': False, 'why': f'anchor x{count}', 'hash_after': before,
                    'pass': None, 'fail': None, 'killed_by': [], 'restored': True})
        rows.append(row)
        print(f"[{len(rows):>3}] {m['name']} -> NOT APPLIED (anchor x{count})", flush=True)
        continue
    mutated = src.replace(m['old'], m['new'], 1)
    open(m['file'], 'w').write(mutated)
    after = h(mutated)
    assert after != before, f"{m['name']}: the file's hash did not move"
    p, f, titles = run(m['tests'])
    restore()
    row.update({'applied': True, 'hash_after': after, 'pass': p, 'fail': f,
                'killed_by': titles, 'restored': h(open(m['file']).read()) == before})
    rows.append(row)
    print(f"[{len(rows):>3}] {m['name']} -> {before}->{after} {p}/{f} "
          f"{titles if f else 'SURVIVED'}{'' if row['restored'] else '  !! NOT RESTORED'}", flush=True)

restore()
bad = [r['name'] for r in rows if r['applied'] and not r['restored']]
json.dump({'sha': SHA, 'rows': rows}, open(OUT_PATH, 'w'), indent=1)
print('restored; wrote', OUT_PATH, '; unrestored rows:', bad or 'none')
