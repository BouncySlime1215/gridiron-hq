// Plan item 20 (CLEANUP): which open PRs has main already made obsolete?
// scripts/ops/pr-cleanup-report.mjs classifies a PR head against main and never
// writes to GitHub. Each case builds a throwaway git repository so the branch
// shape is exactly what the case says it is. Pass bar B1-B7 is pre-registered in
// docs/tdd/pr-cleanup-report.tdd.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/ops/pr-cleanup-report.mjs');
const R = await import('../scripts/ops/pr-cleanup-report.mjs').catch(error => ({ __importError: error }));

function loaded() {
  assert.equal(R.__importError, undefined, `scripts/ops/pr-cleanup-report.mjs must load: ${R.__importError?.message}`);
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
  { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function write(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    git(dir, 'add', file);
  }
}
function commit(dir, files, msg) {
  write(dir, files);
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * main: a.txt, b.txt. Branches:
 *   merged   - one commit, then merged into main (fast-forward ancestor)
 *   squashed - one commit whose change main later gained as a different commit
 *   picked   - one commit cherry-picked onto main (same patch id)
 *   unique   - one commit main never gained
 *   partial  - two commits; main gained only the first
 *   diverged - two commits squash-merged, then main rewrote the same lines (conservative: unique)
 */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-cleanup-'));
  git(dir, 'init', '-q', '-b', 'main');
  commit(dir, { 'a.txt': 'a1\n', 'b.txt': 'b1\n' }, 'base');

  git(dir, 'checkout', '-q', '-b', 'merged');
  commit(dir, { 'm.txt': 'merged work\n' }, 'merged work');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '-q', '--ff-only', 'merged');

  git(dir, 'checkout', '-q', '-b', 'squashed');
  commit(dir, { 's.txt': 's1\n' }, 'squash part 1');
  commit(dir, { 's.txt': 's1\ns2\n' }, 'squash part 2');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, { 's.txt': 's1\ns2\n' }, 'squashed PR (#1)');

  git(dir, 'checkout', '-q', '-b', 'picked');
  const picked = commit(dir, { 'p.txt': 'picked\n' }, 'picked work');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, { 'other.txt': 'unrelated\n' }, 'unrelated main work');
  git(dir, 'cherry-pick', picked);

  git(dir, 'checkout', '-q', '-b', 'unique');
  commit(dir, { 'u.txt': 'only here\n' }, 'unique work');

  git(dir, 'checkout', '-q', 'main');
  git(dir, 'checkout', '-q', '-b', 'partial');
  const first = commit(dir, { 'q1.txt': 'first\n' }, 'partial first');
  commit(dir, { 'q2.txt': 'second\n' }, 'partial second');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'cherry-pick', first);

  git(dir, 'checkout', '-q', '-b', 'diverged');
  commit(dir, { 'b.txt': 'b2\n' }, 'diverged edit');
  commit(dir, { 'c.txt': 'c1\n' }, 'diverged second');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, { 'b.txt': 'b2\n', 'c.txt': 'c1\n' }, 'diverged squashed (#2)');
  commit(dir, { 'b.txt': 'b3 rewritten\n' }, 'main rewrites b');
  return dir;
}
const cleanup = dir => fs.rmSync(dir, { recursive: true, force: true });

test('B1-B4: content classification against main', () => {
  loaded();
  const dir = fixture();
  try {
    const c = ref => R.classifyContent({ repo: dir, base: 'main', head: ref });
    assert.equal(c('merged').status, 'on-main', 'B1 merged branch');
    assert.match(c('merged').how, /ancestor/);
    assert.equal(c('squashed').status, 'on-main', 'B2 squash-merged branch');
    assert.match(c('squashed').how, /content/);
    assert.equal(c('picked').status, 'on-main', 'B2 cherry-picked branch');
    assert.equal(c('unique').status, 'unique', 'B3 unique branch');
    assert.deepEqual(c('unique').files, ['u.txt']);
    assert.equal(c('partial').status, 'unique', 'B3 partially merged branch keeps its unique commit');
    assert.deepEqual(c('partial').files, ['q2.txt']);
    assert.equal(c('diverged').status, 'unique', 'B4 main moved the same lines: never called obsolete');
  } finally { cleanup(dir); }
});

const NOW = Date.parse('2026-09-26T08:00:00Z');
const pr = (number, head, created, extra = {}) => ({ number, title: `PR ${number}`, head, created_at: created, ...extra });

