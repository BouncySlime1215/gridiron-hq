/**
 * ENGINE-00a + EA-00: the ONE ENGINE spine, schema v2 (ENGINE-ARCHITECTURE.md §2, §11.2).
 *
 * Every later engine stage reads `engine_events` / `engine_state` and writes only its own
 * fields. This file pins the contract those stages extend:
 *   1. `engine_events` is one append-only log stamped with valid time (`as_of` +
 *      `as_of_quality`), transaction time (`ingested_at`) and `provenance`; adapters
 *      dedupe by natural key (compare-latest), and every party is in
 *      `engine_event_entities`, with alias ids for unresolved players.
 *   2. `engine_state` rows carry `lane`, `health` and `run_id`; each field has exactly one
 *      producer, enforced by a runtime capability AND by a database trigger reading
 *      `engine_fields`.
 *   3. As-of reads never return a state row or an event stamped after asOf; a default read
 *      never returns a shadow row or a failed row.
 *   4. Reason chains are v2 and, when additive, sum in their declared space.
 *   5. GET /api/engine/state serves typed status (ok/zero/unknown/stale/fallback/thin/degraded),
 *      health and fresh_at, read-only, from specs stored in the database.
 *   6. Writes are refused unless the process role is engine, script or test.
 *
 * The tests named "RED (n)" are the EA-00 acceptance checks (ENGINE-SPECS.md EA-00 row).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-engine-spine-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.GRIDIRON_PROCESS_ROLE = 'test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const { db, run, row, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

/** A module that does not exist yet is an assertion failure, not a crash of the whole file. */
async function optionalImport(specifier) {
  try { return await import(specifier); } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  }
}
const registry = await optionalImport('../server/services/engine/registry.js');
const events = await optionalImport('../server/services/engine/events.js');
const state = await optionalImport('../server/services/engine/state.js');
const backfill = await optionalImport('../server/services/engine/backfill.js');
const health = await optionalImport('../server/services/engine/health.js');
const role = await optionalImport('../server/services/engine/role.js');
const fields = await optionalImport('../server/services/engine/fields.js');
const routeMod = await optionalImport('../server/routes/engine.js');
const migration = await import('../server/migrations/075_engine_spine.js');
const need = (mod, name) => assert.ok(mod, `${name} does not exist: the engine spine is not built`);

const express = (await import('express')).default;

/* ---------------------------------------------------------------- fixture */
run(`INSERT INTO users (id, subject, display_name) VALUES (1, 'eng-1', 'eng-1'), (2, 'eng-2', 'eng-2')`);
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at, current_week)
     VALUES (71, 'espn', 'eng-71', 2026, 'Fixture', '1', 10, 1, '{}', '2026-09-18 01:00:00', 3)`);
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (71, 1, 'commissioner')`);
run(`INSERT INTO players (id, name, position, espn_id, gsis_id) VALUES (9001, 'Fixture Back', 'RB', 555, '00-0099999')`);
run(`INSERT INTO players (id, name, position, espn_id) VALUES (9002, 'Fixture Two', 'WR', 556)`);

// Tables the app creates outside the migration chain; production DDL, verbatim.
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);
db.exec(`CREATE TABLE IF NOT EXISTS manager_signals (
  league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  roster_id TEXT NOT NULL, metric TEXT NOT NULL, value REAL, n INTEGER, source TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (league_id, roster_id, metric))`);

run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, proposed_at, processed_at, team_id,
       scoring_period, bid_amount, items_json, raw_json, first_seen_at, last_seen_at)
     VALUES (71, 2026, 'tx-1', 'WAIVER', 'EXECUTED', '2026-09-16T07:11:15.167Z', '2026-09-16T07:11:15.238Z', 4, 2, 3,
       '[{"playerId":555,"type":"ADD","fromTeamId":0,"toTeamId":4}]', '{"secret":"never copied"}',
       '2026-09-17T21:17:27.148Z', '2026-09-17T21:17:27.148Z')`);
// A PENDING waiver: ESPN's processed_at is the SCHEDULED run (the future), not an observation.
run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, is_pending, proposed_at, processed_at,
       team_id, scoring_period, items_json, first_seen_at, last_seen_at)
     VALUES (71, 2026, 'tx-pending', 'WAIVER', 'PENDING', 1, '2026-09-22T22:56:28.850Z', '2026-09-23T07:00:00.000Z', 4, 3,
       '[{"playerId":555,"type":"ADD"}]', '2026-09-22T23:10:45.557Z', '2026-09-22T23:10:45.557Z')`);
// A two-team, four-player trade: two players resolve to players.id, two do not yet (777, 778).
run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, proposed_at, processed_at, team_id,
       scoring_period, items_json, first_seen_at, last_seen_at)
     VALUES (71, 2026, 'tx-trade', 'TRADE_ACCEPT', 'EXECUTED', '2026-09-14T10:00:00.000Z', '2026-09-15T10:00:00.000Z', 4, 2,
       '[{"playerId":555,"type":"TRADE","fromTeamId":4,"toTeamId":6},{"playerId":556,"type":"TRADE","fromTeamId":4,"toTeamId":6},
         {"playerId":777,"type":"TRADE","fromTeamId":6,"toTeamId":4},{"playerId":778,"type":"TRADE","fromTeamId":6,"toTeamId":4}]',
       '2026-09-15T10:05:00.000Z', '2026-09-15T10:05:00.000Z')`);
// A decline: ESPN leaves processed_at null; the proposal time is NOT when the decline happened.
run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, proposed_at, processed_at, team_id,
       scoring_period, items_json, first_seen_at, last_seen_at)
     VALUES (71, 2026, 'tx-decline', 'TRADE_DECLINE', 'EXECUTED', '2026-09-10T10:00:00.000Z', NULL, 6, 2,
       '[]', '2026-09-12T08:00:00.000Z', '2026-09-12T08:00:00.000Z')`);
run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id, player_id,
       player_name, position, lineup_slot_id, lineup_slot, is_starter, on_roster, source, first_seen_at, changed_at,
       projected_points, actual_points)
     VALUES (71, 2026, 2, 4, 555, 9001, 'Fixture Back', 'RB', 2, 'RB', 1, 1, 'live',
       '2026-09-20T10:00:00.000Z', '2026-09-20T10:00:00.000Z', 12.5, 20.1)`);
run(`INSERT INTO news_items (date, headline, body, importance, source, published_at, ingested_at, entities_json)
     VALUES ('2026-09-19', 'Fixture Back limited', 'long body text', 3, 'fixture', '2026-09-19T15:00:00.000Z',
       '2026-09-19T15:30:00.000Z', '{"players":[{"id":9001,"name":"Fixture Back","confidence":1}],"teams":[]}')`);
// A source stamp later than our own receipt: clamped to ingest, the raw stamp kept.
run(`INSERT INTO news_items (date, headline, importance, source, published_at, ingested_at, entities_json)
     VALUES ('2026-09-19', 'Fixture late stamp', 2, 'fixture', '2026-09-19T21:00:00.000Z', '2026-09-19T16:00:00.000Z',
       '{"players":[],"teams":[]}')`);
run(`INSERT INTO game_lines (season, week, team, opponent, home, spread, total, implied_points, source, fetched_at)
     VALUES (2026, 3, 'AAA', 'BBB', 1, -3.5, 44.5, 24, 'fixture', '2026-09-18 12:00:00')`);
run(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status, practice_status,
       injury, modified_at) VALUES (2026, 3, '00-0099999', 'AAA', 'Fixture Back', 'RB', 'Questionable', 'Limited',
       'Ankle', '2026-09-19T20:00:00Z')`);
