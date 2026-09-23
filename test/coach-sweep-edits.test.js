/**
 * The quoted edits and the spec files that ran them cannot drift apart.
 *
 * The eighth part of the evidence standard asks that each mutation row carry
 * the injection itself, quoted, rather than a description of it. Writing that
 * by hand would be a second copy of the spec files, and the first time a row
 * was re-aimed — as M54 and M78 both were — the quotation would describe an
 * injection nobody ran. So it is generated, and this is the gate that makes
 * "generated" mean something: change a spec and the document goes stale and
 * the suite goes red.
 *
 * It also checks the specs themselves, which are the evidence's own inputs:
 * every row names a file that exists, states its suites, and carries either
 * one substitution or a list of them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = 'docs/tdd/sweeps';
// A spec is a top-level .json in this directory holding an array of rows.
// The harness's own output (`*.results.json`) and the coverage analysis under
// analysis/ are not specs and must not be mistaken for one.
//
// `*.mutations.json` is excluded for a different reason: other threads keep
// their own mutation specs in this directory under that suffix, in their own
// schema (`name`/`aimed_at`/`kind`, an array of suites, no no-op control).
// What this file guards is Coach's evidence standard — row ids, a quoted
// injection per row, a no-op control so a zero means something — and that
// standard is Coach's, not the repository's. Policing another thread's file
// against a contract it never adopted fails the gate for their choices, not
// for a real defect, and it is their file to shape. Coach's own nine specs
// (`<name>.json`, with `id` and `desc`) are all still covered.
const specs = fs.readdirSync(DIR)
  .filter(f => f.endsWith('.json') && !f.endsWith('.results.json') && !f.endsWith('.mutations.json'))
  .filter(f => Array.isArray(JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))));

test('every sweep spec is readable and names a file that exists', () => {
  assert.ok(specs.length >= 8, `only ${specs.length} sweep specs found`);
  for (const spec of specs) {
    const rows = JSON.parse(fs.readFileSync(path.join(DIR, spec), 'utf8'));
    assert.ok(rows.length, `${spec} has no rows`);
    for (const row of rows) {
      // M-numbers for the Coach sweeps, P-numbers for the page-explain pair,
      // NC- for a no-op control.
      assert.match(row.id, /^([A-Z]+\d+|NC-[\w-]+)$/, `${spec}: ${row.id} is not a row id`);
      assert.ok(fs.existsSync(row.file), `${spec}: ${row.id} names ${row.file}, which does not exist`);
      assert.ok(String(row.tests).trim(), `${spec}: ${row.id} names no suite`);
      for (const suite of String(row.tests).split(/\s+/)) {
        assert.ok(fs.existsSync(suite), `${spec}: ${row.id} names suite ${suite}, which does not exist`);
      }
      // A row normally edits one file. `files` is the two-file form, for a
      // behaviour guarded in two places where removing either guard alone
      // changes nothing a caller can see (page-explain.json's P12).
      const groups = row.files ?? [{ file: row.file, edits: row.edits ?? [[row.old, row.new]] }];
      assert.ok(groups.length, `${spec}: ${row.id} edits no file`);
      for (const group of groups) {
        assert.ok(fs.existsSync(group.file), `${spec}: ${row.id} names ${group.file}, which does not exist`);
        assert.ok(group.edits?.length, `${spec}: ${row.id} has no substitution for ${group.file}`);
        for (const [before, after] of group.edits) {
          assert.equal(typeof before, 'string', `${spec}: ${row.id} has no text to replace`);
          assert.equal(typeof after, 'string', `${spec}: ${row.id} has nothing to replace it with`);
          assert.notEqual(before, after, `${spec}: ${row.id} replaces text with itself`);
        }
      }
      assert.ok(String(row.desc ?? '').trim(), `${spec}: ${row.id} says nothing about what it does`);
    }
  }
});

test('every sweep spec ends with a no-op control, so a zero is a measurement', () => {
  for (const spec of specs) {
    const rows = JSON.parse(fs.readFileSync(path.join(DIR, spec), 'utf8'));
    const controls = rows.filter(row => row.id.startsWith('NC-'));
    assert.ok(controls.length, `${spec} has no no-op control; a zero in its table proves nothing`);
    for (const control of controls) {
      assert.match(control.desc, /NO-OP CONTROL/,
        `${spec}: ${control.id} is not labelled as a control`);
    }
  }
});

test('the quoted edits are the spec files, not a copy of them', () => {
  const check = spawnSync(process.execPath, ['scripts/emit-mutation-edits.mjs', '--check'],
    { encoding: 'utf8' });
  assert.equal(check.status, 0,
    `${check.stderr}${check.stdout}\nrun: node scripts/emit-mutation-edits.mjs`);
});

test('every row quoted in the document is a row some spec actually carries', () => {
  // The other direction: the generator could be right and the document still
  // carry a row nobody runs, if it were ever edited by hand between runs.
  const doc = fs.readFileSync(path.join(DIR, 'EDITS.md'), 'utf8');
  const quoted = [...doc.matchAll(/^### ([A-Z]+\d+|NC-[\w-]+) —/gm)].map(m => m[1]);
  const known = new Set(specs.flatMap(spec =>
    JSON.parse(fs.readFileSync(path.join(DIR, spec), 'utf8')).map(row => row.id)));
  assert.ok(quoted.length, 'the document quotes no rows at all');
  for (const id of quoted) {
    assert.ok(known.has(id), `${id} is quoted but no spec file carries it`);
  }
});
