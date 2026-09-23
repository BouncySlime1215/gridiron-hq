/**
 * BLEND-01: the one call site. trade-engine.js#buildAssetUniverse passes its own number (the
 * served construction x this game's factor x his chance to play, 0 with no game) through
 * weekly-blend.js#servedWeekBlend where `current_week_ppg` is made, so every weekly page
 * (Start/Sit, the League Hub card, the waiver board, the matchup card, the trade pill) reads
 * the blend from one producer.
 *
 * What these tests pin (docs/tdd/2026-09-22-weekly-blend-tournament.tdd.md):
 *   - with the blend on, current_week_ppg is the served candidate of ours and ESPN's number
 *     for this league's rostered player, and the asset says so (week_blend);
 *   - the call site passes the player's position, this week (its phase), his week's report
 *     status (the late-news switch) and whether he has a game;
 *   - a player ESPN has no number for keeps ours, labelled; a player with no game is 0;
 *   - Start/Sit's week_points and the trade horizon's adj_ppg read the blended number;
 *   - a new ESPN capture refreshes the cached universe (league_roster_snapshots is an input);
 *   - the surface carries the blend's sentence and ESPN's capture state (context.week_blend).
 *
 * The served switch is mocked ON (candidate 'half') so the wiring is visible whatever the
 * tournament decided; test/weekly-blend.test.js pins the real SERVED_BLEND to the grade.
 * Only the weekly engine, the rest-of-season model and SERVED_BLEND are mocked.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-blend-wiring-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_SEASON = '2026';

const { db, row, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { seedIfEmpty } = await import('../server/db/seed/index.js');
seedIfEmpty();
// Every seeded team plays every 2026 week, so each player has this week's game.
run(`INSERT OR IGNORE INTO schedule_games (season, team_id, week, opponent_abbr, home)
     SELECT 2026, t.id, w.week, t.abbr, 1 FROM nfl_teams t
     JOIN (WITH RECURSIVE n(week) AS (SELECT 1 UNION ALL SELECT week + 1 FROM n WHERE week < 18) SELECT week FROM n) w`);

const ENGINE = new Map();
const realEngine = await import('../server/services/player-week-engine.js');
mock.module('../server/services/player-week-engine.js', {
  namedExports: {
    ...realEngine,
    buildPlayerWeekEngine: () => ENGINE,
    playerWeekDistribution: () => null,
    playerWeekEventExpectation: () => ({ structural_fantasy_points: 12 })
  }
});
mock.module('../server/services/ros-projection.js', { namedExports: { buildRosProjections: () => new Map() } });
const realBlend = await import('../server/services/weekly-blend.js');
// pos_phase with one fitted cell (WR, weeks 2-4) and a far-off pooled weight, plus the late-news
// layer: a wrong position or week lands on the pooled 0.9, a dropped report status loses the switch.
const ON = Object.freeze({ on: true, candidate: 'pos_phase', params: { pooled: 0.9, w: { WR: { '2-4': 0.5 } } },
  news_layer: true, verdict: 'test', evidence: 'test' });
mock.module('../server/services/weekly-blend.js', { namedExports: { ...realBlend, SERVED_BLEND: ON } });

// Side-effect imports, as test/ros-projection-wiring.test.js: routes assetUniverse reads.
await import('../server/routes/stats.js');
await import('../server/routes/aggregates.js');
await import('../server/routes/tradelab.js');
await import('../server/routes/nfldata.js');
const { assetUniverse } = await import('../server/services/trade-engine.js');
const { startSitWeekPoints } = await import('../server/services/lineup-brain.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

// Four seeded WRs on four different teams, each with a crafted weekly projection:
//   P1 ESPN 20; P2 no ESPN row; P3 ESPN 12 and ruled Out on this week's report; P4 ESPN 15, no game.
// MIN(p.id): SQLite then takes the row's other columns from that same player.
const [P1, P2, P3, P4] = rows(`SELECT MIN(p.id) AS id, p.position, t.abbr AS team, t.id AS team_id FROM players p
                               JOIN nfl_teams t ON t.id = p.team_id
                               WHERE p.position = 'WR' AND p.fantasy_relevant = 1
                               GROUP BY t.id ORDER BY id LIMIT 4`);
[P1, P2, P3, P4].forEach((p, i) => run('UPDATE players SET espn_id = ? WHERE id = ?', 9001 + i, p.id));
for (const p of [P1, P2, P3, P4]) {
  ENGINE.set(p.id, { player_id: p.id, position: 'WR', team: p.team, ppg: 14.4, structural_ppg: 12.0, ensemble_shift: 2.4,
    params: { crafted: true }, player_week_engine: { cutoff: '2026-W1', mode: 'weekly' } });
}
run('UPDATE players SET gsis_id = ? WHERE id = ?', 'BLEND-P3', P3.id);
run(`INSERT INTO nfl_injuries (season, week, gsis_id, team, full_name, position, report_status, practice_status, injury, modified_at)
     VALUES (2026, 2, 'BLEND-P3', ?, 'P3', 'WR', 'Out', 'DNP', 'Ankle', '2026-09-19T20:00:00Z')`, P3.team);
run('DELETE FROM schedule_games WHERE season = 2026 AND week = 2 AND team_id = ?', P4.team_id);

run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, payload)
     VALUES (401, 'espn', 'blend-401', 2026, 'BLEND-01 fixture', '1', 10, 1, NULL)`);
const L = row('SELECT * FROM leagues WHERE id = 401');
const FORMAT = 'rd_sf0_t10_ppr1';
const snap = (espnId, pts, at) => run(`INSERT INTO league_roster_snapshots (league_id, season, scoring_period_id, team_id,
    espn_player_id, lineup_slot_id, is_starter, projected_points, on_roster, source, first_seen_at, changed_at)
  VALUES (401, 2026, 2, 1, ?, 0, 1, ?, 1, 'live', ?, ?)
  ON CONFLICT (league_id, season, scoring_period_id, team_id, espn_player_id)
  DO UPDATE SET projected_points = excluded.projected_points, changed_at = excluded.changed_at`, espnId, pts, at, at);
snap(9001, 20, '2026-09-22T20:00:00Z');
snap(9003, 12, '2026-09-22T20:00:00Z');
snap(9004, 15, '2026-09-22T20:00:00Z');

// Ours, from the asset's own fields: 14.4 x this game's factor x his chance to play.
const ours = a => 14.4 * a.matchup.mult * a.active_probability;
const near = (a, b, tol = 0.011) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('the blend is on for this fixture and ESPN has a number for one WR (known-nonzero control)', () => {
  const u = assetUniverse(L, FORMAT, { season: 2026, week: 2 });
  assert.equal(u.context.week_blend.on, true);
  assert.equal(u.context.week_blend.espn.state, 'present');
  assert.ok(u.context.week_blend.espn.players >= 1);
  assert.ok(u.get(P1.id).matchup, 'P1 has a game this week');
  assert.equal(u.get(P4.id).matchup, null, 'P4 has no game this week');
  assert.equal(u.get(P3.id).injury_status, 'Out');
});

test('current_week_ppg is the served candidate of ours and ESPN\'s number, and says so', () => {
  const a = assetUniverse(L, FORMAT, { season: 2026, week: 2 }).get(P1.id);
  near(a.current_week_ppg, 0.5 * ours(a) + 0.5 * 20);
  assert.equal(a.week_blend.basis, 'blend');
  assert.equal(a.week_blend.espn_ppg, 20);
  assert.equal(a.week_blend.weight_ours, 0.5);
});

test('a player ESPN has no number for keeps ours, labelled; a player with no game is 0', () => {
  const u = assetUniverse(L, FORMAT, { season: 2026, week: 2 });
  const b = u.get(P2.id);
  near(b.current_week_ppg, ours(b));
  assert.equal(b.week_blend.basis, 'no_espn_value');
  assert.equal(b.week_blend.espn_ppg, null);
  const d = u.get(P4.id);
  assert.equal(d.current_week_ppg, 0);
  assert.equal(d.week_blend.basis, 'no_game');
});

test('late news: his week\'s Out status switches him to ESPN\'s number', () => {
  const c = assetUniverse(L, FORMAT, { season: 2026, week: 2 }).get(P3.id);
  assert.equal(c.current_week_ppg, 12);
  assert.equal(c.week_blend.basis, 'espn_late_news');
  assert.equal(c.week_blend.weight_ours, 0);
});

test('Start/Sit\'s week_points and the trade horizon\'s adj_ppg read the blended number', () => {
  const a = assetUniverse(L, FORMAT, { season: 2026, week: 2 }).get(P1.id);
  assert.equal(startSitWeekPoints(a, 2026, 2).week_points, a.current_week_ppg);
  near(a.adj_ppg, 0.25 * a.current_week_ppg + 0.75 * a.ros_ppg, 0.01);
});

test('a new ESPN capture refreshes the cached universe', () => {
  const before = assetUniverse(L, FORMAT, { season: 2026, week: 2 }).get(P1.id).current_week_ppg;
  snap(9001, 10, '2026-09-22T23:00:00Z');
  const a = assetUniverse(L, FORMAT, { season: 2026, week: 2 }).get(P1.id);
  near(a.current_week_ppg, 0.5 * ours(a) + 0.5 * 10);
  assert.ok(a.current_week_ppg < before, `${a.current_week_ppg} should drop from ${before}`);
  const ctx = assetUniverse(L, FORMAT, { season: 2026, week: 2 }).context.week_blend;
  assert.equal(ctx.espn.captured_at, '2026-09-22T23:00:00Z');
  assert.match(ctx.label, /blend our projection with ESPN's weekly projection \(pos_phase\)/);
});
