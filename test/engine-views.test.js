/**
 * EA-03 (built as cloud unit EA-04): snapshots, views, status (ENGINE-SPECS.md EA-03 row;
 * ENGINE-ARCHITECTURE.md §2.7, §2.12, §3.5, §4.6; HEALTH-01b folded in).
 *
 * "RED (n)" names the row's acceptance checks:
 *   (1) two views at one snapshot id agree byte-for-byte on their shared rows;
 *   (2) a view at an older snapshot resolves that cut's versions and fallbacks;
 *   (3) HEALTH-01b: a failed field is served its fallback (fallback_used, reason) or
 *       "last good, N min old"; the failed value is never served;
 *   (4) freshness comes from engine_runs: an unchanged row recomputed 5 min ago reads ok;
 *   (5) every row carries a typed status, health, producer@version, as_of and reason chain;
 *   (6) one snapshot per Coach answer: a pinned session keeps its id after a newer publish;
 *   (7) GET /snapshot, /view, /status, /request/:id: shapes, typed absences, league checks;
 *   (8) HEALTH-01b grep: no client file but the engine hook reads an engine route;
 *   (9) FIX-257-1: /status carries the strip flag (GRIDIRON_ENGINE_STRIP via preview-mode.js)
 *       and one typed row per producer for the strip's sheet.
 * Fixtures only: leagues 91-92, fixture players 9201-9202, fixture teams AAA-BBB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-engine-views-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PROCESS_ROLE = 'test';
process.env.GRIDIRON_ENGINE_LOCK = path.join(temp, 'engine.lock');
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

/** A module that does not exist yet is an assertion failure, not a crash of the whole file. */
async function optionalImport(specifier) {
  try { return await import(specifier); } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  }
}
const registry = await import('../server/services/engine/registry.js');
const state = await import('../server/services/engine/state.js');
const fields = await import('../server/services/engine/fields.js');
const { publishSnapshot } = await import('../server/services/engine/daemon/snapshots.js');
const viewsMod = await optionalImport('../server/services/engine/views.js');
const statusMod = await optionalImport('../server/services/engine/status.js');
const routeMod = await import('../server/routes/engine.js');
const express = (await import('express')).default;
const need = (mod, name) => assert.ok(mod, `${name} does not exist: the snapshot/view layer is not built`);

/* ------------------------------------------------------------------ fixtures */
run(`INSERT INTO users (id, subject, display_name) VALUES (1, 'ev-1', 'ev-1'), (2, 'ev-2', 'ev-2')`);
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at, current_week)
     VALUES (91, 'espn', 'ev-91', 2026, 'Fixture A', '1', 10, 1, '{}', '2026-09-18 01:00:00', 3),
            (92, 'espn', 'ev-92', 2026, 'Fixture B', '1', 10, 1, '{}', '2026-09-18 01:00:00', 3)`);
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (91, 1, 'commissioner'), (92, 2, 'commissioner')`);

// The real view declarations read the EA-02 tiny producers' fields; the test stands in for
// those producers (same names, same entity types) so the rows exist without running a tick.
const CAL = registry.registerProducer({ name: 'calendar', active: '1', versions: { 1: {} }, fields: [
  { field: 'nfl.week', valueType: 'object', entityTypes: ['week'], maxAgeSec: 3600 },
  { field: 'game.cutoff', valueType: 'object', entityTypes: ['game'], maxAgeSec: 86400 },
] });
const LG = registry.registerProducer({ name: 'league', active: '1', versions: { 1: {} }, fields: [
  { field: 'league.week', valueType: 'object', entityTypes: ['league'], maxAgeSec: 3600 },
] });
// A fixture producer with a declared baseline (HEALTH-01b: every served field names one).
const FX = registry.registerProducer({ name: 'fx-proj', active: '2', versions: { 1: {}, 2: {} }, fields: [
  { field: 'fx.points', valueType: 'number', entityTypes: ['player'], maxAgeSec: 3600,
    checks: ['in_range:0:60'], fallbackField: 'fx.points_base' },
  { field: 'fx.lonely', valueType: 'number', entityTypes: ['player'], maxAgeSec: 3600, checks: ['in_range:0:60'] },
] });
const BASE = registry.registerProducer({ name: 'fx-base', active: '1', versions: { 1: {} }, fields: [
  { field: 'fx.points_base', valueType: 'number', entityTypes: ['player'], maxAgeSec: 86400 },
] });

