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
 * PR #259 fixes (bottom of the file): the missing EA-04 adapters (A4) league.settings,
 * (A5) league.matchup_result, (A6) market.player_value; decision vs luck, point in time
 * (D1)-(D2); matchup grading (D3); check-promotion and the grade report (P1)-(P4).
 * Fixtures only: leagues 91-92, players 9201-9232, teams AAA-FFF. Tests share one database
 * and run in file order.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
const leagueAdapters = await optionalImport('../server/services/engine/adapters/league.js');
const marketAdapters = await optionalImport('../server/services/engine/adapters/market.js');
const promotion = await optionalImport('../scripts/check-promotion.mjs');
const gradeReport = await optionalImport('../scripts/engine-grade-report.mjs');
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

/* ================================================================== EA-04 completion (PR #259 fixes)
 * (A4) league.settings, (A5) league.matchup_result, (A6) market.player_value: events with as_of
 * and natural keys, and for each the point-in-time rule: a row written after a decision time
 * is never used for that decision.
 * (D1)-(D3) decision vs luck, point in time (ENGINE-ARCHITECTURE §7.3), and matchup grading.
 * (P1)-(P4) scripts/engine-grade-report.mjs and scripts/check-promotion.mjs (§6.2-6.3), grade.* only.
 */
const eventsOf = (type, where = '', ...p) => rows(`SELECT id, league_id, natural_key, as_of, as_of_quality, payload
  FROM engine_events WHERE event_type = ? ${where} ORDER BY id`, type, ...p).map(r => ({ ...r, payload: JSON.parse(r.payload) }));
const latestBy = list => { const m = new Map(); for (const e of list) m.set(e.natural_key, e); return m; };

test('A4: league.settings is one event per league per change (format, scoring key, trade rules); no names, no cookies', () => {
  need(leagueAdapters, 'adapters/league.js');
  at('2026-09-15T12:00:00.000Z');
  const payload = JSON.stringify({ settings: { tradeSettings: { deadlineDate: Date.parse('2026-11-20T17:00:00.000Z'), vetoVotesRequired: 4 },
    scheduleSettings: { playoffTeamCount: 6, matchupPeriodCount: 14 } } });
  run(`UPDATE leagues SET name = 'fx-league-name', espn_s2 = 'fx-cookie-value', swid = 'fx-swid-value', team_count = 12,
         payload = ?, fetched_at = '2026-09-10T00:00:00.000Z' WHERE id = 91`, payload);
  run(`UPDATE leagues SET team_count = 12, fetched_at = '2026-09-10T00:00:00.000Z' WHERE id = 92`);
  const r = cursorsMod.runAdapterStream(leagueAdapters.LEAGUE_SETTINGS_ADAPTER, { database: db });
  assert.equal(r.table_state, 'present');
  const evs = eventsOf('league.settings');
  assert.equal(evs.length, 2, 'one event per league');
  const s91 = evs.find(e => e.league_id === 91);
  assert.equal(s91.natural_key, 'league:91:settings');
  assert.equal(s91.as_of, '2026-09-10T00:00:00.000Z', 'as_of is the capture that saw the settings');
  assert.equal(s91.payload.format_key, 'rd_sf1_t12_ppr1');
  assert.equal(s91.payload.scoring_key, PPR_KEY, 'the same scoring key outcome.player_week uses');
  assert.equal(s91.payload.trade_deadline, '2026-11-20T17:00:00.000Z');
  assert.equal(s91.payload.veto_votes_required, 4);
  assert.equal(s91.payload.playoff_team_count, 6);
  const raw = JSON.stringify(evs.map(e => e.payload));
  for (const bad of ['fx-league-name', 'fx-cookie-value', 'fx-swid-value']) assert.ok(!raw.includes(bad), `${bad} must not reach the log`);
  assert.equal(cursorsMod.runAdapterStream(leagueAdapters.LEAGUE_SETTINGS_ADAPTER, { database: db, sweep: true }).inserted, 0,
    'unchanged settings append nothing');
  // A change captured on 09-14: after the offer's decision time (09-12), so never used for it (D1).
  run(`UPDATE leagues SET team_count = 10, fetched_at = '2026-09-14T00:00:00.000Z' WHERE id = 91`);
  assert.equal(cursorsMod.runAdapterStream(leagueAdapters.LEAGUE_SETTINGS_ADAPTER, { database: db }).inserted, 1);
  const now91 = latestBy(eventsOf('league.settings', 'AND league_id = 91')).get('league:91:settings');
  assert.equal(now91.payload.format_key, 'rd_sf1_t10_ppr1');
  assert.equal(now91.as_of, '2026-09-14T00:00:00.000Z');
});

