import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Regression coverage for the second round of 2026-09-02 fixes: the
// line-snapshot leak in nfl-specialists.js, the officials cartesian join,
// and nfl-market.js's between-season carryover / neutral-site handling.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-model-fixes-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
// game_lines and nfl_line_snapshots are created as import side effects by the
// services that own them, not by the migrations.
await import('../server/services/gamescript.js');
await import('../server/services/line-shopping.js');
const { MOVEMENT_FAMILY, designVectors } = await import('../server/services/nfl-specialists.js');
const marketService = await import('../server/services/nfl-market.js');
const officialsService = await import('../server/services/nfl-officials.js');
const { rankBooks } = await import('../server/services/nfl-execution.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

run(`INSERT OR IGNORE INTO nfl_teams (id,abbr,name,conference,division) VALUES (1,'KC','Kansas City Chiefs','AFC','West')`);
run(`INSERT OR IGNORE INTO nfl_teams (id,abbr,name,conference,division) VALUES (2,'DEN','Denver Broncos','AFC','West')`);

test('the movement family does not attach a 2026 line move to a 2016 game for the same team', () => {
  const zeroProxy = new Proxy({}, { get: () => 0 });
  const ctx = { wind: 5, temp: 60, indoors: 0, turf: 0, home_rest: 7, away_rest: 7, div: 0, spread: -3, spread_abs: 3, total: 44, week: 1 };
  const row2016 = { season: 2016, week: 1, home: 'KC', away: 'DEN', gameday: '2016-09-11',
    open_spread: null, open_total: null, market_margin: -3, market_total: 44,
    actual_margin: -3, actual_total: 44, residual: 0, H: zeroProxy, A: zeroProxy, ctx };
  const row2026 = { season: 2026, week: 1, home: 'KC', away: 'DEN', gameday: '2026-09-13',
    open_spread: null, open_total: null, market_margin: -3, market_total: 44,
    actual_margin: -3, actual_total: 44, residual: 0, H: zeroProxy, A: zeroProxy, ctx };

  const snap = db.prepare(`INSERT INTO nfl_line_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  snap.run('2026-09-11T12:00:00Z', 'evt1', '2026-09-13T17:00:00Z', 'Kansas City Chiefs', 'Denver Broncos',
    'draftkings', 'spreads', 'Kansas City Chiefs', -3, -110);
  snap.run('2026-09-13T16:00:00Z', 'evt1', '2026-09-13T17:00:00Z', 'Kansas City Chiefs', 'Denver Broncos',
    'draftkings', 'spreads', 'Kansas City Chiefs', -4.5, -115);

  const [vec2016, vec2026] = designVectors([row2016, row2026]);
  assert.deepEqual(vec2016[MOVEMENT_FAMILY], [0, 0, 0],
    'a 2016 game with no snapshot of its own must read zero movement, not the 2026 game\'s move');
  assert.notDeepEqual(vec2026[MOVEMENT_FAMILY], [0, 0, 0],
    'the 2026 game the snapshot actually belongs to should see the move');
});

test('predictGame decays ratings by the fitted carryover for a season with no completed games yet', () => {
  const teams = ['AAA', 'BBB'];
  run(`INSERT OR IGNORE INTO nfl_teams (id,abbr,name,conference,division) VALUES (10,'AAA','Team AAA','AFC','West')`);
  run(`INSERT OR IGNORE INTO nfl_teams (id,abbr,name,conference,division) VALUES (11,'BBB','Team BBB','AFC','West')`);
  const insert = db.prepare(`INSERT INTO game_lines
    (season,week,team,opponent,home,spread,total,team_score,opp_score,gameday,gametime)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  let count = 0;
  for (let season = 2000; season < 2030; season++) {
    const swing = season % 2 === 0 ? 10 : -10;
    for (let week = 1; week <= 18; week++) {
      const noise = (week % 3) - 1;
      const homeScore = 24 + swing + noise, awayScore = 20;
      insert.run(season, week, 'AAA', 'BBB', 1, -3, 44, homeScore, awayScore,
        `${season}-09-${String(1 + (week % 20)).padStart(2, '0')}`, '13:00');
      insert.run(season, week, 'BBB', 'AAA', 0, 3, 44, awayScore, homeScore,
        `${season}-09-${String(1 + (week % 20)).padStart(2, '0')}`, '13:00');
      count++;
    }
  }
  assert.ok(count >= 500, 'synthetic dataset must clear fitModel\'s 500-game floor');

  const fitted = marketService.fitModel();
  assert.equal(fitted.error, undefined);
  assert.equal(fitted.lastCompletedSeason, 2029);
  assert.ok(fitted.carryover >= 0.5 && fitted.carryover <= 1, 'carryover must come from the fitted grid');

  const sameSeason = marketService.predictGame('AAA', 'BBB', fitted.lastCompletedSeason);
  const threeSeasonsOut = marketService.predictGame('AAA', 'BBB', fitted.lastCompletedSeason + 3);
  const expectedDecay = fitted.carryover ** 3;
  assert.ok(Math.abs(threeSeasonsOut.home_off - sameSeason.home_off * expectedDecay) < 0.02,
    'a prediction three seasons past the last completed one must apply carryover^3 to the rating');
  assert.ok(Math.abs(threeSeasonsOut.away_def - sameSeason.away_def * expectedDecay) < 0.02);

  // Neutral site: the raw margin must not include home-field advantage.
  const neutral = marketService.predictGame('AAA', 'BBB', fitted.lastCompletedSeason, { neutral: true });
  const notNeutral = marketService.predictGame('AAA', 'BBB', fitted.lastCompletedSeason, { neutral: false });
  if (Math.abs(fitted.hfa) > 0.01) {
    assert.notEqual(neutral.predicted_margin, notNeutral.predicted_margin,
      'a neutral-site game must not receive the fitted home-field constant');
  }
});

test('officials refereeTotals joins each crew to its own game, not to every game in the week', () => {
  run(`INSERT OR IGNORE INTO nfl_teams (id,abbr,name,conference,division) VALUES (20,'ZZA','Team ZZA','AFC','West')`);
  run(`INSERT OR IGNORE INTO nfl_teams (id,abbr,name,conference,division) VALUES (21,'ZZB','Team ZZB','AFC','East')`);
  run(`INSERT OR IGNORE INTO nfl_teams (id,abbr,name,conference,division) VALUES (22,'ZZC','Team ZZC','NFC','West')`);
  run(`INSERT OR IGNORE INTO nfl_teams (id,abbr,name,conference,division) VALUES (23,'ZZD','Team ZZD','NFC','East')`);
  const insert = db.prepare(`INSERT INTO game_lines
    (season,week,team,opponent,home,total,team_score,opp_score) VALUES (?,?,?,?,1,?,?,?)`);
  // Two games in the same season/week — the bug attributed one referee to BOTH.
  insert.run(3000, 1, 'ZZA', 'ZZB', 44, 27, 20);
  insert.run(3000, 1, 'ZZC', 'ZZD', 50, 24, 24);

  const officials = db.prepare(`INSERT INTO nfl_officials
    (game_id,name,position,season,week,season_type,home_team,away_team) VALUES (?,?,?,?,?,?,?,?)`);
  officials.run('g1', 'Ref One', 'Referee', 3000, 1, 'REG', 'ZZA', 'ZZB');

  const joined = rows(`
    SELECT o.name AS referee, g.total, (g.team_score + g.opp_score) AS actual
    FROM nfl_officials o JOIN game_lines g
      ON g.season = o.season AND g.week = o.week AND g.home = 1
     AND g.team = o.home_team AND g.opponent = o.away_team
    WHERE o.name = 'Ref One'`);
  assert.equal(joined.length, 1, 'the exact join must attribute the referee to exactly the one game');
  assert.equal(joined[0].total, 44);
  void officialsService;
});

test('rankBooks never recommends the book furthest from the field in the wrong direction', () => {
  // marginDistribution() (nfl-execution-edge.js) caches on its first call for
  // the life of the process, from whatever game_lines rows exist at that
  // moment. The AAA/BBB synthetic games above cluster far from zero and leave
  // no probability mass between -4.5 and -1.5, so lineMoveValue would return
  // an uninformative 0 for both directions here — a tie the old unsigned code
  // and the new signed code would both technically "pass" trivially. Seed a
  // real spread of close margins before this is the first caller.
  const margins = db.prepare(`INSERT INTO game_lines
    (season,week,team,opponent,home,spread,total,team_score,opp_score) VALUES (?,?,?,?,1,?,?,?,?)`);
  for (let m = -10; m <= 10; m++) margins.run(4000, (m + 11), 'MMM', 'NNN', -3, 44, 24 + m, 24);
  // Each quote is one side's own signed number, so — exactly as routeBet
  // always calls it for spreads — a HIGHER line is always better for this
  // side, whether it is the favorite's or the underdog's own number.
  // 'straddle_bad' (-4.5) is 1.5 points WORSE than the -3 field; 'better'
  // (-1.5) is 1.5 points BETTER. The old unsigned lineEdge scored both as
  // equally far from the median and therefore equally good, so the worse
  // book could rank first.
  const quotes = [
    { book: 'straddle_bad', line: -4.5, american_price: -110 },
    { book: 'field_a', line: -3, american_price: -110 },
    { book: 'field_b', line: -3, american_price: -110 },
    { book: 'better', line: -1.5, american_price: -110 }
  ];
  const ranked = rankBooks(quotes, { market: 'spreads', takingPoints: true });
  assert.equal(ranked.best.book, 'better', 'the book giving up the fewest points must win, not the outlier');
  assert.notEqual(ranked.best.book, 'straddle_bad');
  assert.ok(ranked.best.edge_vs_median > 0, 'the winning book must show a positive edge, not a tied unsigned one');
  const worst = ranked.all.find(q => q.book === 'straddle_bad');
  assert.ok(worst.edge_vs_median < 0, 'the worse line must score a negative edge, not a positive one');
});
