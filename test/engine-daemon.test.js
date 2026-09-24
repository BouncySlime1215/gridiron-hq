/**
 * EA-02: the engine daemon (ENGINE-SPECS.md EA-02 row; ENGINE-ARCHITECTURE.md §4.3, §9.1-9.2).
 *
 * "RED (n)" names the row's acceptance checks: ENGINE-00b-a (1)-(7) as written, plus (8)-(15).
 * Fixtures only: fixture leagues 81-83, fixture players 9101-9103, fixture teams AAA-FFF.
 * Tests share one database and run in file order: each builds on the ticks before it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-engine-daemon-'));
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
const registry = await import('../server/services/engine/registry.js');
const tickMod = await optionalImport('../server/services/engine/daemon/tick.js');
const dagMod = await optionalImport('../server/services/engine/daemon/dag.js');
const lockMod = await optionalImport('../server/services/engine/daemon/lock.js');
const hooksMod = await optionalImport('../server/services/engine/daemon/hooks.js');
const cursorsMod = await optionalImport('../server/services/engine/daemon/cursors.js');
const snapshotsMod = await optionalImport('../server/services/engine/daemon/snapshots.js');
const requestsMod = await optionalImport('../server/services/engine/daemon/requests.js');
const producersMod = await optionalImport('../server/services/engine/producers/index.js');
const gamescriptMod = await optionalImport('../server/services/engine/producers/gamescript.js');
const calendarMod = await optionalImport('../server/services/engine/producers/calendar.js');
const startAll = await optionalImport('../scripts/start-all.mjs');
const need = (mod, name) => assert.ok(mod, `${name} does not exist: the engine daemon is not built`);

/* ------------------------------------------------------------------ fixtures */
run(`INSERT INTO players (id, name, position, espn_id, gsis_id) VALUES
  (9101, 'Fixture One', 'RB', 9101, '00-0091001'), (9102, 'Fixture Two', 'WR', 9102, '00-0091002'),
  (9103, 'Fixture Three', 'TE', 9103, '00-0091003')`);
db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);
const lineup = (league, team, player, period = 3) => run(`INSERT INTO league_roster_snapshots (league_id, season,
    scoring_period_id, team_id, espn_player_id, player_id, player_name, position, lineup_slot_id, lineup_slot, is_starter,
    on_roster, source, first_seen_at, changed_at) VALUES (?, 2026, ?, ?, ?, ?, 'Fixture', 'RB', 2, 'RB', 1, 1, 'live',
    '2026-09-20T10:00:00.000Z', '2026-09-20T10:00:00.000Z')`, league, period, team, player, player);
lineup(81, 1, 9101); lineup(82, 2, 9101); lineup(83, 3, 9103); lineup(81, 1, 9102, 2);
const injury = (gsis, status, modified) => run(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position,
    report_status, practice_status, injury, modified_at) VALUES (2026, 3, ?, 'AAA', 'Fixture', 'RB', ?, 'Limited', 'Ankle', ?)
    ON CONFLICT (season, week, gsis_id) DO UPDATE SET report_status = excluded.report_status, modified_at = excluded.modified_at`,
gsis, status, modified);
injury('00-0091001', 'Questionable', '2026-09-19T20:00:00Z');
injury('00-0091003', 'Questionable', '2026-09-19T20:00:00Z');
run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, proposed_at, processed_at, team_id,
       scoring_period, items_json, first_seen_at, last_seen_at)
     VALUES (81, 2026, 'fx-1', 'FREEAGENT', 'EXECUTED', '2026-09-16T07:00:00.000Z', '2026-09-16T07:00:01.000Z', 1, 3,
       '[{"playerId":9102,"type":"ADD","fromTeamId":0,"toTeamId":1}]', '2026-09-17T21:00:00.000Z', '2026-09-17T21:00:00.000Z')`);

