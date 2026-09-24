/**
 * FIX-166-2: one week-to-window function. fantasy-coordinator.js#constructionWindow is the
 * only definition. scripts/weekly-construction-grade-lib.mjs#weekWindow imports it, and the
 * graded/ungraded split for weeks 1 and 18 is written once (gradedWeek / GRADED_WEEKS).
 *
 * Served side (constructionWindow, weekConstructionBasis): week 1 follows weeks 2-4 and
 * week 18 follows weeks 5-17, labelled as not graded. Study side (weekWindow): weeks 1 and
 * 18 were never graded, so they fall in no window (null).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-construction-window-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const fc = await import('../server/services/fantasy-coordinator.js');
const lib = await import('../scripts/weekly-construction-grade-lib.mjs');

const PINNED = [1, 4, 5, 17, 18];

test('constructionWindow is exported and pins weeks 1, 4, 5, 17, 18 for the served side', () => {
  assert.equal(typeof fc.constructionWindow, 'function');
  assert.deepEqual(PINNED.map(w => fc.constructionWindow(w)), ['2-4', '2-4', '5-17', '5-17', '5-17']);
});

test('graded-only windows: weeks 1 and 18 fall in no window, 4/5 and 17 keep theirs', () => {
  assert.deepEqual(PINNED.map(w => fc.constructionWindow(w, { gradedOnly: true })), [null, '2-4', '5-17', '5-17', null]);
  assert.deepEqual(PINNED.map(w => fc.gradedWeek(w)), [false, true, true, true, false]);
});

test('the study lib weekWindow agrees with the served function on weeks 1, 4, 5, 17, 18', () => {
  assert.deepEqual(PINNED.map(lib.weekWindow), [null, '2-4', '5-17', '5-17', null]);
  for (let w = 0; w <= 19; w++) {
    assert.equal(lib.weekWindow(w), fc.constructionWindow(w, { gradedOnly: true }), `week ${w}`);
  }
});

test('weekConstructionBasis carries the same window and graded split on the pinned weeks', () => {
  const basis = PINNED.map(week => fc.weekConstructionBasis({ fit: null, week, lift: { on: false } }));
  assert.deepEqual(basis.map(b => b.window), PINNED.map(w => fc.constructionWindow(w)));
  assert.deepEqual(basis.map(b => b.graded_week), [false, true, true, true, false]);
  assert.match(basis[0].label, /Week 1 was not graded \(the grade covered weeks 2-17\), so it follows the weeks 2-4 decision/);
  assert.match(basis[4].label, /Week 18 was not graded \(the grade covered weeks 2-17\), so it follows the weeks 5-17 decision/);
  for (const b of basis.slice(1, 4)) assert.doesNotMatch(b.label, /not graded/);
});

test('one definition: the lib imports constructionWindow and writes no week bound of its own', () => {
  const src = fs.readFileSync(new URL('../scripts/weekly-construction-grade-lib.mjs', import.meta.url), 'utf8');
  assert.match(src, /import\s*\{[^}]*\bconstructionWindow\b[^}]*\}\s*from\s*'\.\.\/server\/services\/fantasy-coordinator\.js'/);
  const body = src.slice(src.indexOf('export function weekWindow'));
  const fn = body.slice(0, body.indexOf('\n}\n') + 2);
  assert.doesNotMatch(fn, /\b(?:2|4|5|17|18)\b/, 'weekWindow must not restate the window bounds');
  const coord = fs.readFileSync(new URL('../server/services/fantasy-coordinator.js', import.meta.url), 'utf8');
  assert.equal((coord.match(/<=\s*17/g) ?? []).length, 0, 'the graded upper bound is GRADED_WEEKS.last, written once');
});
