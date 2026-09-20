#!/usr/bin/env node
/**
 * Re-derive a mutation table in an evidence file.
 *
 * WHY THIS IS COMMITTED. A mutation table is a claim about what a suite would
 * catch, and a claim nobody can re-run is a claim. This runner plus the JSON
 * beside it reproduce the table in `docs/tdd/*.tdd.md` row for row: the same
 * edits, the same suites, the same SHA-256 of the file before and after each
 * injection.
 *
 *   node docs/tdd/sweeps/run-mutations.mjs docs/tdd/sweeps/<list>.json
 *
 * Add `--json` for the raw result. Exit code is 1 if any row did not behave as
 * the list says it should, so this is usable as a check and not only as a
 * report.
 *
 * WHAT A ROW MEANS.
 *  - `expect: "red"`      the injection must make the named suites fail.
 *  - `expect: "no-op"`    the pattern must NOT be in the file. This is the
 *                         CONTROL row: it proves the harness reports "I did
 *                         not change anything" rather than silently passing,
 *                         which is the failure mode that makes a whole table
 *                         worthless.
 *  - `baseline_ref`       optional. When set, the row is ALSO run against the
 *                         test files as they were at that git ref, and the
 *                         result is reported as `old`. That is how a sweep
 *                         that tightened assertions shows the old ones
 *                         survived the same injection — a split that a
 *                         neighbouring clause can satisfy is not a split.
 *
 * Every injection is reverted before the next row, and the runner refuses to
 * continue if the file does not hash back to its baseline afterwards.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const listPath = process.argv[2];
const asJson = process.argv.includes('--json');
if (!listPath) {
  console.error('usage: node docs/tdd/sweeps/run-mutations.mjs <list.json> [--json]');
  process.exit(2);
}

const sha = file => createHash('sha256').update(readFileSync(resolve(ROOT, file))).digest('hex').slice(0, 12);
const read = file => readFileSync(resolve(ROOT, file), 'utf8');
const write = (file, text) => writeFileSync(resolve(ROOT, file), text);
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

/** Run `node --test` over the given suites and pull the TAP totals out. */
function runSuites(suites) {
  let out = '';
  try {
    out = execFileSync(process.execPath, ['--test', ...suites],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    // A failing suite exits non-zero, which is the normal case here.
    out = `${e.stdout ?? ''}`;
  }
  const total = k => {
    const line = out.split('\n').find(l => l.startsWith(`# ${k} `));
    return line ? Number(line.trim().split(' ').pop()) : -1;
  };
  // WHICH ASSERTION FAILED, not only which test. A test can hold a positive
  // `assert.match` and a negative `assert.doesNotMatch`, and "this mutation is
  // killed" means nothing until you know which of the two did the killing:
  // a negation's pattern matches nothing whenever the test passes, so counting
  // survivals across a mixed set of shapes is counting two different things.
  // node:test prints the throwing frame in the TAP `stack:` block.
  const suiteSet = new Set(suites.map(s => s.replace(/^\.\//, '')));
  const at = [];
  for (const line of out.split('\n')) {
    const m = line.match(/([\w./-]+\.test\.js):(\d+):\d+\)?\s*$/);
    if (m && [...suiteSet].some(s => m[1].endsWith(s.split('/').pop()))) {
      const hit = `${m[1].split('/').pop()}:${m[2]}`;
      if (!at.includes(hit)) at.push(hit);
    }
  }
  return {
    tests: total('tests'), pass: total('pass'), fail: total('fail'),
    failed: out.split('\n').filter(l => l.startsWith('not ok')).map(l => l.trim()),
    at,
  };
}

const list = JSON.parse(read(listPath));
const results = [];
let bad = 0;

for (const row of list.mutations) {
  const file = row.file ?? list.file;
  const suites = row.suites ?? list.suites;
  const baseline = sha(file);
  const before = read(file);

  if (!before.includes(row.from)) {
    const ok = row.expect === 'no-op';
    if (!ok) bad++;
    results.push({ id: row.id, what: row.what, status: 'NO-OP - pattern not found', ok });
    continue;
  }
  if (row.expect === 'no-op') {
    bad++;
    results.push({ id: row.id, what: row.what, status: 'APPLIED, but the list says it should be a NO-OP', ok: false });
    continue;
  }

  write(file, before.replace(row.from, row.to));
  const after = sha(file);
  const fresh = runSuites(suites);

  let old = null;
  if (row.baseline_ref ?? list.baseline_ref) {
    const ref = row.baseline_ref ?? list.baseline_ref;
    // `git show`, never `git checkout <ref> -- <path>`: checkout with a
    // pathspec STAGES what it writes, so the harness would hand back a clean
    // worktree over an index holding the pre-sweep tests — and the next
    // `git commit` would quietly undo the sweep. Reading the blob and writing
    // it ourselves touches the index not at all.
    const saved = suites.map(s => [s, read(s)]);
    for (const s of suites) write(s, git('show', `${ref}:${s}`));
    old = runSuites(suites);
    for (const [s, text] of saved) write(s, text);
  }

  write(file, before);
  if (sha(file) !== baseline) {
    console.error(`REFUSING TO CONTINUE: ${file} did not restore to ${baseline}`);
    process.exit(3);
  }

  const ok = fresh.fail > 0;
  if (!ok) bad++;
  results.push({
    id: row.id, what: row.what, file, applied: `${baseline} -> ${after}`,
    fresh, old, ok,
  });
}

if (asJson) {
  console.log(JSON.stringify({ list: listPath, results }, null, 1));
} else {
  for (const r of results) {
    if (r.status) { console.log(`${r.id}  ${r.status}  [${r.ok ? 'as listed' : 'UNEXPECTED'}]`); continue; }
    const oldTxt = r.old ? `  old ${r.old.tests}/${r.old.pass}/${r.old.fail}${r.old.fail ? '' : ' SURVIVED'}` : '';
    console.log(`${r.id}  APPLIED ${r.applied}  new ${r.fresh.tests}/${r.fresh.pass}/${r.fresh.fail}`
      + `${r.fresh.fail ? ' RED' : ' NOT KILLED'}${oldTxt}`);
    for (const f of r.fresh.failed) console.log(`      ${f}`);
    if (r.fresh.at?.length) console.log(`      killed at  ${r.fresh.at.join(', ')}`);
    if (r.old?.at?.length) console.log(`      old died at  ${r.old.at.join(', ')}`);
  }
  console.log(`\n${results.filter(r => r.ok).length} of ${results.length} rows behaved as the list says.`);
}
process.exit(bad ? 1 : 0);
