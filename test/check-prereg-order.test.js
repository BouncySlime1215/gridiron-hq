// GR-05 (plan items 12/18): a results file must not be committed before its
// pre-registration. docs/evidence/STATS-METHOD.md rule 1 says the prereg commit
// "must be an ancestor of the result's commit"; scripts/check-prereg-order.mjs
// is the check that enforces it. Each case builds a throwaway git repository
// (fixture) so the order of commits is exactly what the case says it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/check-prereg-order.mjs');
const P = await import('../scripts/check-prereg-order.mjs').catch(error => ({ __importError: error }));

function loaded() {
  assert.equal(P.__importError, undefined, `scripts/check-prereg-order.mjs must load: ${P.__importError?.message}`);
}

// Hermetic git: no user/system config, no hooks, no signing.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
  { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A fixture repo; `steps` is a list of commits, each {files: {path: text}, rename?: [from, to]}. */
function fixture(steps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prereg-order-'));
  git(dir, 'init', '-q', '-b', 'main');
  steps.forEach((step, i) => {
    for (const [file, text] of Object.entries(step.files ?? {})) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
      git(dir, 'add', file);
    }
    if (step.rename) {
      fs.mkdirSync(path.dirname(path.join(dir, step.rename[1])), { recursive: true });
      git(dir, 'mv', step.rename[0], step.rename[1]);
    }
    git(dir, 'commit', '-q', '--allow-empty', '-m', `step ${i + 1}`);
  });
  return dir;
}
const cleanup = dir => fs.rmSync(dir, { recursive: true, force: true });

const E = 'docs/evidence/2026-09-23';
const PREREG = `${E}/widget-lift-preregistration.md`;
const RESULT = `${E}/widget-lift-results.md`;

function cli(dir, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', dir, ...args], { env: GIT_ENV, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('names: a prereg file and its stem are recognised the way this repo names them', () => {
  loaded();
  assert.equal(P.preregStem('docs/evidence/2026-09-22/target-share-prior-preregistration.md'), 'target-share-prior');
  assert.equal(P.preregStem('docs/evidence/2026-09-22/R25-LEVEL-VS-INFORMATION-PREREGISTRATION.md'), 'r25-level-vs-information');
  assert.equal(P.preregStem('docs/evidence/2026-09-22/start-sit-baseline-gate-prereg-addendum-2.md'), 'start-sit-baseline-gate');
  assert.equal(P.preregStem('docs/evidence/2026-09-22/weekly-construction-grade-preregistration-amendment-1.md'), 'weekly-construction-grade');
  assert.equal(P.preregStem('docs/evidence/2026-09-22/target-share-prior-result.md'), null);
  assert.equal(P.resultStem('docs/evidence/2026-09-22/target-share-prior-result.md'), 'target-share-prior');
  assert.equal(P.resultStem('docs/evidence/2026-09-22/R25-LEVEL-VS-INFORMATION-RESULTS.md'), 'r25-level-vs-information');
  assert.equal(P.resultStem('docs/evidence/2026-09-22/weekly-construction-grade-output.json'), 'weekly-construction-grade');
  assert.equal(P.resultStem('docs/evidence/2026-09-22/weekly-construction-grade.md'), 'weekly-construction-grade');
  // An evidence (.tdd.md) file is written before the first test by process, so it is
  // never paired by name; it opts in with an explicit marker instead.
  assert.equal(P.resultStem('docs/tdd/2026-09-22-weekly-construction-grade.tdd.md'), null);
});

test('FAILS when the results file is committed before its pre-registration (acceptance)', () => {
  loaded();
  const dir = fixture([{ files: { [RESULT]: 'MAE -0.12\n' } }, { files: { [PREREG]: 'hypothesis\n' } }]);
  try {
    const report = P.checkPreregOrder({ repo: dir, prefixes: ['docs/'] });
    assert.equal(report.violations.length, 1);
    assert.equal(report.violations[0].result, RESULT);
    assert.equal(report.violations[0].prereg, PREREG);
    const run = cli(dir, '--prefix', 'docs/');
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /widget-lift-results\.md/);
  } finally { cleanup(dir); }
});

