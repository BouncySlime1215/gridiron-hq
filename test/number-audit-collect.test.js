/**
 * BROKEN-01a: the collector reads the app's real producers (not copies of them).
 *
 * A six-team ESPN league in week 6 (the B-01 fixture shape: seeded players, a
 * market, a round-robin schedule with five scored weeks). collectLeagueSnapshot
 * is run end to end: every producer it names must exist and answer, either with
 * numbers or with a named error that becomes a 'warn' row. A renamed export or a
 * changed return shape fails here instead of turning every live row into
 * "could not measure".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-number-audit-collect-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '6';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const { deriveFormat } = await import('../server/services/format.js');
const { collectLeagueSnapshot, evaluateSnapshot, runNumberAudit, readNumberAudit, CHECKS } =
  await import('../server/services/number-audit.js');

await runMigrations();
seedIfEmpty();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
const CURRENT_WEEK = 6;

function seedMarket(players) {
  const { formatKey } = deriveFormat({ team_count: 6, ppr: null, league_type: null, best_ball: 0, payload: null,
    roster_positions: JSON.stringify(SLOTS) });
  const now = new Date().toISOString();
  players.forEach((p, i) => {
    const proj = 320 - i * 3;
    run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games, raw, fetched_at)
         VALUES (?, 2026, 'projected', ?, 17, '{}', ?)
         ON CONFLICT(player_id, season, kind) DO UPDATE SET fantasy_points = excluded.fantasy_points`, p.id, proj, now);
    run(`INSERT INTO dynasty_values (format_key, player_id, value, redraft_value, trend30, age, pos_rank, fetched_at)
         VALUES (?, ?, ?, ?, 0, 26, ?, ?)
         ON CONFLICT(format_key, player_id) DO UPDATE SET value = excluded.value, redraft_value = excluded.redraft_value`,
    formatKey, p.id, Math.round(proj * 3), Math.round(proj * 3), i + 1, now);
  });
}

function schedule() {
  const out = [];
  const ids = [1, 2, 3, 4, 5, 6];
  for (let w = 1; w <= 14; w++) {
    const rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + w - 1) % 5)])];
    for (let i = 0; i < 3; i++) {
      const home = rot[i], away = rot[5 - i];
      const done = w < CURRENT_WEEK;
      out.push({ matchupPeriodId: w,
        home: { teamId: home, totalPoints: done ? 100 + home : undefined },
        away: { teamId: away, totalPoints: done ? 95 + away : undefined } });
    }
  }
  return out;
}

function league() {
  const pick = (pos, n) => rows(`SELECT id, name, position FROM players WHERE position = ? AND fantasy_relevant = 1
                                 ORDER BY id LIMIT ?`, pos, n);
  const qb = pick('QB', 6), rb = pick('RB', 18), wr = pick('WR', 18), te = pick('TE', 6);
  seedMarket([...qb, ...rb, ...wr, ...te]);
  let fakeId = 960000;
  const teams = [];
  for (let i = 0; i < 6; i++) {
    const roster = [qb[i], rb[i], rb[11 - i], rb[12 + i], wr[5 - i], wr[6 + i], wr[17 - i], te[5 - i]].filter(Boolean);
    teams.push({ id: i + 1, name: `Team ${i + 1}`, owners: [`{M${i + 1}}`],
      roster: { entries: roster.map(p => ({
        playerPoolEntry: { player: { id: fakeId++, fullName: p.name, defaultPositionId: POS_ID[p.position] } } })) } });
  }
  const payload = { teams, members: [], schedule: schedule(),
    settings: { name: 'Audit League', scheduleSettings: { matchupPeriodCount: 14, matchupPeriodLength: 1,
      playoffTeamCount: 4, playoffMatchupPeriodLength: 1,
      playoffReseed: false, playoffSeedingRule: 'TOTAL_POINTS_SCORED', divisions: [{ id: 0, size: 6 }] } } };
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status, current_week, payload_season, fetched_at)
       VALUES (701, 'espn', 'espn-audit-701', 2026, 'Audit League', ?, 6, '1', ?, 'x', 'y', 'connected', ?, 2026, datetime('now'))`,
  JSON.stringify(payload), JSON.stringify(SLOTS), CURRENT_WEEK);
  return rows('SELECT * FROM leagues WHERE id = 701')[0];
}

test('collectLeagueSnapshot reads every producer and the checks evaluate it', async () => {
  const lg = league();
  const snap = await collectLeagueSnapshot(lg);
  const problems = [];
  // The simulator paths ran on this league: the two full ones serve every team.
  for (const id of ['my_team', 'trade_lab']) {
    const p = snap.title_paths.find(x => x.id === id);
    if (p.error) problems.push(`${id}: ${p.error}`);
    else assert.equal(Object.keys(p.title).length, 6, `${id} serves all six teams`);
  }
  const weeks = Object.fromEntries(snap.current_weeks.map(w => [w.id, w.week ?? w.error]));
  assert.deepEqual(weeks, { trade_engine: 6, league_week: 6, season_sim: 6 });
  for (const r of snap.weekly_ranges) {
    if (r.error) problems.push(`${r.id}: ${r.error}`);
  }
  if (snap.projection_basis.error) problems.push(`projection_basis: ${snap.projection_basis.error}`);
  if (snap.p_play.error) problems.push(`p_play: ${snap.p_play.error}`);
  assert.equal(snap.checked_out.error, undefined, snap.checked_out.error);
  assert.equal(snap.sources[0].as_of, lg.fetched_at);
  // Any failure left must be a named producer error, never a TypeError from the
  // collector calling a function that does not exist or reading a shape that changed.
  for (const p of problems) assert.doesNotMatch(p, /is not a function|Cannot read properties|is not defined/, p);

  const out = evaluateSnapshot(snap);
  assert.deepEqual(out.map(r => r.check_id).sort(), Object.keys(CHECKS).sort());
  for (const r of out) assert.ok(['ok', 'warn', 'broken'].includes(r.status), `${r.check_id}: ${r.status}`);

  const res = await runNumberAudit({ leagues: [lg], collect: async () => snap, log: () => {} });
  assert.deepEqual(res.audited.map(a => a.league_id), [701]);
  assert.equal(readNumberAudit(701).rows.length, out.length);
});
