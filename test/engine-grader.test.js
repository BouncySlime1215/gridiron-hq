/**
 * Outcomes as events + the grader (ENGINE-SPECS.md "outcomes as events + the grader" row,
 * run as cloud unit EA-05; ENGINE-ARCHITECTURE.md §7.1-7.3).
 *
 * RED (1)-(8) are the row's acceptance checks, in its order:
 *   (1) a row written after its decision time is never graded
 *   (2) a version registered after the decision time is never graded
 *   (3) a stat correction re-grades the same prediction once (one grade per prediction x outcome entity)
 *   (4) the quantile score on a fixture matches the pinball closed form
 *   (5) gradeDecisions is reused unchanged
 *   (6) both lanes are graded on the same outcomes
 *   (7) PIT on a calibrated fixture is uniform (KS p > 0.05)
 *   (8) floors count clusters (30 player-weeks from one Sunday do not meet the floor)
 * plus the adapters (A1)-(A3) and the 2025 holdout (H1).
 * Fixtures only: leagues 91-92, players 9201-9232, teams AAA-FFF. Tests share one database
 * and run in file order.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-engine-grader-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PROCESS_ROLE = 'test';

const { db, run, row, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

async function optionalImport(specifier) {
  try { return await import(specifier); } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  }
}
const registry = await import('../server/services/engine/registry.js');
const { writeState } = await import('../server/services/engine/state.js');
const tickMod = await import('../server/services/engine/daemon/tick.js');
const cursorsMod = await import('../server/services/engine/daemon/cursors.js');
const baselineGate = await import('../server/services/gates/baseline-gate.js');
const outcomesMod = await optionalImport('../server/services/engine/adapters/outcomes.js');
const recMod = await optionalImport('../server/services/engine/adapters/rec.js');
const scorers = await optionalImport('../server/services/engine/grade/scorers.js');
const graderMod = await optionalImport('../server/services/engine/producers/grader.js');
const producersMod = await import('../server/services/engine/producers/index.js');
const need = (mod, name) => assert.ok(mod, `${name} does not exist: outcomes-as-events and the grader are not built`);

const at = iso => mock.timers.setTime(Date.parse(iso));
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-10T12:00:00.000Z') });
test.after(() => mock.timers.reset());

/* ------------------------------------------------------------------ fixtures */
const PLAYERS = Array.from({ length: 30 }, (_, i) => 9201 + i); // AAA, 2026 week 3 (final)
for (const id of [...PLAYERS, 9231, 9232]) {
  run(`INSERT INTO players (id, name, position) VALUES (?, 'Fixture', 'WR')`, id);
}
run(`INSERT INTO leagues (id, platform, league_id, season, ppr) VALUES (91, 'sleeper', 'fx-91', 2026, 1), (92, 'sleeper', 'fx-92', 2026, 0.5)`);
const game = (season, week, home, away, gameday, final) => {
  run(`INSERT INTO game_lines (season, week, team, opponent, home, gameday, gametime, team_score, opp_score, fetched_at)
       VALUES (?, ?, ?, ?, 1, ?, '13:00', ?, ?, '2026-09-09T00:00:00.000Z')`, season, week, home, away, gameday,
  final ? 20 : null, final ? 17 : null);
  run(`INSERT INTO game_lines (season, week, team, opponent, home, gameday, gametime, team_score, opp_score, fetched_at)
       VALUES (?, ?, ?, ?, 0, ?, '13:00', ?, ?, '2026-09-09T00:00:00.000Z')`, season, week, away, home, gameday,
  final ? 17 : null, final ? 20 : null);
};
game(2026, 3, 'AAA', 'BBB', '2026-09-13', true);
game(2026, 4, 'CCC', 'DDD', '2026-09-20', false);
game(2025, 3, 'EEE', 'FFF', '2025-09-14', true);
const usage = (pid, season, week, team, rec, yd) => run(`INSERT INTO player_week_usage (player_id, season, week, team, position,
    receptions, receiving_yards, receiving_tds) VALUES (?, ?, ?, ?, 'WR', ?, ?, 0)`, pid, season, week, team, rec, yd);
PLAYERS.forEach((pid, i) => usage(pid, 2026, 3, 'AAA', 2 + (i % 5), 20 + 3 * i));
usage(9231, 2026, 4, 'CCC', 5, 50); // game not final: no outcome yet
usage(9232, 2025, 3, 'EEE', 4, 40); // the 2025 holdout season
const KICKOFF = '2026-09-13T17:00:00.000Z';