test('PASSES when the pre-registration is committed first (acceptance)', () => {
  loaded();
  const dir = fixture([{ files: { [PREREG]: 'hypothesis\n' } }, { files: { [RESULT]: 'MAE -0.12\n' } }]);
  try {
    const report = P.checkPreregOrder({ repo: dir, prefixes: ['docs/'] });
    assert.equal(report.pairs.length, 1, 'known-nonzero control: the pair is found, so a pass is not an empty scan');
    assert.deepEqual(report.violations, []);
    assert.equal(cli(dir, '--prefix', 'docs/').code, 0);
  } finally { cleanup(dir); }
});

test('same commit (a squash merge) passes but is reported, and fails under --strict', () => {
  loaded();
  const dir = fixture([{ files: { [PREREG]: 'hypothesis\n', [RESULT]: 'MAE -0.12\n' } }]);
  try {
    const report = P.checkPreregOrder({ repo: dir, prefixes: ['docs/'] });
    assert.deepEqual(report.violations, []);
    assert.equal(report.sameCommit.length, 1);
    assert.equal(cli(dir, '--prefix', 'docs/').code, 0);
    assert.equal(cli(dir, '--prefix', 'docs/', '--strict').code, 1);
  } finally { cleanup(dir); }
});

test('an amendment committed after the results does not rescue or break the base prereg', () => {
  loaded();
  const amend = `${E}/widget-lift-preregistration-amendment-1.md`;
  const ok = fixture([{ files: { [PREREG]: 'h\n' } }, { files: { [RESULT]: 'r\n' } }, { files: { [amend]: 'a\n' } }]);
  const bad = fixture([{ files: { [RESULT]: 'r\n' } }, { files: { [amend]: 'a\n' } }, { files: { [PREREG]: 'h\n' } }]);
  try {
    assert.deepEqual(P.checkPreregOrder({ repo: ok, prefixes: ['docs/'] }).violations, []);
    assert.equal(P.checkPreregOrder({ repo: bad, prefixes: ['docs/'] }).violations.length, 1);
  } finally { cleanup(ok); cleanup(bad); }
});

test('an explicit <!-- prereg: path --> marker pairs across directories', () => {
  loaded();
  const tdd = 'docs/tdd/2026-09-23-widget-lift.tdd.md';
  const marker = `# evidence\n<!-- prereg: ${PREREG} -->\nMAE -0.12\n`;
  const bad = fixture([{ files: { [tdd]: marker } }, { files: { [PREREG]: 'h\n' } }]);
  const ok = fixture([{ files: { [PREREG]: 'h\n' } }, { files: { [tdd]: marker } }]);
  try {
    const report = P.checkPreregOrder({ repo: bad, prefixes: ['docs/'] });
    assert.equal(report.violations.length, 1);
    assert.equal(report.violations[0].result, tdd);
    assert.deepEqual(P.checkPreregOrder({ repo: ok, prefixes: ['docs/'] }).violations, []);
  } finally { cleanup(bad); cleanup(ok); }
});

test('a marker naming a prereg that was never committed is a violation, not a pass', () => {
  loaded();
  const tdd = 'docs/tdd/2026-09-23-widget-lift.tdd.md';
  const dir = fixture([{ files: { [tdd]: `<!-- prereg: ${PREREG} -->\n` } }]);
  try {
    const report = P.checkPreregOrder({ repo: dir, prefixes: ['docs/'] });
    assert.equal(report.violations.length, 1);
    assert.match(report.violations[0].reason, /not committed/);
  } finally { cleanup(dir); }
});

test('a results file renamed into place keeps its first commit (git --follow)', () => {
  loaded();
  const draft = `${E}/draft-numbers.md`;
  const dir = fixture([{ files: { [draft]: 'MAE -0.12\nline two\nline three\n' } }, { files: { [PREREG]: 'h\n' } }, { rename: [draft, RESULT] }]);
  try {
    assert.equal(P.checkPreregOrder({ repo: dir, prefixes: ['docs/'] }).violations.length, 1);
  } finally { cleanup(dir); }
});

test('the evidence prefix scopes the scan', () => {
  loaded();
  const other = 'notes/widget-lift-results.md';
  const dir = fixture([{ files: { [other]: 'r\n', 'notes/widget-lift-prereg.md': '' } }, { files: { [PREREG]: 'h\n' } }, { files: { [RESULT]: 'r\n' } }]);
  try {
    assert.deepEqual(P.checkPreregOrder({ repo: dir, prefixes: ['docs/evidence/'] }).violations, []);
    assert.equal(P.checkPreregOrder({ repo: dir, prefixes: ['notes/'] }).pairs.length, 1);
  } finally { cleanup(dir); }
});

