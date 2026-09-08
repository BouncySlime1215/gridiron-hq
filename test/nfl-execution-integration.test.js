import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * The end-to-end path the plan actually asks for: Package A's immutable quote
 * tape feeds Package H's lifecycle ledger and delayed-execution replay,
 * addressed throughout by the exact contract key — never a synthetic price
 * and never a loosely-matched market/line string.
 */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-execution-integration-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

db.exec(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
  (1, 'KC', 'Kansas City Chiefs', 'AFC', 'West'),
  (2, 'BAL', 'Baltimore Ravens', 'AFC', 'North')`);

const { contractKey } = await import('../server/services/nfl-contract-key.js');
const { ingestQuoteSnapshot, bestExecutableQuote } = await import('../server/services/nfl-quote-tape.js');
const { openOpportunity, recordObserved, recordDecision, recordAcceptance, settleOpportunity, getOpportunity } =
  await import('../server/services/nfl-execution-lifecycle.js');
const { timelineFromQuoteTape, replayDelayedExecution } = await import('../server/services/nfl-execution-replay.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const commence = '2026-09-11T00:20:00Z';
const eventPayload = (snapshotAt, price, point) => ([{
  id: 'espn-401671', commence_time: commence, home_team: 'Kansas City Chiefs', away_team: 'Baltimore Ravens',
  bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets: [
    { key: 'spreads', last_update: snapshotAt,
      outcomes: [{ name: 'Kansas City Chiefs', point, price },
                 { name: 'Baltimore Ravens', point: -point, price: -110 }] }
  ] }]
}]);

// Two real snapshots on the immutable tape: the price gets worse between them.
ingestQuoteSnapshot(eventPayload('2026-09-10T10:00:00Z', -110, -3.5),
  { requestedAt: '2026-09-10T10:00:05Z', sourceRef: 'integration_test_1' });
ingestQuoteSnapshot(eventPayload('2026-09-10T10:06:00Z', -125, -3.5),
  { requestedAt: '2026-09-10T10:06:05Z', sourceRef: 'integration_test_2' });

test('a lifecycle opportunity opened from a real quote-tape row carries a genuine quote_id', () => {
  const offered = bestExecutableQuote('espn-401671', { market: 'spreads', sideKey: 'home', at: '2026-09-10T10:00:05Z' });
  assert.ok(offered, 'the quote tape should have a spread quote to offer');
  assert.equal(offered.american_price, -110);

  const contract = contractKey({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
    commenceTime: commence, market: 'spreads', side: 'home', line: offered.line });
  assert.equal(contract.ok, true);

  const opportunity = openOpportunity({
    contract, matchup: 'Baltimore Ravens at Kansas City Chiefs', decisionSource: 'shopping_board',
    occurredAt: offered.snapshot_at, book: offered.bookmaker_key, line: offered.line, price: offered.american_price,
    quoteId: offered.quote_id, source: 'quote_tape'
  });
  const offeredEvent = opportunity.events[0];
  assert.equal(offeredEvent.quote_id, offered.quote_id);
  assert.equal(offeredEvent.price, -110);

  recordObserved(opportunity.id, { occurredAt: '2026-09-10T10:00:06Z', book: 'draftkings', line: offered.line,
    price: offered.american_price, quoteId: offered.quote_id });
  const decided = recordDecision(opportunity.id, { occurredAt: '2026-09-10T10:05:00Z', book: 'draftkings',
    line: offered.line, price: offered.american_price, quoteId: offered.quote_id });
  assert.equal(decided.status, 'decision');
});

test('replaying the DECISION against the real tape reproduces exactly what a realistic delay would obtain', () => {
  const timeline = timelineFromQuoteTape({ providerEventId: 'espn-401671', market: 'spreads', sideKey: 'home',
    book: 'draftkings' });
  assert.equal(timeline.length, 2);

  // A decision made right after the first snapshot, executed 2 minutes later, lands past the
  // second (worse) snapshot — the price genuinely moved on the real tape.
  const replay = replayDelayedExecution({ timeline, decisionAt: '2026-09-10T10:05:00Z', delaySeconds: 120 });
  assert.equal(replay.outcome, 'repriced');
  assert.equal(replay.decision_price, -110);
  assert.equal(replay.obtained_price, -125);
  assert.ok(replay.breakeven_slippage_bps > 0);
});

test('done-when bar: the same frozen tape and the same decision reproduce the identical replay every time', () => {
  const build = () => {
    const timeline = timelineFromQuoteTape({ providerEventId: 'espn-401671', market: 'spreads', sideKey: 'home',
      book: 'draftkings' });
    return replayDelayedExecution({ timeline, decisionAt: '2026-09-10T10:05:00Z', delaySeconds: 120 });
  };
  assert.deepEqual(build(), build());
});

test('a full ledger walk sourced from the real tape settles with an exact realized P&L', () => {
  const offered = bestExecutableQuote('espn-401671', { market: 'spreads', sideKey: 'home', at: '2026-09-10T10:00:05Z' });
  const contract = contractKey({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
    commenceTime: commence, market: 'spreads', side: 'home', line: offered.line });
  const opportunity = openOpportunity({ contract, decisionSource: 'shopping_board',
    occurredAt: offered.snapshot_at, book: offered.bookmaker_key, line: offered.line, price: offered.american_price,
    quoteId: offered.quote_id });
  recordObserved(opportunity.id, { occurredAt: '2026-09-10T10:00:06Z', book: 'draftkings', line: offered.line, price: offered.american_price });
  recordDecision(opportunity.id, { occurredAt: '2026-09-10T10:05:00Z', book: 'draftkings', line: offered.line, price: offered.american_price });
  recordAcceptance(opportunity.id, { occurredAt: '2026-09-10T10:05:05Z', book: 'draftkings', line: offered.line,
    price: offered.american_price, stakeUnits: 1 });
  const settled = settleOpportunity(opportunity.id, { occurredAt: '2026-09-14T20:00:00Z', result: 'won' });
  const settleEvent = settled.events.find(e => e.state === 'settled');
  assert.ok(Math.abs(settleEvent.realized_pnl_units - (100 / 110)) < 1e-3);
  assert.equal(getOpportunity(opportunity.id).status, 'settled');
});