/* Fixture producers: a cheap availability-like producer and a heavy per-league one. */
let failLeague = null;
const AVAIL_WRITERS = registry.registerProducer({
  name: 'fx_avail', active: '1', versions: { 1: {} },
  fields: [{ field: 'fx.p_play', valueType: 'prob', entityTypes: ['player'], checks: ['prob_unit'] }],
  inputs: { events: ['nfl.injury'], fields: [], scope: 'global', schedule: 'tick', cost: 'cheap', budget_ms: 30000 },
});
const SIM_WRITERS = registry.registerProducer({
  name: 'fx_sim', active: '1', versions: { 1: {} },
  fields: [{ field: 'fx.world', valueType: 'object', entityTypes: ['league'] }],
  inputs: { events: ['league.lineup'], fields: ['fx.p_play'], scope: 'league', schedule: 'tick', cost: 'heavy', budget_ms: 30000 },
});
const P = { Out: 0.02, Questionable: 0.75 };
const fxAvail = { name: 'fx_avail', run(ctx) {
  const latest = new Map();
  for (const e of ctx.read.events({ types: ['nfl.injury'] })) latest.set(e.natural_key, e);
  for (const e of latest.values()) {
    if (e.player_id == null) continue;
    const value = P[e.payload.report_status] ?? 0.97;
    ctx.write(AVAIL_WRITERS['fx.p_play'], { entityType: 'player', entityId: String(e.player_id), field: 'fx.p_play', value,
      eventIds: [e.id], reasonChain: { contributions: [{ source: 'nfl.injury', kind: 'event', event_ids: [e.id], delta: null,
        text: e.payload.report_status }] } });
  }
} };
const fxSim = { name: 'fx_sim', run(ctx) {
  if (failLeague === ctx.league) throw new Error(`fixture failure in league ${ctx.league}`);
  const inputs = ctx.read.latest('fx.p_play');
  const ids = inputs.map(r => r.id);
  ctx.write(SIM_WRITERS['fx.world'], { entityType: 'league', entityId: String(ctx.league), leagueId: ctx.league, field: 'fx.world',
    value: { n: inputs.length, p: inputs.map(r => r.value) }, stateIds: ids,
    reasonChain: { contributions: [{ source: 'fx.p_play', kind: 'state', event_ids: [], state_ids: ids, delta: null, text: 'inputs' }] } });
} };
const entry = mod => ({ ...registry.producerSpec(mod.name), ...mod });

const heartbeat = () => row(`SELECT last_status, last_detail FROM sync_log WHERE job = 'engine_daemon'`);
const count = t => row(`SELECT COUNT(*) AS n FROM ${t}`).n;
let fxDag = null;
async function tick(opts = {}) {
  need(tickMod, 'daemon/tick.js');
  fxDag ??= dagMod.buildDag([entry(fxAvail), entry(fxSim)]).order;
  return tickMod.runTick({ database: db, dag: fxDag, ...opts });
}

/* ------------------------------------------------------------------ RED (2), (10) */
test('RED (2): two ticks over the same source rows append the events once (idempotent by watermark)', async () => {
  const first = await tick();
  assert.ok(first.events > 0, 'the first tick ingests the fixture rows');
  assert.equal(first.failed.length, 0, JSON.stringify(first.failed));
  const events = count('engine_events');
  const second = await tick();
  assert.equal(second.events, 0);
  assert.equal(count('engine_events'), events, 'a second pass over the same rows appended events');
  // Cursors hold a watermark per stream and every pass is an engine_runs row (coverage).
  for (const s of ['transactions', 'lineups', 'injuries', 'coverage']) {
    assert.notEqual(cursorsMod.getCursor('engine-adapters', '1', s, db), undefined, `no cursor for ${s}`);
  }
  assert.ok(row(`SELECT COUNT(*) AS n FROM engine_runs WHERE producer = 'engine-adapters' AND tick_id = ?`, second.tick_id).n
    >= cursorsMod.DAEMON_ADAPTERS.length);
  // The first pass of a stream is a backfill; the daemon's own heartbeat never becomes a coverage event.
  assert.equal(row(`SELECT COUNT(*) AS n FROM engine_events WHERE source = 'league_transactions_raw' AND provenance = 'reconstructed'`).n, 1);
  assert.equal(row(`SELECT COUNT(*) AS n FROM engine_events WHERE event_type = 'source.coverage' AND natural_key = 'engine_daemon'`).n, 0);
});

