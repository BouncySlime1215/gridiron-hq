/**
 * SIM CALIBRATION MONITOR (batch D item 29): Brier decomposition, Spiegelhalter z,
 * CUSUM drift alarm, the two shadow rows, the flag, and the weekly matchup log.
 * Seeded fixtures and made-up roster ids only; no live data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rng } from '../server/services/eval/stats.js';
import { brainReportRule } from '../server/services/eval/brain-rule.js';
import { BRAIN_CHECK_IDS } from '../server/services/campaign/plans-schema.js';
import { servedNumbers } from '../server/services/serve-log.js';
import * as CM from '../server/services/eval/calibration-monitor.js';

const ON = { [CM.CAL_MONITOR_ENV]: '1' };

// ------------------------------------------------------------------ pure statistics
test('decomposition: brier = reliability - resolution + uncertainty (+ within-bin, 0 when bins are constant)', () => {
  const p = [0.15, 0.15, 0.15, 0.15, 0.75, 0.75, 0.75, 0.75];
  const y = [0, 0, 1, 0, 1, 1, 0, 1];
  const d = CM.brierDecomposition(p, y);
  assert.ok(Math.abs(d.within_bin) < 1e-12, `within ${d.within_bin}`);
  assert.ok(Math.abs(d.brier - (d.reliability - d.resolution + d.uncertainty)) < 1e-12);
  assert.ok(Math.abs(d.uncertainty - 0.25) < 1e-12);
  // bin 1: 0.15 vs 0.25 observed; bin 2: 0.75 vs 0.75 -> reliability = 4/8 * 0.01
  assert.ok(Math.abs(d.reliability - 0.005) < 1e-12, `rel ${d.reliability}`);
  assert.ok(Math.abs(d.resolution - 0.0625) < 1e-12, `res ${d.resolution}`);
});

test('spiegelhalter z: ~N(0,1) on honest forecasts, large on over-confident ones', () => {
  const rand = rng(29);
  const truth = Array.from({ length: 2000 }, () => 0.2 + 0.6 * rand());
  const y = truth.map(q => (rand() < q ? 1 : 0));
  assert.ok(Math.abs(CM.spiegelhalterZ(truth, y)) < 3);
  const over = truth.map(q => (q > 0.5 ? Math.min(0.99, q + 0.25) : Math.max(0.01, q - 0.25)));
  assert.ok(Math.abs(CM.spiegelhalterZ(over, y)) > 5);
});

test('cusum: no alarm on 17 honest weeks, alarm soon after a planted drift', () => {
  assert.equal(CM.cusum([0.3, -0.8, 1.1, -0.2, 0.4, -1.3, 0.9, 0.1, -0.5, 1.4, -0.6, 0.2, 0.7, -0.9, 0.3, -0.1, 0.5]).alarm, false);
  const drifted = [0.2, -0.4, 0.3, -0.1, 0.5, 0.0, -0.3, 2.5, 2.8, 2.2, 2.6];
  const c = CM.cusum(drifted);
  assert.equal(c.alarm, true);
  assert.ok(c.alarm_at >= 8 && c.alarm_at <= 10, `alarm at ${c.alarm_at}`);
  assert.equal(CM.cusum(drifted.map(z => -z)).alarm, true, 'two-sided');
});

// ------------------------------------------------------------------ matchup resolution
test('resolveMatchups: unplayed zeros, the current week and ties are left out; a pair is graded once, from the lower id', () => {
  const served = [
    { league_id: 4, season: 2026, entity: 'matchup:3:2|7', value: 0.6, served_at: '2026-09-22T12:00:00Z' },
    { league_id: 4, season: 2026, entity: 'matchup:3:7|2', value: 0.4, served_at: '2026-09-22T12:01:00Z' }, // same pair
    { league_id: 4, season: 2026, entity: 'matchup:3:9|1', value: 0.3, served_at: '2026-09-22T12:00:00Z' }, // lower id is 1
    { league_id: 4, season: 2026, entity: 'matchup:3:3|4', value: 0.5, served_at: '2026-09-22T12:00:00Z' }, // tie
    { league_id: 4, season: 2026, entity: 'matchup:5:2|8', value: 0.5, served_at: '2026-10-06T12:00:00Z' }, // placeholder zeros
    { league_id: 4, season: 2026, entity: 'matchup:6:2|9', value: 0.5, served_at: '2026-10-13T12:00:00Z' }, // current week
    { league_id: 4, season: 2026, entity: 'garbage', value: 0.5, served_at: '2026-10-13T12:00:00Z' },
  ];
  const sc = (week, roster_id, points) => ({ league_id: 4, season: 2026, week, roster_id, points });
  const scores = [sc(3, '2', 110), sc(3, '7', 95), sc(3, '9', 120), sc(3, '1', 100), sc(3, '3', 99), sc(3, '4', 99),
    sc(5, '2', 0), sc(5, '8', 0), sc(6, '2', 40), sc(6, '9', 31)];
  const { rows, skipped } = CM.resolveMatchups({ served, scores, currentWeek: new Map([[4, 6]]) });
  assert.deepEqual(rows.map(r => [r.week, r.p, r.y]).sort(), [[3, 0.6, 1], [3, 0.7, 0]].sort());
  assert.deepEqual(skipped, { unplayed: 2, tie: 1, malformed: 1, duplicate: 1 });
});

// ------------------------------------------------------------------ grading
function season({ weeks = 17, perWeek = 25, bias = () => 0, seed = 7 } = {}) {
  const rand = rng(seed);
  const rows = [];
  for (let w = 1; w <= weeks; w += 1) {
    for (let i = 0; i < perWeek; i += 1) {
      const truth = 0.1 + 0.8 * rand();
      const p = Math.min(0.99, Math.max(0.01, truth + bias(w, truth)));
      rows.push({ league_id: 1 + (i % 5), season: 2026, week: w, p, y: rand() < truth ? 1 : 0 });
    }
  }
  return rows;
}

test('matchups: an honest model passes, no alarm, and every row is shadow-only', () => {
  const r = CM.gradeMatchups(season());
  assert.equal(r.status, 'passing', JSON.stringify({ m: r.metric, ci: [r.ci_low, r.ci_high], s: r.detail.slope, d: r.detail.drift }));
  assert.equal(r.detail.drift.alarm, false);
  assert.equal(r.detail.shadow_only, true);
  assert.equal(r.detail.weeks.length, 17);
  assert.ok(r.detail.decomposition.reliability < 0.01);
});

test('matchups: a model that turns over-confident from week 8 trips the drift alarm and fails', () => {
  const over = (w, t) => (w >= 8 ? (t > 0.5 ? 0.3 : -0.3) : 0);
  const r = CM.gradeMatchups(season({ bias: over }));
  assert.equal(r.status, 'failing');
  assert.equal(r.detail.drift.alarm, true);
  assert.ok(r.detail.drift.alarm_week.week >= 8, `alarm week ${r.detail.drift.alarm_week.week}`);
});

test('matchups: below 100 it waits and says how many more matchups', () => {
  const r = CM.gradeMatchups(season({ weeks: 3 }));
  assert.equal(r.status, 'not_enough_data');
  assert.equal(r.needs_unit, 'matchups');
  assert.equal(r.needs_n, 25);
  assert.match(r.needs_text, /needs 25 more matchups/);
});

test('title: waits until a season has ended; an honest set of ended seasons passes', () => {
  const waitingRow = CM.gradeTitle([{ league_id: 4, season: 2026, team_id: '5', week: 3, p_playoffs: 0.4, p_title: 0.05, made_playoffs: null, won_title: null }]);
  assert.equal(waitingRow.status, 'not_enough_data');
  assert.match(waitingRow.needs_text, /season has not ended/);
  assert.equal(waitingRow.detail.shadow_only, true);

  const rand = rng(31);
  const snaps = [];
  for (let lg = 1; lg <= 6; lg += 1) {
    for (let t = 1; t <= 10; t += 1) {
      const strength = rand();
      const made = rand() < strength ? 1 : 0;
      for (let w = 1; w <= 12; w += 1) {
        snaps.push({ league_id: lg, season: 2025, team_id: String(t), week: w, p_playoffs: 0.05 + 0.9 * strength,
          p_title: 0.1 * strength, made_playoffs: made, won_title: 0 });
      }
    }
  }
  const r = CM.gradeTitle(snaps);
  assert.equal(r.n, 60);
  assert.equal(r.status, 'passing', JSON.stringify({ m: r.metric, ci: [r.ci_low, r.ci_high], d: r.detail.drift }));
});

// ------------------------------------------------------------------ flag, storage, rule
function memDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE served_numbers (id INTEGER PRIMARY KEY, league_id INTEGER, surface TEXT, entity TEXT, field TEXT,
      value REAL, model TEXT, model_version TEXT, as_of TEXT, served_at TEXT, request_id TEXT, trigger TEXT, season INTEGER, week INTEGER);
    CREATE TABLE league_week_scores (league_id INTEGER, season INTEGER, week INTEGER, roster_id TEXT, points REAL, opponent_roster_id TEXT, is_playoff INTEGER, captured_at TEXT);
    CREATE TABLE leagues (id INTEGER PRIMARY KEY, current_week INTEGER, payload TEXT);`);
  return db;
}

test('flag off: the grader emits nothing, so the stored report reads exactly as before', () => {
  assert.deepEqual(CM.run(memDb(), { env: {} }), []);
});

test('flag on: both rows, each saying what it waits on; brain-rule never lowers the mode on them', () => {
  const db = memDb();
  const rows = CM.run(db, { env: ON });
  assert.deepEqual(rows.map(r => r.check), CM.ROW_IDS);
  assert.match(rows[0].needs_text, /no weekly matchup win probability has been logged yet/);
  assert.match(rows[1].needs_text, /title_odds_snapshots is not built yet/);
  const failing = rows.map(r => ({ ...r, status: 'failing' }));
  const rule = brainReportRule({ requestedMode: 'all_in', now: new Date('2026-09-25T00:00:00Z'),
    report: { computed_at: '2026-09-25T00:00:00Z', checks: failing } });
  assert.equal(rule.mode, 'all_in');
  assert.equal(rule.shadow.length, 2);
});

test('flag on: logged weekly rows are read, resolved against final scores, and graded', () => {
  const db = memDb();
  db.prepare('INSERT INTO leagues (id, current_week) VALUES (4, 5)').run();
  const ins = db.prepare(`INSERT INTO served_numbers (league_id, surface, entity, field, value, model, served_at, request_id, trigger, season, week)
    VALUES (4, 'matchup_win', ?, 'win_prob', ?, 'lineup-posture.lineupPosture', '2026-09-22T12:00:00Z', 'weekly:x', ?, 2026, 3)`);
  ins.run('matchup:3:2|7', 0.6, 'weekly');
  ins.run('matchup:3:1|9', 0.8, 'request'); // a page view, not the pre-registered weekly source
  const sc = db.prepare('INSERT INTO league_week_scores (league_id, season, week, roster_id, points) VALUES (4, 2026, 3, ?, ?)');
  for (const [id, pts] of [['2', 101], ['7', 90], ['1', 80], ['9', 70]]) sc.run(id, pts);
  const [m] = CM.run(db, { env: ON });
  assert.equal(m.n, 1);
  assert.equal(m.status, 'not_enough_data');
  assert.equal(m.detail.weeks[0].observed, 1);
});

// ------------------------------------------------------------------ contract + serve-log
test('every CAL row id is allowed by the plans contract', () => {
  for (const id of [CM.CHECK, ...CM.ROW_IDS]) assert.ok(BRAIN_CHECK_IDS.includes(id), id);
});

test('serve-log matchup_win: the served percent is stored as a probability; no opponent stores nothing', () => {
  const rows = servedNumbers('matchup_win', { roster_id: '5', opponent_roster_id: '8', week: 4, win_probability: 62.5, edge: 6.1 });
  assert.deepEqual(rows.map(r => [r.entity, r.field, r.value]), [['matchup:4:5|8', 'win_prob', 0.625], ['matchup:4:5|8', 'edge', 6.1]]);
  assert.equal(rows[0].model, 'lineup-posture.lineupPosture');
  assert.deepEqual(servedNumbers('matchup_win', { roster_id: '5', opponent_roster_id: null, week: 4 }), []);
  assert.throws(() => servedNumbers('matchup_win', { win_probability: 50 }), /no roster or week/);
});

test('matchupPostures: one producer call per pair, errors and byes skipped', () => {
  const lg = { payload: JSON.stringify({ teams: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }] }) };
  const opp = { 1: '2', 2: '1', 3: '4', 4: '3', 5: null };
  const calls = [];
  const posture = (_lg, { myTeamId }) => {
    calls.push(myTeamId);
    return { roster_id: myTeamId, opponent_roster_id: opp[myTeamId], week: 4, win_probability: opp[myTeamId] ? 55 : null };
  };
  const out = CM.matchupPostures(lg, posture);
  assert.deepEqual(out.map(o => `${o.roster_id}|${o.opponent_roster_id}`), ['1|2', '3|4']);
  assert.deepEqual(calls, ['1', '3', '5']);
});
