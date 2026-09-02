import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Polymarket as the line-movement source: the implied spread/total is read
// off the alternate ladders, and a move is logged only when it is material.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-pm-lines-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.NFL_SEASON = '2026';

const { db, run, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
await import('../server/services/gamescript.js');
await import('../server/services/polymarket.js');
const feeds = await import('../server/services/book-feeds.js');
const pm = await import('../server/services/polymarket-lines.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
  delete process.env.NFL_SEASON;
});

run(`INSERT OR IGNORE INTO nfl_teams (id,abbr,name,conference,division) VALUES (1,'SEA','Seattle Seahawks','NFC','West')`);
run(`INSERT OR IGNORE INTO nfl_teams (id,abbr,name,conference,division) VALUES (2,'NE','New England Patriots','AFC','East')`);
feeds.clearTeamResolverCache();
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,gameday,gametime) VALUES (2026,1,'SEA','NE',1,-3.5,44.5,'2026-09-09','20:20')`);

test('crossing interpolates the 50% point of a ladder and flags extrapolation', () => {
  assert.equal(pm.__test.crossing([{ x: -4.5, p: 0.44 }, { x: -3.5, p: 0.495 }, { x: -2.5, p: 0.58 }]).x.toFixed(3), '-3.441');
  const ex = pm.__test.crossing([{ x: -6.5, p: 0.6 }, { x: -4.5, p: 0.7 }, { x: -2.5, p: 0.8 }]);
  assert.equal(ex.extrapolated, true, 'a ladder entirely above 50% has no crossing');
  assert.equal(pm.__test.crossing([{ x: -6.5, p: 0.6 }, { x: -4.5, p: 0.7 }]), null, 'two points are not a ladder');
});

test('the isotonic fit removes a noisy dip so it cannot create a spurious crossing', () => {
  // A thin 27.5 leg printing 0.51 next to a 25.5 printing 0.90: raw reading
  // would find a "crossing" near 27; the monotone fit does not.
  const pts = [{ x: 25.5, p: 0.90 }, { x: 27.5, p: 0.51 }, { x: 29.5, p: 0.52 }, { x: 31.5, p: 0.78 },
    { x: 37.5, p: 0.585 }, { x: 40.5, p: 0.49 }, { x: 43.5, p: 0.40 }, { x: 45.5, p: 0.355 }];
  const fit = pm.__test.isotonic(pts.map(p => p.p), { increasing: false });
  for (let i = 1; i < fit.length; i++) assert.ok(fit[i] <= fit[i - 1] + 1e-12, 'fitted P(over) never rises with the number');
  const c = pm.__test.crossing(pts, { increasing: false });
  assert.ok(c.x > 38 && c.x < 42, `crossing should be near 40, got ${c.x}`);
});

test('parseGameMarket reads spread ladders and full-game totals, not team totals or halves', () => {
  assert.deepEqual(pm.__test.parseGameMarket('Spread: Seahawks (-3.5)'), { kind: 'spread', team: 'Seahawks', line: -3.5 });
  assert.deepEqual(pm.__test.parseGameMarket('Patriots vs. Seahawks: O/U 44.5', 'Patriots vs. Seahawks'), { kind: 'total', line: 44.5 });
  assert.equal(pm.__test.parseGameMarket('Seahawks Team Total: O/U 24.5', 'Patriots vs. Seahawks'), null);
  assert.equal(pm.__test.parseGameMarket('Patriots vs. Seahawks: 1H O/U 23.5', 'Patriots vs. Seahawks'), null);
  assert.equal(pm.__test.parseGameMarket('1H Spread: Seahawks (-2.5)'), null);
});

test('the implied home spread and total come from the ladder, in home perspective', () => {
  const resolve = feeds.teamResolver();
  const game = { home: resolve('Seahawks'), away: resolve('Patriots') };
  const markets = [
    { condition_id: 'a', question: 'Spread: Seahawks (-1.5)', event_title: 'Patriots vs. Seahawks', resolve },
    { condition_id: 'b', question: 'Spread: Seahawks (-3.5)', event_title: 'Patriots vs. Seahawks', resolve },
    { condition_id: 'c', question: 'Spread: Seahawks (-4.5)', event_title: 'Patriots vs. Seahawks', resolve },
    { condition_id: 'd', question: 'Spread: Patriots (+2.5)', event_title: 'Patriots vs. Seahawks', resolve },
    { condition_id: 'e', question: 'Patriots vs. Seahawks: O/U 43.5', event_title: 'Patriots vs. Seahawks', resolve },
    { condition_id: 'f', question: 'Patriots vs. Seahawks: O/U 44.5', event_title: 'Patriots vs. Seahawks', resolve },
    { condition_id: 'g', question: 'Patriots vs. Seahawks: O/U 46.5', event_title: 'Patriots vs. Seahawks', resolve }
  ];
  const quotes = new Map([['a', 0.595], ['b', 0.495], ['c', 0.44], ['d', 0.42], ['e', 0.52], ['f', 0.475], ['g', 0.42]]);
  const implied = pm.__test.impliedLines(markets, quotes, game);
  assert.ok(implied.home_spread < -3 && implied.home_spread > -3.5, `home spread ${implied.home_spread}`);
  assert.ok(implied.total > 43.5 && implied.total < 44.5, `total ${implied.total}`);
  assert.equal(implied.spread_ladder, 4, 'the away-quoted +2.5 leg counts, flipped to home perspective');
  assert.equal(implied.total_ladder, 3);
});

test('pollPolymarketLines logs a first sighting, ignores noise, and logs a material move once', () => {
  const ins = db.prepare(`INSERT INTO polymarket_markets (condition_id,question,event_title,kind,end_date) VALUES (?,?,?,'other','2026-09-10T00:20:00Z')`);
  ins.run('s1', 'Spread: Seahawks (-2.5)', 'Patriots vs. Seahawks');
  ins.run('s2', 'Spread: Seahawks (-3.5)', 'Patriots vs. Seahawks');
  ins.run('s3', 'Spread: Seahawks (-4.5)', 'Patriots vs. Seahawks');
  ins.run('t1', 'Patriots vs. Seahawks: O/U 43.5', 'Patriots vs. Seahawks');
  ins.run('t2', 'Patriots vs. Seahawks: O/U 45.5', 'Patriots vs. Seahawks');
  const q = db.prepare(`INSERT INTO polymarket_quotes (captured_at,condition_id,mid_yes) VALUES (?,?,?)`);
  const at = (h) => `2026-09-01T${String(h).padStart(2, '0')}:00:00.000Z`;
  // capture 1: market at -3.5 / 44.5
  for (const [c, p] of [['s1', 0.56], ['s2', 0.50], ['s3', 0.44], ['t1', 0.55], ['t2', 0.45]]) q.run(at(10), c, p);
  // capture 2: tiny noise, no material change
  for (const [c, p] of [['s1', 0.565], ['s2', 0.502], ['s3', 0.44], ['t1', 0.55], ['t2', 0.45]]) q.run(at(11), c, p);
  // capture 3: market moves to about -4.4 (Seahawks steam) — the ladder still
  // crosses 50% between the -4.5 and -3.5 legs, so it is a priced number.
  for (const [c, p] of [['s1', 0.70], ['s2', 0.62], ['s3', 0.49], ['t1', 0.55], ['t2', 0.45]]) q.run(at(12), c, p);
  // capture 4: the whole ladder above 50% — unpriced at these legs, carried
  // forward, and NOT a move.
  for (const [c, p] of [['s1', 0.75], ['s2', 0.66], ['s3', 0.55], ['t1', 0.55], ['t2', 0.45]]) q.run(at(13), c, p);

  const first = pm.pollPolymarketLines({ sinceHours: 24 * 400 });
  assert.equal(first.games, 1);
  assert.equal(first.first_seen, 1);
  assert.equal(first.moves, 1, 'one material move after the first sighting');
  // The noise capture counts as unchanged; the fully unpriced capture (no
  // spread crossing, and only two total legs) is skipped outright.
  assert.equal(first.unchanged, 1);
  assert.equal(rows(`SELECT COUNT(*) n FROM polymarket_line_moves`)[0].n, 2, 'the unpriced capture is not logged as a move');
  const logged = rows(`SELECT captured_at, home_spread, total, spread_delta, first_sighting, season, week FROM polymarket_line_moves ORDER BY captured_at`);
  assert.equal(logged.length, 2);
  assert.equal(logged[0].first_sighting, 1);
  assert.equal(logged[0].season, 2026);
  assert.equal(logged[0].week, 1);
  assert.ok(Math.abs(logged[0].home_spread - -3.5) < 0.05, `first implied spread ${logged[0].home_spread}`);
  assert.ok(logged[1].spread_delta < -0.5, `the move is toward the home favorite: ${logged[1].spread_delta}`);
  assert.equal(first.detected[0].matchup, 'NE at SEA');

  const again = pm.pollPolymarketLines({ sinceHours: 24 * 400 });
  assert.equal(again.moves, 0, 'rerunning is idempotent');
  const movement = pm.polymarketMovement();
  assert.equal(movement.games, 1);
  assert.equal(movement.current[0].open_spread, logged[0].home_spread);
  assert.equal(movement.recent_moves.length, 1);
});