test('RED (10): unchanged inputs write 0 state rows and publish no snapshot', async () => {
  const before = { state: count('engine_state'), events: count('engine_events'), snaps: count('engine_snapshots') };
  assert.ok(before.snaps >= 4, 'the first tick published leagues 0, 81, 82, 83');
  const t = await tick();
  assert.equal(count('engine_state'), before.state, 'state rows were written for unchanged inputs');
  assert.equal(count('engine_events'), before.events);
  assert.equal(count('engine_snapshots'), before.snaps, 'a snapshot was published with nothing changed');
  assert.deepEqual(t.runs.filter(r => r.producer === 'fx_sim'), [], 'a heavy producer ran with a clean dirty bit');
  assert.equal(t.runs.find(r => r.producer === 'fx_avail')?.unchanged, 2, 'the cheap producer still recomputes every entity');
});

/* ------------------------------------------------------------------ RED (8) */
test('RED (8): the injury example runs exactly the declared producers and publishes exactly two snapshots', async () => {
  injury('00-0091001', 'Out', '2026-09-21T20:00:00Z'); // player 9101, rostered in leagues 81 and 82, not 83
  const snaps = count('engine_snapshots');
  const t = await tick();
  assert.equal(t.events, 1);
  const scopes = rows(`SELECT DISTINCT producer, scope_key FROM engine_runs WHERE tick_id = ? AND producer <> 'engine-adapters'
      ORDER BY producer, scope_key`, t.tick_id).map(r => `${r.producer}|${r.scope_key}`);
  assert.deepEqual(scopes, ['fx_avail|', 'fx_sim|league:81', 'fx_sim|league:82']);
  assert.equal(count('engine_snapshots') - snaps, 2);
  assert.deepEqual(t.snapshots.map(s => s.league).sort(), [81, 82]);
  const s81 = snapshotsMod.latestSnapshot(81, db);
  assert.equal(s81.max_state_id, row('SELECT MAX(id) AS m FROM engine_state').m, 'the cut includes the rows built on the Out');
  assert.equal(row(`SELECT value FROM engine_state WHERE field = 'fx.p_play' AND entity_id = '9101' ORDER BY id DESC LIMIT 1`).value, '0.02');
});

/* ------------------------------------------------------------------ RED (11) */
test('RED (11): a failed producer leaves the league\'s previous snapshot serving and its dirty bit set', async () => {
  const prev81 = snapshotsMod.latestSnapshot(81, db).id;
  const cursor81 = cursorsMod.getCursor('fx_sim', '1', 'league:81', db);
  failLeague = 81;
  injury('00-0091001', 'Questionable', '2026-09-22T20:00:00Z');
  const t = await tick();
  assert.ok(t.failed.some(f => /fx_sim@1 league 81/.test(f.what) && /fixture failure/.test(f.error)), JSON.stringify(t.failed));
  assert.deepEqual(t.snapshots.map(s => s.league), [82], 'only the league whose DAG finished publishes');
  assert.equal(snapshotsMod.latestSnapshot(81, db).id, prev81, 'league 81 keeps serving its previous snapshot');
  assert.equal(cursorsMod.getCursor('fx_sim', '1', 'league:81', db), cursor81, 'the failed run advanced its cursor');
  assert.equal(heartbeat().last_status, 'error');
  assert.match(heartbeat().last_detail, /fixture failure in league 81/);
  failLeague = null;
  const again = await tick();
  assert.deepEqual(again.runs.filter(r => r.producer === 'fx_sim').map(r => r.league), [81], 'the dirty bit stayed set');
  assert.deepEqual(again.snapshots.map(s => s.league), [81]);
  assert.equal(heartbeat().last_status, 'ok');
});

