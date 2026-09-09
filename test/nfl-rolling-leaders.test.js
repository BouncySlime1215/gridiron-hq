/**
 * The "insane" part of Phase 3 (2026-09-09 learning-pipeline plan): cutoff-safe
 * rolling stat leaderboards — "who led the league in EPA/play through their
 * first 6 games, as known entering week 7" — fed into analyzeErrors as
 * additional segment dimensions for EVERY numeric stat the feature warehouse
 * tracks, not a hand-picked shortlist. The one property that matters more
 * than any other here is the no-leak guarantee: a team's rolling average for
 * week N must never be influenced by week N's own game, because that's
 * exactly the kind of leak this project has spent all night hunting down in
 * other places.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-rolling-leaders-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { rollingTeamStats, statLeaderboardBuckets, teamStatBucket, availableLeaderboardKeys, clearRollingLeaderCache } =
  await import('../server/services/nfl-rolling-leaders.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function seedWeek(season, week, teamStats) {
  const insert = db.prepare(`INSERT INTO nfl_team_week_features (season, week, team, opponent, home, features)
    VALUES (?,?,?,?,1,?)`);
  for (const [team, stats] of Object.entries(teamStats)) {
    insert.run(season, week, team, 'OPP', JSON.stringify(stats));
  }
}

test('a rolling average through week N never includes week N\'s own value (no leak)', () => {
  // Team AAA's off_epa_per_play: week1=0.0, week2=0.0, week3=100.0 (a huge
  // outlier). Its rolling average AS OF week 3 (i.e. using weeks < 3) must be
  // 0.0, completely unaffected by week 3's own huge value.
  seedWeek(2030, 1, { AAA: { off_epa_per_play: 0.0 }, BBB: { off_epa_per_play: 0.0 } });
  seedWeek(2030, 2, { AAA: { off_epa_per_play: 0.0 }, BBB: { off_epa_per_play: 0.0 } });
  seedWeek(2030, 3, { AAA: { off_epa_per_play: 100.0 }, BBB: { off_epa_per_play: 0.0 } });
  clearRollingLeaderCache();
  const asOfWeek3 = rollingTeamStats(2030, 3);
  assert.equal(asOfWeek3.get('AAA').off_epa_per_play, 0.0, 'week 3\'s own outlier must not leak into its own "as of week 3" rolling average');
  const asOfWeek4 = rollingTeamStats(2030, 4);
  assert.ok(asOfWeek4.get('AAA').off_epa_per_play > 30, 'once week 3 is strictly in the past, it SHOULD count');
});

test('a team with fewer than MIN_GAMES_FOR_RANKING prior weeks is omitted, not given a noisy one-game average', () => {
  seedWeek(2031, 1, { AAA: { off_epa_per_play: 5.0 } });
  clearRollingLeaderCache();
  const asOfWeek2 = rollingTeamStats(2031, 2); // only 1 prior week exists
  assert.equal(asOfWeek2.has('AAA'), false, 'one game is not enough to rank on yet');
});

test('quartile buckets are assigned correctly among enough ranked teams', () => {
  const teams = {};
  // 12 teams with a clean, ordered spread of off_epa_per_play values.
  for (let i = 0; i < 12; i++) teams[`T${i}`] = { off_epa_per_play: i };
  seedWeek(2032, 1, teams);
  seedWeek(2032, 2, teams); // second week so week 3 has >= MIN_GAMES_FOR_RANKING
  clearRollingLeaderCache();
  const buckets = statLeaderboardBuckets(2032, 3);
  assert.equal(buckets.get('T0').get('off_epa_per_play'), 'bottom_quartile', 'the lowest value should be in the bottom quartile');
  assert.equal(buckets.get('T11').get('off_epa_per_play'), 'top_quartile', 'the highest value should be in the top quartile');
});

test('too few qualifying teams to form real quartiles produces no bucket for that stat, not a fabricated one', () => {
  seedWeek(2033, 1, { AAA: { off_epa_per_play: 1 }, BBB: { off_epa_per_play: 2 } });
  seedWeek(2033, 2, { AAA: { off_epa_per_play: 1 }, BBB: { off_epa_per_play: 2 } });
  clearRollingLeaderCache();
  assert.equal(teamStatBucket(2033, 3, 'AAA', 'off_epa_per_play'), null, 'only 2 teams is not enough to rank into quartiles honestly');
});

test('availableLeaderboardKeys reflects real data breadth, not a hardcoded shortlist', () => {
  const teams = {};
  for (let i = 0; i < 10; i++) teams[`Q${i}`] = { stat_a: i, stat_b: i * 2, stat_c: i * 3 };
  seedWeek(2034, 1, teams);
  seedWeek(2034, 2, teams);
  clearRollingLeaderCache();
  const keys = availableLeaderboardKeys(2034, 3);
  assert.deepEqual([...keys].sort(), ['stat_a', 'stat_b', 'stat_c']);
});

test('segmentsFor attributes a leaderboard bucket to the side actually bet, not always home', async () => {
  const { analyzeErrors } = await import('../server/services/nfl-replay.js');
  const teams = {};
  for (let i = 0; i < 10; i++) teams[`R${i}`] = { off_epa_per_play: i };
  seedWeek(2035, 1, teams);
  seedWeek(2035, 2, teams);
  clearRollingLeaderCache();
  // R9 has the top off_epa_per_play. Bet AWAY on a game where R9 is the away team.
  const bets = [];
  for (let i = 0; i < 30; i++) {
    bets.push({
      season: 2035, week: 3, home: `R${i % 8}`, away: 'R9', market: 'spread',
      side: 'R9 +3', line: 3, model_margin: -1, market_margin: 3,
      edge: -4, edge_points: 4, disagreement: 2, actual_margin: 5, actual_total: 44,
      result: 'Lost', won: false, pushed: false, units: -1, american_price: -110, opposite_price: -110
    });
  }
  const result = analyzeErrors(bets, { minBets: 25 });
  const topQuartileSeg = result.segments.find(s => s.dimension === 'stat:off_epa_per_play' && s.segment === 'top_quartile');
  assert.ok(topQuartileSeg, 'backing R9 (the top off_epa_per_play team, as the AWAY side) should bucket into top_quartile, not be missed because it is away rather than home');
  assert.equal(topQuartileSeg.bets, 30);
});