const outcomeEvents = (where = '', ...p) => rows(`SELECT id, natural_key, payload FROM engine_events
  WHERE event_type = 'outcome.player_week' ${where} ORDER BY id`, ...p).map(r => ({ ...r, payload: JSON.parse(r.payload) }));

/* ------------------------------------------------------------------ adapters */
test('A1: outcome.player_week is one event per (player_week, scoring_key, stat_version), finals only', () => {
  need(outcomesMod, 'adapters/outcomes.js');
  at('2026-09-15T12:00:00.000Z'); // ingested after the games (a future as_of is clamped to the ingest clock)
  const r = cursorsMod.runAdapterStream(outcomesMod.OUTCOMES_ADAPTER, { database: db });
  assert.equal(r.table_state, 'present');
  const evs = outcomeEvents();
  const keys = new Set(evs.map(e => e.payload.scoring_key));
  assert.equal(keys.size, 2, 'two leagues with different scoring -> two scoring keys');
  for (const k of keys) assert.match(k, /^[0-9a-f]{16}$/, 'a scoring key fits the player_week_scored grammar');
  assert.equal(evs.length, (PLAYERS.length + 1) * 2, '30 players + the 2025 row, each under both keys; the non-final game has none');
  assert.ok(!evs.some(e => e.payload.player_id === 9231), 'a player-week whose game is not final has no outcome');
  const one = evs.filter(e => e.payload.player_id === 9201);
  const ppr = one.find(e => e.payload.points === 4); // PPR: 2 rec + 20 yd
  const half = one.find(e => e.payload.points === 3); // half-PPR
  assert.ok(ppr && half, `${JSON.stringify(one.map(e => e.payload.points))}`);
  assert.equal(ppr.payload.kickoff, KICKOFF, 'the outcome carries its game cutoff (the decision time)');
  const asOf = row(`SELECT as_of, as_of_quality FROM engine_events WHERE id = ?`, ppr.id);
  assert.deepEqual({ ...asOf }, { as_of: '2026-09-14T03:59:59.999Z', as_of_quality: 'date_only' }, 'end of game day, Eastern');
  assert.match(ppr.payload.stat_version, /^[0-9a-f]{12,}$/);
  assert.ok(ppr.natural_key.endsWith(`:${ppr.payload.scoring_key}:${ppr.payload.stat_version}`),
    'stat_version is in the natural key: a correction (or its revert) is its own event');
  const again = cursorsMod.runAdapterStream(outcomesMod.OUTCOMES_ADAPTER, { database: db, sweep: true });
  assert.equal(again.inserted, 0, 'a re-read of unchanged lines appends nothing');
});

