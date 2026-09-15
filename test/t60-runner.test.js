/**
 * Codex correction C12 and plan section 7: the durable T-60 operation.
 *
 * The finding: "The reviewed production callers do not invoke
 * `cutoffBatches`/`sequentialCapacity` to drive a durable T-60 operation. A GET
 * packet route is not a scheduled collector." Both helpers had test callers and
 * nothing else.
 *
 * The property that matters most here is the unglamorous one: a MISSED capture
 * has to leave a row. A system that only writes rows when it succeeds cannot
 * tell a quiet week from a broken collector, and coverage computed from such
 * rows is always 100%.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-t60-runner-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, run, rows } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// The stuck-in-`frozen`-forever regression below needs a way to make the
// decision-tape link step -- the step AFTER a packet freezes -- fail on
// command, without touching nfl-decision-tape.js itself. `recordDecisionRun`
// is real and unmocked for every observation id except the ones a test has
// explicitly poisoned, so this only affects the rows the regression test
// means to affect; every other capture in this file still exercises the real
// tape writer end to end.
const realDecisionTape = await import('../server/services/nfl-decision-tape.js');
const poisonedLinkIds = new Set();
mock.module('../server/services/nfl-decision-tape.js', { namedExports: {
  ...realDecisionTape,
  recordDecisionRun: (season, week, board, opts) => {
    if (poisonedLinkIds.has(opts?.observation?.observationId)) {
      throw new Error('SIMULATED decision-tape link failure (test-injected)');
    }
    return realDecisionTape.recordDecisionRun(season, week, board, opts);
  }
} });

db.exec(`INSERT INTO nfl_teams (id,abbr,name,conference,division) VALUES
  (1,'KC','Kansas City Chiefs','AFC','West'), (2,'BAL','Baltimore Ravens','AFC','North'),
  (3,'SF','San Francisco 49ers','NFC','West'), (4,'SEA','Seattle Seahawks','NFC','West')`);

const SEASON = 2026, WEEK = 7, DAY = '2026-10-25';
// Two games kicking off at the SAME instant, so a cross-game mistake has
// somewhere to go wrong, plus one later game.
for (const [home, away, time] of [['KC', 'BAL', '13:00'], ['SF', 'SEA', '13:00']]) {
  run(`INSERT INTO game_lines (season,week,team,opponent,home,gameday,gametime,spread,spread_odds)
       VALUES (?,?,?,?,1,?,?,-3.5,-110)`, SEASON, WEEK, home, away, DAY, time);
  run(`INSERT INTO game_lines (season,week,team,opponent,home,gameday,gametime,spread,spread_odds)
       VALUES (?,?,?,?,0,?,?,3.5,-110)`, SEASON, WEEK, away, home, DAY, time);
}

const runner = await import('../server/betting/nfl/strategy/t60-runner.js');

const EXPERIMENT = 'c12-runner-fixture';
/** Well before the 13:00 ET kickoffs (17:00Z), so cutoffs are still ahead. */
const BEFORE = '2026-10-25T10:00:00Z';

test('C12: the runner opens a prospective observation for every scheduled game', () => {
  const result = runner.openObservations({ season: SEASON, week: WEEK,
    experimentId: EXPERIMENT, scheduleVersion: 'sched-1', now: BEFORE });
  assert.equal(result.opened.length, 2, 'both simultaneous games get their own observation');
  const keys = new Set(result.opened.map(o => o.event_key));
  assert.equal(keys.size, 2, 'and they are distinct events, not one row for the kickoff instant');
  for (const o of result.opened) assert.match(o.cutoff_at, /T16:00/, 'sixty minutes before a 17:00Z kickoff');
});

test('C12: opening again is idempotent — a scheduler tick does not duplicate observations', () => {
  const before = rows(`SELECT COUNT(*) n FROM nfl_t60_observations WHERE experiment_id=?`, EXPERIMENT)[0].n;
  const again = runner.openObservations({ season: SEASON, week: WEEK,
    experimentId: EXPERIMENT, scheduleVersion: 'sched-1', now: BEFORE });
  assert.equal(again.opened.length, 0);
  assert.ok(again.skipped.every(s => s.reason === 'already_open'));
  assert.equal(rows(`SELECT COUNT(*) n FROM nfl_t60_observations WHERE experiment_id=?`, EXPERIMENT)[0].n, before);
});

