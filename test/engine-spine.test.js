/**
 * ENGINE-00a: the ONE ENGINE spine.
 *
 * Every later engine stage (PROJ-*, TELLS-*, CLONE-*, CHESS-*, COACH-*, OFFER-*, Jev
 * calls and grades) reads `engine_events` / `engine_state` and writes only its own
 * fields. This file pins the contract those stages extend:
 *   1. `engine_events` is one append-only, as-of-stamped log (migration 075).
 *   2. `engine_state` holds entity x field x as_of rows, each written by the ONE
 *      producer registered for that field; another producer's write throws.
 *   3. As-of reads never return a state row or an event stamped after asOf, and a
 *      state row may not cite an event from its own future.
 *   4. Every state row carries a reason_chain {contributions:[{source,event_ids,delta,text}]}.
 *   5. GET /api/engine/state serves that row, reason chain included, read-only.
 *   6. The backfill adapters copy the existing streams into the log idempotently.
 *
 * On origin/main b0862ffc none of this exists: `grep -rn engine_events server` is empty.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-engine-spine-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

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
const routeMod = await optionalImport('../server/routes/engine.js');
const need = (mod, name) => assert.ok(mod, `${name} does not exist: the engine spine is not built`);

const express = (await import('express')).default;

/* ---------------------------------------------------------------- fixture */
run(`INSERT INTO users (id, subject, display_name) VALUES (1, 'eng-1', 'eng-1'), (2, 'eng-2', 'eng-2')`);
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
     VALUES (71, 'espn', 'eng-71', 2026, 'Fixture', '1', 10, 1, '{}', '2026-09-18 01:00:00')`);
run(`INSERT INTO league_memberships (league_id, user_id, role) VALUES (71, 1, 'commissioner')`);
run(`INSERT INTO players (id, name, position, espn_id, gsis_id) VALUES (9001, 'Fixture Back', 'RB', 555, '00-0099999')`);

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
run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id, espn_player_id, player_id,
       player_name, position, lineup_slot_id, lineup_slot, is_starter, on_roster, source, first_seen_at, changed_at,
       projected_points, actual_points)
     VALUES (71, 2026, 2, 4, 555, 9001, 'Fixture Back', 'RB', 2, 'RB', 1, 1, 'live',
       '2026-09-20T10:00:00.000Z', '2026-09-20T10:00:00.000Z', 12.5, 20.1)`);
run(`INSERT INTO news_items (date, headline, body, importance, source, published_at, entities_json)
     VALUES ('2026-09-19', 'Fixture Back limited', 'long body text', 3, 'fixture', '2026-09-19T15:00:00.000Z',
       '{"players":[{"id":9001,"name":"Fixture Back","confidence":1}],"teams":[]}')`);
run(`INSERT INTO game_lines (season, week, team, opponent, home, spread, total, implied_points, source, fetched_at)
     VALUES (2026, 3, 'AAA', 'BBB', 1, -3.5, 44.5, 24, 'fixture', '2026-09-18 12:00:00')`);
run(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status, practice_status,
       injury, modified_at) VALUES (2026, 3, '00-0099999', 'AAA', 'Fixture Back', 'RB', 'Questionable', 'Limited',
       'Ankle', '2026-09-19T20:00:00Z')`);
run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, give_json, get_json,
       proposed_at, status, espn_tx_id, resolved_at, created_at)
     VALUES (71, 2026, 'observed', '4', '6', '[555]', '[777]', '2026-09-18T01:00:00.000Z', 'accepted', 'tx-9',
       '2026-09-19T01:00:00.000Z', '2026-09-19T02:00:00.000Z')`);
run(`INSERT INTO manager_signals (league_id, roster_id, metric, value, n, source, computed_at)
     VALUES (71, '4', 'chat_trade_talk', 0.21, 140, 'chat', '2026-09-20 09:00:00'),
            (71, '4', 'roster_size', 16, 1, 'roster', '2026-09-20 09:00:00')`);

const count = () => row('SELECT COUNT(*) AS n FROM engine_events').n;

/* ------------------------------------------------------------------ schema */
test('migration 075 creates engine_events and engine_state with the contract columns', () => {
  const files = fs.readdirSync(path.join(root, 'server/migrations'));
  assert.ok(files.some(f => /^075_engine_spine\.js$/.test(f)), 'no migration 075_engine_spine.js');
  const cols = t => rows(`PRAGMA table_info(${t})`).map(c => c.name);
  for (const c of ['id', 'event_type', 'as_of', 'league_id', 'team_id', 'player_id', 'source', 'payload', 'ingested_at']) {
    assert.ok(cols('engine_events').includes(c), `engine_events.${c} missing`);
  }
  for (const c of ['entity_type', 'entity_id', 'field', 'value', 'as_of', 'producer', 'producer_version',
    'reason_chain', 'event_ids']) {
    assert.ok(cols('engine_state').includes(c), `engine_state.${c} missing`);
  }
});