/* ------------------------------------------------------------------ RED (3), (4) */
test('RED (3), (4): one new transaction gives 1 event and 1 dispatch per learner; a failing learner is recorded, never fatal', async () => {
  const calls = { a: 0, b: 0, thrower: 0 };
  const a = () => { calls.a += 1; };
  const b = async () => { calls.b += 1; };
  const thrower = () => { calls.thrower += 1; throw new Error('learner exploded'); };
  thrower.learnerName = 'fx_thrower';
  const sleeper = () => new Promise(() => {}); // never settles
  sleeper.learnerName = 'fx_sleeper';
  const offs = [registry.onEvent('espn.transaction', a), registry.onEvent('espn.transaction', b),
    registry.onEvent('espn.transaction', thrower), registry.onEvent('espn.transaction', sleeper)];
  try {
    run(`INSERT INTO league_transactions_raw (league_id, season, tx_id, type, status, proposed_at, processed_at, team_id,
         scoring_period, items_json, first_seen_at, last_seen_at)
       VALUES (81, 2026, 'fx-2', 'FREEAGENT', 'EXECUTED', '2026-09-22T07:00:00.000Z', '2026-09-22T07:00:01.000Z', 1, 3,
         '[]', '2026-09-22T21:00:00.000Z', '2026-09-22T21:00:00.000Z')`);
    const before = count('engine_events');
    const t = await tick({ learnerBudgetMs: 100 });
    assert.equal(count('engine_events') - before, 1);
    assert.deepEqual(calls, { a: 1, b: 1, thrower: 1 });
    assert.equal(t.learners.dispatched, 4);
    const failed = t.learners.failures.map(f => `${f.learner}: ${f.error}`).sort();
    assert.equal(failed.length, 2);
    assert.match(failed[0], /^fx_sleeper: timed out after 100 ms/);
    assert.match(failed[1], /^fx_thrower: learner exploded/);
    assert.ok(t.runs.length > 0, 'the tick went on to its producers');
    const detail = JSON.parse(heartbeat().last_detail);
    assert.ok(detail.failed.some(f => f.what === 'learner fx_thrower'), 'the failure is not in the heartbeat detail');
    assert.ok(detail.failed.some(f => f.what === 'learner fx_sleeper'));
  } finally {
    offs.forEach(off => off());
  }
});

/* ------------------------------------------------------------------ RED (7), in process */
test('RED (7): a stop request mid-tick finishes the current source and stops before the next', async () => {
  run(`UPDATE league_transactions_raw SET status = 'CANCELED', last_seen_at = '2026-09-23T21:00:00.000Z' WHERE tx_id = 'fx-2'`);
  injury('00-0091003', 'Out', '2026-09-23T20:00:00Z');
  const injuriesCursor = cursorsMod.getCursor('engine-adapters', '1', 'injuries', db);
  let calls = 0;
  const t = await tick({ shouldStop: () => calls++ >= 1 });
  assert.equal(t.stopped, true);
  assert.deepEqual(t.adapters.map(a => a.stream), ['transactions'], 'the tick went past the source it was in');
  assert.equal(t.adapters[0].inserted, 1, 'the current source was not finished');
  assert.deepEqual(t.runs, [], 'a producer ran after the stop');
  assert.deepEqual(t.snapshots, []);
  assert.equal(cursorsMod.getCursor('engine-adapters', '1', 'injuries', db), injuriesCursor, 'a later source advanced');
  const resumed = await tick();
  assert.equal(resumed.events, 1, 'the next tick picks up where the stopped one left off');
});

/* ------------------------------------------------------------------ RED (9) */
test('RED (9): a declaration cycle refuses to start, and so does an input nobody writes', () => {
  need(dagMod, 'daemon/dag.js');
  const p = (name, fields, reads) => ({ name, fields, inputs: { fields: reads } });
  assert.throws(() => dagMod.buildDag([p('a', ['x.a'], ['x.b']), p('b', ['x.b'], ['x.c']), p('c', ['x.c'], ['x.a'])]),
    /declaration cycle: a -> b -> c -> a/);
  assert.throws(() => dagMod.buildDag([p('a', ['x.a'], ['x.missing'])]), /reads field x\.missing, which no declared producer writes/);
  const { order } = dagMod.buildDag([p('late', ['y.late'], ['y.early']), p('early', ['y.early'], [])]);
  assert.deepEqual(order.map(o => o.name), ['early', 'late']);
  need(producersMod, 'producers/index.js');
  const real = dagMod.buildDag(producersMod.daemonProducers()).order.map(o => o.name);
  assert.deepEqual(real, ['calendar', 'league', 'gamescript']);
});

