/**
 * "Over the season" was a fixed multiply by 17, in every week of the season.
 *
 * `evaluate()` reported `season_delta` as the per-week lineup gain times
 * `GAMES`, a constant equal to the length of an NFL regular season — not to the
 * length of what is left of one. Two surfaces print it and both call it the
 * season: `client/src/components/TradeCard.tsx:109`, and the LLM prompt at
 * `server/routes/trades.js:1055`, which means a wrong magnitude does not only
 * mislead a reader, it conditions the generated reasoning about the trade.
 *
 * The error is small early and large late. At week 2 of a 17-week league, 16
 * weeks remain and ×17 overstates by about 6%. At week 10, 8 remain and it
 * overstates by 113% — the card claims more than twice the points the trade can
 * still deliver. At week 15 it is ×17 against three, which is when a manager is
 * most willing to overpay for exactly this number.
 *
 * `evaluate()` takes no league, which is why it could not see the week; the
 * count arrives through `ctx.weeksLeft`, and a caller that supplies none still
 * gets 17 but now has to say so on `season_delta_basis`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-season-weeks-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
const { seedIfEmpty } = await import('../server/db/seed/index.js');
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const {
  assetUniverse, loadRosters, lineupSlots, evaluate, seasonWeeksLeft
} = await import('../server/services/trade-engine.js');
const { deriveFormat } = await import('../server/services/format.js');

await runMigrations();
seedIfEmpty();

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------------ fixture */

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
const entry = (player, fakeId) =>
  ({ playerPoolEntry: { player: { id: fakeId, fullName: player.name, defaultPositionId: POS_ID[player.position] } } });
const pool = (position, n) => rows(`SELECT id, name, position FROM players
  WHERE position = ? AND fantasy_relevant = 1 ORDER BY id LIMIT ?`, position, n);

const { formatKey } = deriveFormat({
  team_count: 6, ppr: null, league_type: null, best_ball: 0, payload: null,
  roster_positions: JSON.stringify(SLOTS)
});