test('--rev checks a branch without checking it out', () => {
  loaded();
  const dir = fixture([{ files: { 'README.md': 'x\n' } }]);
  try {
    git(dir, 'checkout', '-q', '-b', 'feature');
    fs.mkdirSync(path.join(dir, E), { recursive: true });
    fs.writeFileSync(path.join(dir, RESULT), 'r\n'); git(dir, 'add', RESULT); git(dir, 'commit', '-q', '-m', 'numbers first');
    fs.writeFileSync(path.join(dir, PREREG), 'h\n'); git(dir, 'add', PREREG); git(dir, 'commit', '-q', '-m', 'prereg second');
    git(dir, 'checkout', '-q', 'main');
    assert.equal(P.checkPreregOrder({ repo: dir, prefixes: ['docs/'] }).pairs.length, 0, 'main has no pair');
    const report = P.checkPreregOrder({ repo: dir, prefixes: ['docs/'], rev: 'feature' });
    assert.equal(report.violations.length, 1);
    assert.equal(cli(dir, '--prefix', 'docs/', '--rev', 'feature').code, 1);
    assert.equal(cli(dir, '--rev', '--output=/tmp/x').code, 3, 'an option-shaped rev is refused, not passed to git');
  } finally { cleanup(dir); }
});

test('first commit: the oldest add wins, a copy stops the walk', () => {
  loaded();
  const log = entries => entries.map(([sha, status]) => `\0${sha}\n\n${status}\tpath\n`).join('');
  assert.equal(P.firstAddCommit(log([['c4', 'M'], ['c3', 'A'], ['c1', 'A']])), 'c1', 'squash add (c3) is not the first add');
  assert.equal(P.firstAddCommit(log([['c3', 'M'], ['c2', 'C100'], ['c1', 'A']])), 'c2', 'a copy creates the file; its twin (c1) is not followed');
  assert.equal(P.firstAddCommit(log([['c2', 'R100'], ['c1', 'A']])), 'c1', 'a rename keeps the first add');
  assert.equal(P.firstAddCommit(''), null);
});

test('a PR branch that merged main back (after a squash) is still judged on its own commits', () => {
  loaded();
  const dir = fixture([{ files: { 'README.md': 'x\n' } }]);
  const put = (file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); git(dir, 'add', file); };
  try {
    git(dir, 'checkout', '-q', '-b', 'feature');
    put(RESULT, 'r\n'); git(dir, 'commit', '-q', '-m', 'numbers first');
    put(PREREG, 'h\n'); git(dir, 'commit', '-q', '-m', 'prereg second');
    git(dir, 'checkout', '-q', 'main');
    put(RESULT, 'r\n'); put(PREREG, 'h\n'); git(dir, 'commit', '-q', '-m', 'squash of feature');
    git(dir, 'checkout', '-q', 'feature');
    git(dir, 'merge', '-q', '--no-edit', 'main');
    assert.equal(P.checkPreregOrder({ repo: dir, prefixes: ['docs/'], rev: 'main' }).sameCommit.length, 1, 'main alone cannot tell');
    assert.equal(P.checkPreregOrder({ repo: dir, prefixes: ['docs/'], rev: 'feature' }).violations.length, 1);
  } finally { cleanup(dir); }
});

test('a shallow clone cannot see first commits, so it exits 2 instead of passing', () => {
  loaded();
  const src = fixture([{ files: { [RESULT]: 'r\n' } }, { files: { [PREREG]: 'h\n' } }]);
  const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'prereg-order-shallow-'));
  try {
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${src}`, shallow], { env: GIT_ENV, stdio: 'ignore' });
    const run = cli(shallow, '--prefix', 'docs/');
    assert.equal(run.code, 2, run.out);
    assert.match(run.out, /shallow/i);
  } finally { cleanup(src); cleanup(shallow); }
});

test('this repository: no results file under docs/evidence or docs/tdd predates its prereg', (t) => {
  loaded();
  const shallow = execFileSync('git', ['-C', ROOT, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim();
  if (shallow === 'true') {
    t.skip('shallow checkout (CI default depth 1): first commits are not visible; the fixture cases above still run');
    return;
  }
  const report = P.checkPreregOrder({ repo: ROOT });
  assert.ok(report.pairs.length > 0, 'known-nonzero control: the repository has prereg/results pairs to check');
  assert.deepEqual(report.violations, []);
});