/* ------------------------------------------------------------------ RED (1) */
test('RED (1): a second instance is refused while the first holds the lock; a dead pid\'s lock is taken over', () => {
  need(lockMod, 'daemon/lock.js');
  const file = path.join(temp, 'rl1.lock');
  const first = lockMod.acquireEngineLock(process.env.GRIDIRON_DB_PATH, { file });
  assert.throws(() => lockMod.acquireEngineLock(process.env.GRIDIRON_DB_PATH, { file }),
    new RegExp(`already running pid ${process.pid}`));
  assert.equal(first.held(), true);
  assert.equal(first.release(), true);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  assert.equal(lockMod.pidAlive(dead), false);
  fs.writeFileSync(file, JSON.stringify({ pid: dead, host: os.hostname(), started_at: 'earlier', token: 'x' }));
  const taken = lockMod.acquireEngineLock(process.env.GRIDIRON_DB_PATH, { file });
  assert.equal(taken.tookOver, true);
  assert.equal(taken.previous.pid, dead);
  taken.release();
  assert.equal(fs.existsSync(file), false);
});

/* ------------------------------------------------------------------ requests */
test('requests: an open request is leased and answered; a kind with no handler is answered with an error, never left open', async () => {
  need(requestsMod, 'daemon/requests.js');
  run(`INSERT INTO engine_requests (kind, params_hash, params_json, requested_at) VALUES ('fx_echo', 'h1', '{"x":1}', ?), ('rescore', 'h2', '{}', ?)`,
    new Date().toISOString(), new Date().toISOString());
  const seen = [];
  const off = requestsMod.registerRequestHandler('fx_echo', req => { seen.push(req.params.x); return { resultStateId: null }; });
  try {
    const out = await requestsMod.serveRequests(db, { budgetMs: 1000 });
    assert.deepEqual(out.map(o => [o.kind, o.ok]), [['fx_echo', true], ['rescore', false]]);
    assert.deepEqual(seen, [1]);
    assert.equal(row(`SELECT COUNT(*) AS n FROM engine_requests WHERE done_at IS NULL`).n, 0);
    assert.match(row(`SELECT error FROM engine_requests WHERE kind = 'rescore'`).error, /no handler/);
  } finally { off(); }
});

/* ------------------------------------------------------------------ the three producers */
const game = (season, week, home, away, { gameday, gametime = null, final = false, spread = -3, total = 44.5, fetched }) => {
  for (const [team, opp, isHome, sp] of [[home, away, 1, spread], [away, home, 0, -spread]]) {
    run(`INSERT INTO game_lines (season, week, team, opponent, home, spread, total, implied_points, source, fetched_at, gameday,
         gametime, team_score) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'fixture', ?, ?, ?, ?)
         ON CONFLICT (season, week, team) DO UPDATE SET team_score = excluded.team_score, fetched_at = excluded.fetched_at`,
    season, week, team, opp, isHome, sp, total, fetched, gameday, gametime, final ? 20 : null);
  }
};