const chain = { contributions: [] };
function put(writers, field, entityType, entityId, value, asOf, extra = {}) {
  const spec = registry.fieldSpec(field);
  const version = registry.producerSpec(spec.producer).active;
  return state.writeState({ entityType, entityId, field, value, asOf, writer: writers[field], producerVersion: version,
    reasonChain: chain, eventIds: [], ...extra }).id;
}
function runRow(producer, version, finishedAt, scopeKey = '') {
  return fields.recordRun({ producer, version, scopeKey, startedAt: finishedAt, finishedAt }, db);
}
/** fx-proj@1's rows, written while version 1 was active (raw SQL: this process declares 2 active). */
function putV1(entityId, value, asOf) {
  return Number(db.prepare(`INSERT INTO engine_state (entity_type, entity_id, league_id, field, value, as_of, producer,
      producer_version, lane, reason_chain, event_ids, health, run_id, written_at)
      VALUES ('player', ?, 0, 'fx.points', ?, ?, 'fx-proj', '1', 'live', ?, '[]', ?, NULL, ?) RETURNING id`)
    .get(entityId, JSON.stringify(value), asOf, JSON.stringify({ v: 2, additive: false, contributions: [] }),
      JSON.stringify({ status: 'ok', checks: [], inputs_health: 'ok' }), asOf).id);
}
const VERSIONS = { calendar: '1', league: '1', 'fx-proj': '2', 'fx-base': '1' };

const T0 = '2026-09-20T12:00:00.000Z';
const T1 = '2026-09-20T14:00:00.000Z';
put(CAL, 'nfl.week', 'week', '2026:3', { season: 2026, week: 3, phase: 'regular' }, T0);
put(CAL, 'game.cutoff', 'game', '2026:3:AAA', { kickoff: '2026-09-21T17:00:00Z' }, T0);
put(CAL, 'game.cutoff', 'game', '2026:3:BBB', { kickoff: '2026-09-21T20:25:00Z' }, T0);
put(LG, 'league.week', 'league', '91', { season: 2026, week: 3 }, T0, { leagueId: 91 });
put(LG, 'league.week', 'league', '92', { season: 2026, week: 3 }, T0, { leagueId: 92 });
put(BASE, 'fx.points_base', 'player', '9201', 11.5, T0);
put(BASE, 'fx.points_base', 'player', '9202', 7.5, T0);
fields.storeFieldSpec(registry.fieldSpec('fx.points'), registry.producerSpec('fx-proj'), db);
const v1Row = putV1('9201', 14, T0);
runRow('calendar', '1', T0); runRow('league', '1', T0, 'league:91'); runRow('league', '1', T0, 'league:92');
runRow('fx-base', '1', T0); runRow('fx-proj', '1', T0);
// Snapshot A: fx-proj@1 was active; nothing on its fallback.
const snapA = publishSnapshot({ leagueId: 0, versionSet: { ...VERSIONS, 'fx-proj': '1' }, season: 2026, nflWeek: 3, now: T0 }, db);

// fx-proj@2 goes active. 9201 fails its range check on the next tick; 9202 is fine.
put(FX, 'fx.points', 'player', '9201', 17.25, '2026-09-20T13:00:00.000Z');
put(FX, 'fx.points', 'player', '9201', 99, T1);      // fails in_range:0:60 -> written, never served
put(FX, 'fx.points', 'player', '9202', 8, T1);
put(FX, 'fx.lonely', 'player', '9201', 5, '2026-09-20T13:00:00.000Z');
put(FX, 'fx.lonely', 'player', '9201', 75, T1);      // failed, no fallback field: last good serves
put(FX, 'fx.lonely', 'player', '9202', 70, T1);      // failed, no fallback and no good row: unknown
runRow('fx-proj', '2', T1);
// The monitor (EA-05) stands in: league 92 serves fx.points on its baseline.
fields.setFallback({ field: 'fx.points', leagueId: 92, fallbackField: 'fx.points_base', reason: 'fixture: ours trails', n: 4,
  since: T1 }, db);
