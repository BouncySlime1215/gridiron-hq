import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// What a growth run REPORTS about itself, tested directly.
//
// This decision used to be an inline ternary in the middle of the cycle body,
// which meant the only way to test it was to drive the whole cycle — and the
// whole cycle needs a warehouse in which everything succeeds except the one
// thing under test. Three attempts at that fixture on 2026-09-22 each came out
// masked: no finalized week gives 'waiting', an unseeded run gives
// 'source_lag', a seeded run gives 'fit_error'. None of them reaches the state
// that matters.
//
// These tests are table-driven against the extracted function instead, so each
// input is set on purpose rather than arrived at.

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-growth-outcome-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { cycleOutcome } = await import('../server/services/nfl-model-growth.js');

const lag = [{ id: 'player_play_by_play_features', required: true, current: false }];

test('no finalized week is reported as waiting, whatever else is wrong', () => {
  const { status, note } = cycleOutcome({
    finalizedWeek: 0, requiredLag: lag, detail: { fit: { error: 'boom' } } });
  assert.equal(status, 'waiting');
  assert.match(note, /No regular-season game is final yet/);
});

test('a required release that has not published is source_lag', () => {
  const { status, note } = cycleOutcome({
    finalizedWeek: 3, requiredLag: lag, detail: { fit: { error: 'boom' } } });
  assert.equal(status, 'source_lag',
    'a missing required source explains a missing fit, so it is reported first');
  assert.match(note, /not published yet/);
});

test('a failed fit with every source current is fit_error', () => {
  const { status, note } = cycleOutcome({
    finalizedWeek: 3, requiredLag: [], detail: { fit: { error: 'singular matrix' } } });
  assert.equal(status, 'fit_error');
  assert.match(note, /cutoff fit failed/);
});

test('a clean run is ok', () => {
  const { status, note } = cycleOutcome({ finalizedWeek: 3, requiredLag: [], detail: {} });
  assert.equal(status, 'ok');
  assert.match(note, /immutable labels/);
});

test('the note always describes the status it came with', () => {
  // A status and a note that disagree is worse than either alone, because the
  // note is the half a person reads.
  for (const [input, word] of [
    [{ finalizedWeek: 0, requiredLag: [], detail: {} }, /final yet/],
    [{ finalizedWeek: 2, requiredLag: lag, detail: {} }, /not published yet/],
    [{ finalizedWeek: 2, requiredLag: [], detail: { fit: { error: 'x' } } }, /fit failed/],
    [{ finalizedWeek: 2, requiredLag: [], detail: {} }, /immutable labels/]
  ]) {
    assert.match(cycleOutcome(input).note, word, `note for ${cycleOutcome(input).status}`);
  }
});

test('the inputs are optional in the same way the cycle supplies them', () => {
  // `detail` is built incrementally through the run; a cycle that threw early
  // can reach here with keys missing, and the verdict must not throw on top.
  assert.equal(cycleOutcome({ finalizedWeek: 0 }).status, 'waiting');
  assert.equal(cycleOutcome({ finalizedWeek: 1 }).status, 'ok');
});
