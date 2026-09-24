/**
 * RL-16-2: the next waiver run comes from a real time before a guess.
 *
 * nextWaiverRun() used to read acquisitionSettings.waiverProcessHour as an hour
 * in US Eastern and nothing else. On the local copy that named the wrong run in
 * 9 of 9 checked claims (8 late by ~7-8 hours, 1 on the wrong day). The order is
 * now: ESPN's own scheduled time, then the league's observed runs (processDate
 * of executed WAIVER claims, captured by the sync into league_waiver_runs), then
 * the settings guess, labelled unconfirmed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-rl16-2-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { nextWaiverRun } = await import('../server/services/waiver-wire.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const ACQ = { waiverProcessDays: ['WEDNESDAY', 'SATURDAY'], waiverProcessHour: 11, waiverHours: 24 };
const PAYLOAD = { settings: { acquisitionSettings: ACQ } };
// Tuesday 2026-10-06, 10:00 US Eastern.
const TUESDAY = new Date('2026-10-06T14:00:00Z');
// Observed runs: Wednesdays and Saturdays at about 03:30 Eastern (07:30Z in EDT),
// seconds apart within a run, as ESPN stamps each processed claim.
const OBSERVED = [
  '2026-09-23T07:31:02Z', '2026-09-23T07:31:40Z', '2026-09-26T07:30:15Z',
  '2026-09-30T07:32:10Z', '2026-10-03T07:30:55Z', '2026-10-03T07:31:05Z'
];

let waiverRuns = null;
async function runs() {
  waiverRuns ??= await import('../server/services/waiver-runs.js');
  return waiverRuns;
}

test('RED 1: a fixture with observed runs -> the next run is the observed time, not hour 11', () => {
  const r = nextWaiverRun(PAYLOAD, TUESDAY, OBSERVED);
  assert.equal(r.known, true);
  assert.equal(r.basis, 'observed');
  assert.equal(r.confirmed, true);
  assert.equal(r.day, 'WEDNESDAY');
  assert.equal(r.date, '2026-10-07');
  assert.equal(r.hour, 3, 'the observed 03:3x Eastern, not the settings hour 11');
  assert.equal(r.at, '2026-10-07T07:32:10.000Z', 'the latest Wednesday run\'s clock time, carried to the next Wednesday');
  assert.equal(r.observed_runs, 4, 'claims seconds apart are one run');
  assert.doesNotMatch(r.zone_basis, /guess/i);
});

test('RED 2: no observed runs and no ESPN schedule -> the settings guess, labelled unconfirmed', () => {
  const r = nextWaiverRun(PAYLOAD, TUESDAY, []);
  assert.equal(r.known, true);
  assert.equal(r.basis, 'unconfirmed_guess');
  assert.equal(r.confirmed, false);
  assert.match(r.label, /unconfirmed/);
  assert.deepEqual({ day: r.day, date: r.date, hour: r.hour }, { day: 'WEDNESDAY', date: '2026-10-07', hour: 11 });
  // Called the old way (no third argument) it is the same guess.
  assert.equal(nextWaiverRun(PAYLOAD, TUESDAY).basis, 'unconfirmed_guess');
});

test('RED 3: a Sunday injury does not claim a Monday run when history has no Monday run', () => {
  const mondayListed = { settings: { acquisitionSettings: { ...ACQ, waiverProcessDays: ['MONDAY', 'WEDNESDAY'] } } };
  // Sunday 2026-10-04, 20:00 Eastern.
  const r = nextWaiverRun(mondayListed, new Date('2026-10-05T00:00:00Z'), OBSERVED);
  assert.notEqual(r.day, 'MONDAY');
  assert.equal(r.day, 'WEDNESDAY');
  assert.equal(r.date, '2026-10-07');
});

test('ESPN\'s own scheduled time wins over observed runs and the guess', () => {
  const scheduled = { ...PAYLOAD, status: { waiverNextExecutionDate: Date.parse('2026-10-07T08:05:00Z') } };
  const r = nextWaiverRun(scheduled, TUESDAY, OBSERVED);
  assert.equal(r.basis, 'espn_scheduled');
  assert.equal(r.at, '2026-10-07T08:05:00.000Z');
  assert.deepEqual({ day: r.day, date: r.date, hour: r.hour, minute: r.minute },
    { day: 'WEDNESDAY', date: '2026-10-07', hour: 4, minute: 5 });
  // A scheduled time already in the past is not the next run: fall through to observed.
  const stale = { ...PAYLOAD, status: { waiverNextExecutionDate: Date.parse('2026-10-03T07:30:00Z') } };
  assert.equal(nextWaiverRun(stale, TUESDAY, OBSERVED).basis, 'observed');
});

test('the sync captures executed WAIVER processDates and ESPN\'s last execution into league_waiver_runs', async () => {
  const { recordWaiverRuns, observedWaiverRuns } = await runs();
  run(`INSERT INTO leagues (id, platform, league_id, season, name) VALUES (1, 'espn', '1', 2026, 'L1')`);
  const data = {
    status: { waiverLastExecutionDate: Date.parse('2026-10-03T07:30:55Z') },
    transactions: [
      { id: 'a', type: 'WAIVER', status: 'EXECUTED', processDate: Date.parse('2026-09-30T07:32:10Z') },
      { id: 'b', type: 'WAIVER', status: 'FAILED_INVALIDPLAYERSOURCE', processDate: Date.parse('2026-09-30T07:32:11Z') },
      { id: 'c', type: 'FREEAGENT', status: 'EXECUTED', processDate: Date.parse('2026-10-01T19:00:00Z') },
      { id: 'd', type: 'WAIVER', status: 'EXECUTED', processDate: null }
    ]
  };
  const n = recordWaiverRuns(1, 2026, data);
  assert.equal(n, 2, 'one executed WAIVER claim and ESPN\'s last execution; failed claims and free-agent adds are not runs');
  recordWaiverRuns(1, 2026, data);
  const seen = observedWaiverRuns(1, 2026);
  assert.deepEqual(seen, ['2026-09-30T07:32:10.000Z', '2026-10-03T07:30:55.000Z'], 'a second sync adds nothing');
  // Other league / season is not mixed in.
  assert.deepEqual(observedWaiverRuns(1, 2025), []);
});

test('observed runs also read league_transactions_raw when the collector has filled it', async () => {
  const { observedWaiverRuns } = await runs();
  db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
    league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
    type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
    team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
    bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    PRIMARY KEY (league_id, season, tx_id))`);
  const ins = db.prepare(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, processed_at,
    first_seen_at, last_seen_at) VALUES (1, 2026, ?, ?, ?, ?, 'x', 'x')`);
  ins.run('t1', 'WAIVER', 'EXECUTED', '2026-09-26T07:30:15.000Z');
  ins.run('t2', 'WAIVER', 'EXECUTED', '2026-09-26T07:30:40.000Z');
  ins.run('t3', 'WAIVER', 'CANCELED', '2026-09-27T12:00:00.000Z');
  ins.run('t4', 'FREEAGENT', 'EXECUTED', '2026-09-27T13:00:00.000Z');
  assert.deepEqual(observedWaiverRuns(1, 2026),
    ['2026-09-26T07:30:15.000Z', '2026-09-30T07:32:10.000Z', '2026-10-03T07:30:55.000Z']);
});