test('C12: a cutoff that has already passed is never opened retrospectively', () => {
  const late = runner.openObservations({ season: SEASON, week: WEEK,
    experimentId: 'too-late', scheduleVersion: 'sched-1', now: '2026-10-25T18:00:00Z' });
  assert.equal(late.opened.length, 0);
  assert.ok(late.skipped.every(s => s.reason === 'cutoff_already_passed'),
    'a capture cannot be planned for a moment that is already in the past');
});

test('C12: a cutoff that passes with NO capture is recorded as missed, not forgotten', () => {
  // This is the property the whole ledger exists for. The collector never ran;
  // the row says so, and it stays in the denominator.
  const after = '2026-10-25T17:30:00Z';
  const { missed } = runner.markMissedObservations({ experimentId: EXPERIMENT, now: after });
  assert.equal(missed.length, 2);
  const stored = rows(`SELECT state, note FROM nfl_t60_observations WHERE experiment_id=?`, EXPERIMENT);
  assert.ok(stored.every(o => o.state === 'missed'));
  assert.ok(stored.every(o => /missing prospective observation/.test(o.note)));
});

test('C12: coverage distinguishes a missed capture from a quiet week', () => {
  const coverage = runner.t60Coverage({ experimentId: EXPERIMENT, season: SEASON, week: WEEK });
  assert.equal(coverage.games_on_schedule, 2);
  assert.equal(coverage.observations, 2);
  assert.equal(coverage.by_state.missed, 2);
  assert.equal(coverage.captured_rate, 0,
    'nothing was captured, and the report says zero rather than reporting nothing');
  assert.deepEqual(coverage.never_scheduled, [], 'both games did at least have a capture planned');
});

test('C12: a game with no observation at all is a DIFFERENT failure from a missed one', () => {
  // Nothing ever planned to look at this experiment's games.
  const coverage = runner.t60Coverage({ experimentId: 'never-ran', season: SEASON, week: WEEK });
  assert.equal(coverage.observations, 0);
  assert.equal(coverage.never_scheduled.length, 2,
    'no collector was ever scheduled — which is not the same as one that ran and failed');
});

/* ------------------------------------------------------- capacity ledger */

const CAP = { experimentId: 'capacity-fixture', season: SEASON, week: WEEK };

test('C12: capacity is answered AT an instant, from timestamped events', () => {
  runner.reserveSlot({ ...CAP, eventKey: 'nfl|2026-10-25|BAL@KC', occurredAt: '2026-10-25T12:00:00Z' });
  runner.releaseSlot({ ...CAP, eventKey: 'nfl|2026-10-25|BAL@KC', occurredAt: '2026-10-25T12:10:00Z',
    reason: 'price refresh failed' });

  // The audit's exact counterexample, asked of the ledger directly.
  assert.equal(runner.slotsHeldAt({ ...CAP, at: '2026-10-25T12:05:00Z' }).count, 1,
    'at 12:05 the slot was still held; the 12:10 release had not happened');
  assert.equal(runner.slotsHeldAt({ ...CAP, at: '2026-10-25T12:15:00Z' }).count, 0,
    'and by 12:15 it genuinely had');
  assert.equal(runner.slotsHeldAt({ ...CAP, at: '2026-10-25T11:59:00Z' }).count, 0,
    'before the reservation, nothing was held');
});

test('C12: a committed slot stays held', () => {
  runner.reserveSlot({ ...CAP, eventKey: 'nfl|2026-10-25|SEA@SF', occurredAt: '2026-10-25T12:00:00Z' });
  runner.commitSlot({ ...CAP, eventKey: 'nfl|2026-10-25|SEA@SF', occurredAt: '2026-10-25T12:02:00Z' });
  assert.equal(runner.slotsHeldAt({ ...CAP, at: '2026-10-25T23:00:00Z' }).count, 1,
    'a committed slot does not come back');
});

test('C12: capacity events are append-only, and a release must say why', () => {
  assert.throws(() => db.prepare(`DELETE FROM nfl_capacity_events`).run(), /append-only/);
  assert.throws(() => db.prepare(`UPDATE nfl_capacity_events SET kind='released'`).run(), /append-only/);
  assert.throws(() => runner.releaseSlot({ ...CAP, eventKey: 'x', occurredAt: '2026-10-25T12:00:00Z' }),
    /must say why/);
  assert.throws(() => runner.reserveSlot({ ...CAP, eventKey: 'x', occurredAt: 'not a time' }),
    /instant the reservation actually happened/);
});