const snapB = publishSnapshot({ leagueId: 0, versionSet: VERSIONS, season: 2026, nflWeek: 3, now: T1 }, db);
const snap91 = publishSnapshot({ leagueId: 91, versionSet: VERSIONS, season: 2026, nflWeek: 3, now: T1 }, db);
const snap92 = publishSnapshot({ leagueId: 92, versionSet: VERSIONS, season: 2026, nflWeek: 3, now: T1 }, db);

const FX_VIEW = { name: 'fx_player', scope: 'global', rows: [
  { entity: 'player:9201', field: 'fx.points' }, { entity: 'player:9202', field: 'fx.points' },
  { entity: 'player:9201', field: 'fx.lonely' }, { entity: 'player:9202', field: 'fx.lonely' },
  { entity: 'player:9203', field: 'fx.points' }, { entity: 'player:9201', field: 'fx.not_registered' },
] };
const rowOf = (view, entity, field) => view.rows.find(r => `${r.entity_type}:${r.entity_id}` === entity && r.field === field);

/* --------------------------------------------------------------------- tests */
test('RED (1): two views at one snapshot id agree byte-for-byte on their shared rows', () => {
  need(viewsMod, 'server/services/engine/views.js');
  const { VIEWS, resolveView, snapshotById } = viewsMod;
  assert.ok(VIEWS.week && VIEWS.league_week, 'views.js declares the week and league_week views');
  for (const v of Object.values(VIEWS)) {
    assert.ok(Array.isArray(v.rows) && v.rows.length, `view ${v.name} is data: a list of rows`);
    for (const r of v.rows) assert.equal(typeof r.field, 'string', `view ${v.name} row ${JSON.stringify(r)} has a field`);
  }
  const s = snapshotById(snap91, db);
  const a = resolveView({ view: VIEWS.week, snapshot: s, leagueId: 91 }, db);
  const b = resolveView({ view: VIEWS.league_week, snapshot: s, leagueId: 91 }, db);
  assert.equal(a.snapshot_id, snap91); assert.equal(b.snapshot_id, snap91);
  const shared = a.rows.filter(ra => b.rows.some(rb => rb.entity_type === ra.entity_type && rb.entity_id === ra.entity_id
    && rb.field === ra.field));
  assert.ok(shared.length >= 1, 'the two views share nfl.week');
  for (const ra of shared) {
    const rb = b.rows.find(x => x.entity_type === ra.entity_type && x.entity_id === ra.entity_id && x.field === ra.field);
    assert.equal(JSON.stringify(ra), JSON.stringify(rb), `shared row ${ra.field} differs between views`);
  }
  // The week view enumerates the week's games at the cut.
  assert.deepEqual(a.rows.filter(r => r.field === 'game.cutoff').map(r => r.entity_id).sort(), ['2026:3:AAA', '2026:3:BBB']);
});