function seedMarket(players) {
  const now = new Date().toISOString();
  players.forEach((p, i) => {
    const proj = 320 - i * 3;
    run(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games, raw, fetched_at)
         VALUES (?, 2026, 'projected', ?, 17, '{}', ?)
         ON CONFLICT(player_id, season, kind) DO UPDATE SET fantasy_points = excluded.fantasy_points`,
    p.id, proj, now);
    run(`INSERT INTO dynasty_values (format_key, player_id, value, redraft_value, trend30, age, pos_rank, fetched_at)
         VALUES (?, ?, ?, ?, 0, 26, ?, ?)
         ON CONFLICT(format_key, player_id) DO UPDATE SET value = excluded.value, redraft_value = excluded.redraft_value`,
    formatKey, p.id, Math.round(proj * 3), Math.round(proj * 3), i + 1, now);
  });
}

/** `scheduleSettings` is what leagueSchedule() reads; without it the defaults apply. */
function buildLeague(id, scheduleSettings) {
  const qb = pool('QB', 6), rb = pool('RB', 18), wr = pool('WR', 18), te = pool('TE', 6);
  seedMarket([...qb, ...rb, ...wr, ...te]);
  let fakeId = 600000;
  const teams = [];
  for (let i = 0; i < 6; i++) {
    const roster = [qb[i], rb[i], rb[i + 6], rb[i + 12], wr[i], wr[i + 6], wr[i + 12], te[i]].filter(Boolean);
    teams.push({ id: i + 1, name: `Team ${i + 1}`, roster: { entries: roster.map(p => entry(p, fakeId++)) } });
  }
  const payload = { teams, settings: { name: 'Weeks League', ...(scheduleSettings ? { scheduleSettings } : {}) } };
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status)
       VALUES (?, 'espn', ?, 2026, 'Weeks League', ?, 6, '1', ?, 'x', 'y', 'connected')`,
  id, `espn-weeks-${id}`, JSON.stringify(payload), JSON.stringify(SLOTS));
  return rows('SELECT * FROM leagues WHERE id = ?', id)[0];
}

function sides(lg) {
  const { formatKey: fk } = deriveFormat(lg);
  const assets = assetUniverse(lg, fk);
  const teams = loadRosters(lg, assets);
  const slots = lineupSlots(lg);
  const mine = teams.find(t => String(t.roster_id) === '1');
  const theirs = teams.find(t => String(t.roster_id) === '2');
  return { slots, mine, theirs };
}

/* -------------------------------------------------------------------- tests */

test('seasonWeeksLeft counts the weeks this league still plays, not 17', () => {
  const lg = buildLeague(701, null);   // defaults: regular season to 14, playoffs 15-17
  assert.equal(seasonWeeksLeft(lg, 1), 17, 'week 1 of a default league is the whole season');
  assert.equal(seasonWeeksLeft(lg, 2), 16);
  assert.equal(seasonWeeksLeft(lg, 10), 8);
  assert.equal(seasonWeeksLeft(lg, 15), 3, 'only the playoff weeks are left');
  assert.equal(seasonWeeksLeft(lg, 18), 0, 'a finished league buys nothing');
});

test('seasonWeeksLeft reads THIS league\'s schedule, not the default one', () => {
  // A 12-week regular season with a two-week final: weeks 13-16. At week 10
  // that is 3 regular weeks plus 4 playoff weeks, not the default 8.
  const lg = buildLeague(702, {
    matchupPeriodCount: 12, playoffMatchupPeriodLength: 2, playoffTeamCount: 4, matchupPeriodLength: 1
  });
  assert.equal(seasonWeeksLeft(lg, 10), 7);
  assert.equal(seasonWeeksLeft(lg, 13), 4, 'the regular season is over; four playoff weeks remain');
});

test('season_delta is the weekly gain over the weeks left, and says how many it counted', () => {
  const lg = buildLeague(703, null);
  const { slots, mine, theirs } = sides(lg);
  const myPiece = mine.players.find(p => p.position === 'WR');
  const theirPiece = theirs.players.find(p => p.position === 'WR');

  const ev = evaluate({ team: mine, gives: [myPiece] }, { team: theirs, gives: [theirPiece] },
    slots, { weeksLeft: 8 });

  assert.equal(ev.me.season_delta_weeks, 8, 'the count actually used must be served');
  assert.equal(ev.me.season_delta_basis, 'weeks_remaining');
  assert.equal(ev.me.season_delta, +(ev.me.ppg_delta * 8).toFixed(1),
    'season_delta must be the per-week gain times the weeks counted');
  // Both sides of one deal are played out over the same weeks.
  assert.equal(ev.them.season_delta_weeks, 8);
});

test('a caller with no league still gets 17, and has to admit it', () => {
  const lg = buildLeague(704, null);
  const { slots, mine, theirs } = sides(lg);
  const myPiece = mine.players.find(p => p.position === 'WR');
  const theirPiece = theirs.players.find(p => p.position === 'WR');

  // POST /:leagueId/evaluate passes no weeksLeft today (routes/trades.js, another
  // owner's file). The fallback is unchanged so that surface does not move — but
  // it is now labelled, because a full-season figure printed in November is the
  // whole defect and it must be visible rather than inferred from the size.
  const ev = evaluate({ team: mine, gives: [myPiece] }, { team: theirs, gives: [theirPiece] }, slots);
  assert.equal(ev.me.season_delta_weeks, 17);
  assert.equal(ev.me.season_delta_basis, 'full_season_default');
});

test('a finished league reports zero, not a season', () => {
  const lg = buildLeague(705, null);
  const { slots, mine, theirs } = sides(lg);
  const myPiece = mine.players.find(p => p.position === 'WR');
  const theirPiece = theirs.players.find(p => p.position === 'WR');
  const ev = evaluate({ team: mine, gives: [myPiece] }, { team: theirs, gives: [theirPiece] },
    slots, { weeksLeft: 0 });
  assert.equal(ev.me.season_delta_weeks, 0);
  assert.equal(ev.me.season_delta, 0, 'a trade made after the last week is worth no points');
});