test('engine_events and engine_state are append-only at the database', () => {
  need(events, 'events.js'); need(state, 'state.js');
  registry.registerEventType('test.append_only', { description: 'fixture' });
  const [ev] = events.appendEvents([{ event_type: 'test.append_only', as_of: '2026-09-01T00:00:00Z',
    source: 'fixture', source_key: 'ao-1', payload: { k: 1 } }]).events;
  assert.throws(() => run('UPDATE engine_events SET as_of = ? WHERE id = ?', '2020-01-01T00:00:00.000Z', ev.id),
    /append-only/);
  assert.throws(() => run('DELETE FROM engine_events WHERE id = ?', ev.id), /append-only/);
  // A row-level trigger only fires on a row, so write one first (an empty-table UPDATE proves nothing).
  registry.registerField('test.append_only', { producer: 'producer-ao', version: '1', entityTypes: ['player'] });
  const { id } = state.writeState({ entityType: 'player', entityId: '9001', field: 'test.append_only', value: 1,
    asOf: '2026-09-01T00:00:00Z', producer: 'producer-ao', producerVersion: '1', eventIds: [ev.id],
    reasonChain: { contributions: [] } });
  assert.throws(() => run('UPDATE engine_state SET producer = ? WHERE id = ?', 'x', id), /append-only/);
  assert.throws(() => run('DELETE FROM engine_state WHERE id = ?', id), /append-only/);
});