test('C12: a restart neither loses nor duplicates a reservation', () => {
  const before = runner.slotsHeldAt({ ...CAP, at: '2026-10-25T12:05:00Z' });
  // A restart re-runs the same pass with the same inputs.
  runner.openObservations({ season: SEASON, week: WEEK, experimentId: EXPERIMENT,
    scheduleVersion: 'sched-1', now: BEFORE });
  const after = runner.slotsHeldAt({ ...CAP, at: '2026-10-25T12:05:00Z' });
  assert.deepEqual(after.held, before.held);
  assert.equal(after.count, before.count);
});

test('C12: one full pass opens, captures and reports without throwing on a bad game', () => {
  const pass = runner.runT60Pass({ season: SEASON, week: WEEK, experimentId: 'full-pass',
    scheduleVersion: 'sched-1', now: BEFORE });
  assert.equal(pass.runner_version, runner.T60_RUNNER_VERSION);
  assert.equal(pass.opened, 2);
  assert.ok(Array.isArray(pass.failed));
  assert.ok(Array.isArray(pass.skipped));
  // `started_at` is the simulated clock this pass was told to run at;
  // `finished_at` is the real one. They are deliberately different clocks --
  // a pass records when it believed it was running, not only when it ran.
  assert.equal(pass.started_at, BEFORE);
  assert.ok(Number.isFinite(Date.parse(pass.finished_at)));
});

/* --------------------------------------------- a `frozen` row must not be
 * able to die there: the packet freezes, the decision-tape link fails, and
 * (unlike before this fix) the row gets a real path back into processing
 * instead of sitting in `frozen` with no `decision_run_id` forever. */

const AT_CUTOFF = '2026-10-25T16:03:00Z'; // inside CAPTURE_GRACE_MINUTES of the 16:00Z cutoff

test('C12: a frozen packet whose decision-tape link fails is retried and completes on a later pass', () => {
  const EXP = 'relink-success';
  const opened = runner.openObservations({ season: SEASON, week: WEEK, experimentId: EXP,
    scheduleVersion: 'sched-1', now: BEFORE });
  assert.equal(opened.opened.length, 2);
  const target = opened.opened[0];
  poisonedLinkIds.add(target.id);

  const captured = runner.captureDueObservations({ experimentId: EXP, now: AT_CUTOFF });
  assert.equal(captured.captured.length, 2, 'the freeze itself must not be undone by a downstream failure');
  const poisoned = captured.captured.find(c => c.id === target.id);
  assert.ok(poisoned.decision_tape_error, 'the poisoned observation records a tape error, not a thrown pass');

  let stored = rows(`SELECT state, decision_run_id, last_error, capture_finished_at
    FROM nfl_t60_observations WHERE id=?`, target.id)[0];
  assert.equal(stored.state, 'frozen', 'the packet freeze is real evidence regardless of the link failure');
  assert.equal(stored.decision_run_id, null);
  assert.match(stored.last_error, /decision tape write failed/);
  const frozenAt = stored.capture_finished_at;
  assert.ok(frozenAt);

  // Before this fix, NOTHING ever looked at a `frozen` row again -- every
  // capture/scheduling query in the runner reads `state='scheduled'`. This is
  // the property under test: a later pass gives it a real path forward.
  assert.equal(
    rows(`SELECT COUNT(*) n FROM nfl_t60_observations WHERE state='frozen' AND decision_run_id IS NULL AND id=?`,
      target.id)[0].n, 1);

  // The transient failure clears -- exactly what a real DB blip, or a bug fix
  // deployed between ticks, looks like from the row's point of view.
  poisonedLinkIds.delete(target.id);

  const relink = runner.relinkStalledObservations({ experimentId: EXP, graceMinutes: 0 });
  assert.equal(relink.relinked.length, 1);
  assert.equal(relink.relinked[0].id, target.id);
  assert.ok(relink.relinked[0].decision_run_id);
  assert.deepEqual(relink.failed, []);

  stored = rows(`SELECT state, decision_run_id, last_error, note, capture_finished_at
    FROM nfl_t60_observations WHERE id=?`, target.id)[0];
  assert.equal(stored.state, 'decided');
  assert.ok(stored.decision_run_id, 'the row now has a real decision_run_id, not just a cleared error');
  assert.equal(stored.last_error, null, 'a resolved failure must not still read as a live one');
  // The freeze time is NEVER touched by a relink -- only the packet's own
  // capture wrote it, once, and a retry must not be mistaken for a second
  // (later) capture of live data.
  assert.equal(stored.capture_finished_at, frozenAt);
  // The retry's own completion is recorded distinctly from that freeze time,
  // which is exactly what lets a report tell "captured and linked on time"
  // apart from "captured on time but linked late after a retry."
  assert.match(stored.note, /linked via retry/);
  assert.ok(stored.note.includes(frozenAt), 'the note cross-references the original freeze time');

  // No duplicate: exactly one decision run was ever written for this observation.
  assert.equal(rows(`SELECT COUNT(*) n FROM nfl_decision_runs WHERE observation_id=?`, target.id)[0].n, 1);

  const coverage = runner.t60Coverage({ experimentId: EXP, season: SEASON, week: WEEK });
  const detail = coverage.detail.find(d => d.decision_run_id === stored.decision_run_id);
  assert.match(detail.note, /linked via retry/, 't60Coverage surfaces the relink note for a report to read');
});