test('A5: league.matchup_result is one event per matchup, final weeks only, as_of the week end', () => {
  need(leagueAdapters, 'adapters/league.js');
  at('2026-09-15T12:00:00.000Z');
  const ins = (week, roster, pts, opp, captured) => run(`INSERT INTO league_week_scores (league_id, season, week, roster_id, points,
    opponent_roster_id, is_playoff, captured_at) VALUES (91, 2026, ?, ?, ?, ?, 0, ?)`, week, roster, pts, opp, captured);
  for (const [roster, pts, opp] of [['1', 101.5, '2'], ['2', 99, '1'], ['3', 80, '4'], ['4', 90.25, '3'], ['5', 70, null]]) {
    ins(3, roster, pts, opp, '2026-09-15T08:00:00.000Z');
  }
  ins(4, '1', 12, '2', '2026-09-15T08:00:00.000Z'); // week 4 (game day 09-20) is not over: partial points
  ins(4, '2', 3, '1', '2026-09-15T08:00:00.000Z');
  const r = cursorsMod.runAdapterStream(leagueAdapters.MATCHUP_RESULT_ADAPTER, { database: db });
  assert.equal(r.table_state, 'present');
  const evs = eventsOf('league.matchup_result');
  assert.deepEqual(evs.map(e => e.natural_key).sort(), ['matchup:91:2026:3:1:2', 'matchup:91:2026:3:3:4'],
    'one per matchup (not per roster), no bye, nothing from the unfinished week');
  const m12 = evs.find(e => e.natural_key.endsWith(':1:2'));
  assert.equal(m12.as_of, '2026-09-14T03:59:59.999Z', 'the end of the week\'s last game day, Eastern');
  assert.equal(m12.as_of_quality, 'date_only');
  assert.deepEqual({ a: m12.payload.team_a, b: m12.payload.team_b, pa: m12.payload.points_a, pb: m12.payload.points_b,
    w: m12.payload.winner }, { a: '1', b: '2', pa: 101.5, pb: 99, w: '1' });
  assert.equal(m12.payload.decision_time, KICKOFF, 'the week\'s first kickoff: the decision time of a matchup call');
  assert.equal(evs.find(e => e.natural_key.endsWith(':3:4')).payload.winner, '4');
  const ents = rows(`SELECT entity_type, entity_id FROM engine_event_entities WHERE event_id = ? ORDER BY entity_id`, m12.id)
    .map(e => `${e.entity_type}:${e.entity_id}`);
  for (const e of ['league:91', 'league_team:91:1', 'league_team:91:2']) assert.ok(ents.includes(e), `${e} in ${ents}`);
  // A score correction is a new event; the unchanged matchup appends nothing.
  run(`UPDATE league_week_scores SET points = 92, captured_at = '2026-09-15T09:00:00.000Z' WHERE week = 3 AND roster_id = '4'`);
  assert.equal(cursorsMod.runAdapterStream(leagueAdapters.MATCHUP_RESULT_ADAPTER, { database: db }).inserted, 1);
});