test('RED (2): a view at an older snapshot resolves that cut\'s versions and fallbacks', () => {
  need(viewsMod, 'server/services/engine/views.js');
  const { resolveView, snapshotById, VIEWS } = viewsMod;
  const old = resolveView({ view: FX_VIEW, snapshot: snapshotById(snapA, db), leagueId: null }, db);
  const r = rowOf(old, 'player:9201', 'fx.points');
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.value, 14); assert.equal(r.producer_version, '1'); assert.equal(r.state_id, v1Row);
  assert.equal(rowOf(old, 'player:9202', 'fx.points').status, 'unknown', 'a row written after the cut leaked into it');
  const now = resolveView({ view: FX_VIEW, snapshot: snapshotById(snapB, db), leagueId: null }, db);
  assert.equal(rowOf(now, 'player:9202', 'fx.points').value, 8);
  assert.equal(rowOf(now, 'player:9202', 'fx.points').producer_version, '2');

  // The version set, not the newest version, picks the row: a cut taken after fx-proj@2 wrote,
  // but recording fx-proj@1 as active, still serves @1's row (mutation M2).
  const pinnedV1 = publishSnapshot({ leagueId: 0, versionSet: { ...VERSIONS, 'fx-proj': '1' }, season: 2026, nflWeek: 3,
    now: T1 }, db);
  const v1 = resolveView({ view: FX_VIEW, snapshot: snapshotById(pinnedV1, db), leagueId: null }, db);
  assert.equal(rowOf(v1, 'player:9201', 'fx.points').value, 14);
  assert.equal(rowOf(v1, 'player:9201', 'fx.points').producer_version, '1');
  assert.equal(rowOf(v1, 'player:9202', 'fx.points').status, 'unknown', 'fx-proj@2 row served under a @1 version set');
  // The id cut, not the clock, bounds the rows: a same-version row written after the cut is invisible (M4).
  put(FX, 'fx.points', 'player', '9202', 9, '2026-09-20T13:30:00.000Z');
  assert.equal(rowOf(resolveView({ view: FX_VIEW, snapshot: snapshotById(snapB, db), leagueId: null }, db),
    'player:9202', 'fx.points').value, 8, 'a row written after the cut leaked into it');

  // League 92's snapshot recorded fx.points on its fallback; the global snapshot did not.
  const on = resolveView({ view: FX_VIEW, snapshot: snapshotById(snap92, db), leagueId: 92 }, db);
  const fb = rowOf(on, 'player:9202', 'fx.points');
  assert.equal(fb.status, 'fallback', JSON.stringify(fb)); assert.equal(fb.fallback_used, true);
  assert.equal(fb.fallback_field, 'fx.points_base'); assert.equal(fb.value, 7.5);
  assert.match(fb.reason, /ours trails/);
  // A fallback put in force later does not rewrite what an older snapshot served.
  fields.setFallback({ field: 'fx.points', leagueId: 0, fallbackField: 'fx.points_base', reason: 'fixture: later', since: T1 }, db);
  try {
    const again = resolveView({ view: FX_VIEW, snapshot: snapshotById(snapB, db), leagueId: null }, db);
    assert.equal(rowOf(again, 'player:9202', 'fx.points').status, 'ok', 'a later fallback leaked into an older snapshot');
    assert.equal(rowOf(again, 'player:9202', 'fx.points').value, 8);
  } finally {
    db.prepare(`DELETE FROM engine_fallback WHERE field = 'fx.points' AND league_id = 0`).run();
  }
});

test('RED (3): HEALTH-01b: a failed field serves its fallback or last good, never the failed value', () => {
  need(viewsMod, 'server/services/engine/views.js');
  const { resolveView, snapshotById } = viewsMod;
  const v = resolveView({ view: FX_VIEW, snapshot: snapshotById(snapB, db), leagueId: null }, db);
  const fb = rowOf(v, 'player:9201', 'fx.points');
  assert.equal(fb.status, 'fallback', JSON.stringify(fb));
  assert.equal(fb.fallback_used, true); assert.equal(fb.fallback_field, 'fx.points_base');
  assert.equal(fb.value, 11.5); assert.equal(fb.producer, 'fx-base');
  assert.match(fb.reason, /fx\.points failed/); assert.match(fb.reason, /in_range/);

  const lg = rowOf(v, 'player:9201', 'fx.lonely');
  assert.equal(lg.status, 'last_good', JSON.stringify(lg));
  assert.equal(lg.value, 5); assert.equal(lg.fallback_used, true);
  assert.equal(lg.age_min, 60, 'last good row is 60 min older than the snapshot');
  assert.match(lg.reason, /last good, 60 min old/);

  const none = rowOf(v, 'player:9202', 'fx.lonely');
  assert.equal(none.status, 'unknown'); assert.equal(none.value, null);
  assert.match(none.reason, /failed/);
  for (const row of v.rows) {
    assert.notEqual(row.value, 99, 'a failed value was served'); assert.notEqual(row.value, 75); assert.notEqual(row.value, 70);
    assert.notEqual(row.health?.status, 'failed', `row ${row.entity_id} ${row.field} served a failed health`);
  }
  assert.equal(rowOf(v, 'player:9201', 'fx.not_registered').reason, 'field_not_registered');
  assert.equal(rowOf(v, 'player:9203', 'fx.points').reason, 'no_row_at_snapshot');
});