test('A2: offer.sent carries the snapshot in force at send time; rec.* waits on rec_ledger without failing', () => {
  need(recMod, 'adapters/rec.js');
  run(`INSERT INTO engine_snapshots (league_id, max_event_id, max_state_id, version_set, fallback_set, created_at)
       VALUES (91, 0, 0, '{}', '{}', '2026-09-11T00:00:00.000Z'), (91, 0, 0, '{}', '{}', '2026-09-12T23:00:00.000Z')`);
  const [inForce] = rows(`SELECT id FROM engine_snapshots WHERE league_id = 91 ORDER BY id`);
  run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json,
         proposed_at, model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, status, not_proposed_reason, idea_id,
         created_at)
       VALUES (91, 2026, 'app_proposed', '1', '2', '[9201]', '[9202]', '2026-09-12T15:00:00.000Z', 0.4, 0.2, 0.6,
         'heuristic_unanchored', 'proposed', NULL, 'fx-idea-1', '2026-09-12T15:00:00.000Z'),
              (91, 2026, 'considered_only', '1', '3', '[9203]', '[9204]', '2026-09-12T15:00:00.000Z', NULL, NULL, NULL,
         NULL, 'not_proposed', 'fixture', 'fx-idea-2', '2026-09-12T15:00:00.000Z')`);
  cursorsMod.runAdapterStream(recMod.OFFER_ADAPTER, { database: db });
  const offers = rows(`SELECT payload, as_of FROM engine_events WHERE event_type = 'offer.sent'`).map(r => ({ ...r, payload: JSON.parse(r.payload) }));
  assert.equal(offers.length, 1, 'only an offer the app sent is offer.sent; a considered-only row is not');
  assert.equal(offers[0].payload.snapshot_id, inForce.id, 'the snapshot in force at proposed_at, not the later one');
  assert.equal(offers[0].as_of, '2026-09-12T15:00:00.000Z');

  // #174 landed on main (migration 071): rec_ledger exists, empty. An empty table is 0 rows, present.
  const empty = cursorsMod.runAdapterStream(recMod.REC_ADAPTER, { database: db });
  assert.equal(empty.table_state, 'present', 'rec_ledger (migration 071) exists once migrations run');
  assert.equal(empty.source_rows, 0);
  run(`INSERT INTO rec_ledger (league_id, kind, disposition, made_at, season, week, inputs_hash, predicted_json, horizon,
         graded_at, outcome_json, score)
       VALUES (91, 'lineup', 'shown', '2026-09-12T10:00:00.000Z', 2026, 3, 'abc', '{"snapshot_id": 7, "delta": 1.5}', 1,
         '2026-09-15T10:00:00.000Z', '{"delta": 2}', 0.5),
              (92, 'waiver', 'considered_not_shown', '2026-09-12T10:00:00.000Z', 2026, 3, 'def', '{"delta": 0.2}', 1,
         NULL, NULL, NULL)`);
  cursorsMod.runAdapterStream(recMod.REC_ADAPTER, { database: db });
  const recs = rows(`SELECT event_type, payload FROM engine_events WHERE event_type LIKE 'rec.%' ORDER BY id`)
    .map(r => ({ type: r.event_type, payload: JSON.parse(r.payload) }));
  assert.deepEqual(recs.map(r => r.type).sort(), ['rec.considered', 'rec.graded', 'rec.shown']);
  assert.equal(recs.find(r => r.type === 'rec.shown').payload.snapshot_id, 7, 'predicted_json.snapshot_id wins');
  assert.equal(recs.find(r => r.type === 'rec.considered').payload.snapshot_id, null, 'no snapshot in force for league 92: null, typed');
  assert.equal(recs.find(r => r.type === 'rec.considered').payload.snapshot_basis, 'none_in_force');
});

test('A3: the daemon ingests the new streams and runs the grader in its DAG', () => {
  const streams = cursorsMod.DAEMON_ADAPTERS.map(a => a.stream);
  for (const s of ['outcomes', 'offers', 'rec']) assert.ok(streams.includes(s), `daemon stream ${s}`);
  for (const s of streams) assert.ok(cursorsMod.CURSOR_SPECS[s], `cursor spec for ${s}`);
  assert.ok(producersMod.daemonProducers().some(p => p.name === 'grader'), 'grader is a daemon producer');
});

/* ------------------------------------------------------------------ predictions under test */
const levels = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
const Z = [-1.645, -1.2816, -0.8416, -0.5244, -0.2533, 0, 0.2533, 0.5244, 0.8416, 1.2816, 1.645];
const dist = (mu, sd) => ({ levels, values: Z.map(z => +(mu + sd * z).toFixed(3)) });
const RANGE = registry.registerProducer({
  name: 'fx_range', active: '1', shadow: ['2'], versions: { 1: {}, 2: {} },
  fields: [{ field: 'fx.range', valueType: 'dist', entityTypes: ['player_week_scored'], description: 'fixture range' }],
  inputs: { events: [], fields: [] },
});
const LATE = registry.registerProducer({
  name: 'fx_late', active: '1', versions: { 1: {} },
  fields: [{ field: 'fx.late', valueType: 'dist', entityTypes: ['player_week_scored'], description: 'fixture late version' }],
  inputs: { events: [], fields: [] },
});
const chain = { contributions: [{ source: 'fixture', kind: 'event', event_ids: [], delta: null, text: 'fixture' }] };
const predict = (writer, field, version, pid, season, week, key, value) => writeState({ entityType: 'player_week_scored',
  entityId: `${pid}:${season}:${week}:${key}`, field, value, asOf: new Date().toISOString(), writer, producerVersion: version,
  reasonChain: chain }, db);
let PPR_KEY;
const early = {};
let late9201;

function gradeRow(entity, field = 'grade.season_to_date') {
  const r = row(`SELECT * FROM engine_state WHERE field = ? AND entity_type = 'producer' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
    field, entity);
  return r ? { ...r, value: JSON.parse(r.value) } : null;
}
const graderTick = now => {
  need(graderMod, 'producers/grader.js');
  const dag = [producersMod.producerEntry(graderMod.graderProducer)];
  return tickMod.runTick({ database: db, dag, now: new Date(now) });
};