/* ------------------------------------------------------------- one writer */
test('one writer per field: a second producer cannot register or write a field', () => {
  need(registry, 'registry.js'); need(state, 'state.js');
  registry.registerField('test.owned', { producer: 'producer-a', version: '1', entityTypes: ['player'] });
  // Same producer again is idempotent (modules may be imported twice).
  registry.registerField('test.owned', { producer: 'producer-a', version: '1', entityTypes: ['player'] });
  assert.throws(() => registry.registerField('test.owned', { producer: 'producer-b', version: '1', entityTypes: ['player'] }),
    /test\.owned.*producer-a/);
  const base = { entityType: 'player', entityId: '9001', field: 'test.owned', value: 1, asOf: '2026-09-10T00:00:00Z',
    producerVersion: '1', reasonChain: { contributions: [] }, eventIds: [] };
  assert.throws(() => state.writeState({ ...base, producer: 'producer-b' }), /one writer.*producer-a/i);
  assert.throws(() => state.writeState({ ...base, field: 'test.never_registered', producer: 'producer-a' }),
    /not registered/);
  state.writeState({ ...base, producer: 'producer-a' });
  assert.equal(row(`SELECT COUNT(*) AS n FROM engine_state WHERE field = 'test.owned'`).n, 1);
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
  assert.deepEqual(hits(/(UPDATE|DELETE\s+FROM)\s+engine_(state|events)\b/i), [], 'something rewrites the log');
  const decl = new Map();
  for (const f of files) {
    for (const m of read(f).matchAll(/registerField\(\s*['"]([^'"]+)['"]\s*,\s*\{[^}]*producer:\s*['"]([^'"]+)['"]/g)) {
      decl.set(m[1], [...(decl.get(m[1]) ?? []), `${f}:${m[2]}`]);
    }
  }
  assert.ok(decl.has('engine.ingest'), 'the spine declares its own field engine.ingest');
  for (const [field, where] of decl) assert.equal(where.length, 1, `${field} declared by ${where.join(', ')}`);
});

/* ------------------------------------------------------------------ as-of */
test('as-of reads never return an event or a state row stamped after asOf', () => {
  need(events, 'events.js'); need(state, 'state.js');
  registry.registerEventType('test.asof', { description: 'fixture' });
  registry.registerField('test.asof_field', { producer: 'producer-asof', version: '1', entityTypes: ['player'] });
  const { events: evs } = events.appendEvents([
    { event_type: 'test.asof', as_of: '2026-09-01T00:00:00Z', source: 'fixture', source_key: 'asof-past', player_id: 9001, payload: { i: 1 } },
    { event_type: 'test.asof', as_of: '2026-09-03T00:00:00Z', source: 'fixture', source_key: 'asof-future', player_id: 9001, payload: { i: 2 } },
  ]);
  const [past, future] = evs;
  const seen = events.getEvents({ asOf: '2026-09-02T00:00:00Z', playerId: 9001, types: ['test.asof'] });
  assert.deepEqual(seen.map(e => e.id), [past.id], 'the future event leaked into an as-of read');
  assert.throws(() => events.getEvents({ playerId: 9001 }), /asOf/, 'an as-of read with no asOf must refuse');

  const w = (asOf, ids, value) => state.writeState({ entityType: 'player', entityId: '9001', field: 'test.asof_field',
    value, asOf, producer: 'producer-asof', producerVersion: '1', eventIds: ids,
    reasonChain: { contributions: [{ source: 'fixture', event_ids: ids, delta: value, text: 'fixture' }] } });
  w('2026-09-01T12:00:00Z', [past.id], 1);
  w('2026-09-03T12:00:00Z', [past.id, future.id], 2);
  assert.equal(state.getState('player', '9001', 'test.asof_field', { asOf: '2026-09-02T00:00:00Z' }).value, 1);
  assert.equal(state.getState('player', '9001', 'test.asof_field', { asOf: '2026-09-04T00:00:00Z' }).value, 2);
  assert.equal(state.getState('player', '9001', 'test.asof_field', { asOf: '2026-08-01T00:00:00Z' }), null);
  // A state row may not cite an event from its own future: that is how a leak gets in.
  assert.throws(() => w('2026-09-02T00:00:00Z', [future.id], 3), /future|after/i);
  assert.throws(() => w('2026-09-02T00:00:00Z', [987654], 3), /unknown event/i);
});

test('reason_chain is required and shaped {contributions:[{source,event_ids,delta,text}]}', () => {
  need(state, 'state.js');
  registry.registerField('test.reason', { producer: 'producer-r', version: '1', entityTypes: ['player'] });
  const base = { entityType: 'player', entityId: '9001', field: 'test.reason', value: 1, asOf: '2026-09-10T00:00:00Z',
    producer: 'producer-r', producerVersion: '1', eventIds: [] };
  assert.throws(() => state.writeState(base), /reason_chain/);
  assert.throws(() => state.writeState({ ...base, reasonChain: {} }), /contributions/);
  assert.throws(() => state.writeState({ ...base, reasonChain: { contributions: [{ source: 'x' }] } }), /event_ids/);
  assert.throws(() => state.writeState({ ...base, reasonChain: { contributions: [
    { source: 'x', event_ids: [123], delta: 1, text: 't' }] } }), /not in event_ids/);
  state.writeState({ ...base, reasonChain: { contributions: [] } });
});

/* -------------------------------------------------------------- privacy */
test('no private text or cookie ever enters the log', () => {
  need(events, 'events.js');
  registry.registerEventType('test.private', { description: 'fixture' });
  for (const key of ['text', 'body', 'message', 'espn_s2', 'swid']) {
    assert.throws(() => events.appendEvents([{ event_type: 'test.private', as_of: '2026-09-01T00:00:00Z',
      source: 'fixture', source_key: `p-${key}`, payload: { nested: { [key]: 'x' } } }]), /not allowed/);
  }
  assert.throws(() => events.appendEvents([{ event_type: 'test.unregistered', as_of: '2026-09-01T00:00:00Z',
    source: 'fixture', source_key: 'u', payload: {} }]), /not registered/);
});

/* ---------------------------------------------------------------- backfill */
test('backfill copies every stream, is idempotent, and fires onEvent only for new events', () => {
  need(backfill, 'backfill.js');
  const fired = [];
  const off = registry.onEvent('*', ev => fired.push(ev.event_type));
  const before = count();
  const first = backfill.backfillAll();
  const afterFirst = count();
  const second = backfill.backfillAll();
  off();
  assert.equal(count(), afterFirst, 'running the backfill twice added events');
  const streams = Object.fromEntries(first.streams.map(s => [s.stream, s]));
  for (const s of ['transactions', 'lineups', 'news', 'game_lines', 'injuries', 'trade_outcomes', 'chat_signals']) {
    assert.ok(streams[s], `no adapter for ${s}`);
    assert.ok(streams[s].inserted > 0, `${s}: 0 events from a fixture row`);
  }
  assert.equal(afterFirst - before, first.streams.reduce((a, s) => a + s.inserted, 0));
  assert.equal(second.streams.reduce((a, s) => a + s.inserted, 0), 0);
  assert.equal(fired.length, afterFirst - before, 'onEvent must fire once per new event, never on a duplicate');

  const tx = row(`SELECT * FROM engine_events WHERE event_type = 'espn.transaction'`);
  assert.equal(tx.as_of, '2026-09-16T07:11:15.238Z');
  assert.equal(tx.league_id, 71); assert.equal(tx.team_id, '4');
  assert.ok(!tx.payload.includes('never copied'), 'raw_json copied into the log');
  const lineup = JSON.parse(row(`SELECT payload FROM engine_events WHERE event_type = 'league.lineup'`).payload);
  assert.equal(lineup.actual_points, undefined, 'a lineup event must not carry the game result');
  const inj = row(`SELECT * FROM engine_events WHERE event_type = 'nfl.injury'`);
  assert.equal(inj.player_id, 9001);
  const line = row(`SELECT * FROM engine_events WHERE event_type = 'market.game_line'`);
  assert.equal(line.as_of, '2026-09-18T12:00:00.000Z', 'SQLite datetime is normalised to ISO UTC');
  const trades = rows(`SELECT event_type, as_of FROM engine_events WHERE source = 'trade_outcomes' ORDER BY as_of`);
  assert.deepEqual(trades.map(t => t.event_type), ['trade.proposed', 'trade.resolved']);
  const chat = rows(`SELECT * FROM engine_events WHERE event_type = 'manager.chat_signal'`);
  assert.equal(chat.length, 1, 'only source=chat rows are chat signals');
  assert.deepEqual(Object.keys(JSON.parse(chat[0].payload)).sort(), ['metric', 'n', 'value']);
  // The backfill's own state row: counts per stream, reason chain populated.
  const ingest = state.getState('engine', 'events', 'engine.ingest', { asOf: new Date().toISOString() });
  assert.ok(ingest, 'backfill wrote no engine.ingest row');
  assert.ok(ingest.value.streams.transactions.events >= 1);
  assert.ok(ingest.reason_chain.contributions.some(c => c.source === 'league_transactions_raw'));
});

test('an absent source table is reported as table_absent, never as 0 events', () => {
  need(backfill, 'backfill.js');
  const out = backfill.backfillStream('transactions', { table: 'no_such_table_here' });
  assert.equal(out.table_state, 'table_absent');
  assert.equal(out.inserted, null);
});

/* -------------------------------------------------------------------- route */
test('GET /api/engine/state serves the as-of row with its reason_chain, league rows to members only', async () => {
  need(routeMod, 'routes/engine.js');
  assert.match(read('server/index.js'), /app\.use\('\/api\/engine', \.\.\.legacyAuthenticated, engineRouter\)/);
  registry.registerField('test.route', { producer: 'producer-route', version: '2', entityTypes: ['league_team'] });
  const [ev] = events.appendEvents([{ event_type: 'test.asof', as_of: '2026-09-05T00:00:00Z', source: 'fixture',
    source_key: 'route-1', league_id: 71, team_id: '4', payload: { i: 3 } }]).events;
  state.writeState({ entityType: 'league_team', entityId: '71:4', leagueId: 71, field: 'test.route', value: { x: 1 },
    asOf: '2026-09-06T00:00:00Z', producer: 'producer-route', producerVersion: '2', eventIds: [ev.id],
    reasonChain: { contributions: [{ source: 'fixture', event_ids: [ev.id], delta: 1, text: 'one fixture event' }] } });

  let user = 1;
  const app = express();
  app.use((req, _res, next) => { req.auth = { userId: user }; next(); });
  app.use('/api/engine', routeMod.default);
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/engine/state`;
  try {
    const q = 'entity=league_team:71:4&field=test.route&league_id=71';
    const ok = await fetch(`${base}?${q}&as_of=2026-09-07T00:00:00Z`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(body.state.value, { x: 1 });
    assert.equal(body.state.producer, 'producer-route');
    assert.equal(body.state.producer_version, '2');
    assert.deepEqual(body.state.event_ids, [ev.id]);
    assert.equal(body.state.reason_chain.contributions[0].text, 'one fixture event');

    const early = await (await fetch(`${base}?${q}&as_of=2026-09-05T12:00:00Z`)).json();
    assert.equal(early.state, null);
    assert.equal(early.absence, 'no_row_as_of');

    assert.equal((await fetch(`${base}?field=test.route`)).status, 400);
    assert.equal((await fetch(`${base}?entity=league_team:71:4&field=test.route&league_id=71&as_of=nonsense`)).status, 400);
    user = 2;
    assert.equal((await fetch(`${base}?${q}`)).status, 403);
    const post = await fetch(base, { method: 'POST' });
    assert.equal(post.status, 404, 'the reader API is read-only');
  } finally {
    server.close();
  }
});

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