test('RED (4): freshness comes from engine_runs: an unchanged row recomputed 5 min ago reads ok', () => {
  need(viewsMod, 'server/services/engine/views.js');
  const { resolveView, snapshotById } = viewsMod;
  // league.week for 91 was written at T0 (2 h before snap91) with max_age 1 h. No run since: stale.
  const stale = rowOf(resolveView({ view: viewsMod.VIEWS.league_week, snapshot: snapshotById(snap91, db), leagueId: 91 }, db),
    'league:91', 'league.week');
  assert.equal(stale.status, 'stale', JSON.stringify(stale));
  assert.equal(stale.age_min, 120);
  // The producer re-ran 5 min before a new snapshot and wrote nothing (the value was unchanged).
  const T2 = '2026-09-20T16:00:00.000Z';
  runRow('league', '1', '2026-09-20T15:55:00.000Z', 'league:91');
  const s = publishSnapshot({ leagueId: 91, versionSet: VERSIONS, season: 2026, nflWeek: 3, now: T2 }, db);
  const fresh = rowOf(resolveView({ view: viewsMod.VIEWS.league_week, snapshot: snapshotById(s, db), leagueId: 91 }, db),
    'league:91', 'league.week');
  assert.equal(fresh.status, 'ok', JSON.stringify(fresh));
  assert.equal(fresh.as_of, T0, 'the row itself is the unchanged one');
  assert.equal(fresh.fresh_at, '2026-09-20T15:55:00.000Z');
});

test('RED (5): every served row carries status, health, producer@version, as_of and its reason chain', () => {
  need(viewsMod, 'server/services/engine/views.js');
  need(statusMod, 'server/services/engine/status.js');
  const { resolveView, snapshotById } = viewsMod;
  const v = resolveView({ view: viewsMod.VIEWS.week, snapshot: snapshotById(snapB, db), leagueId: null }, db);
  for (const r of v.rows) {
    for (const k of ['entity_type', 'entity_id', 'league_id', 'field', 'status', 'reason', 'value', 'fallback_used',
      'producer', 'producer_version', 'as_of', 'health', 'reason_chain', 'fresh_at', 'state_id']) {
      assert.ok(k in r, `row ${r.field} lacks ${k}`);
    }
    assert.ok(statusMod.ROW_STATUSES.includes(r.status), `status ${r.status} is typed`);
  }
  assert.deepEqual([...statusMod.ROW_STATUSES].sort(),
    ['degraded', 'fallback', 'last_good', 'ok', 'stale', 'thin', 'unknown', 'zero']);
});

test('RED (6): one snapshot per Coach answer: a pinned session keeps its id after a newer publish', () => {
  need(viewsMod, 'server/services/engine/views.js');
  const session = viewsMod.pinSnapshot({ leagueId: 91 }, db);
  const first = session.view('league_week');
  const newer = publishSnapshot({ leagueId: 91, versionSet: VERSIONS, season: 2026, nflWeek: 3,
    now: '2026-09-20T17:00:00.000Z' }, db);
  const second = session.view('week');
  assert.ok(newer > session.snapshot.id);
  assert.equal(first.snapshot_id, session.snapshot.id); assert.equal(second.snapshot_id, session.snapshot.id);
  assert.equal(viewsMod.pinSnapshot({ leagueId: 91 }, db).snapshot.id, newer, 'a new answer pins the newest');
  assert.throws(() => session.view('no_such_view'), /unknown view/);
  // A snapshot with no NFL week cannot fill a week template: the row says so, typed; it never reads
  // week "null" and the view does not fail (M11). Published earlier than any league-91 test reads.
  const weekless = viewsMod.pinSnapshot({ leagueId: 91, snapshotId: publishSnapshot({ leagueId: 91, versionSet: VERSIONS,
    now: '2026-09-20T17:30:00.000Z' }, db) }, db).view('league_week');
  const nw = weekless.rows.find(r => r.field === 'nfl.week');
  assert.equal(nw.status, 'unknown'); assert.match(nw.reason, /has no season/); assert.equal(nw.value, null);
  assert.equal(weekless.rows.find(r => r.field === 'league.week').status, 'stale', 'the rows it can fill still resolve');
  // The next tick knows the week again (and is the newest league-91 snapshot for RED (7)).
  publishSnapshot({ leagueId: 91, versionSet: VERSIONS, season: 2026, nflWeek: 3, now: '2026-09-20T18:00:00.000Z' }, db);
});