test('setup: predictions before kickoff, one after, a late-registered version, a 2025 row', async () => {
  need(graderMod, 'producers/grader.js');
  PPR_KEY = outcomeEvents().find(e => e.payload.player_id === 9201 && e.payload.points === 4).payload.scoring_key;
  graderMod.registerGraded('fx.range', { kind: 'dist' });
  graderMod.registerGraded('fx.late', { kind: 'dist' });
  at('2026-09-10T12:00:00.000Z');
  for (const pid of PLAYERS.slice(0, 29)) {
    const pts = outcomeEvents().find(e => e.payload.player_id === pid && e.payload.scoring_key === PPR_KEY).payload.points;
    early[pid] = predict(RANGE['fx.range'], 'fx.range', '1', pid, 2026, 3, PPR_KEY, dist(pts, 4)).id;
    predict(RANGE['fx.range'], 'fx.range', '2', pid, 2026, 3, PPR_KEY, dist(pts + 1, 6));
    predict(LATE['fx.late'], 'fx.late', '1', pid, 2026, 3, PPR_KEY, dist(pts, 4));
  }
  // fx_late's version "registered" after kickoff (a re-registration: the version was not in force at the cut).
  run(`UPDATE engine_producers SET registered_at = '2026-09-14T00:00:00.000Z' WHERE producer = 'fx_late'`);
  at('2026-09-14T09:00:00.000Z'); // after kickoff
  predict(RANGE['fx.range'], 'fx.range', '1', 9230, 2026, 3, PPR_KEY, dist(10, 4));
  late9201 = predict(RANGE['fx.range'], 'fx.range', '1', 9201, 2026, 3, PPR_KEY, dist(99, 1)).id;
  at('2025-09-01T12:00:00.000Z');
  predict(RANGE['fx.range'], 'fx.range', '1', 9232, 2025, 3, PPR_KEY, dist(8, 4));
  at('2026-09-15T12:00:00.000Z');
  const t = await graderTick('2026-09-15T12:00:00.000Z');
  assert.equal(t.failed.length, 0, JSON.stringify(t.failed));
});

test('RED (1): a row written after its decision time is never graded', () => {
  const week = gradeRow('fx_range@1', 'grade.week');
  assert.ok(week, 'grade.week row for fx_range@1');
  const graded = week.value.by_field['fx.range'].graded;
  const players = graded.map(g => Number(g.entity_id.split(':')[0]));
  assert.ok(!players.includes(9230), 'the player predicted only after kickoff is not graded');
  const g9201 = graded.find(g => g.entity_id.startsWith('9201:'));
  assert.equal(g9201.state_id, early[9201], 'the row in force at kickoff is graded, not the one written after it');
  assert.notEqual(g9201.state_id, late9201);
  assert.equal(week.value.by_field['fx.range'].n, 29);
});

test('RED (2): a version registered after the decision time is never graded', () => {
  need(graderMod, 'producers/grader.js');
  const f = gradeRow('fx_late@1')?.value?.by_field?.['fx.late'];
  assert.ok(f, 'the grader writes a row for fx_late@1 that says why nothing was graded');
  assert.equal(f.n, 0, `fx_late@1 must grade nothing, got n=${f.n}`);
  assert.equal(f.excluded.version_after_decision, 29, JSON.stringify(f.excluded));
});

test('RED (6): both lanes are graded on the same outcomes', () => {
  const a = gradeRow('fx_range@1').value.by_field['fx.range'];
  const b = gradeRow('fx_range@2').value.by_field['fx.range'];
  assert.equal(a.lane, 'live'); assert.equal(b.lane, 'shadow');
  assert.equal(a.n, b.n);
  assert.equal(a.outcomes_hash, b.outcomes_hash, 'the same outcome events');
  assert.ok(a.metrics.quantile_score < b.metrics.quantile_score, 'the centred, narrower version scores better');
});

test('RED (8): floors count clusters: 29 player-weeks from one Sunday do not meet the floor', () => {
  const f = gradeRow('fx_range@1').value.by_field['fx.range'];
  assert.equal(f.clusters.weeks, 1);
  assert.equal(f.clusters.entities, 29);
  assert.equal(f.floor_met, false);
  need(scorers, 'grade/scorers.js');
  const many = Array.from({ length: 30 }, (_, i) => ({ week: `2026:${1 + (i % 5)}`, entity: String(i) }));
  assert.equal(scorers.clusterFloor(many).met, true, '5 weeks x 30 players meets it');
  const oneSunday = Array.from({ length: 30 }, (_, i) => ({ week: '2026:3', entity: String(i) }));
  assert.equal(scorers.clusterFloor(oneSunday).met, false);
});

