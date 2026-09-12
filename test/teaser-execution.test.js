import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-teaser-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
await import('../server/services/line-shopping.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

// settleTeaserExecution() now resolves the real final score from game_lines
// (via teamResolver()), same as settleExecutionOpportunities() does — it no
// longer trusts a caller-supplied score. teamResolver() reads nfl_teams, so
// the real teams this test's legs will settle against must exist here.
db.exec(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
  (1, 'KC', 'Kansas City Chiefs', 'AFC', 'West'),
  (2, 'BAL', 'Baltimore Ravens', 'AFC', 'North'),
  (3, 'SEA', 'Seattle Seahawks', 'NFC', 'West'),
  (4, 'SF', 'San Francisco 49ers', 'NFC', 'West'),
  (5, 'BUF', 'Buffalo Bills', 'AFC', 'East'),
  (6, 'MIA', 'Miami Dolphins', 'AFC', 'East'),
  (7, 'GB', 'Green Bay Packers', 'NFC', 'North'),
  (8, 'CHI', 'Chicago Bears', 'NFC', 'North')`);

const { recordTeaserPrice } = await import('../server/services/nfl-profitability.js');
const { clearShoppingBoardCache } = await import('../server/services/nfl-shopping-board.js');
const { easternGameDate } = await import('../server/services/nfl-contract-key.js');
const {
  compileTeaserRoutes, teaserExecutionBoard, recordTeaserExecution,
  settleTeaserExecution, teaserExecutionLedger
} = await import('../server/services/nfl-teaser-execution.js');

test.after(() => {
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

const history = { legs: 1391, wins: 1039, win_rate: 0.7469, standard_error: 0.0117 };
const now = new Date('2026-09-01T12:00:00Z');
const event = (event_id, side, line, book = 'draftkings') => ({
  event_id, captured_at: '2026-09-01T11:55:00Z', commence_time: '2026-09-02T17:00:00Z',
  home_team: `${event_id} HOME`, away_team: `${event_id} AWAY`,
  quotes: [{ event_id, captured_at: '2026-09-01T11:55:00Z', book, side, line }]
});

test('route compiler pairs only different games at the same book', () => {
  const prices = [{ book: 'draftkings', captured_at: '2026-09-01T11:30:00Z',
    american_price: -110, reachable: 1 }];
  const out = compileTeaserRoutes({
    events: [event('A', 'A AWAY', 2), event('B', 'B AWAY', 2),
      event('C', 'C AWAY', 2, 'fanduel')],
    prices, history, now
  });
  assert.equal(out.eligible_candidates, 1);
  assert.equal(out.candidates[0].book, 'draftkings');
  assert.notEqual(out.candidates[0].legs[0].event_id, out.candidates[0].legs[1].event_id);
  assert.deepEqual(out.candidates[0].legs.map(leg => leg.teased_line), [8, 8]);
});

test('route compiler blocks stale quotes and payouts that destroy the edge', () => {
  const badPrice = compileTeaserRoutes({
    events: [event('D', 'D AWAY', 2), event('E', 'E AWAY', 2)],
    prices: [{ book: 'draftkings', captured_at: '2026-09-01T11:30:00Z',
      american_price: -130, reachable: 1 }], history, now
  });
  assert.equal(badPrice.eligible_candidates, 0);
  assert.ok(badPrice.candidates[0].blocked_reasons.some(reason => /break-even|operating gate/.test(reason)));

  const stale = compileTeaserRoutes({
    events: [event('F', 'F AWAY', 2), event('G', 'G AWAY', 2)],
    prices: [{ book: 'draftkings', captured_at: '2026-08-01T11:30:00Z',
      american_price: -110, reachable: 1 }], history, now
  });
  assert.equal(stale.eligible_candidates, 0);
  assert.ok(stale.candidates[0].blocked_reasons.some(reason => /older than/.test(reason)));
});

test('validated tickets persist both legs and settle into a forward leg rate', () => {
  // Give wongHistory() a measured rate in this isolated database.
  //
  // The season matters now and did not used to. wongHistory() defaults to
  // 1999-2024 because game_lines.spread is corrupted for 2025 and 2026, so a
  // fixture seeded at 2025 measures nothing, wongHistory returns {legs: 0}, and
  // every downstream gate fails for a reason that has nothing to do with what
  // this test is checking. Seed inside the window.
  const insertGame = db.prepare(`INSERT INTO game_lines
    (season,week,team,opponent,home,spread,team_score,opp_score)
    VALUES (2024,?,?,?,0,2,?,?)`);
  for (let i = 0; i < 100; i++) insertGame.run(i + 1, `HIST${i}`, `OPP${i}`,
    i < 75 ? 21 : 10, i < 75 ? 20 : 20);

  const capturedAt = new Date().toISOString();
  const commence = new Date(Date.now() + 24 * 3600e3).toISOString();
  // Two real, different games so settlement can look up a real final score
  // from game_lines instead of trusting whatever the caller sends. Only the
  // away (underdog) side of each qualifies for a 6-point tease at +2 -- the
  // home side at -2 is outside the qualifying window -- so each event
  // contributes exactly one leg, matching the two-leg ticket this test grades.
  const games = [
    { id: 'EXEC_A', home: 'Kansas City Chiefs', homeAbbr: 'KC', away: 'Baltimore Ravens', awayAbbr: 'BAL' },
    { id: 'EXEC_B', home: 'Seattle Seahawks', homeAbbr: 'SEA', away: 'San Francisco 49ers', awayAbbr: 'SF' }
  ];
  const insertLine = db.prepare(`INSERT INTO nfl_line_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price)
    VALUES (?,?,?,?,?,?, 'spreads',?,?,?)`);
  for (const { id, home, away } of games) {
    insertLine.run(capturedAt, id, commence, home, away, 'draftkings', away, 2, -110);
    insertLine.run(capturedAt, id, commence, home, away, 'draftkings', home, -2, -110);
    insertLine.run(capturedAt, id, commence, home, away, 'fanduel', away, 1, -110);
    insertLine.run(capturedAt, id, commence, home, away, 'fanduel', home, -1, -110);
  }
  recordTeaserPrice({ book: 'draftkings', teaser_points: 6, legs: 2,
    american_price: -110, reachable: true, captured_at: capturedAt });
  clearShoppingBoardCache();

  // Real final scores in game_lines, both directions, for settleTeaserExecution
  // to look up: Baltimore covers its +8 tease despite losing by 1 (WON), San
  // Francisco does not despite the tease (LOST) -- the same win/loss split, and
  // therefore the same ticket-level 'lost' and 0.5 forward leg rate, the old
  // caller-supplied-score version of this test asserted.
  const gameday = easternGameDate(commence);
  const insertFinal = db.prepare(`INSERT INTO game_lines
    (season,week,team,opponent,home,gameday,gametime,team_score,opp_score)
    VALUES (2099,1,?,?,?,?,?,?,?)`);
  insertFinal.run('KC', 'BAL', 1, gameday, '13:00', 21, 20);
  insertFinal.run('BAL', 'KC', 0, gameday, '13:00', 20, 21);
  insertFinal.run('SEA', 'SF', 1, gameday, '13:00', 20, 10);
  insertFinal.run('SF', 'SEA', 0, gameday, '13:00', 10, 20);

  const board = teaserExecutionBoard();
  const candidate = board.candidates.find(item => item.eligible);
  assert.ok(candidate, 'fresh qualifying legs and a reachable -110 price should produce a route');
  const logged = recordTeaserExecution({ candidate_id: candidate.candidate_id, mode: 'paper', stake_units: 1 });
  assert.equal(logged.logged, true);
  assert.equal(logged.candidate.legs.length, 2);

  const settled = settleTeaserExecution(logged.execution_id);
  assert.equal(settled.status, 'lost');
  assert.equal(settled.profit_units, -1);
  const ledger = teaserExecutionLedger();
  assert.equal(ledger.summary.graded_legs, 2);
  assert.equal(ledger.summary.forward_leg_rate, 0.5);
  assert.equal(ledger.executions[0].legs.length, 2);
});

test('settleTeaserExecution refuses to grade a leg from a caller-supplied score, and a game with no recorded final', () => {
  const capturedAt = new Date().toISOString();
  const commence = new Date(Date.now() + 24 * 3600e3).toISOString();
  const insertLine = db.prepare(`INSERT INTO nfl_line_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price)
    VALUES (?,?,?,?,?,?, 'spreads',?,?,?)`);
  // Two more real games, using DIFFERENT teams than the previous test (which
  // recorded real KC/BAL and SEA/SF finals under the same "tomorrow" gameday
  // this test also lands on) so this exercises the refusal path in isolation,
  // never accidentally matching that leftover final.
  const games = [
    { id: 'EXEC_C', home: 'Buffalo Bills', away: 'Miami Dolphins' },
    { id: 'EXEC_D', home: 'Green Bay Packers', away: 'Chicago Bears' }
  ];
  for (const { id, home, away } of games) {
    // A second book is required: simultaneousQuotes() only reports an event
    // that carries more than one book at the same capture instant.
    insertLine.run(capturedAt, id, commence, home, away, 'draftkings', away, 2, -110);
    insertLine.run(capturedAt, id, commence, home, away, 'draftkings', home, -2, -110);
    insertLine.run(capturedAt, id, commence, home, away, 'fanduel', away, 1, -110);
    insertLine.run(capturedAt, id, commence, home, away, 'fanduel', home, -1, -110);
  }
  clearShoppingBoardCache();

  // The board pairs every qualifying leg with every other, including
  // EXEC_A/EXEC_B from the previous test (still on the board -- their
  // snapshots are still fresh and that ticket is already logged), so the
  // candidate actually wanted here is specifically the EXEC_C/EXEC_D pair,
  // not just the first eligible one.
  const board = teaserExecutionBoard();
  const eventIds = new Set(games.map(g => g.id));
  const candidate = board.candidates.find(item => item.eligible
    && item.legs.every(leg => eventIds.has(leg.event_id)));
  assert.ok(candidate, 'fresh qualifying legs and a reachable -110 price should produce a route');
  const logged = recordTeaserExecution({ candidate_id: candidate.candidate_id, mode: 'paper', stake_units: 1 });
  assert.equal(logged.logged, true);

  // A malicious or buggy caller claiming a score must not settle the ticket --
  // only game_lines can.
  const forged = settleTeaserExecution(logged.execution_id, { scores: [
    { event_id: logged.candidate.legs[0].event_id, team_score: 99, opponent_score: 0 },
    { event_id: logged.candidate.legs[1].event_id, team_score: 99, opponent_score: 0 }
  ] });
  assert.match(forged.error, /final score not yet available/);
  const stillOpen = teaserExecutionLedger().executions.find(e => e.id === logged.execution_id);
  assert.equal(stillOpen.status, 'open', 'a forged score must never settle the ticket');
});