// Empty modified_at (every 2025-26 row today): an event stamped at capture time, `first_seen`, never dropped.
run(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status, practice_status,
       injury, modified_at) VALUES (2026, 3, '00-0099998', 'AAA', 'Fixture Other', 'WR', 'Out', 'DNP', 'Knee', NULL)`);
run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json,
       proposed_at, model_p_accept, model_basis, status, espn_tx_id, resolved_at, created_at)
     VALUES (71, 2026, 'observed', '4', '6', '[555]', '[777]', '2026-09-18T01:00:00.000Z', 0.31, 'heuristic_anchored', 'accepted', 'tx-9',
       '2026-09-19T01:00:00.000Z', '2026-09-19T02:00:00.000Z')`);
run(`INSERT INTO manager_signals (league_id, roster_id, metric, value, n, source, computed_at)
     VALUES (71, '4', 'chat_trade_talk', 0.21, 140, 'chat', '2026-09-20 09:00:00'),
            (71, '4', 'roster_size', 16, 1, 'roster', '2026-09-20 09:00:00')`);
run(`INSERT INTO sync_log (job, last_run_at, last_status, last_detail, runs)
     VALUES ('league_transactions', '2026-09-20T09:00:00.000Z', 'ok', 'free text never copied', 1)`);

const count = () => row('SELECT COUNT(*) AS n FROM engine_events').n;
const eventsFor = (entity, opts = {}) => events.getEvents({ asOf: '2026-12-31T00:00:00Z', entities: [entity], ...opts });

/* ------------------------------------------------------------------ schema */
test('migration 075 creates every engine table with the contract columns', () => {
  const files = fs.readdirSync(path.join(root, 'server/migrations'));
  assert.ok(files.some(f => /^075_engine_spine\.js$/.test(f)), 'no migration 075_engine_spine.js');
  const cols = t => rows(`PRAGMA table_info(${t})`).map(c => c.name);
  const want = {
    engine_events: ['id', 'event_type', 'as_of', 'as_of_quality', 'ingested_at', 'provenance', 'league_id', 'team_id',
      'player_id', 'source', 'natural_key', 'source_key', 'payload', 'schema_version'],
    engine_event_entities: ['event_id', 'entity_type', 'entity_id', 'role'],
    engine_state: ['id', 'entity_type', 'entity_id', 'league_id', 'field', 'value', 'as_of', 'producer',
      'producer_version', 'lane', 'reason_chain', 'event_ids', 'health', 'run_id', 'written_at'],
    engine_fields: ['field', 'producer', 'value_type', 'entity_types', 'max_age_sec', 'tolerance', 'fallback_field',
      'checks', 'replaces', 'space', 'description', 'updated_at'],
    engine_producers: ['producer', 'version', 'code_sha', 'params_hash', 'fit_ref', 'training_window', 'fields', 'inputs',
      'status', 'registered_at', 'prereg_ref'],
    engine_runs: ['id', 'tick_id', 'producer', 'version', 'lane', 'scope_key', 'input_cut_event_id', 'input_cut_state_id',
      'started_at', 'finished_at', 'ms', 'rows_written', 'rows_unchanged', 'error', 'dirty_reason', 'lease_until'],
    engine_cursors: ['producer', 'version', 'source', 'watermark', 'updated_at'],
    engine_fallback: ['field', 'league_id', 'fallback_field', 'since', 'reason', 'n'],
    engine_snapshots: ['id', 'league_id', 'tick_id', 'max_event_id', 'max_state_id', 'version_set', 'fallback_set',
      'season', 'nfl_week', 'world', 'created_at'],
    engine_requests: ['id', 'kind', 'params_hash', 'params_json', 'snapshot_id', 'requested_by', 'requested_at',
      'lease_until', 'started_at', 'done_at', 'result_state_id', 'error'],
  };
  for (const [t, cs] of Object.entries(want)) {
    for (const c of cs) assert.ok(cols(t).includes(c), `${t}.${c} missing`);
  }
  assert.ok(!cols('engine_state').includes('known_by'), 'engine_state has no known_by column (D1: the row id is the clock)');
  const notNullZero = t => rows(`PRAGMA table_info(${t})`).find(c => c.name === 'league_id');
  for (const t of ['engine_events', 'engine_state']) {
    assert.equal(notNullZero(t).notnull, 1, `${t}.league_id must be NOT NULL`);
    assert.equal(String(notNullZero(t).dflt_value), '0', `${t}.league_id must default to 0`);
  }
});

test('migration 075 aborts on a v1 engine_state (no lane) instead of silently keeping the old shape', () => {
  const v1 = new DatabaseSync(':memory:');
  v1.exec(`CREATE TABLE engine_state (id INTEGER PRIMARY KEY, entity_type TEXT, entity_id TEXT, field TEXT, value TEXT,
    as_of TEXT, producer TEXT, producer_version TEXT, reason_chain TEXT, event_ids TEXT, written_at TEXT)`);
  assert.throws(() => migration.up(v1), /lane/);
  v1.close();
  const fresh = new DatabaseSync(':memory:');
  migration.up(fresh);
  migration.up(fresh); // re-running on a v2 database is a no-op
  fresh.close();
});