test('RED (7): GET /snapshot, /view, /status and /request/:id', async () => {
  need(viewsMod, 'server/services/engine/views.js');
  need(statusMod, 'server/services/engine/status.js');
  run(`INSERT INTO sync_log (job, last_run_at, last_status, last_detail, runs, consecutive_failures)
       VALUES ('engine_daemon', ?, 'ok', '{}', 3, 0)`, new Date(Date.now() - 50 * 60000).toISOString());
  run(`INSERT INTO engine_cursors (producer, version, source, watermark, updated_at)
       VALUES ('adapters', '1', 'injury_reports', '2026-09-20T11:00:00Z', '2026-09-20T11:05:00Z')`);
  run(`INSERT INTO engine_requests (kind, params_hash, params_json, snapshot_id, requested_by, requested_at, done_at, error)
       VALUES ('rescore', 'abc', '{}', ?, 1, '2026-09-20T12:00:00Z', '2026-09-20T12:00:02Z', NULL)`, snap91);
  let user = 1;
  const app = express();
  app.use((req, _res, next) => { req.auth = { userId: user }; next(); });
  app.use('/api/engine', routeMod.default);
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/engine`;
  const get = async p => { const res = await fetch(`${base}${p}`); return { code: res.status, body: await res.json() }; };
  try {
    const snap = await get('/snapshot?league_id=91');
    assert.equal(snap.code, 200, JSON.stringify(snap.body));
    assert.equal(snap.body.status, 'ok');
    const s = snap.body.snapshot;
    assert.ok(s.id > snap91, 'the latest snapshot for the league');
    assert.equal(s.league_id, 91);
    for (const k of ['max_event_id', 'max_state_id']) assert.equal(typeof s.cut[k], 'number');
    assert.deepEqual(s.version_set, VERSIONS);
    assert.equal(typeof s.world, 'string'); assert.equal(typeof s.age_sec, 'number');
    assert.equal((await get('/snapshot')).body.snapshot.league_id, 0, 'no league_id = the global snapshot');
    assert.equal((await get('/snapshot?league_id=abc')).code, 400);

    const view = await get(`/view?view=league_week&league_id=91&snapshot_id=${s.id}`);
    assert.equal(view.code, 200, JSON.stringify(view.body));
    assert.equal(view.body.snapshot_id, s.id); assert.equal(view.body.view, 'league_week');
    assert.ok(view.body.rows.length >= 2);
    assert.equal((await get('/view?view=league_week&league_id=91')).code, 400, 'snapshot_id is required');
    assert.equal((await get(`/view?view=nope&league_id=91&snapshot_id=${s.id}`)).code, 404);
    assert.equal((await get(`/view?view=league_week&league_id=92&snapshot_id=${s.id}`)).code, 403, 'not a member of 92');
    user = 2;
    assert.equal((await get(`/view?view=league_week&league_id=92&snapshot_id=${s.id}`)).code, 400,
      'a snapshot of league 91 read as league 92');
    assert.equal((await get(`/view?view=league_week&snapshot_id=${snapB}`)).code, 400, 'a league view needs league_id');
    assert.equal((await get(`/snapshot?league_id=91`)).code, 403);
    user = 1;
    assert.equal((await get(`/view?view=week&snapshot_id=${snapB}`)).code, 200, 'a global view at a global snapshot');

    const st = await get('/status');
    assert.equal(st.code, 200);
    assert.equal(st.body.daemon.status, 'stale', 'a heartbeat 50 min old is stale');
    assert.ok(st.body.daemon.age_sec >= 50 * 60 - 5);
    assert.equal(st.body.lock.status, 'unknown', 'no engine.lock file: no holder');
    assert.ok(st.body.sources.some(x => x.source === 'injury_reports' && x.watermark));
    const fbProducer = st.body.producers.find(p => p.producer === 'fx-proj');
    assert.ok(fbProducer, JSON.stringify(st.body.producers));
    assert.deepEqual(fbProducer.fallbacks.map(f => [f.field, f.fallback_field, f.league_id, f.reason]),
      [['fx.points', 'fx.points_base', 92, 'fixture: ours trails']]);
    assert.equal(st.body.jev.status, 'unknown'); assert.match(st.body.jev.reason, /Jev not live/);
    assert.equal(st.body.producers.find(p => p.producer === 'fx-proj').version, '2');

    const req = await get('/request/1');
    assert.equal(req.code, 200); assert.equal(req.body.kind, 'rescore'); assert.equal(req.body.status, 'done');
    assert.equal((await get('/request/999')).code, 404);
    user = 2;
    assert.equal((await get('/request/1')).code, 404, 'another user\'s request is not visible');
    user = 1;
    assert.equal((await fetch(`${base}/view`, { method: 'POST' })).status, 404, 'the view API is read-only');
  } finally {
    server.close();
  }
});

test('RED (8): HEALTH-01b grep: only the engine hook reads engine routes on the client', () => {
  const hits = [];
  const walk = dir => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && /['"`]\/(api\/)?engine\//.test(read(p))) hits.push(p);
    }
  };
  walk('client/src');
  assert.deepEqual(hits, [path.join('client', 'src', 'engine', 'useEngineView.ts')]);
  // Nothing under routes/ reaches the daemon's code (the web process only reads).
  assert.doesNotMatch(read('server/routes/engine.js'), /from '[^']*engine\/daemon\//);
  need(viewsMod, 'server/services/engine/views.js');
  assert.doesNotMatch(read('server/services/engine/views.js'), /from '[^']*daemon\//);
  assert.doesNotMatch(read('server/services/engine/status.js'), /from '[^']*daemon\//);
});