test('calendar, league, gamescript: nfl.week, game.cutoff (= gameCutoff), league.week and game.script (= gameScriptFor arithmetic)', async () => {
  need(producersMod, 'producers/index.js');
  game(2026, 1, 'AAA', 'BBB', { gameday: '2026-09-10', gametime: '20:20', final: true, fetched: '2026-09-11 04:00:00' });
  game(2026, 1, 'CCC', 'DDD', { gameday: '2026-09-13', gametime: '13:00', final: true, fetched: '2026-09-14 04:00:00' });
  game(2026, 2, 'AAA', 'CCC', { gameday: '2026-09-20', gametime: '16:25', fetched: '2026-09-18 12:00:00' });
  game(2026, 3, 'EEE', 'FFF', { gameday: '2026-09-27', fetched: '2026-09-18 12:00:00', spread: -7 });
  run(`INSERT INTO gamescript_model (target, b0, b_spread, b_total, r2, n, fitted_at) VALUES
      ('pass_att', 20, 0.6, 0.35, 0.3, 500, '2026-09-01'), ('rush_att', 30, -0.7, 0.05, 0.2, 500, '2026-09-01')
      ON CONFLICT (target) DO UPDATE SET b0 = excluded.b0`);
  const dag = dagMod.buildDag(producersMod.daemonProducers()).order;
  const t = await tickMod.runTick({ database: db, dag });
  assert.equal(t.failed.length, 0, JSON.stringify(t.failed));
  const latest = (field, id) => {
    const r = row(`SELECT value, health FROM engine_state WHERE field = ? AND entity_id = ? ORDER BY id DESC LIMIT 1`, field, id);
    return r ? { value: r.value == null ? null : JSON.parse(r.value), health: JSON.parse(r.health) } : null;
  };
  const w1 = latest('nfl.week', '2026:1').value;
  const w2 = latest('nfl.week', '2026:2').value;
  assert.deepEqual([w1.status, w1.current, w1.finals, w1.games], ['final', false, 2, 2]);
  assert.deepEqual([w2.status, w2.current], ['in_progress', true], 'week 2 kicked off before now and has a game left');
  assert.equal(latest('nfl.week', '2026:3').value.status, 'upcoming');
  const { gameCutoff } = await import('../server/services/game-cutoff.js');
  for (const [id, s, w, home] of [['2026:2:AAA', 2026, 2, 'AAA'], ['2026:3:EEE', 2026, 3, 'EEE'], ['2026:1:CCC', 2026, 1, 'CCC']]) {
    assert.equal(latest('game.cutoff', id).value.kickoff, gameCutoff(s, w, home), `game.cutoff ${id} differs from gameCutoff`);
  }
  assert.equal(latest('game.cutoff', '2026:3:EEE').value.basis, 'end_of_day');
  assert.deepEqual(latest('league.week', '81').value, { season: 2026, week: 3, basis: 'lineups' });
  // Every fixture total is 44.5, so gameScriptFor's neutral total (all lines) equals ours (prior lines).
  const { gameScriptFor, clearGameScriptCache } = await import('../server/services/gamescript.js');
  clearGameScriptCache();
  const script = latest('game.script', '2026:2:AAA').value;
  for (const [side, team] of [['home', 'AAA'], ['away', 'CCC']]) {
    const legacy = gameScriptFor(team, 2026, 2);
    assert.deepEqual([script[side].pass_mult, script[side].rush_mult], [legacy.pass_mult, legacy.rush_mult], `${team} differs`);
  }
  assert.ok(latest('game.script', '2026:3:EEE'), 'a later week of the season is written too');
  assert.equal(latest('game.script', '2026:1:AAA'), null, 'a past week is not');
  const snap = snapshotsMod.latestSnapshot(0, db);
  assert.deepEqual([snap.season, snap.nfl_week], [2026, 2]);
  assert.equal(snap.world, snapshotsMod.worldSeed(2026, 2));
  assert.deepEqual(snap.version_set, { calendar: 'ea02-1', league: 'ea02-1', gamescript: 'ea02-1' });
  const again = await tickMod.runTick({ database: db, dag });
  assert.equal(again.runs.reduce((a, r) => a + r.written, 0), 0, 'the tiny producers rewrote an unchanged world');
  assert.ok(again.runs.every(r => r.ms < 30000));
});

/* ------------------------------------------------------------------ RED (5), (13) */
const hookScript = (name, body) => { const f = path.join(temp, name); fs.writeFileSync(f, body); return f; };
const at = iso => new Date(iso);

