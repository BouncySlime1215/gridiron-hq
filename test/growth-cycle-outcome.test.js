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

// --- a download that failed must not be reported as a clean run ----------
//
// `attempt()` (nfl-model-growth.js:149) catches every ingestion step
// individually, on purpose: one late nflverse release must not abort the
// other nine. What it writes on failure — detail.ingestion.<step>.error —
// was then read by nothing. The verdict looked at requiredLag and at the fit
// and at neither of those.
//
// requiredLag cannot stand in for it. It is computed from warehouseSnapshot's
// `sources`, and eight of the ten ingestion steps write to tables marked
// `required: false` (:84-99), so their failure is invisible to it by
// construction. Two of them — formation_participation and ftn_charting — have
// no entry in `sources` at all, so nothing anywhere in the result records that
// they were even attempted.
//
// The consequence is a run that reports 'ok' and a note reading "current-season
// features were ingested" on a cycle where a feed threw. That note is the half
// a person reads.

const failed = step => ({ ingestion: { [step]: { error: 'HTTP 404 from nflverse' } } });

test('an ingestion step that failed is not reported as a clean run', () => {
  const { status } = cycleOutcome({ finalizedWeek: 3, requiredLag: [], detail: failed('depth_charts') });
  assert.notEqual(status, 'ok',
    'depth_charts is required:false, so requiredLag never sees this; the verdict must');
  assert.equal(status, 'ingest_error');
});

test('the verdict names the step that failed', () => {
  const { note } = cycleOutcome({ finalizedWeek: 3, requiredLag: [], detail: failed('injury_reports') });
  assert.match(note, /injury_reports/,
    'a status without the step name sends the reader back to the log to find it');
});

test('every failed step is named, not just the first', () => {
  const { status, note } = cycleOutcome({ finalizedWeek: 3, requiredLag: [], detail: { ingestion: {
    snap_counts: { error: 'a' }, next_gen_stats: { rows: 12 }, ftn_charting: { error: 'b' } } } });
  assert.equal(status, 'ingest_error');
  assert.match(note, /ftn_charting/);
  assert.match(note, /snap_counts/);
  assert.doesNotMatch(note, /next_gen_stats/, 'a step that succeeded must not be listed as failed');
});

test('a step with no error key is a success, whatever else it returned', () => {
  const { status } = cycleOutcome({ finalizedWeek: 3, requiredLag: [], detail: { ingestion: {
    pfr_advanced: { rows: 0, seasons: [2025] } } } });
  assert.equal(status, 'ok', 'zero rows is a separate question; only a thrown step is an ingest error');
});

test('a missing required release still outranks a failed download', () => {
  // The order is the order of causes. If nflverse has not published the week,
  // that explains the failed download too, and is the thing to report.
  const { status } = cycleOutcome({ finalizedWeek: 3, requiredLag: lag, detail: failed('depth_charts') });
  assert.equal(status, 'source_lag');
});

test('a failed download outranks a failed fit', () => {
  // A fit built on rows a failed download left stale is not independent
  // evidence of a broken fit, so the download is the cause to report.
  const { status } = cycleOutcome({ finalizedWeek: 3, requiredLag: [],
    detail: { ...failed('play_by_play'), fit: { error: 'singular matrix' } } });
  assert.equal(status, 'ingest_error');
});

test('a run with no finalized week is still waiting, even with a failed step', () => {
  const { status } = cycleOutcome({ finalizedWeek: 0, requiredLag: [], detail: failed('depth_charts') });
  assert.equal(status, 'waiting');
});