test('H1: 2025 outcomes are never graded (holdout, never opened)', () => {
  const f = gradeRow('fx_range@1').value.by_field['fx.range'];
  assert.ok(f.excluded.holdout_2025 >= 1, JSON.stringify(f.excluded));
  const week = gradeRow('fx_range@1', 'grade.week').value.by_field['fx.range'];
  assert.ok(!week.graded.some(g => g.entity_id.startsWith('9232:')));
  assert.deepEqual(Object.keys(f.labels), ['forward']);
});

test('RED (3): a stat correction re-grades the same prediction once', async () => {
  const before = gradeRow('fx_range@1', 'grade.week').value.by_field['fx.range'];
  const old = before.graded.find(g => g.entity_id.startsWith('9202:'));
  run(`UPDATE player_week_usage SET receiving_yards = receiving_yards + 30 WHERE player_id = 9202 AND season = 2026 AND week = 3`);
  const r = cursorsMod.runAdapterStream(outcomesMod.OUTCOMES_ADAPTER, { database: db });
  assert.equal(r.inserted, 2, 'the corrected line is a new event under each scoring key');
  await graderTick('2026-09-15T13:00:00.000Z');
  const after = gradeRow('fx_range@1', 'grade.week').value.by_field['fx.range'];
  assert.equal(after.n, before.n, 'still one grade per prediction');
  const now = after.graded.filter(g => g.entity_id.startsWith('9202:'));
  assert.equal(now.length, 1, 'exactly one grade for the corrected player-week');
  assert.notEqual(now[0].outcome_event_id, old.outcome_event_id, 're-graded against the corrected outcome');
  assert.equal(now[0].state_id, old.state_id, 'the same prediction');
  const count = row(`SELECT COUNT(*) AS n FROM engine_state WHERE producer = 'grader'`).n;
  await graderTick('2026-09-15T14:00:00.000Z');
  assert.equal(row(`SELECT COUNT(*) AS n FROM engine_state WHERE producer = 'grader'`).n, count,
    'no new outcome: no new grade rows');
});

/* ------------------------------------------------------------------ scorers */
test('RED (4): the quantile score matches the pinball closed form', () => {
  need(scorers, 'grade/scorers.js');
  const q = scorers.quantileScore([0.1, 0.5, 0.9], [2, 5, 9], 6);
  // rho_0.1(6-2)=0.1*4=0.4; rho_0.5(6-5)=0.5; rho_0.9(6-9)=(1-0.9)*3=0.3
  assert.ok(Math.abs(q.score - 1.2) < 1e-12, `score ${q.score}`);
  assert.ok(Math.abs(q.crps_approx - (2 * 1.2) / 3) < 1e-12, 'CRPS approximation = 2 x mean pinball');
  assert.ok(Math.abs(scorers.logLoss(0.8, 1) - (-Math.log(0.8))) < 1e-12);
  assert.ok(Math.abs(scorers.logLoss(0.8, 0) - (-Math.log(0.2))) < 1e-12);
  assert.ok(Math.abs(scorers.brier(0.8, 0) - 0.64) < 1e-12);
});

test('RED (5): gradeDecisions is reused unchanged', () => {
  need(scorers, 'grade/scorers.js');
  assert.equal(scorers.DECISION_SCORER, baselineGate.gradeDecisions, 'the same function, not a copy');
  const decisions = Array.from({ length: 12 }, (_, i) => ({ policy_id: `p${i % 4}`, baseline_id: `b${i % 3}`,
    season: 2026, week: 1 + (i % 4), policy_points: 10 + (i % 3), baseline_points: 9 + (i % 5) }));
  assert.deepEqual(scorers.scoreDecisions(decisions, { iterations: 200, seed: 3 }),
    baselineGate.gradeDecisions(decisions, { iterations: 200, seed: 3 }));
});

test('RED (7): PIT on a calibrated fixture is uniform (KS p > 0.05); a too-narrow one is not', () => {
  need(scorers, 'grade/scorers.js');
  let s = 12345;
  const u = () => { s = (s * 1103515245 + 12345) % 2147483648; return (s + 0.5) / 2147483648; };
  const normal = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  const ys = Array.from({ length: 600 }, () => 10 + 4 * normal());
  const good = ys.map(y => scorers.pitFromQuantiles(levels, dist(10, 4).values, y));
  const narrow = ys.map(y => scorers.pitFromQuantiles(levels, dist(10, 1.5).values, y));
  const g = scorers.ksUniform(good);
  const n = scorers.ksUniform(narrow);
  assert.ok(g.p > 0.05, `calibrated KS p ${g.p} (D ${g.d})`);
  assert.ok(n.p < 0.05, `too-narrow KS p ${n.p} (D ${n.d}) should reject`);
});
