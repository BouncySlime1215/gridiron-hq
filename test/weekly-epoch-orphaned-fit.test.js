/**
 * An epoch rollover AFTER a good promotion silently un-promotes the champion.
 *
 * activeWeeklyWeightSet() filters weekly_ensemble_fits on
 * `epoch_id = activeLearningEpoch()?.id ?? 1`. Start a new learning epoch and the
 * previous epoch's promoted fit stops matching, weightSetFrom() finds nothing, and
 * it returns the frozen-2023 constants. No throw, no log, no change to the shape of
 * the returned object -- a caller cannot tell this apart from a genuine cold start.
 *
 * In weeks 2-4 that is not a small difference: the frozen vectors put 60/50/40/20
 * per cent of a projection on a single prior game, and a promoted fit carrying an
 * `early` block puts far less. So the layer goes inert exactly when it matters, and
 * says nothing -- which is the one thing CLAUDE.md says a layer may never do.
 *
 * These tests pin the honesty, NOT a change in the numbers: the orphaned fallback
 * must still serve the frozen vectors, and must say that is what it is doing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-epoch-orphan-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const S = await import('../server/services/weekly-weight-store.js');
const R = await import('../server/services/nfl-engine-registry.js');
const E = await import('../server/services/weekly-ensemble.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const LIVE = [0.2, 0.4, 0.15000000000000002, 0.05, 0.2];
const perPosition = v => Object.fromEntries(POSITIONS.map(p => [p, [...v]]));

function reset() {
  run('DELETE FROM weekly_ensemble_fits');
  run('DELETE FROM nfl_learning_epochs WHERE id <> 1');
  run("UPDATE nfl_learning_epochs SET status='active', closed_at=NULL WHERE id=1");
  R.clearNflEngineRegistryCache?.();
}

/** A promoted fit in `epochId`, trained through 2025 week 18. */
function promote(epochId, weights = perPosition(LIVE), through = [2025, 18]) {
  run(`INSERT INTO weekly_ensemble_fits
        (data_hash, through_season, through_week, weights_json, sample_size, validation_size, promoted, epoch_id)
       VALUES (?, ?, ?, ?, 5000, 1000, 1, ?)`,
  `hash-e${epochId}-${through.join('-')}`, through[0], through[1], JSON.stringify(weights), epochId);
  return rows('SELECT id FROM weekly_ensemble_fits ORDER BY id DESC LIMIT 1')[0].id;
}

/**
 * Roll the epoch through the REAL production path, not hand-written SQL: this is
 * what POST /api/nfl-betting/engine/learning-epoch calls (routes/nfl-betting.js:268).
 * Writing the rows by hand got the status vocabulary wrong ('closed' is not in the
 * CHECK constraint; the real value is 'archived'), which is exactly the kind of
 * divergence that makes a hand-rolled fixture prove nothing.
 */
function rollEpoch() {
  return R.startLearningEpoch({ reason: 'test rollover', confirmed: true }).active_epoch.id;
}

test('a rollover after a good promotion is announced, not served silently', () => {
  reset();
  const fitId = promote(1);
  const activeId = rollEpoch();

  const set = S.activeWeeklyWeightSet({ season: 2026, week: 2 });

  assert.notEqual(set.source, 'frozen',
    'the orphaned fallback is reported as an ordinary cold start: a caller cannot tell it apart');
  assert.ok(set.orphaned_fit, 'no orphaned_fit detail on the returned weight set');
  assert.equal(set.orphaned_fit.fit_id, fitId);
  assert.equal(set.orphaned_fit.fit_epoch_id, 1);
  assert.equal(set.orphaned_fit.active_epoch_id, activeId);
});

test('the orphaned fallback still serves the frozen vectors: this is an honesty fix, not a numbers change', () => {
  reset();
  promote(1);
  const activeId = rollEpoch();

  const set = S.activeWeeklyWeightSet({ season: 2026, week: 2 });
  assert.equal(set.id, 'frozen-2023', 'the served identity must stay frozen-2023');
  for (const position of POSITIONS) {
    assert.deepEqual(set.weights[position], E.WEEKLY_ENSEMBLE_WEIGHTS[position],
      `${position}: the served vector changed; this fix must not move any projection`);
  }
});

test('a genuine cold start is still plain "frozen": the new signal must be specific', () => {
  reset();
  const set = S.activeWeeklyWeightSet({ season: 2026, week: 2 });
  assert.equal(set.source, 'frozen');
  assert.equal(set.orphaned_fit, undefined,
    'nothing was ever promoted, so there is no orphaned fit to report');
});

test('a fit excluded by the leakage cutoff is NOT an orphan: same epoch, just too recent', () => {
  reset();
  promote(1, perPosition(LIVE), [2026, 9]);   // trained through 2026 wk 9, predicting wk 2
  const set = S.activeWeeklyWeightSet({ season: 2026, week: 2 });
  assert.equal(set.source, 'frozen', 'the cutoff is working as designed');
  assert.equal(set.orphaned_fit, undefined,
    'the cutoff excluded it, not the epoch filter: reporting it as an orphan would cry wolf');
});

test('a promoted fit in the active epoch is unaffected', () => {
  reset();
  promote(1);
  const set = S.activeWeeklyWeightSet({ season: 2026, week: 2 });
  assert.equal(set.source, 'adaptive');
  assert.equal(set.orphaned_fit, undefined);
});

/**
 * The orphan probe keeps the leakage cutoff and drops only the epoch clause. Drop
 * the cutoff as well and a fit in another epoch that was trained through a LATER
 * week gets reported as an orphan -- but that fit could never have served this week
 * under any epoch, so calling it orphaned blames the epoch roll for the cutoff's
 * work. Without this case the suite survives that mutation, which would mean the
 * suite, not the code, was wrong.
 */
test('a fit in another epoch trained past the cutoff is not an orphan either', () => {
  reset();
  promote(1, perPosition(LIVE), [2026, 9]);   // trained through 2026 wk 9
  rollEpoch();                                 // now in a later epoch, predicting wk 2
  const set = S.activeWeeklyWeightSet({ season: 2026, week: 2 });
  assert.equal(set.source, 'frozen',
    'the cutoff excluded it under every epoch; the roll changed nothing for this week');
  assert.equal(set.orphaned_fit, undefined);
});