test('RED (5): the nightly hook fires once per local day, the weekly hook once per scoring period, never without the lock', async () => {
  need(hooksMod, 'daemon/hooks.js');
  const results = [];
  const offs = [
    hooksMod.registerHook('nightly', { name: 'fx-nightly', command: [hookScript('n.mjs', 'console.log(JSON.stringify({ok:"n"}))')],
      onResult: j => { results.push(`nightly:${j.ok}`); } }),
    hooksMod.registerHook('weekly', { name: 'fx-weekly', command: [hookScript('w.mjs', 'console.log(JSON.stringify({ok:"w"}))')],
      onResult: (j, { period }) => { results.push(`weekly:${period}`); } }),
  ];
  const hooks = hooksMod.createHookRunner({ database: db });
  const held = { held: () => true };
  const lost = { held: () => false };
  const dag = dagMod.buildDag(producersMod.daemonProducers()).order;
  const beat = async (iso, lock = held) => { const t = await tickMod.runTick({ database: db, dag, hooks, lock, now: at(iso) }); await hooks.idle(); return t; };
  try {
    let t = await beat('2026-10-01T05:00:00Z'); // 01:00 ET: too early
    assert.deepEqual(t.hooks.filter(h => h.schedule === 'nightly'), []);
    assert.deepEqual(t.hooks.map(h => `${h.schedule}:${h.period}`), ['weekly:2026:1'], 'week 1 is final');
    t = await beat('2026-10-01T08:00:00Z', lost); // 04:00 ET, but this tick lost the lock
    assert.deepEqual(t.hooks, []);
    assert.ok(t.failed.some(f => f.what === 'engine.lock'));
    t = await beat('2026-10-01T08:10:00Z');
    assert.deepEqual(t.hooks.map(h => `${h.schedule}:${h.period}`), ['nightly:2026-10-01']);
    t = await beat('2026-10-01T20:00:00Z');
    assert.deepEqual(t.hooks, [], 'a second nightly the same day');
    game(2026, 2, 'AAA', 'CCC', { gameday: '2026-09-20', gametime: '16:25', final: true, fetched: '2026-09-21 04:00:00' });
    t = await beat('2026-10-02T08:30:00Z');
    assert.deepEqual(t.hooks.map(h => `${h.schedule}:${h.period}`).sort(), ['nightly:2026-10-02', 'weekly:2026:2']);
    t = await beat('2026-10-02T09:30:00Z');
    assert.deepEqual(t.hooks, []);
    // Two children started in one tick finish in either order: compare as a multiset.
    assert.deepEqual([...results].sort(), ['nightly:n', 'nightly:n', 'weekly:2026:1', 'weekly:2026:2']);
    const done = rows(`SELECT scope_key, error FROM engine_runs WHERE producer = 'engine-hooks' AND finished_at IS NOT NULL`);
    assert.equal(done.length, 4);
    assert.ok(done.every(r => r.error == null), JSON.stringify(done));
  } finally { offs.forEach(off => off()); }
});

test('RED (13): a child past its lease is killed and the tick continues', { timeout: 20000 }, async () => {
  const off = hooksMod.registerHook('nightly', { name: 'fx-stuck', leaseMs: 300,
    command: [hookScript('stuck.mjs', 'setInterval(() => {}, 1000)')] });
  const hooks = hooksMod.createHookRunner({ database: db });
  try {
    const first = await tickMod.runTick({ database: db, dag: [], hooks, lock: { held: () => true }, now: at('2026-10-03T08:00:00Z') });
    assert.equal(first.hooks[0].hooks[0].started, true);
    await new Promise(r => setTimeout(r, 400));
    const second = await tickMod.runTick({ database: db, dag: [], hooks, lock: { held: () => true },
      now: new Date(Date.parse('2026-10-03T08:00:00Z') + 400) });
    assert.ok(second.failed.some(f => f.what === 'hook nightly:fx-stuck' && /lease expired/.test(f.error)), JSON.stringify(second.failed));
    assert.ok(second.snapshots !== undefined && second.ms >= 0, 'the tick did not complete');
    await hooks.idle();
    assert.match(row(`SELECT error FROM engine_runs WHERE producer = 'engine-hooks' AND scope_key = 'nightly:fx-stuck'
        AND finished_at IS NOT NULL`).error, /lease expired/);
  } finally { off(); }
});