/* RULINGS 3: ONE last-good rule. The views read state.js#readServed (#250), pinned to the snapshot. */
test('RULINGS 3: views use the engine spine\'s fallback rule, pinned to the snapshot cut and versions', () => {
  need(viewsMod, 'server/services/engine/views.js');
  const { resolveView, snapshotById } = viewsMod;
  const T2 = '2026-09-20T16:00:00.000Z';
  const T3 = '2026-09-20T17:00:00.000Z';
  // 9301: an ok row, then a degraded one. #250's rule: degraded is served its last healthy row.
  put(FX, 'fx.lonely', 'player', '9301', 4, '2026-09-20T15:00:00.000Z');
  put(FX, 'fx.lonely', 'player', '9301', 6, T2, { inputsHealth: 'degraded' });
  // 9302: degraded with nothing healthy before it: served as itself, labelled degraded.
  put(FX, 'fx.lonely', 'player', '9302', 3, T2, { inputsHealth: 'degraded' });
  // 9303: failed at the cut; its only good row is written AFTER the snapshot, so it is not served.
  put(FX, 'fx.lonely', 'player', '9303', 80, T2);
  runRow('fx-proj', '2', T2);
  const snapC = publishSnapshot({ leagueId: 0, versionSet: VERSIONS, season: 2026, nflWeek: 3, now: T2 }, db);
  put(FX, 'fx.lonely', 'player', '9303', 9, T3);
  const view = { name: 'fx_r3', scope: 'global', rows: ['9301', '9302', '9303'].map(id => ({ entity: `player:${id}`, field: 'fx.lonely' })) };
  const v = resolveView({ view, snapshot: snapshotById(snapC, db), leagueId: null }, db);

  const lg = rowOf(v, 'player:9301', 'fx.lonely');
  assert.equal(lg.status, 'last_good', JSON.stringify(lg));
  assert.equal(lg.value, 4); assert.equal(lg.fallback_used, true);
  assert.match(lg.reason, /degraded/); assert.match(lg.reason, /last good, 60 min old/);

  const dg = rowOf(v, 'player:9302', 'fx.lonely');
  assert.equal(dg.status, 'degraded', JSON.stringify(dg));
  assert.equal(dg.value, 3); assert.equal(dg.fallback_used, false);

  const cut = rowOf(v, 'player:9303', 'fx.lonely');
  assert.equal(cut.status, 'unknown', 'a good row after the cut is not the last good at the snapshot');
  assert.equal(cut.value, null); assert.match(cut.reason, /failed/);

  // An older snapshot's version pin holds for the last good row too: at snapshot A (fx-proj@1)
  // fx.lonely has no v1 row at all, so nothing of v2 leaks back.
  const old = resolveView({ view, snapshot: snapshotById(snapA, db), leagueId: null }, db);
  for (const r of old.rows) assert.equal(r.value, null, `${r.entity_id} at snapshot A`);
});