test('A6: market.player_value is one event per (format, player) per value change, as_of the fetch that saw it', () => {
  need(marketAdapters, 'adapters/market.js');
  at('2026-09-15T12:00:00.000Z');
  const F = 'rd_sf1_t12_ppr1';
  const ins = (pid, value, fetched) => run(`INSERT INTO dynasty_values (format_key, player_id, value, redraft_value, trend30, age,
    pos_rank, fetched_at) VALUES (?, ?, ?, ?, 0, 25, 10, ?)`, F, pid, value, value, fetched);
  ins(9201, 5000, '2026-09-11T00:00:00.000Z');
  ins(9202, 5600, '2026-09-11T00:00:00.000Z');
  ins(9203, 2000, '2026-09-11T00:00:00.000Z');
  ins(9204, 3000, '2026-09-13T00:00:00.000Z'); // first seen AFTER the second offer's decision time (D1)
  run(`INSERT INTO dynasty_values (format_key, player_id, value, redraft_value, fetched_at) VALUES ('rd_sf1_t10_ppr1', 9202, 7000, 7000,
    '2026-09-11T00:00:00.000Z')`);
  const r = cursorsMod.runAdapterStream(marketAdapters.MARKET_VALUE_ADAPTER, { database: db });
  assert.equal(r.table_state, 'present');
  const evs = eventsOf('market.player_value');
  assert.equal(evs.length, 5);
  const v = evs.find(e => e.natural_key === `${F}:9202`);
  assert.ok(v, 'natural key format:player');
  assert.equal(v.as_of, '2026-09-11T00:00:00.000Z');
  assert.deepEqual({ f: v.payload.format_key, p: v.payload.player_id, val: v.payload.value }, { f: F, p: 9202, val: 5600 });
  assert.ok(!('fetched_at' in v.payload), 'the fetch stamp is the as_of, not payload: a refetch of the same value is no change');
  run(`UPDATE dynasty_values SET fetched_at = '2026-09-12T00:00:00.000Z' WHERE player_id <> 9204`);
  assert.equal(cursorsMod.runAdapterStream(marketAdapters.MARKET_VALUE_ADAPTER, { database: db }).inserted, 0,
    'a refetch of unchanged values appends nothing');
  run(`UPDATE dynasty_values SET value = 9000, redraft_value = 9000, fetched_at = '2026-09-14T00:00:00.000Z'
       WHERE player_id = 9202 AND format_key = ?`, F);
  assert.equal(cursorsMod.runAdapterStream(marketAdapters.MARKET_VALUE_ADAPTER, { database: db }).inserted, 1);
  assert.equal(latestBy(eventsOf('market.player_value')).get(`${F}:9202`).as_of, '2026-09-14T00:00:00.000Z');
});

