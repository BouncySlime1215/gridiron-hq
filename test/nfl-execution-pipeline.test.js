import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * The connector between the existing NFL spread decision board
 * (nfl-auto-picks.js) and Package H's execution ledger. `runExecutionPipeline`
 * itself is exercised only at the integration/live level — going through it
 * for real means computing the full ensemble (nfl-ensemble.js: team-week
 * aggregates, injuries, snaps, calibration, dozens of models), which is
 * exactly the machinery `autoPickDecisionBoard` already owns and tests
 * separately. Fabricating all of that here to drive one more code path
 * through nfl-execution-pipeline.js would duplicate that surface without
 * proving anything nfl-auto-picks.js's own tests don't already prove.
 *
 * What IS genuinely new here — contract resolution from a candidate's plain
 * fields, the quote-tape-vs-single-sample fallback and its labeling, event-key
 * parsing for settlement, and the settlement arithmetic itself — is tested
 * directly and for real, against the real lifecycle/replay primitives and a
 * real seeded game_lines row.
 */
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-execution-pipeline-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

db.exec(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
  (1, 'KC', 'Kansas City Chiefs', 'AFC', 'West'),
  (2, 'BAL', 'Baltimore Ravens', 'AFC', 'North')`);

const { contractKey } = await import('../server/services/nfl-contract-key.js');
const { openOpportunity, recordObserved, recordDecision, recordAcceptance, getOpportunity } =
  await import('../server/services/nfl-execution-lifecycle.js');
const { ingestQuoteSnapshot } = await import('../server/services/nfl-quote-tape.js');
const { settleExecutionOpportunities, __test } =
  await import('../server/services/nfl-execution-pipeline.js');
const { sideFor, resolveQuoteBasis, parseEventKey } = __test;

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('sideFor: resolves home or away from the candidate\'s own selection field, and neither on a mismatch', () => {
  const candidate = { selection: 'Kansas City Chiefs', home_team: 'Kansas City Chiefs', away_team: 'Baltimore Ravens' };
  assert.equal(sideFor(candidate), 'home');
  assert.equal(sideFor({ ...candidate, selection: 'Baltimore Ravens' }), 'away');
  assert.equal(sideFor({ ...candidate, selection: 'Some Other Team' }), null);
});

test('parseEventKey: round-trips a real contractKey() event_key, and refuses a malformed one', () => {
  const c = contractKey({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
    commenceTime: '2026-09-13T17:00:00Z', market: 'spreads', side: 'home', line: -3.5 });
  assert.equal(c.ok, true);
  const parsed = parseEventKey(c.event_key);
  assert.deepEqual(parsed, { gameDate: c.game_date, away: 'BAL', home: 'KC' });
  assert.equal(parseEventKey('not-a-real-key'), null);
  assert.equal(parseEventKey(undefined), null);
});

test('resolveQuoteBasis: prefers the real multi-book quote tape when this event is actually covered by it', () => {
  const payload = (snapshotAt, price) => ([{ id: 'espn-pipeline-1', commence_time: '2026-09-13T17:00:00Z',
    home_team: 'Kansas City Chiefs', away_team: 'Baltimore Ravens',
    bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets: [{ key: 'spreads', last_update: snapshotAt,
      outcomes: [{ name: 'Kansas City Chiefs', point: -3.5, price }, { name: 'Baltimore Ravens', point: 3.5, price: -110 }] }] }] }]);
  ingestQuoteSnapshot(payload('2026-09-12T10:00:00Z', -110), { requestedAt: '2026-09-12T10:00:05Z', sourceRef: 'pipeline_test_1' });
  ingestQuoteSnapshot(payload('2026-09-12T10:06:00Z', -120), { requestedAt: '2026-09-12T10:06:05Z', sourceRef: 'pipeline_test_2' });

  const contract = contractKey({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
    commenceTime: '2026-09-13T17:00:00Z', market: 'spreads', side: 'home', line: -3.5 });
  const candidate = { book: 'draftkings', american_price: -110, quote_at: '2026-09-11 09:00:00' };
  const basis = resolveQuoteBasis(candidate, contract);
  assert.equal(basis.provenance, 'quote_tape');
  assert.equal(basis.timeline.length, 2, 'both real polls should be in the timeline, not just the candidate\'s own single price');
  assert.equal(basis.provider_event_id, 'espn-pipeline-1');
});

test('resolveQuoteBasis: falls back to the decision board\'s own single captured price when the tape has nothing for this event, and labels it as a single sample', () => {
  const contract = contractKey({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
    commenceTime: '2026-11-01T18:00:00Z', market: 'spreads', side: 'home', line: -2.5 }); // an event the tape never saw
  const candidate = { book: 'espn', american_price: -105, quote_at: '2026-10-31 19:09:49' };
  const basis = resolveQuoteBasis(candidate, contract);
  assert.equal(basis.provenance, 'decision_board_single_sample');
  assert.equal(basis.timeline.length, 1);
  assert.equal(basis.timeline[0].price, -105);
  assert.equal(basis.provider_event_id, null);
});

test('resolveQuoteBasis: refuses rather than fabricating a quote when the candidate itself has no usable price', () => {
  const contract = contractKey({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
    commenceTime: '2026-11-08T18:00:00Z', market: 'spreads', side: 'home', line: -1 });
  assert.equal(resolveQuoteBasis({ book: 'espn', american_price: null, quote_at: null }, contract), null);
});

function acceptedOpportunity({ homeTeam, awayTeam, commenceTime, side, line, price, stakeUnits }) {
  const c = contractKey({ homeTeam, awayTeam, commenceTime, market: 'spreads', side, line });
  assert.equal(c.ok, true);
  const opp = openOpportunity({ contract: c, decisionSource: 'test', occurredAt: '2026-09-10T10:00:00Z',
    book: 'draftkings', line, price });
  recordObserved(opp.id, { occurredAt: '2026-09-10T10:00:05Z', book: 'draftkings', line, price });
  recordDecision(opp.id, { occurredAt: '2026-09-10T10:05:00Z', book: 'draftkings', line, price });
  recordAcceptance(opp.id, { occurredAt: '2026-09-10T10:05:05Z', book: 'draftkings', line, price, stakeUnits });
  return opp.id;
}

test('settleExecutionOpportunities: a covered home favorite settles WON with real realized P&L, from the real final score', () => {
  run(`INSERT INTO game_lines (season, week, team, opponent, home, gameday, gametime, spread, team_score, opp_score)
       VALUES (2026, 2, 'KC', 'BAL', 1, '2026-09-20', '13:00', -3.5, 27, 17),
              (2026, 2, 'BAL', 'KC', 0, '2026-09-20', '13:00', 3.5, 17, 27)`);
  const id = acceptedOpportunity({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
    commenceTime: '2026-09-20T17:00:00Z', side: 'home', line: -3.5, price: -110, stakeUnits: 1 });

  const { settled, skipped } = settleExecutionOpportunities();
  assert.equal(skipped.length, 0);
  const mine = settled.find(s => s.id === id);
  assert.ok(mine, 'this opportunity should have been settled');
  assert.equal(mine.result, 'won');
  assert.ok(Math.abs(mine.realized_pnl_units - (100 / 110)) < 1e-3);
  assert.equal(getOpportunity(id).status, 'settled');
});

test('settleExecutionOpportunities: an away underdog that lost by less than the line settles WON, not LOST — the sign convention is exercised both directions', () => {
  run(`INSERT INTO game_lines (season, week, team, opponent, home, gameday, gametime, spread, team_score, opp_score)
       VALUES (2026, 3, 'KC', 'BAL', 1, '2026-09-27', '13:00', -3.5, 20, 17),
              (2026, 3, 'BAL', 'KC', 0, '2026-09-27', '13:00', 3.5, 17, 20)`);
  // BAL +3.5: lost by 3, which is inside the 3.5-point cushion -- a cover.
  const id = acceptedOpportunity({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
    commenceTime: '2026-09-27T17:00:00Z', side: 'away', line: 3.5, price: -110, stakeUnits: 1 });

  const { settled } = settleExecutionOpportunities();
  const mine = settled.find(s => s.id === id);
  assert.equal(mine.result, 'won');
});

test('settleExecutionOpportunities: an exact push settles at precisely zero, and is idempotent on a second run', () => {
  run(`INSERT INTO game_lines (season, week, team, opponent, home, gameday, gametime, spread, team_score, opp_score)
       VALUES (2026, 4, 'KC', 'BAL', 1, '2026-10-04', '13:00', -3, 24, 21),
              (2026, 4, 'BAL', 'KC', 0, '2026-10-04', '13:00', 3, 21, 24)`);
  const id = acceptedOpportunity({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
    commenceTime: '2026-10-04T17:00:00Z', side: 'home', line: -3, price: -110, stakeUnits: 1 });

  const first = settleExecutionOpportunities();
  const mine = first.settled.find(s => s.id === id);
  assert.equal(mine.result, 'push');
  assert.equal(mine.realized_pnl_units, 0);

  // The opportunity is now SETTLED (terminal), so a second run must not see
  // it again as an open, acceptable position -- proving this is safe to call
  // repeatedly (e.g. from a manual "run settlement now" action) rather than
  // exactly once.
  const second = settleExecutionOpportunities();
  assert.equal(second.settled.find(s => s.id === id), undefined);
});

test('settleExecutionOpportunities: an accepted position whose game has not finished yet is skipped, never guessed at', () => {
  run(`INSERT INTO game_lines (season, week, team, opponent, home, gameday, gametime, spread)
       VALUES (2026, 5, 'KC', 'BAL', 1, '2026-10-11', '13:00', -2.5),
              (2026, 5, 'BAL', 'KC', 0, '2026-10-11', '13:00', 2.5)`);
  const id = acceptedOpportunity({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
    commenceTime: '2026-10-11T17:00:00Z', side: 'home', line: -2.5, price: -110, stakeUnits: 1 });

  const { settled, skipped } = settleExecutionOpportunities();
  assert.equal(settled.find(s => s.id === id), undefined);
  assert.ok(skipped.find(s => s.id === id && s.reason === 'game_not_final'));
});
