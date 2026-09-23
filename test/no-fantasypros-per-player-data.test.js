/**
 * NICK-FP guard: no committed evidence file may carry per-player FantasyPros ranks or
 * projections (WORK-QUEUE.md §12, ruling NICK-FP). HX-01 keeps its method, its scripts and our
 * own aggregate accuracy numbers; a real per-player FantasyPros export does not belong in the
 * public repo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanForPerPlayerFantasyPros, scanTree, GUARDED_DIRECTORIES } from '../scripts/guard-no-fantasypros-per-player.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('designed survivor: a header naming a FantasyPros id column and an ecr/rank column, followed by real data rows, is caught', () => {
  const csv = 'player,fantasypros_id,ecr\nA. Player,101,3\nB. Player,102,7\nC. Player,103,12\n';
  const violations = scanForPerPlayerFantasyPros(csv, 'docs/evidence/fake-export.md');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, 'docs/evidence/fake-export.md');
});

test('not-applied control: prose that only mentions fantasypros_id and ecr, with no data rows after it, is not caught', () => {
  const prose = 'The join maps fantasypros_id to gsis id; ecr is the weekly rank on that page.\n\nMore prose, no table.\n';
  const violations = scanForPerPlayerFantasyPros(prose, 'docs/tdd/fake-note.tdd.md');
  assert.deepEqual(violations, []);
});

test('a two-column mention with fewer than 3 data-shaped rows after it is not caught (one worked example, not a table)', () => {
  const oneExample = 'player,fantasypros_id,ecr\nA. Player,101,3\n\nThat is the only row we quote.\n';
  const violations = scanForPerPlayerFantasyPros(oneExample, 'docs/tdd/fake-note.tdd.md');
  assert.deepEqual(violations, []);
});

test('a raw FantasyPros export file extension committed under a guarded directory is always a violation, whatever it contains', () => {
  const violations = scanForPerPlayerFantasyPros('season,week,ecr\n2023,4,1.5\n', 'docs/evidence/2026-09-22/fp-ecr-weekly-wp.csv');
  assert.equal(violations.length, 1);
});

test('the real committed tree has zero violations under docs/evidence and docs/tdd (HX-01 already reads FantasyPros only from .local-db/, git-excluded)', () => {
  const violations = scanTree(ROOT, GUARDED_DIRECTORIES);
  assert.deepEqual(violations, []);
});