test('D1: an offer\'s decision grade uses only the settings and values in force at its decision time; luck is what moved after', async () => {
  need(graderMod, 'producers/grader.js');
  at('2026-09-15T15:00:00.000Z'); // a tick after RED (3)'s: a grader row's key includes its tick as_of
  run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json,
         proposed_at, model_p_accept, model_p_accept_low, model_p_accept_high, model_basis, status, idea_id, created_at)
       VALUES (91, 2026, 'app_proposed', '1', '3', '[9203]', '[9204]', '2026-09-12T20:00:00.000Z', 0.3, 0.1, 0.5,
         'heuristic_unanchored', 'proposed', 'fx-idea-3', '2026-09-12T20:00:00.000Z')`);
  cursorsMod.runAdapterStream(recMod.OFFER_ADAPTER, { database: db });
  const t = await graderTick('2026-09-15T15:00:00.000Z');
  assert.equal(t.failed.length, 0, JSON.stringify(t.failed));
  const g = gradeRow('offer.sent@app', 'grade.decision_luck');
  assert.ok(g, 'a grade.decision_luck row for offers');
  assert.equal(g.value.items.length, 1, JSON.stringify(g.value.excluded));
  const [first] = g.value.items;
  assert.equal(first.format_key, 'rd_sf1_t12_ppr1', 'the format in force at 09-12, not the 09-14 change (t10)');
  assert.equal(first.decision, 600, 'get 9202 (5600) minus give 9201 (5000), the values in force at proposed_at');
  assert.equal(first.realised, 4000, 'the same deal at the latest values (9202 moved to 9000 on 09-14)');
  assert.equal(first.luck, 3400);
  assert.equal(first.pit, null, 'no before-the-fact distribution logged for offers yet');
  assert.equal(g.value.excluded.no_value_in_force, 1, 'the second offer: 9204 was first valued after its decision time');
});

test('D2: a rec\'s decision is its before-the-fact forecast; luck is where the result fell (PIT); a later rewrite is never used', async () => {
  need(graderMod, 'producers/grader.js');
  at('2026-09-20T12:00:00.000Z');
  run(`INSERT INTO rec_ledger (league_id, kind, disposition, made_at, season, week, inputs_hash, predicted_json, horizon,
         graded_at, outcome_json, score)
       VALUES (91, 'trade', 'shown', '2026-09-12T10:00:00.000Z', 2026, 3, 'ghi',
         '{"delta_dist": {"levels": [0.1, 0.5, 0.9], "values": [-2, 1, 4]}}', 2, '2026-09-20T10:00:00.000Z', '{"weeks": [3, 4]}', 3)`);
  cursorsMod.runAdapterStream(recMod.REC_ADAPTER, { database: db });
  // Hindsight: the lineup rec's prediction is rewritten after it was made. The adapter logs it; the grader must not use it.
  run(`UPDATE rec_ledger SET predicted_json = '{"snapshot_id": 7, "delta": 0.5}' WHERE inputs_hash = 'abc'`);
  cursorsMod.runAdapterStream(recMod.REC_ADAPTER, { database: db, sweep: true });
  const lineupKey = rows(`SELECT natural_key FROM engine_events WHERE event_type = 'rec.shown' ORDER BY id`)[0].natural_key;
  assert.equal(eventsOf('rec.shown', 'AND natural_key = ?', lineupKey).length, 2, 'the rewrite is its own event');
  await graderTick('2026-09-20T12:00:00.000Z');
  const lineup = gradeRow('rec.lineup@shown', 'grade.decision_luck');
  assert.ok(lineup, 'grade.decision_luck for shown lineup recs');
  assert.equal(lineup.value.items[0].decision, 1.5, 'the forecast made at made_at, not the rewrite (0.5)');
  assert.equal(lineup.value.items[0].realised, 0.5);
  assert.equal(lineup.value.items[0].luck, -1);
  assert.equal(lineup.value.ignored.rewritten_after_decision, 1);
  const trade = gradeRow('rec.trade@shown', 'grade.decision_luck');
  assert.ok(trade, 'grade.decision_luck for shown trade recs');
  const it = trade.value.items[0];
  assert.equal(it.decision, 1, 'the median of the before-the-fact distribution');
  assert.equal(it.luck, 2);
  assert.ok(Math.abs(it.pit - (0.5 + 0.4 * (2 / 3))) < 1e-6, `PIT ${it.pit} (stored to 6 dp)`);
  assert.equal(trade.value.pit_ks.n, 1, 'PIT uniformity is checked per stream');
  assert.equal(gradeRow('rec.waiver@considered', 'grade.decision_luck'), null, 'an ungraded rec has no grade');
});

const WIN = registry.registerProducer({
  name: 'fx_win', active: '1', versions: { 1: {} },
  fields: [{ field: 'fx.win', valueType: 'prob', entityTypes: ['matchup'], description: 'fixture matchup win probability' }],
  inputs: { events: [], fields: [] },
});
const predictMatchup = (id, p) => writeState({ entityType: 'matchup', entityId: id, leagueId: 91, field: 'fx.win', value: p,
  asOf: new Date().toISOString(), writer: WIN['fx.win'], producerVersion: '1', reasonChain: chain }, db);

test('D3: a matchup probability is graded on league.matchup_result at the week\'s first kickoff; a later row is never graded', async () => {
  need(graderMod, 'producers/grader.js');
  graderMod.registerGraded('fx.win', { kind: 'prob', outcome: 'league.matchup_result' });
  at('2026-09-12T12:00:00.000Z');
  const a = predictMatchup('91:2026:3:1:2', 0.7).id;
  const b = predictMatchup('91:2026:3:3:4', 0.4).id;
  at('2026-09-13T18:00:00.000Z'); // after the first kickoff (17:00Z)
  const late = predictMatchup('91:2026:3:1:2', 0.99).id;
  at('2026-09-20T13:00:00.000Z');
  await graderTick('2026-09-20T13:00:00.000Z');
  const week = gradeRow('fx_win@1', 'grade.week')?.value?.by_field?.['fx.win'];
  assert.ok(week, 'grade.week for fx_win@1');
  assert.deepEqual(week.graded.map(g => g.state_id).sort((x, y) => x - y), [a, b]);
  assert.ok(!week.graded.some(g => g.state_id === late));
  const std = gradeRow('fx_win@1').value.by_field['fx.win'];
  // team_a wins 1v2 (p 0.7 -> y 1); team_b wins 3v4 (p 0.4 -> y 0)
  assert.ok(Math.abs(std.metrics.log_loss - (-Math.log(0.7) - Math.log(0.6)) / 2) < 1e-6, `log loss ${std.metrics.log_loss}`);
});

/* ------------------------------------------------------------------ promotion + the grade report */
const PROMO_PLAYERS = PLAYERS.slice(0, 25);
const PROMO_WEEKS = [[5, '2026-10-04'], [6, '2026-10-11'], [7, '2026-10-18'], [8, '2026-10-25']];
const PROMO = registry.registerProducer({
  name: 'fx_promo', active: '1', shadow: ['2'], versions: { 1: {}, 2: {} },
  fields: [{ field: 'fx.promo', valueType: 'dist', entityTypes: ['player_week_scored'], description: 'fixture promotion' }],
  inputs: { events: [], fields: [] },
});
const scriptsDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts');
const runScript = (name, args) => spawnSync(process.execPath, [path.join(scriptsDir, name), ...args], { encoding: 'utf8',
  env: { ...process.env, GRIDIRON_PROCESS_ROLE: 'script', NODE_OPTIONS: '' } });

test('P1: check-promotion refuses unless shadow beats active by the rule (floor in clusters, interval clear of 0, same outcomes, forward)', () => {
  need(promotion, 'scripts/check-promotion.mjs');
  const mk = (lane, over = {}) => ({ kind: 'dist', lane, n: 100, clusters: { weeks: 5, entities: 25 }, floor_met: true,
    labels: { forward: 100 }, outcomes_hash: 'h1', metrics: { quantile_score: 1 }, ...over });
  const good = mk('shadow', { vs_incumbent: { version: '1', n_pairs: 100, weeks: 5, delta_mean: -0.4,
    interval: { lo: -0.6, hi: -0.2, alpha: 0.05 } } });
  const active = mk('live');
  const ok = promotion.promotionVerdict({ field: 'fx', active, shadow: good });
  assert.equal(ok.promote, true, JSON.stringify(ok.reasons));
  const refuse = over => promotion.promotionVerdict({ field: 'fx', active, shadow: { ...good, ...over } });
  assert.equal(refuse({ floor_met: false, clusters: { weeks: 1, entities: 29 } }).promote, false, 'floor in clusters');
  assert.equal(refuse({ vs_incumbent: { ...good.vs_incumbent, interval: { lo: -0.6, hi: 0.01, alpha: 0.05 } } }).promote, false,
    'the interval must clear 0');
  assert.equal(refuse({ vs_incumbent: { ...good.vs_incumbent, delta_mean: 0.4, interval: { lo: 0.2, hi: 0.6, alpha: 0.05 } } }).promote,
    false, 'clear of 0 in the WRONG direction (shadow worse) refuses');
  assert.equal(refuse({ outcomes_hash: 'h2' }).promote, false, 'both lanes on the same outcomes');
  assert.equal(refuse({ labels: { forward: 60, test: 40 } }).promote, false, 'forward rows only');
  assert.equal(refuse({ vs_incumbent: undefined }).promote, false, 'no paired comparison, no promotion');
  assert.equal(promotion.promotionVerdict({ field: 'fx', active: null, shadow: good }).promote, false, 'no active row');
});

test('P2: on the grader fixture, fx_range@2 (shadow, worse, one Sunday) is refused: the script exits non-zero', () => {
  need(promotion, 'scripts/check-promotion.mjs');
  const r = runScript('check-promotion.mjs', ['--producer', 'fx_range', '--field', 'fx.range']);
  assert.equal(r.status, 1, `stdout ${r.stdout} stderr ${r.stderr}`);
  assert.match(r.stdout, /REFUSE/);
  assert.match(r.stdout, /floor/);
});

test('P3: a shadow that beats active over 4 weeks x 25 players passes; the script exits 0', async () => {
  need(promotion, 'scripts/check-promotion.mjs');
  for (const [week, day] of PROMO_WEEKS) {
    game(2026, week, 'AAA', 'BBB', day, true);
    PROMO_PLAYERS.forEach((pid, i) => usage(pid, 2026, week, 'AAA', 1 + ((i + week) % 6), 10 + ((7 * i + 3 * week) % 40)));
  }
  at('2026-10-28T12:00:00.000Z');
  cursorsMod.runAdapterStream(outcomesMod.OUTCOMES_ADAPTER, { database: db, sweep: true });
  at('2026-10-01T12:00:00.000Z');
  for (const [week] of PROMO_WEEKS) {
    for (const [i, pid] of PROMO_PLAYERS.entries()) {
      const pts = outcomeEvents().find(e => e.payload.player_id === pid && e.payload.week === week && e.payload.scoring_key === PPR_KEY)
        .payload.points;
      predict(PROMO['fx.promo'], 'fx.promo', '1', pid, 2026, week, PPR_KEY, dist(pts + 3 + (i % 3), 6));
      predict(PROMO['fx.promo'], 'fx.promo', '2', pid, 2026, week, PPR_KEY, dist(pts + (i % 2), 3));
    }
  }
  need(graderMod, 'producers/grader.js');
  graderMod.registerGraded('fx.promo', { kind: 'dist' });
  at('2026-10-28T12:00:00.000Z');
  const t = await graderTick('2026-10-28T12:00:00.000Z');
  assert.equal(t.failed.length, 0, JSON.stringify(t.failed));
  const s = gradeRow('fx_promo@2').value.by_field['fx.promo'];
  assert.equal(s.floor_met, true, JSON.stringify(s.clusters));
  assert.ok(s.vs_incumbent, 'the shadow row carries its paired comparison against the active version');
  assert.equal(s.vs_incumbent.version, '1');
  assert.equal(s.vs_incumbent.n_pairs, 100);
  assert.ok(s.vs_incumbent.interval.hi < 0, JSON.stringify(s.vs_incumbent));
  const r = runScript('check-promotion.mjs', ['--producer', 'fx_promo', '--field', 'fx.promo']);
  assert.equal(r.status, 0, `stdout ${r.stdout} stderr ${r.stderr}`);
  assert.match(r.stdout, /PROMOTE fx_promo@2/);
});

test('P4: engine-grade-report prints grade.season_to_date per producer@version, from grade rows only', () => {
  need(gradeReport, 'scripts/engine-grade-report.mjs');
  const list = gradeReport.readSeasonGrades(db);
  const names = list.map(r => r.entity);
  for (const e of ['fx_range@1', 'fx_range@2', 'fx_promo@1', 'fx_promo@2', 'fx_win@1']) assert.ok(names.includes(e), `${e} in ${names}`);
  const text = gradeReport.formatReport(list.filter(r => r.entity === 'fx_range@1'));
  assert.match(text, /fx_range@1\s+fx\.range\s+live/);
  assert.match(text, /n=29/);
  assert.match(text, /floor=no/);
  const r = runScript('engine-grade-report.mjs', ['--producer', 'fx_promo']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fx_promo@1/);
  assert.match(r.stdout, /fx_promo@2\s+fx\.promo\s+shadow/);
  assert.ok(!r.stdout.includes('fx_range'), '--producer filters');
});
