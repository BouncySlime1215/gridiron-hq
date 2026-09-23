/**
 * B-01 — a team's real record reaches its playoff odds (2026-09-22).
 *
 * Every page-facing season simulation called `simulateSeason` with the default
 * `fromWeek = 1`: GET /simulate and POST /trade-impact in server/routes/model.js
 * passed `|| 1`, and title-odds-trades.js and the trade sense-check in
 * routes/trades.js passed nothing. `initialRecords()` returns an empty record
 * for `fromWeek <= 1`, so in week 6 a 5-0 team was simulated as 0-0 and its
 * odds were those of a team that had not played.
 *
 * The fixture is a six-team ESPN league in week 6 (`leagues.current_week = 6`)
 * where team 1 has won all five completed weeks, four of six make the playoffs.
 * It has no weekly projection history, so every simulated week is a 0-0 tie
 * and the simulated standings are exactly the carried-in record: odds move
 * only if the real record reaches the sim. Team 1 is listed LAST so that at
 * 0-0 it loses every tie-break (odds 0) — the fixture's own control, measured
 * below with an explicit fromWeek = 1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-b01-'));
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
const { simulateSeason, simStartWeek } = await import('../server/services/season-sim.js');
const { withRandomSeed } = await import('../server/services/stats-util.js');

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

/** Round-robin over 14 weeks; weeks before CURRENT_WEEK are scored, team 1 winning each. */
function schedule() {
  const out = [];
  const ids = [1, 2, 3, 4, 5, 6];
  for (let w = 1; w <= 14; w++) {
    const rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + w - 1) % 5)])];
    for (let i = 0; i < 3; i++) {
      const home = rot[i], away = rot[5 - i];
      const done = w < CURRENT_WEEK;
      const pts = id => (id === 1 ? 180 : 100 + id);
      out.push({ matchupPeriodId: w,
        home: { teamId: home, totalPoints: done ? pts(home) : undefined },
        away: { teamId: away, totalPoints: done ? pts(away) - 5 : undefined } });
    }
  }
  return out;
}

let fakeId = 950000;
function sixTeamLeague() {
  const pick = (pos, n) => rows(`SELECT id, name, position FROM players WHERE position = ? AND fantasy_relevant = 1
                                 ORDER BY id LIMIT ?`, pos, n);
  const qb = pick('QB', 6), rb = pick('RB', 18), wr = pick('WR', 18), te = pick('TE', 6);
  seedMarket([...qb, ...rb, ...wr, ...te]);
  const teams = [];
  for (let i = 0; i < 6; i++) {
    const roster = [qb[i], rb[i], rb[11 - i], rb[12 + i], wr[5 - i], wr[6 + i], wr[17 - i], te[5 - i]].filter(Boolean);
    teams.push({ id: i + 1, name: `Team ${i + 1}`, owners: [`{M${i + 1}}`],
      roster: { entries: roster.map(p => ({
        playerPoolEntry: { player: { id: fakeId++, fullName: p.name, defaultPositionId: POS_ID[p.position] } } })) } });
  }
  const members = teams.map((t, i) => ({ id: t.owners[0], firstName: `First${i + 1}`, lastName: `Last${i + 1}` }));
  teams.reverse();                              // team 1 last: it loses 0-0 tie-breaks
  return { teams, members, schedule: schedule(),
    settings: { name: 'B01 League', scheduleSettings: { matchupPeriodCount: 14, matchupPeriodLength: 1,
      playoffTeamCount: 4, playoffMatchupPeriodLength: 1 } } };
}

function insertLeague(id, payload, { currentWeek = CURRENT_WEEK, payloadSeason = 2026 } = {}) {
  run(`INSERT INTO leagues(id, platform, league_id, season, name, payload, team_count, my_team_id,
       roster_positions, espn_s2, swid, connection_status, current_week, payload_season)
       VALUES (?, 'espn', ?, 2026, 'B01 League', ?, 6, '1', ?, 'x', 'y', 'connected', ?, ?)`,
  id, `espn-b01-${id}`, JSON.stringify(payload), JSON.stringify(SLOTS), currentWeek, payloadSeason);
  return rows('SELECT * FROM leagues WHERE id = ?', id)[0];
}

const team1 = sim => sim.teams.find(t => String(t.roster_id) === '1');
const payload = sixTeamLeague();

test('B-01: with no fromWeek, a 5-0 team in week 6 is simulated as 5-0', () => {
  const lg = insertLeague(601, payload);
  const sim = withRandomSeed(601, () => simulateSeason(lg, { runs: 400 }));
  assert.ok(!sim.error, sim.error);
  assert.equal(sim.from_week, CURRENT_WEEK, 'the default start is the league\'s current week');
  assert.equal(sim.standings_carried_in, true);
  const odds = team1(sim).playoff_odds;
  assert.ok(odds >= 0.9, `a 5-0 team with 4 of 6 making the playoffs got playoff odds ${odds}`);

  // The same league from week 1 is the 0-0 answer the pages used to show.
  const fresh = withRandomSeed(601, () => simulateSeason(lg, { runs: 400, fromWeek: 1 }));
  assert.equal(fresh.from_week, 1, 'an explicit fromWeek = 1 still means a fresh season');
  assert.ok(team1(fresh).playoff_odds <= 0.1,
    `control: at 0-0 team 1 must not already be a lock (got ${team1(fresh).playoff_odds})`);
});

test('B-01: simStartWeek is the one producer — explicit week wins, else the league week', () => {
  const lg = rows('SELECT * FROM leagues WHERE id = 601')[0];
  assert.equal(simStartWeek(lg), CURRENT_WEEK);
  assert.equal(simStartWeek(lg, null), CURRENT_WEEK);
  assert.equal(simStartWeek(lg, 0), CURRENT_WEEK, 'a missing ?from_week parses to 0 and is not a week');
  assert.equal(simStartWeek(lg, 3), 3);
});

test('B-01: a payload that is last season\'s (pre-draft fallback) starts at week 1', () => {
  // Its scored weeks are last year's results; carrying them in would hand
  // this season's standings last season's record.
  const lg = insertLeague(602, payload, { payloadSeason: 2025 });
  assert.equal(simStartWeek(lg), 1);
});

test('B-01: the page routes no longer pin from_week to 1', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/routes/model.js'), 'utf8');
  assert.ok(/simulateSeason\(lg,/.test(src), 'control: the route still calls simulateSeason');
  assert.doesNotMatch(src, /from_week\)\s*\|\|\s*1/, 'a route still defaults from_week to 1');
});