test('C12: retrying an already fully-linked observation is a safe no-op', () => {
  const EXP = 'relink-noop';
  runner.openObservations({ season: SEASON, week: WEEK, experimentId: EXP,
    scheduleVersion: 'sched-1', now: BEFORE });
  const captured = runner.captureDueObservations({ experimentId: EXP, now: AT_CUTOFF });
  assert.ok(captured.captured.every(c => !c.decision_tape_error), 'nothing is poisoned in this test');

  const before = rows(`SELECT id, state, decision_run_id, note FROM nfl_t60_observations
    WHERE experiment_id=? ORDER BY event_key`, EXP);
  assert.equal(before.length, 2);
  assert.ok(before.every(o => o.state === 'decided' && o.decision_run_id),
    'both observations linked cleanly on the first pass, with no relink involved');
  const runsBefore = rows(`SELECT COUNT(*) n FROM nfl_decision_runs`)[0].n;

  const relink = runner.relinkStalledObservations({ experimentId: EXP, graceMinutes: 0 });
  assert.deepEqual(relink.relinked, [], 'an already-decided row is not a candidate for relink at all');
  assert.deepEqual(relink.failed, []);
  assert.deepEqual(relink.unretryable, []);

  const after = rows(`SELECT id, state, decision_run_id, note FROM nfl_t60_observations
    WHERE experiment_id=? ORDER BY event_key`, EXP);
  assert.deepEqual(after, before, 'an already-linked row is byte-for-byte untouched by a relink pass');
  assert.equal(rows(`SELECT COUNT(*) n FROM nfl_decision_runs`)[0].n, runsBefore,
    'no duplicate decision record is created');
});

test('C12: a full runT60Pass retries a stalled link on a later pass, honoring relinkGraceMinutes', () => {
  const EXP = 'relink-full-pass';
  const opened = runner.openObservations({ season: SEASON, week: WEEK, experimentId: EXP,
    scheduleVersion: 'sched-1', now: BEFORE });
  const target = opened.opened[0];
  poisonedLinkIds.add(target.id);

  const first = runner.runT60Pass({ season: SEASON, week: WEEK, experimentId: EXP,
    scheduleVersion: 'sched-1', now: AT_CUTOFF });
  assert.equal(first.captured, 2);
  assert.equal(first.relinked, 0, 'nothing was frozen before this pass ran, so there is nothing to relink yet');
  let stored = rows(`SELECT state, decision_run_id FROM nfl_t60_observations WHERE id=?`, target.id)[0];
  assert.equal(stored.state, 'frozen');
  assert.equal(stored.decision_run_id, null);

  // Still poisoned and inside the default relink grace window: a pass run
  // again immediately must not spin retrying the same known failure.
  const stillTooSoon = runner.runT60Pass({ season: SEASON, week: WEEK, experimentId: EXP,
    scheduleVersion: 'sched-1', now: AT_CUTOFF });
  assert.equal(stillTooSoon.relinked, 0, 'the grace window has not passed yet');

  poisonedLinkIds.delete(target.id);
  const second = runner.runT60Pass({ season: SEASON, week: WEEK, experimentId: EXP,
    scheduleVersion: 'sched-1', now: AT_CUTOFF, relinkGraceMinutes: 0 });
  assert.equal(second.relinked, 1, 'the stalled row from the first pass is relinked once the grace window is waived');
  assert.deepEqual(second.relink_failed, []);

  stored = rows(`SELECT state, decision_run_id FROM nfl_t60_observations WHERE id=?`, target.id)[0];
  assert.equal(stored.state, 'decided');
  assert.ok(stored.decision_run_id);
});