test('B5-B6: policy overlays decide close vs flag vs keep', () => {
  loaded();
  const dir = fixture();
  try {
    const old = '2026-09-10T00:00:00Z';
    const rows = R.buildReport({
      repo: dir, base: 'main', now: NOW, minAgeDays: 7,
      prs: [
        pr(1, 'merged', old),
        pr(2, 'unique', old),
        pr(3, 'squashed', '2026-09-24T00:00:00Z'),
        pr(4, 'merged', old),
        pr(5, 'unique', old),
        pr(6, 'unique', old),
      ],
      keep: { 4: 'owned locally' },
      superseded: { 5: { by: 99, merged: true }, 6: { by: 98, merged: false } },
    });
    const by = Object.fromEntries(rows.map(r => [r.number, r]));
    assert.equal(by[1].action, 'close', 'obsolete and old enough');
    assert.equal(by[2].action, 'flag', 'B3 unique work is flagged, never closed');
    assert.equal(by[3].action, 'wait', 'B5 younger than 7 days is not eligible even when obsolete');
    assert.equal(by[4].action, 'keep', 'B6 keep list wins over obsolete');
    assert.match(by[4].reason, /owned locally/);
    assert.equal(by[5].action, 'close', 'superseded by a merged replacement');
    assert.match(by[5].reason, /#99/);
    assert.equal(by[6].action, 'flag', 'replacement not merged yet: keep and flag');
    for (const r of rows) assert.ok(r.reason.length > 0, `row ${r.number} has a reason`);
  } finally { cleanup(dir); }
});

test('B6: a head that cannot be read is flagged, never closed', () => {
  loaded();
  const dir = fixture();
  try {
    const [row] = R.buildReport({ repo: dir, base: 'main', now: NOW, minAgeDays: 7,
      prs: [pr(7, 'no-such-branch', '2026-09-01T00:00:00Z')] });
    assert.equal(row.action, 'flag');
    assert.match(row.reason, /could not read/);
  } finally { cleanup(dir); }
});

test('B7: the script has no path that writes to GitHub', () => {
  loaded();
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(|https?:\/\/api\.github|['"]gh['"]|state:\s*['"]closed|git['"],\s*\[?['"]push/,
    'read-only: no HTTP, no gh, no close, no push');
});

test('markdown table lists every row with its action and reason', () => {
  loaded();
  const md = R.toMarkdown([
    { number: 1, title: 'A | pipe', created_at: '2026-09-10T00:00:00Z', action: 'close', reason: 'on main (ancestor)' },
    { number: 2, title: 'B', created_at: '2026-09-10T00:00:00Z', action: 'flag', reason: '1 file not on main' },
  ]);
  assert.match(md, /\| #1 \|/);
  assert.match(md, /A \\\| pipe/);
  assert.match(md, /close/);
  assert.match(md, /flag/);
});

// Found on the first real run: main was re-rooted on 2026-09-24, so 102 open PRs share no
// history with it. Their own change is measured from the PR's base sha instead.
test('B8: a PR from before a history rewrite is measured from its own base', () => {
  loaded();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-cleanup-rewrite-'));
  try {
    git(dir, 'init', '-q', '-b', 'old');
    const oldBase = commit(dir, { 'a.txt': 'a1\n' }, 'old base');
    git(dir, 'checkout', '-q', '-b', 'landed');
    commit(dir, { 'x.txt': 'x part 1\n' }, 'landed 1');
    commit(dir, { 'x.txt': 'x part 1\nx part 2\n' }, 'landed 2');
    git(dir, 'checkout', '-q', 'old');
    git(dir, 'checkout', '-q', '-b', 'lost');
    commit(dir, { 'y.txt': 'never on main\n' }, 'lost');
    git(dir, 'checkout', '-q', '--orphan', 'main');
    git(dir, 'rm', '-q', '-rf', '.');
    commit(dir, { 'a.txt': 'a1\n', 'x.txt': 'x part 1\nx part 2\n' }, 'rewritten root');

    const c = (head, baseSha) => R.classifyContent({ repo: dir, base: 'main', head, baseSha });
    assert.equal(c('landed', oldBase).status, 'on-main', 'its change is on the rewritten main');
    assert.equal(c('lost', oldBase).status, 'unique');
    assert.deepEqual(c('lost', oldBase).files, ['y.txt']);
    assert.equal(c('lost', undefined).status, 'unreadable', 'no shared history and no base: never guessed');
    assert.equal(c('lost', 'f'.repeat(40)).status, 'unreadable', 'base sha not fetched');
  } finally { cleanup(dir); }
});

test('hint: share of added lines already on main, never a close reason', () => {
  loaded();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-cleanup-hint-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, { 'a.txt': 'a1\n' }, 'base');
    git(dir, 'checkout', '-q', '-b', 'reshaped');
    commit(dir, { 'h.txt': 'alpha line\nbeta line\n' }, 'pr adds two lines');
    git(dir, 'checkout', '-q', 'main');
    commit(dir, { 'h.txt': 'alpha line\ngamma line\n' }, 'main lands one of them, reshaped');
    const c = R.classifyContent({ repo: dir, base: 'main', head: 'reshaped' });
    assert.equal(c.status, 'unique');
    assert.equal(c.landed, 0.5);
    const [row] = R.buildReport({ repo: dir, base: 'main', now: NOW, minAgeDays: 7,
      prs: [pr(8, 'reshaped', '2026-09-01T00:00:00Z')] });
    assert.equal(row.action, 'flag');
    assert.match(row.reason, /50% of its added lines are on main/);
  } finally { cleanup(dir); }
});
