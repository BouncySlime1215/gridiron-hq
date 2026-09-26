/**
 * Mutation sweep for the gridiron merge gate (v2 section 2).
 *
 * Applies one mutation at a time to a source file, runs a single test file,
 * and records whether the mutation DIED (tests failed, so the tests pin that
 * behaviour) or SURVIVED (tests passed, so nothing pins it).
 *
 * Every spec carries two designed controls, per the gate:
 *   - a NOT-APPLIED control: no mutation, tests must pass. If this fails the
 *     harness is measuring something other than the mutation.
 *   - a designed SURVIVING control: a change the tests deliberately do not pin,
 *     which must survive. If it dies, the tests are pinning more than claimed
 *     and the "survived" verdicts below are not trustworthy.
 *
 * Usage: node mutation-sweep.mjs <repo-root> <spec.json>
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [, , root, specPath] = process.argv;
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const target = path.join(root, spec.file);
const original = fs.readFileSync(target, 'utf8');

const runTests = () => {
  try {
    execFileSync('node', ['--test', ...(spec.nodeFlags ?? []), spec.test],
      { cwd: root, stdio: 'pipe', env: { ...process.env, SCHEDULER_DISABLED: '1' } });
    return { passed: true };
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '');
    const first = out.split('\n').find(l => /^not ok /.test(l.trim())) ?? '(no "not ok" line)';
    return { passed: false, first: first.trim() };
  }
};

const results = [];
try {
  // Control 1: nothing applied.
  const base = runTests();
  results.push({ id: 'control-not-applied', kind: 'control', expect: 'pass',
    verdict: base.passed ? 'PASS' : 'FAIL', detail: base.first ?? '' });
  if (!base.passed) {
    console.log(JSON.stringify({ aborted: 'unmutated tests do not pass', results }, null, 2));
    process.exit(1);
  }

  for (const m of spec.mutants) {
    if (!original.includes(m.find)) {
      results.push({ id: m.id, kind: m.kind ?? 'mutant', verdict: 'NOT-APPLIED',
        detail: 'find string absent — spec is stale against the source' });
      continue;
    }
    const count = original.split(m.find).length - 1;
    fs.writeFileSync(target, original.replace(m.find, m.replace));
    const r = runTests();
    const verdict = r.passed ? 'SURVIVED' : 'DIED';
    results.push({ id: m.id, kind: m.kind ?? 'mutant', expect: m.expect, sites: count,
      verdict, matches: verdict === m.expect, detail: r.first ?? '' });
    fs.writeFileSync(target, original);
  }
} finally {
  fs.writeFileSync(target, original);
}

const bad = results.filter(r => r.matches === false || r.verdict === 'NOT-APPLIED');
console.log(JSON.stringify({ file: spec.file, test: spec.test, results,
  unexpected: bad.map(r => r.id) }, null, 2));
process.exit(bad.length ? 2 : 0);
