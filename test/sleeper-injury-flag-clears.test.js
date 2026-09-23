/**
 * RL-12-2 (2026-09-23): the Sleeper injury flag was set but never cleared.
 *
 * `syncSleeper()` (server/routes/aggregates.js) upserted
 * `player_metrics(source='injury_flag', value=1)` whenever Sleeper listed an
 * `injury_status`, and had no branch for a player Sleeper lists as healthy
 * (null status). One Questionable tag marked a player down for the rest of the
 * season: x0.82 on his durability prior (contingency.js availability), a ✚ and
 * "Sell the Injury Risk" on trade cards, and an AI fact.
 *
 * These tests pin:
 *  1. a player flagged on run 1 and healthy on run 2 has value 0 after run 2,
 *     the row is updated (not deleted), and the sync reports how many it cleared;
 *  2. a player still injured stays flagged and a newly injured one is inserted;
 *  3. a flag Sleeper has not re-confirmed for more than STALE_FLAG_DAYS, on a
 *     player who took snaps in the latest loaded week (a week that started after
 *     the flag), is ignored by the one producer and by availability();
 *  4. a stale flag without snaps, a fresh flag with snaps, and a stale flag whose
 *     latest game started before the flag are all still honoured.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-injury-flag-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { db } = await import('../server/db/index.js');
const { syncSleeper } = await import('../server/routes/aggregates.js');
const { availability } = await import('../server/services/contingency.js');

const realFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function sleeperReturns(payload, t) {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
  t.after(() => { globalThis.fetch = realFetch; });
}
const sp = (id, name, pos, status) => ({ player_id: String(id), full_name: name, position: pos, search_rank: 50, injury_status: status });
const flag = pid => db.prepare(`SELECT value FROM player_metrics WHERE player_id = ? AND source = 'injury_flag'`).get(pid);

function reset() {
  for (const t of ['ranking_entries', 'ranking_sets', 'player_metrics', 'player_week_usage', 'player_week_snaps', 'schedule_games', 'players']) db.exec(`DELETE FROM ${t}`);
}

test('a player Sleeper stops listing as injured is unflagged (update, not delete) and counted', async t => {
  reset();
  const ins = db.prepare('INSERT INTO players (id, name, position, sleeper_id) VALUES (?,?,?,?)');
  ins.run(1, 'Healed Back', 'RB', '9001');
  ins.run(2, 'Still Hurt', 'WR', '9002');
  ins.run(3, 'Newly Hurt', 'TE', '9003');

  sleeperReturns({ a: sp(9001, 'Healed Back', 'RB', 'Questionable'), b: sp(9002, 'Still Hurt', 'WR', 'Out'), c: sp(9003, 'Newly Hurt', 'TE', null) }, t);
  await syncSleeper();
  assert.equal(flag(1)?.value, 1, 'run 1 flags the Questionable player');
  assert.equal(flag(3), undefined, 'a player never injured gets no row');

  sleeperReturns({ a: sp(9001, 'Healed Back', 'RB', null), b: sp(9002, 'Still Hurt', 'WR', 'Out'), c: sp(9003, 'Newly Hurt', 'TE', 'IR') }, t);
  const result = await syncSleeper();

  assert.equal(flag(1)?.value, 0, 'healed player: flag must be cleared after the next sync');
  assert.equal(flag(2)?.value, 1, 'still-injured player keeps his flag');
  assert.equal(flag(3)?.value, 1, 'newly injured player is inserted');
  assert.equal(result.cleared, 1, 'sync reports how many flags it cleared');
  const n = db.prepare(`SELECT COUNT(*) n FROM player_metrics WHERE source = 'injury_flag'`).get().n;
  assert.equal(n, 3, 'clearing updates the row; nothing is deleted');

  // A flag already at 0 is not cleared again: the daily count stays honest and
  // fetched_at is not re-stamped (skeptic mutant U1 drops `AND value <> 0`).
  db.prepare(`UPDATE player_metrics SET fetched_at = '2026-01-01 00:00:00' WHERE player_id = 1 AND source = 'injury_flag'`).run();
  const again = await syncSleeper();
  assert.equal(again.cleared, 0, 'an already-cleared flag is not counted again');
  const at = db.prepare(`SELECT fetched_at FROM player_metrics WHERE player_id = 1 AND source = 'injury_flag'`).get().fetched_at;
  assert.equal(at, '2026-01-01 00:00:00', 'an already-cleared flag is not re-stamped');
});

test('a player Sleeper did not match this run keeps his flag (a partial pull cannot wipe flags)', async t => {
  reset();
  db.prepare('INSERT INTO players (id, name, position, sleeper_id) VALUES (?,?,?,?)').run(4, 'Absent Guy', 'RB', '9004');
  db.prepare('INSERT INTO players (id, name, position, sleeper_id) VALUES (?,?,?,?)').run(5, 'Present Guy', 'RB', '9005');
  db.prepare(`INSERT INTO player_metrics (player_id, source, value, fetched_at) VALUES (4,'injury_flag',1,datetime('now'))`).run();
  sleeperReturns({ e: sp(9005, 'Present Guy', 'RB', null) }, t);
  const result = await syncSleeper();
  assert.equal(flag(4)?.value, 1);
  assert.equal(result.cleared, 0);
});

function seedStale({ weekStartDaysAgo = 3 } = {}) {
  reset();
  const team = db.prepare('SELECT id FROM nfl_teams ORDER BY id LIMIT 1').get()?.id
    ?? Number(db.prepare(`INSERT INTO nfl_teams (abbr, name, conference, division) VALUES ('TST','Test','AFC','East')`).run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO players (id, name, position) VALUES (?,?,?)');
  const usage = db.prepare('INSERT INTO player_week_usage (player_id, season, week, position) VALUES (?,?,?,?)');
  const snaps = db.prepare('INSERT INTO player_week_snaps (player_id, season, week, offense_snaps, offense_pct) VALUES (?,?,?,?,?)');
  const flagAt = db.prepare(`INSERT INTO player_metrics (player_id, source, value, fetched_at) VALUES (?, 'injury_flag', 1, datetime('now', ?))`);
  // 10 stale-and-played, 11 fresh-and-played, 12 stale-and-benched, 13 unflagged twin.
  for (const id of [10, 11, 12, 13]) {
    ins.run(id, `Player ${id}`, 'WR');
    for (let w = 1; w <= 14; w++) usage.run(id, 2025, w, 'WR');
    snaps.run(id, 2026, 1, 50, 0.8);
    snaps.run(id, 2026, 2, id === 12 ? 0 : 50, id === 12 ? 0 : 0.8);
  }
  flagAt.run(10, '-10 days');
  // 5 days: younger than STALE_FLAG_DAYS but older than the week-2 start, so only the age check keeps it.
  flagAt.run(11, '-5 days');
  flagAt.run(12, '-10 days');
  db.prepare(`INSERT INTO schedule_games (season, team_id, week, date) VALUES (2026, ?, 1, date('now', '-20 days'))`).run(team);
  db.prepare(`INSERT INTO schedule_games (season, team_id, week, date) VALUES (2026, ?, 2, date('now', ?))`).run(team, `-${weekStartDaysAgo} days`);
}

test('a stale flag on a player who played in the latest week is ignored by availability()', () => {
  seedStale();
  const av = availability();
  const twin = av.get(13).available;
  assert.equal(av.get(10).available, twin, 'stale flag + snaps in the latest week: no x0.82 penalty');
  assert.ok(av.get(11).available < twin, 'control: a fresh flag is still penalised');
  assert.ok(av.get(12).available < twin, 'control: a stale flag on a player with no snaps is still penalised');
});

test('the one producer reports which stale flags it ignored', async () => {
  seedStale();
  const { injuryFlagState, activeInjuryFlagIds } = await import('../server/services/injury-flags.js');
  const st = injuryFlagState();
  assert.deepEqual([...st.active].sort(), [11, 12]);
  assert.deepEqual(st.ignored.map(x => x.player_id), [10]);
  assert.equal(st.ignored[0].season, 2026);
  assert.equal(st.ignored[0].week, 2);
  assert.deepEqual([...activeInjuryFlagIds()].sort(), [11, 12]);
});

test('a stale flag whose latest game started before the flag is still honoured', async () => {
  seedStale({ weekStartDaysAgo: 12 });
  const { injuryFlagState } = await import('../server/services/injury-flags.js');
  const st = injuryFlagState();
  assert.deepEqual([...st.active].sort(), [10, 11, 12]);
  assert.equal(st.ignored.length, 0);
});

// Structural pin (widened after the skeptic pass): every server file that reads
// player_metrics and names injury_flag (a WHERE, a LEFT JOIN, or a generic
// source -> value map as in players.js), other than the producer, must import
// and call the producer. The list is discovered, not hand-written. Control: the
// scan must find the known readers. contingency.js and trade-engine.js no longer
// name the flag at all; their behaviour is pinned by the tests below.
test('every server file that reads injury_flag goes through services/injury-flags.js', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'server');
  const files = fs.readdirSync(root, { recursive: true }).filter(f => f.endsWith('.js')).map(String);
  const names = /(?<![a-z_])injury_flag\b/;
  const readers = files.filter(f => {
    if (f === path.join('services', 'injury-flags.js')) return false;
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    return names.test(src) && /player_metrics/.test(src);
  });
  for (const known of ['routes/aggregates.js', 'routes/rankings.js', 'routes/players.js', 'services/draft-assist.js']) {
    assert.ok(readers.includes(path.join(...known.split('/'))), `control: scan finds ${known}`);
  }
  for (const f of readers) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.match(src, /import \{ activeInjuryFlagIds \} from '(\.\/|\.\.\/services\/)injury-flags\.js'/, `${f} imports the producer`);
    assert.ok((src.match(/activeInjuryFlagIds\(/g) ?? []).length >= 1, `${f} calls the producer`);
  }
});

// Behaviour at each call site on the stale fixture: player 10 (stale, played) off, 11 (fresh) on.
function giveMarket() {
  const m = db.prepare(`INSERT INTO player_metrics (player_id, source, value, fetched_at) VALUES (?,?,?,datetime('now'))`);
  for (const [id, r] of [[10, 5], [11, 6], [13, 7]]) { m.run(id, 'sleeper_rank', r); m.run(id, 'ffc_adp', r); }
}

test('computeConsensus (GET /aggregates, draft board, draft AI) shows the stale flag as off', async () => {
  seedStale(); giveMarket();
  const { computeConsensus } = await import('../server/routes/aggregates.js');
  const byId = Object.fromEntries(computeConsensus().map(p => [p.id, p.injury_flag]));
  assert.equal(byId[10], 0, 'stale flag reads as off');
  assert.equal(byId[11], 1, 'control: live flag reads as on');
  assert.equal(byId[13], null, 'never-flagged player has no flag');
});

test('playerDossier shows the stale flag as off', async () => {
  seedStale();
  const { playerDossier } = await import('../server/services/draft-assist.js');
  assert.equal(playerDossier(10).injury_flag, 0, 'stale flag reads as off');
  assert.equal(playerDossier(11).injury_flag, 1, 'control: live flag reads as on');
});

test('GET /players/:id metrics show the stale flag as off', async () => {
  seedStale();
  const express = (await import('express')).default;
  const players = (await import('../server/routes/players.js')).default;
  const app = express().use('/players', players);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const get = async id => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/players/${id}`);
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
      return body.metrics.injury_flag;
    };
    assert.equal(await get(10), 0, 'stale flag reads as off');
    assert.equal(await get(11), 1, 'control: live flag reads as on');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

function tradeLeague() {
  db.prepare('DELETE FROM leagues WHERE id = 71').run();
  db.prepare(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload, fetched_at)
              VALUES (71, 'espn', 'inj-71', 2026, 'Injury', '1', 10, 1, ?, '2026-09-18 01:00:00')`)
    .run(JSON.stringify({ teams: [{ id: 1, name: 'Mine', roster: { entries: [] } }] }));
  return db.prepare('SELECT * FROM leagues WHERE id = 71').get();
}

test('assetUniverse (trade cards, Sell the Injury Risk) treats the stale flag as off', async () => {
  seedStale();
  const lg = tradeLeague();
  const { assetUniverse } = await import('../server/services/trade-engine.js');
  const { deriveFormat } = await import('../server/services/format.js');
  const u = assetUniverse(lg, deriveFormat(lg).formatKey);
  assert.equal(u.get(10).injury, 0, 'stale flag is not an injury');
  assert.equal(u.get(11).injury, 1, 'control: live flag is an injury');
  assert.equal(u.get(13).injury, 0, 'never-flagged player is not an injury');
});

test('a clearing sync and a flag going stale by the clock both rebuild the trade universe', async t => {
  reset();
  const lg = tradeLeague();
  const { assetUniverse } = await import('../server/services/trade-engine.js');
  const { deriveFormat } = await import('../server/services/format.js');
  const universe = () => assetUniverse(lg, deriveFormat(lg).formatKey);
  db.prepare('INSERT INTO players (id, name, position, sleeper_id) VALUES (?,?,?,?)').run(1, 'Healed Back', 'RB', '9001');
  sleeperReturns({ a: sp(9001, 'Healed Back', 'RB', 'Questionable') }, t);
  await syncSleeper();
  // Pin every fetched_at so only the clear itself can move the fingerprint.
  db.prepare(`UPDATE player_metrics SET fetched_at = '2026-09-01 00:00:00'`).run();
  const before = universe();
  assert.equal(before.get(1).injury, 1);
  assert.equal(universe(), before, 'control: no change serves the cached universe');
  sleeperReturns({ a: sp(9001, 'Healed Back', 'RB', null) }, t);
  assert.equal((await syncSleeper()).cleared, 1);
  const after = universe();
  assert.notEqual(after, before, 'a clearing sync must not serve the cached injured set');
  assert.equal(after.get(1).injury, 0);

  // Same row count, no flag change: an in-place ffc_adp re-sync (read by vorBoard)
  // must still rebuild, which only the fetched_at stamp sees.
  db.prepare(`INSERT INTO player_metrics (player_id, source, value, fetched_at) VALUES (1,'ffc_adp',40,'2026-09-01 00:00:00')`).run();
  db.prepare(`UPDATE player_metrics SET fetched_at = '2026-09-01 00:00:00'`).run();
  const adpBefore = universe();
  db.prepare(`UPDATE player_metrics SET value = 12, fetched_at = '2026-09-02 00:00:00' WHERE player_id = 1 AND source = 'ffc_adp'`).run();
  assert.notEqual(universe(), adpBefore, 'an in-place player_metrics update must rebuild the universe');

  // Stale by the clock alone: no table write, only the producer's answer changes.
  seedStale({ weekStartDaysAgo: 3 });
  db.prepare(`UPDATE player_metrics SET fetched_at = datetime('now', '-5 days') WHERE player_id = 10`).run();
  const fresh = universe();
  assert.equal(fresh.get(10).injury, 1, 'a 5-day flag is live');
  const { activeInjuryFlagIds } = await import('../server/services/injury-flags.js');
  const real = Date;
  // Advance the producer's clock 6 days: the same row is now 11 days old.
  globalThis.Date = class extends real { constructor(...a) { super(...(a.length ? a : [real.now() + 6 * 864e5])); } static now() { return real.now() + 6 * 864e5; } };
  try {
    assert.equal(activeInjuryFlagIds().has(10), false, 'control: the producer now ignores the flag');
    assert.equal(universe().get(10).injury, 0, 'the cached universe must follow the producer');
  } finally { globalThis.Date = real; }
});

test('GET /rankings/:id/entries shows the stale flag as off and the live one as on', async () => {
  seedStale();
  const express = (await import('express')).default;
  const rankings = (await import('../server/routes/rankings.js')).default;
  const setId = Number(db.prepare(`INSERT INTO ranking_sets (name) VALUES ('t')`).run().lastInsertRowid);
  const ins = db.prepare('INSERT INTO ranking_entries (set_id, player_id, rank) VALUES (?,?,?)');
  ins.run(setId, 10, 1); ins.run(setId, 11, 2); ins.run(setId, 13, 3);
  const app = express().use('/rankings', rankings);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/rankings/${setId}/entries`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body), JSON.stringify(body).slice(0, 300));
    const byId = Object.fromEntries(body.map(e => [e.player_id, e.injury_flag]));
    assert.equal(byId[10], 0, 'stale flag reads as off');
    assert.equal(byId[11], 1, 'control: live flag reads as on');
    assert.equal(byId[13], null, 'never-flagged player has no flag');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
