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

function sleeperReturns(payload) {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
}
const sp = (id, name, pos, status) => ({ player_id: String(id), full_name: name, position: pos, search_rank: 50, injury_status: status });
const flag = pid => db.prepare(`SELECT value FROM player_metrics WHERE player_id = ? AND source = 'injury_flag'`).get(pid);

function reset() {
  for (const t of ['player_metrics', 'player_week_usage', 'player_week_snaps', 'schedule_games', 'players']) db.exec(`DELETE FROM ${t}`);
}

test('a player Sleeper stops listing as injured is unflagged (update, not delete) and counted', async () => {
  reset();
  const ins = db.prepare('INSERT INTO players (id, name, position, sleeper_id) VALUES (?,?,?,?)');
  ins.run(1, 'Healed Back', 'RB', '9001');
  ins.run(2, 'Still Hurt', 'WR', '9002');
  ins.run(3, 'Newly Hurt', 'TE', '9003');

  sleeperReturns({ a: sp(9001, 'Healed Back', 'RB', 'Questionable'), b: sp(9002, 'Still Hurt', 'WR', 'Out'), c: sp(9003, 'Newly Hurt', 'TE', null) });
  await syncSleeper();
  assert.equal(flag(1)?.value, 1, 'run 1 flags the Questionable player');
  assert.equal(flag(3), undefined, 'a player never injured gets no row');

  sleeperReturns({ a: sp(9001, 'Healed Back', 'RB', null), b: sp(9002, 'Still Hurt', 'WR', 'Out'), c: sp(9003, 'Newly Hurt', 'TE', 'IR') });
  const result = await syncSleeper();

  assert.equal(flag(1)?.value, 0, 'healed player: flag must be cleared after the next sync');
  assert.equal(flag(2)?.value, 1, 'still-injured player keeps his flag');
  assert.equal(flag(3)?.value, 1, 'newly injured player is inserted');
  assert.equal(result.cleared, 1, 'sync reports how many flags it cleared');
  const n = db.prepare(`SELECT COUNT(*) n FROM player_metrics WHERE source = 'injury_flag'`).get().n;
  assert.equal(n, 3, 'clearing updates the row; nothing is deleted');
});

test('a player Sleeper did not match this run keeps his flag (a partial pull cannot wipe flags)', async () => {
  reset();
  db.prepare('INSERT INTO players (id, name, position, sleeper_id) VALUES (?,?,?,?)').run(4, 'Absent Guy', 'RB', '9004');
  db.prepare('INSERT INTO players (id, name, position, sleeper_id) VALUES (?,?,?,?)').run(5, 'Present Guy', 'RB', '9005');
  db.prepare(`INSERT INTO player_metrics (player_id, source, value, fetched_at) VALUES (4,'injury_flag',1,datetime('now'))`).run();
  sleeperReturns({ e: sp(9005, 'Present Guy', 'RB', null) });
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
  flagAt.run(11, '-1 days');
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