/* ------------------------------------------------------------------ RED (6)/(14) */
test('RED (6)/(14): nothing under server/index.js or server/routes/ imports engine/daemon/; the refresh job imports no engine code', () => {
  const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : /\.(m?js)$/.test(d.name) ? [path.join(dir, d.name)] : []);
  const web = ['server/index.js', ...walk('server/routes')];
  const importsDaemon = /(import|from)\s*\(?\s*['"][^'"]*engine\/daemon\//;
  assert.ok(importsDaemon.test(read('scripts/engine-daemon.mjs')), 'control: the grep finds the daemon entry\'s import');
  assert.deepEqual(web.filter(f => importsDaemon.test(read(f))), []);
  const importsEngine = /(import|from)\s*\(?\s*['"][^'"]*services\/engine\//;
  assert.deepEqual(['scripts/refresh-live-data.mjs', 'server/services/process-lock.js'].filter(f => importsEngine.test(read(f))), []);
});

/* ------------------------------------------------------------------ processes */
const childEnv = extra => ({ ...process.env, GRIDIRON_PROCESS_ROLE: '', NODE_OPTIONS: '', ...extra });
function waitFor(check, ms = 20000, what = 'condition') {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let v; try { v = check(); } catch { v = null; }
      if (v) return resolve(v);
      if (Date.now() > until) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(poll, 50);
    };
    poll();
  });
}
function runScript(args, env, ms = 60000) {
  return new Promise(resolve => {
    const c = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => c.kill('SIGKILL'), ms);
    c.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
const readLock = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

test('RED (1), as processes: a second daemon exits non-zero naming the running pid', async () => {
  const file = path.join(temp, 'engine-proc.lock');
  const held = lockMod.acquireEngineLock(process.env.GRIDIRON_DB_PATH, { file });
  try {
    const r = await runScript(['scripts/engine-daemon.mjs', '--once'], childEnv({ GRIDIRON_ENGINE_LOCK: file }));
    assert.equal(r.code, 3, r.err);
    assert.match(r.err, new RegExp(`already running pid ${process.pid}`));
  } finally { held.release(); }
  const r = await runScript(['scripts/engine-daemon.mjs', '--loop', '60'], childEnv({ GRIDIRON_ENGINE_LOCK: file }));
  assert.equal(r.code, 64, '--loop outside 300-900 s is refused');
});

test('RED (12): a second refresh loop exits non-zero', async () => {
  const file = path.join(temp, 'refresh.lock');
  const { acquireLock } = await import('../server/services/process-lock.js');
  const held = acquireLock(file, { name: 'refresh-live-data' });
  try {
    const r = await runScript(['scripts/refresh-live-data.mjs', '--loop', '900'], childEnv({ GRIDIRON_REFRESH_LOCK: file }));
    assert.equal(r.code, 3, r.err);
    assert.match(r.err, new RegExp(`already running pid ${process.pid}`));
  } finally { held.release(); }
});

test('RED (7), as a process: SIGTERM exits 0 and releases engine.lock', async () => {
  const file = path.join(temp, 'engine-term.lock');
  const c = spawn(process.execPath, ['scripts/engine-daemon.mjs', '--loop', '300'], { cwd: root,
    env: childEnv({ GRIDIRON_ENGINE_LOCK: file }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
  const exited = new Promise(resolve => c.on('close', code => resolve(code)));
  try {
    await waitFor(() => /tick \S+ \(start/.test(out), 30000, `the first tick (stderr: ${err})`);
    assert.equal(readLock(file)?.pid, c.pid);
    c.kill('SIGTERM');
    assert.equal(await exited, 0, err);
    assert.equal(fs.existsSync(file), false, 'engine.lock was left behind');
  } finally { c.kill('SIGKILL'); }
});

test('RED (15): the supervisor restarts a killed daemon, which takes over its stale lock', async () => {
  need(startAll, 'scripts/start-all.mjs');
  const file = path.join(temp, 'engine-sup.lock');
  const sup = startAll.createSupervisor({ children: [{ name: 'engine', args: ['scripts/engine-daemon.mjs', '--loop', '300'] }],
    cwd: root, env: childEnv({ GRIDIRON_ENGINE_LOCK: file }), stdio: 'ignore', backoff: () => 100 }).start();
  try {
    const first = sup.child('engine').pid;
    await waitFor(() => readLock(file)?.pid === first, 30000, 'the first daemon to take the lock');
    sup.child('engine').kill('SIGKILL');
    const second = await waitFor(() => { const c = sup.child('engine'); return c && c.pid !== first ? c.pid : null; }, 10000, 'a restart');
    await waitFor(() => readLock(file)?.pid === second, 30000, 'the restarted daemon to take over the stale lock');
    assert.equal(sup.status()[0].restarts, 1);
    assert.equal(sup.status()[0].last_exit.signal, 'SIGKILL');
  } finally {
    await sup.stop('SIGTERM');
  }
  assert.equal(fs.existsSync(file), false, 'the stopped daemon left its lock');
});
