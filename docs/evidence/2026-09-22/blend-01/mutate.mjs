#!/usr/bin/env node
/**
 * BLEND-01 mutation sweep (merge-gate v2 §2), the shape of the shared mutate-run-v1.sh
 * rebuilt for this Mac (that script's paths are the cloud box's; it is never edited in place).
 *
 *   node docs/evidence/2026-09-22/blend-01/mutate.mjs <sha> <tag> <spec.json>   (from the repo root)
 *
 * Runs in an isolated detached worktree of <sha> (node_modules symlinked from the main clone);
 * the builder's worktree is never touched. Each mutant is applied only when its anchor occurs
 * EXACTLY once (else NOT-APPLIED), the file's sha256 is recorded before and after, the listed
 * tests run, the failing tests are recorded by title, and the file is restored and re-hashed.
 * A BASELINE line (the unmutated head) opens the output so an already-red suite is visible.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [sha, tag, specPath] = process.argv.slice(2);
if (!sha || !tag || !specPath) throw new Error('usage: blend01-mutate.mjs <sha> <tag> <spec.json>');
const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
// node_modules for the throwaway worktree: MUTATE_NODE_MODULES, else this checkout's own (a symlink is followed).
const MODULES = process.env.MUTATE_NODE_MODULES ?? fs.realpathSync(path.join(REPO, 'node_modules'));
const SP = fs.mkdtempSync(path.join(os.tmpdir(), 'blend01-mutate-'));
const WT = path.join(SP, `mut-${tag}`);
const OUT = path.join(SP, `mutation-${tag}.json`);
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();
if (fs.existsSync(WT)) { git('worktree', 'remove', '--force', WT); }
git('worktree', 'add', '-q', '--detach', WT, sha);
fs.symlinkSync(MODULES, path.join(WT, 'node_modules'));
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(WT, f))).digest('hex').slice(0, 12);

function runTests(tests) {
  const results = { pass: 0, fail: 0, failing: [] };
  for (const t of tests) {
    const db = fs.mkdtempSync(path.join(os.tmpdir(), 'blend01-mut-'));
    const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-reporter=tap', t], {
      cwd: WT, encoding: 'utf8', timeout: 300_000,
      env: { ...process.env, SCHEDULER_DISABLED: '1', GRIDIRON_DB_PATH: path.join(db, 't.sqlite'), NFL_SEASON: '2026' }
    });
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const pass = Number(out.match(/^# pass (\d+)/m)?.[1] ?? 0);
    const fail = Number(out.match(/^# fail (\d+)/m)?.[1] ?? (r.status === 0 ? 0 : 1));
    results.pass += pass; results.fail += fail;
    for (const m of out.matchAll(/^not ok \d+ - (.+)$/gm)) results.failing.push(`${t}: ${m[1]}`);
    fs.rmSync(db, { recursive: true, force: true });
  }
  return results;
}

const report = { sha, tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: WT, encoding: 'utf8' }).trim(),
  tests: spec.tests, started_at: new Date().toISOString() };
report.baseline = runTests(spec.tests);
console.log('BASELINE', JSON.stringify(report.baseline));
report.rows = [];
for (const m of spec.mutants) {
  const file = path.join(WT, m.file);
  const before = fs.readFileSync(file, 'utf8');
  const occurrences = before.split(m.from).length - 1;
  const row = { id: m.id, file: m.file, kind: m.kind, expect: m.expect, note: m.note, from: m.from, to: m.to,
    occurrences, sha_before: hash(m.file) };
  if (occurrences !== 1) {
    row.state = 'NOT-APPLIED';
    row.verdict = 'NOT-APPLIED';
  } else {
    fs.writeFileSync(file, before.replace(m.from, m.to));
    row.state = 'APPLIED';
    row.sha_after = hash(m.file);
    const r = runTests(spec.tests);
    row.pass = r.pass; row.fail = r.fail; row.failing = r.failing;
    row.verdict = r.fail > 0 ? 'KILLED' : 'SURVIVED';
    fs.writeFileSync(file, before);
    row.sha_restored = hash(m.file);
    if (row.sha_restored !== row.sha_before) throw new Error(`${m.id}: restore failed`);
  }
  row.as_expected = row.verdict === m.expect;
  report.rows.push(row);
  console.log(`${m.id} ${row.verdict} (expect ${m.expect}) ${row.failing?.length ?? 0} red`);
}
report.finished_at = new Date().toISOString();
fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
git('worktree', 'remove', '--force', WT);
console.log('wrote', OUT);
