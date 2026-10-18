/**
 * The migration-name rules, shown failing (2026-09-20).
 *
 * Migrations are identified by their `name` export, not by their number.
 * `server/db/migrate.js` counts PENDING migrations by filename, and that count
 * is what decides whether a VACUUM INTO snapshot is taken; the apply-once
 * guard keys on the NAME. So a file whose basename is already recorded but
 * whose name is not runs `up()` against the live database with no backup
 * behind it and nothing in the output saying so.
 *
 * Two of the three failures are silent in exactly that way: a clean boot and a
 * database missing a change, or a schema change with no snapshot. Nothing that
 * exercises the runner can catch them, because the runner behaves correctly in
 * every case — it is the names that are wrong. They can only be caught at the
 * moment the file is written, which is what this rule is for.
 *
 * Before this file the rule had no test at all, so nobody had shown it firing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrationNameProblems } from '../scripts/migration-name-check.mjs';

/** Builds a throwaway migrations directory from { filename: source }. */
function dirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-migrations-'));
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), source);
  return dir;
}
const named = n => `export const name = '${n}';\nexport function up(db) { void db; }\n`;
const unnamed = 'export function up(db) { void db; }\n';

const temps = [];
function scratch(files) { const d = dirWith(files); temps.push(d); return migrationNameProblems(d); }
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

test('a clean directory has nothing to report', () => {
  const { problems, checked } = scratch({
    '001_first.js': named('001_first'),
    '002_second.js': named('002_second'),
    '003_third.js': unnamed          // no name export: migrate.js falls back to the basename
  });
  assert.deepEqual(problems, []);
  assert.equal(checked, 3);
});

test('a name that does not match its filename is reported', () => {
  // THE DANGEROUS ONE. The pending count says one thing, the apply-once guard
  // another, and the difference is whether a backup exists.
  const { problems } = scratch({
    '001_first.js': named('001_first'),
    '002_second.js': named('002_secnod')
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /002_second\.js/);
  assert.match(problems[0], /exports name '002_secnod' but its filename says '002_second'/);
});

test('two files sharing a name are reported, because the second is skipped in silence', () => {
  // Easiest to hit by copying a migration as a template and editing only the
  // filename. The second is recorded as applied and never runs; nothing errors
  // and schema_migrations shows no trace of it having been passed over.
  const { problems } = scratch({
    '004_add_index.js': named('004_add_index'),
    '005_add_index.js': named('004_add_index')
  });
  assert.equal(problems.length, 2, 'the copy trips both the mismatch rule and the duplicate-name rule');
  assert.ok(problems.some(p => /already used by 004_add_index\.js/.test(p)));
});

test('a repeated migration number is reported', () => {
  const { problems } = scratch({
    '007_a.js': named('007_a'),
    '007_b.js': named('007_b')
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /migration number 007 is used by 007_a\.js, 007_b\.js/);
  assert.match(problems[0], /do not renumber an existing file/,
    'renaming an applied migration re-runs it, so the advice must never be "renumber"');
});

test('062 is exempt, because those two already ran against the live database', () => {
  // Renaming an applied migration re-runs it (README rule 1), so these are
  // permanent. The exemption is for numbers that LANDED, not for new ones.
  const { problems } = scratch({
    '062_a.js': named('062_a'),
    '062_b.js': named('062_b')
  });
  assert.deepEqual(problems, []);
});

test('a name export this check cannot read is reported rather than assumed', () => {
  // Without this the guard would silently inspect the basename while the
  // runner used something else — a check that passes by not looking.
  const { problems } = scratch({
    '008_multiline.js': "export const name =\n  '008_multiline';\nexport function up(db) { void db; }\n"
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /exports `name` in a form this check cannot read/);
});

test('files that are not numbered migrations are ignored', () => {
  const { problems, checked } = scratch({
    '001_first.js': named('001_first'),
    'README.md': '# not a migration\n',
    'helpers.js': 'export const helper = 1;\n'
  });
  assert.deepEqual(problems, []);
  assert.equal(checked, 1);
});

test('the real migrations directory passes its own rule', () => {
  // The guard is live, not aspirational.
  const { problems, checked } = migrationNameProblems(
    path.join(process.cwd(), 'server', 'migrations'));
  assert.deepEqual(problems, []);
  assert.ok(checked > 50, `expected the real directory, got ${checked} files`);
});
