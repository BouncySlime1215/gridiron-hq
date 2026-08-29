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
const { recordTeaserPrice } = await import('../server/services/nfl-profitability.js');
const { clearShoppingBoardCache } = await import('../server/services/nfl-shopping-board.js');
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
  const insertGame = db.prepare(`INSERT INTO game_lines
    (season,week,team,opponent,home,spread,team_score,opp_score)
    VALUES (2025,?,?,?,0,2,?,?)`);
  for (let i = 0; i < 100; i++) insertGame.run(i + 1, `HIST${i}`, `OPP${i}`,
    i < 75 ? 21 : 10, i < 75 ? 20 : 20);

  const capturedAt = new Date().toISOString();
  const commence = new Date(Date.now() + 24 * 3600e3).toISOString();
  const insertLine = db.prepare(`INSERT INTO nfl_line_snapshots
    (captured_at,event_id,commence_time,home_team,away_team,book,market,side,line,price)
    VALUES (?,?,?,?,?,?, 'spreads',?,?,?)`);
  for (const id of ['EXEC_A', 'EXEC_B']) {
    const home = `${id}_HOME`, away = `${id}_AWAY`;
    insertLine.run(capturedAt, id, commence, home, away, 'draftkings', away, 2, -110);
    insertLine.run(capturedAt, id, commence, home, away, 'draftkings', home, -2, -110);
    insertLine.run(capturedAt, id, commence, home, away, 'fanduel', away, 1, -110);
    insertLine.run(capturedAt, id, commence, home, away, 'fanduel', home, -1, -110);
  }
  recordTeaserPrice({ book: 'draftkings', teaser_points: 6, legs: 2,
    american_price: -110, reachable: true, captured_at: capturedAt });
  clearShoppingBoardCache();

  const board = teaserExecutionBoard();
  const candidate = board.candidates.find(item => item.eligible);
  assert.ok(candidate, 'fresh qualifying legs and a reachable -110 price should produce a route');
  const logged = recordTeaserExecution({ candidate_id: candidate.candidate_id, mode: 'paper', stake_units: 1 });
  assert.equal(logged.logged, true);
  assert.equal(logged.candidate.legs.length, 2);

  const scores = logged.candidate.legs.map((leg, index) => ({ event_id: leg.event_id,
    team_score: index === 0 ? 20 : 10, opponent_score: index === 0 ? 21 : 20 }));
  const settled = settleTeaserExecution(logged.execution_id, { scores });
  assert.equal(settled.status, 'lost');
  assert.equal(settled.profit_units, -1);
  const ledger = teaserExecutionLedger();
  assert.equal(ledger.summary.graded_legs, 2);
  assert.equal(ledger.summary.forward_leg_rate, 0.5);
  assert.equal(ledger.executions[0].legs.length, 2);
});