test('RULINGS 3: views.js has no last-good query of its own', () => {
  const src = fs.readFileSync(new URL('../server/services/engine/views.js', import.meta.url), 'utf8');
  assert.match(src, /readServed\(/, 'views read the spine\'s rule');
  assert.doesNotMatch(src, /okOnly|includeFailed:\s*true/, 'no second copy of the last-good query');
});

test('RED (9) FIX-257-1: /status carries the strip flag and a typed row per producer', async () => {
  need(statusMod, 'server/services/engine/status.js');
  // calendar: its newest run failed after its last good one. fx-idle: registered, never ran.
  fields.recordRun({ producer: 'calendar', version: '1', startedAt: T1, finishedAt: T1, error: 'fixture: feed 500' }, db);
  run(`INSERT INTO engine_producers (producer, version, params_hash, fields, inputs, status, registered_at)
       VALUES ('fx-idle', '1', 'h', '[]', '{}', 'active', ?)`, T0);
  const app = express();
  app.use((req, _res, next) => { req.auth = { userId: 1 }; next(); });
  app.use('/api/engine', routeMod.default);
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/engine/status`;
  const saved = { strip: process.env.GRIDIRON_ENGINE_STRIP, preview: process.env.GRIDIRON_PREVIEW_UNCONFIRMED };
  try {
    delete process.env.GRIDIRON_ENGINE_STRIP; delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
    const off = await (await fetch(url)).json();
    assert.equal(off.strip?.enabled, false, JSON.stringify(off.strip));
    assert.match(off.strip.reason, /GRIDIRON_ENGINE_STRIP=1/);
    assert.ok(off.daemon && Array.isArray(off.producers), 'the status itself is still served with the strip off');
    process.env.GRIDIRON_ENGINE_STRIP = '1';
    const on = await (await fetch(url)).json();
    assert.deepEqual(on.strip, { enabled: true });
    delete process.env.GRIDIRON_ENGINE_STRIP;
    process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
    const pv = await (await fetch(url)).json();
    assert.equal(pv.strip.enabled, true); assert.equal(pv.strip.preview, true);

    const by = Object.fromEntries(on.producers.map(p => [p.producer, p]));
    const HEALTH = ['ok', 'fallback', 'error', 'unknown'];
    for (const p of on.producers) {
      assert.ok(HEALTH.includes(p.health), `${p.producer} health ${p.health} is typed`);
      assert.ok('reason' in p && 'age_sec' in p, `${p.producer} carries reason and age_sec`);
    }
    assert.equal(by['fx-proj'].health, 'fallback'); assert.match(by['fx-proj'].reason, /fx\.points/);
    assert.equal(by.calendar.health, 'error'); assert.match(by.calendar.reason, /feed 500/);
    assert.equal(by['fx-idle'].health, 'unknown'); assert.equal(by['fx-idle'].age_sec, null);
    assert.match(by['fx-idle'].reason, /never run/);
    assert.equal(by['fx-base'].health, 'ok'); assert.equal(by['fx-base'].reason, null);
    assert.equal(typeof by['fx-base'].age_sec, 'number');
  } finally {
    server.close();
    for (const [k, v] of [['GRIDIRON_ENGINE_STRIP', saved.strip], ['GRIDIRON_PREVIEW_UNCONFIRMED', saved.preview]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