test('engine_events, entities and engine_state are append-only at the database', () => {
  need(events, 'events.js'); need(state, 'state.js');
  registry.registerEventType('test.append_only', { description: 'fixture' });
  const [ev] = events.appendEvents([{ event_type: 'test.append_only', as_of: '2026-09-01T00:00:00Z',
    source: 'fixture', natural_key: 'ao-1', player_id: 9001, payload: { k: 1 } }]).events;
  assert.throws(() => run('UPDATE engine_events SET as_of = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', ev.id),
    /append-only/);
  assert.throws(() => run('DELETE FROM engine_events WHERE id = ?', ev.id), /append-only/);
  assert.throws(() => run('DELETE FROM engine_event_entities WHERE event_id = ?', ev.id), /append-only/);
  const writerAo = registry.registerField('test.append_only', { producer: 'producer-ao', version: '1', entityTypes: ['player'] });
  const { id } = state.writeState({ entityType: 'player', entityId: '9001', field: 'test.append_only', value: 1,
    asOf: '2026-09-01T00:00:00Z', writer: writerAo, producerVersion: '1', eventIds: [ev.id],
    reasonChain: { contributions: [] } });
  assert.throws(() => run('UPDATE engine_state SET producer = ? WHERE id = ?', 'x', id), /append-only/);
  assert.throws(() => run('DELETE FROM engine_state WHERE id = ?', id), /append-only/);
  // A field's producer cannot be changed in place either: a rename is a migration of the field.
  assert.throws(() => run(`UPDATE engine_fields SET producer = 'x' WHERE field = 'test.append_only'`), /producer/);
});

/* ------------------------------------------------------------- one writer */
test('one writer per field: a second producer cannot register or write a field', () => {
  need(registry, 'registry.js'); need(state, 'state.js');
  const writerA = registry.registerField('test.owned', { producer: 'producer-a', version: '1', entityTypes: ['player'] });
  // Same producer again does not throw (modules may be imported twice), but the writer
  // capability is handed out once, to the first registrant only.
  assert.equal(registry.registerField('test.owned', { producer: 'producer-a', version: '1', entityTypes: ['player'] }), null);
  assert.throws(() => registry.registerField('test.owned', { producer: 'producer-b', version: '1', entityTypes: ['player'] }),
    /test\.owned.*producer-a/);
  const writerOther = registry.registerField('test.owned_other', { producer: 'producer-a', version: '1', entityTypes: ['player'] });
  const base = { entityType: 'player', entityId: '9001', field: 'test.owned', value: 1, asOf: '2026-09-10T00:00:00Z',
    producerVersion: '1', reasonChain: { contributions: [] }, eventIds: [] };
  // A producer NAME is not a capability: the right label from the wrong module is refused.
  assert.throws(() => state.writeState({ ...base, producer: 'producer-a' }), /writer/i);
  assert.throws(() => state.writeState({ ...base, writer: { field: 'test.owned', producer: 'producer-a' } }), /one writer/i);
  assert.throws(() => state.writeState({ ...base, writer: writerOther }), /one writer/i);
  assert.throws(() => state.writeState({ ...base, field: 'test.never_registered', writer: writerA }), /not registered/);
  assert.throws(() => state.writeState({ ...base, writer: writerA, producerVersion: '9' }), /version/);
  state.writeState({ ...base, writer: writerA });
  assert.equal(row(`SELECT COUNT(*) AS n FROM engine_state WHERE field = 'test.owned'`).n, 1);
  assert.equal(row(`SELECT producer FROM engine_state WHERE field = 'test.owned'`).producer, 'producer-a');
  assert.equal(row(`SELECT producer FROM engine_fields WHERE field = 'test.owned'`).producer, 'producer-a',
    'the spec is stored in engine_fields so every process reads it');
  // The spine's own field: nobody outside backfill.js can write it, label or not.
  assert.throws(() => state.writeState({ entityType: 'engine', entityId: 'events', field: 'engine.ingest', value: { spoof: 1 },
    asOf: '2026-09-10T00:00:00Z', producer: 'engine-backfill', producerVersion: '1', eventIds: [],
    reasonChain: { contributions: [] } }), /writer/i);
  assert.equal(registry.registerField('engine.ingest', { producer: 'engine-backfill', version: '1', entityTypes: ['engine'] }), null,
    're-registering the spine field must not hand out its writer');
});

test('one writer per field, by grep: SQL writes live in one file each and every field is declared once', () => {
  const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (d.name === 'node_modules' ? [] : walk(path.join(dir, d.name)))
      : /\.(m?js)$/.test(d.name) ? [path.join(dir, d.name)] : []);
  const files = [...walk('server'), ...walk('scripts')];
  const hits = re => files.filter(f => re.test(read(f)));
  // Control: the grep finds a known writer, so an empty result below is not a broken grep.
  assert.ok(hits(/INSERT INTO dynasty_value_history/).length >= 1, 'control grep found nothing');
  assert.deepEqual(hits(/INSERT\s+(OR\s+\w+\s+)?INTO\s+engine_state\b/i), ['server/services/engine/state.js']);
  assert.deepEqual(hits(/INSERT\s+(OR\s+\w+\s+)?INTO\s+engine_events\b/i), ['server/services/engine/events.js']);
  assert.deepEqual(hits(/INSERT\s+(OR\s+\w+\s+)?INTO\s+engine_event_entities\b/i), ['server/services/engine/events.js']);
  assert.deepEqual(hits(/INSERT\s+(OR\s+\w+\s+)?INTO\s+engine_(fields|producers)\b/i), ['server/services/engine/fields.js']);
  assert.deepEqual(hits(/(UPDATE|DELETE\s+FROM)\s+engine_(state|events|event_entities)\b/i), [], 'something rewrites the log');
  const decl = new Map();
  const add = (field, where) => decl.set(field, [...(decl.get(field) ?? []), where]);
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/registerField\(\s*['"]([^'"]+)['"]\s*,\s*\{[^}]*producer:\s*['"]([^'"]+)['"]/g)) add(m[1], `${f}:${m[2]}`);
    for (const m of src.matchAll(/registerProducer\(\s*\{\s*name:\s*['"]([^'"]+)['"]([\s\S]*?)\n\}\);/g)) {
      for (const fm of m[2].matchAll(/\bfield:\s*['"]([^'"]+)['"]/g)) add(fm[1], `${f}:${m[1]}`);
    }
  }
  assert.ok(decl.has('engine.ingest'), 'the spine declares its own field engine.ingest');
  assert.deepEqual(decl.get('engine.ingest'), ['server/services/engine/backfill.js:engine-backfill'],
    'engine.ingest is declared by the module that writes it');
  for (const [field, where] of decl) assert.equal(where.length, 1, `${field} declared by ${where.join(', ')}`);
  // Every registerField call is one the regex above can see (a literal field name), so no
  // field is claimed out of the grep's sight.
  const calls = files.flatMap(f => [...read(f).matchAll(/registerField\(/g)].map(() => f))
    .filter(f => f !== 'server/services/engine/registry.js');
  const literal = files.flatMap(f => [...read(f).matchAll(/registerField\(\s*['"]/g)].map(() => f));
  assert.equal(calls.length, literal.length, `a registerField call without a literal field: ${calls.join(', ')}`);
  // The writer capability never leaves its module.
  assert.deepEqual(hits(/export\s+(const|let|var)\s+\w+\s*=\s*register(Field|Producer)\(/), [], 'a writer capability is exported');
  assert.deepEqual(hits(/export\s*\{[^}]*\b\w*WRITER\w*\b[^}]*\}/), [], 'a writer capability is re-exported');
});

/* ------------------------------------------------------------------ as-of */
test('as-of reads never return an event or a state row stamped after asOf', () => {
  need(events, 'events.js'); need(state, 'state.js');
  registry.registerEventType('test.asof', { description: 'fixture' });
  const writerAsof = registry.registerField('test.asof_field', { producer: 'producer-asof', version: '1', entityTypes: ['player'] });
  const { events: evs } = events.appendEvents([
    { event_type: 'test.asof', as_of: '2026-09-01T00:00:00Z', source: 'fixture', natural_key: 'asof-past', player_id: 9001, payload: { i: 1 } },
    { event_type: 'test.asof', as_of: '2026-09-03T00:00:00Z', source: 'fixture', natural_key: 'asof-future', player_id: 9001, payload: { i: 2 } },
  ]);
  const [past, future] = evs;
  const seen = events.getEvents({ asOf: '2026-09-02T00:00:00Z', playerId: 9001, types: ['test.asof'] });
  assert.deepEqual(seen.map(e => e.id), [past.id], 'the future event leaked into an as-of read');
  assert.throws(() => events.getEvents({ playerId: 9001 }), /asOf/, 'an as-of read with no asOf must refuse');

  const w = (asOf, ids, value) => state.writeState({ entityType: 'player', entityId: '9001', field: 'test.asof_field',
    value, asOf, writer: writerAsof, producerVersion: '1', eventIds: ids,
    reasonChain: { contributions: [{ source: 'fixture', event_ids: ids, delta: value, text: 'fixture' }] } });
  w('2026-09-01T12:00:00Z', [past.id], 1);
  w('2026-09-03T12:00:00Z', [past.id, future.id], 2);
  assert.equal(state.getState('player', '9001', 'test.asof_field', { asOf: '2026-09-02T00:00:00Z' }).value, 1);
  assert.equal(state.getState('player', '9001', 'test.asof_field', { asOf: '2026-09-04T00:00:00Z' }).value, 2);
  assert.equal(state.getState('player', '9001', 'test.asof_field', { asOf: '2026-08-01T00:00:00Z' }), null);
  // maxId is the transaction-time cut: a read at an older cut never sees a later row.
  const firstId = row(`SELECT MIN(id) AS id FROM engine_state WHERE field = 'test.asof_field'`).id;
  assert.equal(state.getState('player', '9001', 'test.asof_field', { asOf: '2026-09-04T00:00:00Z', maxId: firstId }).value, 1);
  // A global read (no league) never returns a league-scoped row, and a league read never returns another league's.
  state.writeState({ entityType: 'player', entityId: '9002', field: 'test.asof_field', leagueId: 71, value: 'league-only',
    asOf: '2026-09-01T12:00:00Z', writer: writerAsof, producerVersion: '1', eventIds: [],
    reasonChain: { contributions: [] } });
  assert.equal(state.getState('player', '9002', 'test.asof_field', { asOf: '2026-09-04T00:00:00Z' }), null,
    'a leagueId=null read returned a league row');
  assert.equal(state.getState('player', '9002', 'test.asof_field', { asOf: '2026-09-04T00:00:00Z', leagueId: 72 }), null);
  assert.equal(state.getState('player', '9002', 'test.asof_field', { asOf: '2026-09-04T00:00:00Z', leagueId: 71 }).value,
    'league-only');
  // A state row may not cite an event from its own future: that is how a leak gets in.
  assert.throws(() => w('2026-09-02T00:00:00Z', [future.id], 3), /future|after/i);
  assert.throws(() => w('2026-09-02T00:00:00Z', [987654], 3), /unknown event/i);
});

test('reason_chain is required; a legacy {contributions} chain is accepted as non-additive v2', () => {
  need(state, 'state.js');
  const writerR = registry.registerField('test.reason', { producer: 'producer-r', version: '1', entityTypes: ['player'] });
  const base = { entityType: 'player', entityId: '9001', field: 'test.reason', value: 1, asOf: '2026-09-10T00:00:00Z',
    writer: writerR, producerVersion: '1', eventIds: [] };
  assert.throws(() => state.writeState(base), /reason_chain/);
  assert.throws(() => state.writeState({ ...base, reasonChain: {} }), /contributions/);
  assert.throws(() => state.writeState({ ...base, reasonChain: { contributions: [{ source: 'x' }] } }), /event_ids/);
  assert.throws(() => state.writeState({ ...base, reasonChain: { contributions: [
    { source: 'x', event_ids: [123], delta: 1, text: 't' }] } }), /not in event_ids/);
  const out = state.writeState({ ...base, reasonChain: { contributions: [] } });
  const stored = JSON.parse(row('SELECT reason_chain FROM engine_state WHERE id = ?', out.id).reason_chain);
  assert.equal(stored.v, 2);
  assert.equal(stored.additive, false);
});

/* -------------------------------------------------------------- privacy */
test('no private text or cookie ever enters the log', () => {
  need(events, 'events.js');
  registry.registerEventType('test.private', { description: 'fixture' });
  for (const key of ['text', 'body', 'message', 'espn_s2', 'swid']) {
    assert.throws(() => events.appendEvents([{ event_type: 'test.private', as_of: '2026-09-01T00:00:00Z',
      source: 'fixture', natural_key: `p-${key}`, payload: { nested: { [key]: 'x' } } }]), /not allowed/);
  }
  assert.throws(() => events.appendEvents([{ event_type: 'test.unregistered', as_of: '2026-09-01T00:00:00Z',
    source: 'fixture', natural_key: 'u', payload: {} }]), /not registered/);
});

/* ---------------------------------------------------------------- backfill */
test('backfill copies every stream idempotently, with provenance, quality and payload.model', () => {
  need(backfill, 'backfill.js');
  const before = count();
  const first = backfill.backfillAll();
  const afterFirst = count();
  const second = backfill.backfillAll();
  assert.equal(count(), afterFirst, 'running the backfill twice added events');
  const streams = Object.fromEntries(first.streams.map(s => [s.stream, s]));
  for (const s of ['transactions', 'lineups', 'news', 'game_lines', 'injuries', 'trade_outcomes', 'manager_signals', 'coverage']) {
    assert.ok(streams[s], `no adapter for ${s}`);
    assert.ok(streams[s].inserted > 0, `${s}: 0 events from a fixture row`);
  }
  assert.equal(afterFirst - before, first.streams.reduce((a, s) => a + s.inserted, 0));
  assert.equal(second.streams.reduce((a, s) => a + s.inserted, 0), 0);
  assert.equal(row(`SELECT COUNT(*) AS n FROM engine_events WHERE source <> 'fixture' AND provenance <> 'reconstructed'`).n, 0,
    'everything the first backfill writes is provenance=reconstructed');

  const pending = row(`SELECT as_of, as_of_quality FROM engine_events WHERE natural_key = '71:2026:tx-pending:PENDING'`);
  assert.equal(pending.as_of, '2026-09-22T22:56:28.850Z',
    'a pending transaction is stamped at its proposal, not its scheduled processing time (its own future)');
  const tx = row(`SELECT * FROM engine_events WHERE natural_key = '71:2026:tx-1:EXECUTED'`);
  assert.equal(tx.as_of, '2026-09-16T07:11:15.238Z');
  assert.equal(tx.as_of_quality, 'exact');
  assert.equal(tx.league_id, 71); assert.equal(tx.team_id, '4');
  assert.ok(!tx.payload.includes('never copied'), 'raw_json copied into the log');
  const lineup = JSON.parse(row(`SELECT payload FROM engine_events WHERE event_type = 'league.lineup'`).payload);
  assert.equal(lineup.actual_points, undefined, 'a lineup event must not carry the game result');
  assert.equal(row(`SELECT as_of FROM engine_events WHERE event_type = 'league.lineup'`).as_of, '2026-09-20T10:00:00.000Z');
  assert.equal(row(`SELECT as_of FROM engine_events WHERE natural_key = '2026:3:00-0099999'`).as_of, '2026-09-19T20:00:00.000Z');
  const line = row(`SELECT * FROM engine_events WHERE event_type = 'market.game_line'`);
  assert.equal(line.as_of, '2026-09-18T12:00:00.000Z', 'SQLite datetime is normalised to ISO UTC');
  const trades = rows(`SELECT event_type, payload FROM engine_events WHERE source = 'trade_outcomes' ORDER BY as_of`);
  assert.deepEqual(trades.map(t => t.event_type), ['trade.proposed', 'trade.resolved']);
  const proposed = JSON.parse(trades[0].payload);
  assert.equal(proposed.model_p_accept, undefined, 'a model output sits under payload.model, not beside the facts');
  assert.equal(proposed.model.p_accept, 0.31);
  const stripped = events.getEvents({ asOf: '2026-12-31T00:00:00Z', types: ['trade.proposed'], stripModel: true });
  assert.equal(stripped[0].payload.model, undefined, 'stripModel removes model outputs for learners');
  const signals = rows(`SELECT * FROM engine_events WHERE event_type = 'manager.signal' ORDER BY natural_key`);
  assert.equal(signals.length, 2, 'every manager_signals source is a signal (counts only)');
  assert.deepEqual(signals.map(s => s.natural_key), ['71:4:chat_trade_talk:3', '71:4:roster_size:3'],
    'the scoring period is in the natural key');
  assert.equal(signals[0].as_of, '2026-09-20T09:00:00.000Z');
  const ingest = state.getState('engine', 'events', 'engine.ingest', { asOf: new Date().toISOString() });
  assert.ok(ingest, 'backfill wrote no engine.ingest row');
  assert.ok(ingest.value.streams.transactions.events >= 1);
  assert.ok(ingest.reason_chain.contributions.some(c => c.source === 'league_transactions_raw'));
  const runRow = row('SELECT * FROM engine_runs WHERE id = ?', ingest.run_id);
  assert.ok(runRow, 'engine.ingest does not cite the run that wrote it');
  assert.equal(runRow.producer, 'engine-backfill');
  assert.ok(runRow.input_cut_event_id == null || runRow.input_cut_event_id <= row('SELECT MAX(id) AS m FROM engine_events').m);
});

test('an absent source table is reported as table_absent, never as 0 events', () => {
  need(backfill, 'backfill.js');
  const out = backfill.backfillStream('transactions', { table: 'no_such_table_here' });
  assert.equal(out.table_state, 'table_absent');
  assert.equal(out.inserted, null);
});

/* ================================================================ RED (EA-00) */

test('RED (1): a shadow row is never returned by a default read, and a failed row never', () => {
  need(state, 'state.js');
  const W = registry.registerProducer({ name: 'producer-lanes',
    active: 'v1', versions: { v1: { params: { a: 1 } }, v2: { params: { a: 2 } } }, shadow: ['v2'],
    fields: [{ field: 'test.laned', valueType: 'number', entityTypes: ['player'], checks: ['no_nan'] }],
  });
  const base = { entityType: 'player', entityId: '9001', field: 'test.laned', writer: W['test.laned'], eventIds: [],
    reasonChain: { contributions: [] } };
  state.writeState({ ...base, value: 1, asOf: '2026-09-01T00:00:00Z', producerVersion: 'v1' });
  const sh = state.writeState({ ...base, value: 99, asOf: '2026-09-02T00:00:00Z', producerVersion: 'v2' });
  assert.equal(row('SELECT lane FROM engine_state WHERE id = ?', sh.id).lane, 'shadow', 'the lane comes from the version');
  assert.throws(() => state.writeState({ ...base, value: 2, asOf: '2026-09-03T00:00:00Z', producerVersion: 'v2', lane: 'live' }),
    /lane/, 'a producer cannot pick its own lane');
  assert.equal(state.getState('player', '9001', 'test.laned', { asOf: '2026-09-05T00:00:00Z' }).value, 1);
  assert.equal(state.getState('player', '9001', 'test.laned', { asOf: '2026-09-05T00:00:00Z', lane: 'shadow' }).value, 99);
  const bad = state.writeState({ ...base, value: Number.NaN, asOf: '2026-09-04T00:00:00Z', producerVersion: 'v1' });
  assert.equal(bad.health.status, 'failed');
  assert.equal(state.getState('player', '9001', 'test.laned', { asOf: '2026-09-05T00:00:00Z' }).value, 1,
    'a failed row was served');
  assert.equal(row(`SELECT status FROM engine_producers WHERE producer = 'producer-lanes' AND version = 'v2'`).status, 'shadow');
});

test('RED (2): a two-team, four-player trade is returned for every party; a gsis: alias resolves after mapping', () => {
  need(backfill, 'backfill.js');
  const tradeId = row(`SELECT id FROM engine_events WHERE natural_key = '71:2026:tx-trade:EXECUTED'`)?.id;
  assert.ok(tradeId, 'the trade was not ingested');
  for (const party of ['league_team:71:4', 'league_team:71:6', 'player:9001', 'player:9002', 'espn:777', 'espn:778']) {
    assert.ok(eventsFor(party).some(e => e.id === tradeId), `the trade is missing for ${party}`);
  }
  assert.ok(events.getEvents({ asOf: '2026-12-31T00:00:00Z', playerId: 9002 }).some(e => e.id === tradeId),
    'playerId reads go through the entity table, not the single player_id column');
  // 777 has no players.id yet; once mapped, a player: read reaches the event already written.
  assert.ok(!eventsFor('player:9777').some(e => e.id === tradeId));
  run(`INSERT INTO players (id, name, position, espn_id) VALUES (9777, 'Fixture Late', 'TE', 777)`);
  assert.ok(eventsFor('player:9777').some(e => e.id === tradeId), 'an espn: alias did not resolve after mapping');
  // The same for an injury whose gsis id had no players row at ingest.
  const inj = row(`SELECT id FROM engine_events WHERE natural_key = '2026:3:00-0099998'`).id;
  assert.ok(eventsFor('gsis:00-0099998').some(e => e.id === inj));
  assert.ok(!eventsFor('player:9998').some(e => e.id === inj));
  run(`INSERT INTO players (id, name, position, gsis_id) VALUES (9998, 'Fixture Other', 'WR', '00-0099998')`);
  assert.ok(eventsFor('player:9998').some(e => e.id === inj), 'a gsis: alias did not resolve after mapping');
});

test('RED (3): unchanged line re-capture appends 0 events, a move 1, and A -> B -> A three in all', () => {
  need(backfill, 'backfill.js');
  const lines = () => row(`SELECT COUNT(*) AS n FROM engine_events WHERE natural_key = '2026:3:AAA'`).n;
  assert.equal(lines(), 1);
  run(`UPDATE game_lines SET fetched_at = '2026-09-18 13:00:00' WHERE team = 'AAA'`);
  assert.equal(backfill.backfillStream('game_lines').inserted, 0, 'an unchanged re-capture appended an event');
  run(`UPDATE game_lines SET spread = -4.5, fetched_at = '2026-09-18 14:00:00' WHERE team = 'AAA'`);
  assert.equal(backfill.backfillStream('game_lines').inserted, 1);
  run(`UPDATE game_lines SET spread = -3.5, fetched_at = '2026-09-18 15:00:00' WHERE team = 'AAA'`);
  assert.equal(backfill.backfillStream('game_lines').inserted, 1, 'A -> B -> A dropped the second A');
  assert.equal(lines(), 3);
  assert.equal(backfill.backfillStream('game_lines').inserted, 0);
});

test('RED (4): a 2026 injury row with empty modified_at is one event stamped first_seen', () => {
  const ev = rows(`SELECT * FROM engine_events WHERE natural_key = '2026:3:00-0099998'`);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].as_of_quality, 'first_seen');
  assert.equal(ev[0].as_of, ev[0].ingested_at, 'stamped at capture time');
});

test('RED (5): a TRADE_DECLINE with null processed_at is stamped first_seen_at, not proposed_at', () => {
  const ev = row(`SELECT * FROM engine_events WHERE natural_key = '71:2026:tx-decline:EXECUTED'`);
  assert.ok(ev);
  assert.equal(ev.as_of, '2026-09-12T08:00:00.000Z');
  assert.equal(ev.as_of_quality, 'first_seen');
});

test('RED (6): a news stamp later than ingest is clamped and keeps source_as_of', () => {
  const ev = rows(`SELECT * FROM engine_events WHERE event_type = 'news.item'`)
    .find(e => JSON.parse(e.payload).headline === 'Fixture late stamp');
  assert.ok(ev);
  assert.equal(ev.as_of, '2026-09-19T16:00:00.000Z');
  assert.equal(ev.as_of_quality, 'clamped');
  assert.equal(JSON.parse(ev.payload).source_as_of, '2026-09-19T21:00:00.000Z');
  // The live-capture rule: anything stamped after this log received it is clamped to ingested_at.
  registry.registerEventType('test.clamp', { description: 'fixture' });
  const [c] = events.appendEvents([{ event_type: 'test.clamp', as_of: '2099-01-01T00:00:00Z', source: 'fixture',
    natural_key: 'clamp-1', payload: {} }]).events;
  assert.equal(c.as_of, c.ingested_at);
  assert.equal(c.as_of_quality, 'clamped');
  assert.equal(c.payload.source_as_of, '2099-01-01T00:00:00.000Z');
  // A bare date is the end of that day, Eastern.
  const [d] = events.appendEvents([{ event_type: 'test.clamp', as_of: '2026-09-10', source: 'fixture',
    natural_key: 'date-1', payload: {} }]).events;
  assert.equal(d.as_of, '2026-09-11T03:59:59.999Z');
  assert.equal(d.as_of_quality, 'date_only');
});

test('RED (7): a chain whose deltas do not sum in its declared space is refused', () => {
  const W = registry.registerProducer({ name: 'producer-chain', active: '1', versions: { 1: {} },
    fields: [{ field: 'test.p_chain', valueType: 'prob', space: 'logit', entityTypes: ['player'], checks: ['prob_unit'] }],
  });
  const logit = p => Math.log(p / (1 - p));
  const base = { entityType: 'player', entityId: '9001', field: 'test.p_chain', writer: W['test.p_chain'], value: 0.6,
    producerVersion: '1', eventIds: [] };
  const chain = delta => ({ v: 2, additive: true, space: 'logit', baseline: { value: 0, source: 'prior', text: 'p=0.5' },
    contributions: [{ source: 'x', kind: 'prior', event_ids: [], state_ids: [], delta, text: 'moved' }], residual: 0 });
  // 0.1 is the move in probability space; the declared space is log-odds.
  assert.throws(() => state.writeState({ ...base, asOf: '2026-09-01T00:00:00Z', reasonChain: chain(0.1) }), /sum|additive/);
  state.writeState({ ...base, asOf: '2026-09-01T00:00:00Z', reasonChain: chain(logit(0.6)) });
  assert.throws(() => state.writeState({ ...base, asOf: '2026-09-02T00:00:00Z',
    reasonChain: { ...chain(logit(0.6)), space: 'pts' } }), /space/, 'a chain in a space other than the field\'s');
});

test('RED (8): the route returns each of the seven statuses, and league_id_required', async () => {
  need(routeMod, 'routes/engine.js');
  assert.match(read('server/index.js'), /app\.use\('\/api\/engine', \.\.\.legacyAuthenticated, engineRouter\)/);
  const W = registry.registerProducer({ name: 'producer-route', active: '2', versions: { 2: {} },
    fields: [
      { field: 'test.route', valueType: 'object', entityTypes: ['league_team'], maxAgeSec: 3600 },
      { field: 'test.route_fb', valueType: 'number', entityTypes: ['league_team'] },
    ],
  });
  const [ev] = events.appendEvents([{ event_type: 'test.asof', as_of: '2026-09-05T00:00:00Z', source: 'fixture',
    natural_key: 'route-1', league_id: 71, team_id: '4', payload: { i: 3 } }]).events;
  const put = (entityId, extra) => state.writeState({ entityType: 'league_team', entityId, leagueId: 71, field: 'test.route',
    asOf: '2026-09-06T00:00:00Z', writer: W['test.route'], producerVersion: '2', eventIds: [ev.id],
    reasonChain: { contributions: [{ source: 'fixture', event_ids: [ev.id], delta: 1, text: 'one fixture event' }] }, ...extra });
  put('71:4', { value: { x: 1 } });
  put('71:5', { value: null, absence: { status: 'zero', reason: 'no adds in a covered window' } });
  put('71:7', { value: { x: 7 }, inputsHealth: 'thin' });
  put('71:8', { value: { x: 8 }, inputsHealth: 'degraded' });
  put('71:9', { value: { x: 9 } });
  state.writeState({ entityType: 'league_team', entityId: '71:9', leagueId: 71, field: 'test.route_fb', value: 4.5,
    asOf: '2026-09-06T00:00:00Z', writer: W['test.route_fb'], producerVersion: '2', eventIds: [],
    reasonChain: { contributions: [] } });

  let user = 1;
  const app = express();
  app.use((req, _res, next) => { req.auth = { userId: user }; next(); });
  app.use('/api/engine', routeMod.default);
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/engine/state`;
  const get = async q => (await fetch(`${base}?${q}`)).json();
  const at = '&as_of=2026-09-06T00:30:00Z';
  try {
    const ok = await get(`entity=league_team:71:4&field=test.route&league_id=71${at}`);
    assert.equal(ok.status, 'ok', JSON.stringify(ok));
    assert.deepEqual(ok.state.value, { x: 1 });
    assert.equal(ok.state.producer, 'producer-route');
    assert.equal(ok.state.producer_version, '2');
    assert.equal(ok.state.lane, 'live');
    assert.deepEqual(ok.state.event_ids, [ev.id]);
    assert.equal(ok.state.reason_chain.contributions[0].text, 'one fixture event');
    assert.equal(ok.health.status, 'ok');
    assert.ok(ok.fresh_at, 'fresh_at is missing');

    assert.equal((await get(`entity=league_team:71:5&field=test.route&league_id=71${at}`)).status, 'zero');
    const unknown = await get(`entity=league_team:71:6&field=test.route&league_id=71${at}`);
    assert.equal(unknown.status, 'unknown'); assert.equal(unknown.reason, 'no_row_as_of');
    assert.equal((await get(`entity=league_team:71:4&field=test.route&league_id=71&as_of=2026-09-06T03:00:00Z`)).status, 'stale');
    assert.equal((await get(`entity=league_team:71:7&field=test.route&league_id=71${at}`)).status, 'thin');
    assert.equal((await get(`entity=league_team:71:8&field=test.route&league_id=71${at}`)).status, 'degraded');
    // setFallback is the monitor's writer (the monitor lands later); the test stands in for it.
    // A fallback is per (field, league): from now on every test.route read in league 71 is served the fallback.
    fields.setFallback({ field: 'test.route', leagueId: 71, fallbackField: 'test.route_fb', reason: 'fixture: losing', n: 12,
      since: '2026-09-06T00:00:00.000Z' }, db);
    const fb = await get(`entity=league_team:71:9&field=test.route&league_id=71${at}`);
    assert.equal(fb.status, 'fallback'); assert.equal(fb.state.value, 4.5); assert.equal(fb.state.field, 'test.route_fb');
    const noLeague = await get(`entity=league_team:71:4&field=test.route${at}`);
    assert.equal(noLeague.status, 'league_id_required');
    assert.equal(noLeague.state, null, 'a read without league_id served a league row');
    const unreg = await get(`entity=player:9001&field=test.nobody_owns_this${at}`);
    assert.equal(unreg.status, 'unknown'); assert.equal(unreg.reason, 'field_not_registered');

    assert.equal((await fetch(`${base}?field=test.route`)).status, 400);
    assert.equal((await fetch(`${base}?entity=league_team:71:4&field=test.route&league_id=71&as_of=nonsense`)).status, 400);
    user = 2;
    assert.equal((await fetch(`${base}?entity=league_team:71:4&field=test.route&league_id=71`)).status, 403);
    assert.equal((await fetch(base, { method: 'POST' })).status, 404, 'the reader API is read-only');
  } finally {
    server.close();
  }
});

test('RED (8b): the web process reads specs from the database and never imports a writer', () => {
  const src = read('server/routes/engine.js');
  assert.doesNotMatch(src, /backfill\.js/, 'the web route imports the backfill (a writer)');
  assert.doesNotMatch(src, /\b(writeState|appendEvents|registerField|registerProducer)\b/);
  const index = read('server/index.js');
  const setAt = index.search(/process\.env\.GRIDIRON_PROCESS_ROLE\s*=\s*'web'/);
  assert.ok(setAt >= 0, 'server/index.js does not set the web role in code');
  assert.ok(setAt < index.indexOf('await import('), 'the web role is set after a module import');
});

test('RED (9): a write with role unset or web throws; a second producer is refused by the trigger even from raw SQL', () => {
  need(role, 'role.js');
  const W = registry.registerField('test.role_guard', { producer: 'producer-rg', version: '1', entityTypes: ['player'] });
  const write = () => state.writeState({ entityType: 'player', entityId: '9001', field: 'test.role_guard', value: 1,
    asOf: '2026-09-01T00:00:00Z', writer: W, producerVersion: '1', eventIds: [], reasonChain: { contributions: [] } });
  const append = () => events.appendEvents([{ event_type: 'test.asof', as_of: '2026-09-01T00:00:00Z', source: 'fixture',
    natural_key: 'role-1', payload: {} }]);
  try {
    for (const r of [undefined, 'web', 'refresh', 'engine-child']) {
      if (r === undefined) delete process.env.GRIDIRON_PROCESS_ROLE; else process.env.GRIDIRON_PROCESS_ROLE = r;
      assert.throws(write, /role/, `writeState allowed role ${r}`);
      assert.throws(append, /role/, `appendEvents allowed role ${r}`);
    }
  } finally {
    process.env.GRIDIRON_PROCESS_ROLE = 'test';
  }
  write();
  assert.throws(() => run(`INSERT INTO engine_state (entity_type, entity_id, league_id, field, value, as_of, producer,
      producer_version, lane, reason_chain, event_ids, health, written_at)
      VALUES ('player', '9001', 0, 'test.role_guard', '2', '2026-09-02T00:00:00.000Z', 'intruder', '1', 'live',
      '{"contributions":[]}', '[]', '{"status":"ok","checks":[]}', '2026-09-02T00:00:00.000Z')`), /producer/);
  assert.throws(() => run(`INSERT INTO engine_state (entity_type, entity_id, league_id, field, value, as_of, producer,
      producer_version, lane, reason_chain, event_ids, health, written_at)
      VALUES ('player', '9001', 0, 'test.no_spec', '2', '2026-09-02T00:00:00.000Z', 'anyone', '1', 'live',
      '{"contributions":[]}', '[]', '{"status":"ok","checks":[]}', '2026-09-02T00:00:00.000Z')`), /producer/,
    'a field with no engine_fields row cannot be written at all');
});

test('RED (10): no handler is called by default; getEvents throws at its limit', () => {
  const fired = [];
  const off = registry.onEvent('*', ev => fired.push(ev.id));
  try {
    events.appendEvents([{ event_type: 'test.asof', as_of: '2026-08-01T00:00:00Z', source: 'fixture', natural_key: 'nd-1',
      player_id: 9001, payload: {} }]);
    assert.equal(fired.length, 0, 'appendEvents dispatched without being asked');
    events.appendEvents([{ event_type: 'test.asof', as_of: '2026-08-01T00:00:00Z', source: 'fixture', natural_key: 'nd-2',
      player_id: 9001, payload: {} }], { dispatch: true });
    assert.equal(fired.length, 1, 'dispatch:true must still call the handler once');
  } finally { off(); }
  const q = { asOf: '2026-12-31T00:00:00Z', types: ['test.asof'] };
  const all = events.getEvents({ ...q, limit: 1000 });
  assert.ok(all.length >= 3);
  assert.throws(() => events.getEvents({ ...q, limit: 2 }), /limit/);
  const t = events.getEvents({ ...q, limit: 2, allowTruncated: true });
  assert.equal(t.truncated, true); assert.equal(t.events.length, 2);
  const after = events.getEvents({ ...q, afterId: all[0].id });
  assert.ok(after.every(e => e.id > all[0].id));
  const window = events.getEvents({ ...q, from: '2026-09-02T00:00:00Z' });
  assert.ok(window.every(e => e.as_of >= '2026-09-02T00:00:00.000Z'));
});

test('RED (11): a probability of 1.3 writes a failed row and the reader serves the last good one', () => {
  need(health, 'health.js');
  const W = registry.registerProducer({ name: 'producer-prob', active: '1', versions: { 1: {} },
    fields: [{ field: 'test.prob', valueType: 'prob', space: 'prob', entityTypes: ['player'], checks: ['prob_unit', 'no_nan'] }],
  });
  const put = (value, asOf) => state.writeState({ entityType: 'player', entityId: '9001', field: 'test.prob', value, asOf,
    writer: W['test.prob'], producerVersion: '1', eventIds: [], reasonChain: { contributions: [] } });
  assert.equal(put(0.3, '2026-09-01T00:00:00Z').health.status, 'ok');
  const bad = put(1.3, '2026-09-02T00:00:00Z');
  assert.equal(bad.written, true, 'a failed row is kept for the audit');
  assert.equal(bad.health.status, 'failed');
  assert.ok(bad.health.checks.some(c => c.id === 'prob_unit' && !c.passed));
  const served = state.getState('player', '9001', 'test.prob', { asOf: '2026-09-03T00:00:00Z' });
  assert.equal(served.value, 0.3);
  assert.equal(health.runChecks([0.1, 0.5, 0.4], ['quantiles_ordered']).status, 'failed');
  assert.equal(health.runChecks({ a: 0.5, b: 0.5 }, ['probs_sum_1']).status, 'ok');
  assert.equal(health.runChecks(7, ['in_range:0:5']).status, 'failed');
  assert.equal(health.runChecks({ a: 1, b: 2 }, ['sum_to:3']).status, 'ok');
  // Write-on-change: the same value again adds nothing.
  assert.equal(put(0.3, '2026-09-04T00:00:00Z').written, true, 'the value after a failed row differs from it');
  const again = put(0.3, '2026-09-05T00:00:00Z');
  assert.equal(again.written, false); assert.equal(again.unchanged, true);
});

test('RED (12): sync_log advancing appends one source.coverage event', () => {
  need(backfill, 'backfill.js');
  const cov = () => row(`SELECT COUNT(*) AS n FROM engine_events WHERE event_type = 'source.coverage'`).n;
  const before = cov();
  assert.ok(before >= 1);
  assert.equal(backfill.backfillStream('coverage').inserted, 0, 'an unchanged sync_log appended coverage');
  run(`UPDATE sync_log SET last_run_at = '2026-09-20T09:15:00.000Z', runs = 2 WHERE job = 'league_transactions'`);
  assert.equal(backfill.backfillStream('coverage').inserted, 1);
  assert.equal(cov(), before + 1);
  const ev = row(`SELECT payload FROM engine_events WHERE event_type = 'source.coverage' ORDER BY id DESC LIMIT 1`);
  assert.doesNotMatch(ev.payload, /free text/, 'sync_log.last_detail must not be copied');
});

test('RED (13): bytes per engine row are measurable (recorded in the PR body; BENCHMARKS.md is local)', () => {
  need(backfill, 'backfill.js');
  const m = backfill.measureEngineBytes(db);
  if (m.available === false) { assert.ok(m.reason); return; } // dbstat is compiled out on some builds
  for (const t of ['engine_events', 'engine_event_entities', 'engine_state']) {
    assert.ok(m.tables[t], `no measurement for ${t}`);
    assert.ok(m.tables[t].rows > 0);
    assert.ok(m.tables[t].bytes_per_row > 0);
  }
  assert.match(read('scripts/engine-backfill.mjs'), /measureEngineBytes/, 'the backfill script prints bytes per row');
});

test('entity key grammar: league-scoped keys carry their league; points fields use player_week_scored', () => {
  const W = registry.registerProducer({ name: 'producer-keys', active: '1', versions: { 1: {} },
    fields: [
      { field: 'test.keyed', valueType: 'number', entityTypes: ['league_team', 'player', 'bogus_type'] },
      { field: 'test.points', valueType: 'number', space: 'pts', entityTypes: ['player_week', 'player_week_scored'] },
    ],
  });
  const put = (field, entityType, entityId, leagueId) => state.writeState({ entityType, entityId, leagueId, field, value: 1,
    asOf: '2026-09-01T00:00:00Z', writer: W[field], producerVersion: '1', eventIds: [], reasonChain: { contributions: [] } });
  assert.throws(() => put('test.keyed', 'league_team', '71:4', 72), /league/);
  assert.throws(() => put('test.keyed', 'league_team', '71:4', null), /league/);
  assert.throws(() => put('test.keyed', 'league_team', 'seventy-one', 71), /key/);
  assert.throws(() => put('test.keyed', 'player', 'Fixture Back', null), /key/);
  assert.throws(() => put('test.keyed', 'bogus_type', 'x', null), /entity type/);
  put('test.keyed', 'league_team', '71:4', 71);
  assert.throws(() => put('test.points', 'player_week', '9001:2026:3', null), /player_week_scored/);
  put('test.points', 'player_week_scored', `9001:2026:3:${'ab'.repeat(8)}`, null);
});

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
