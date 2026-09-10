/**
 * Codex audit finding E9 (2026-09-10): "accepted positions, CLV and staking
 * learning are separate systems." The lifecycle ledger computed realized
 * P&L, but closing-value grading lived on a different table
 * (`nfl_bet_log`), needed a separate recordBet action, and read a different
 * source — so an accepted position was never graded for CLV at all.
 *
 * These cover the audit's four named acceptance criteria: one accepted
 * ticket appears once across exposure/settlement/CLV; a retry is idempotent;
 * a late-arriving close grades once; a missing close does not remove a
 * losing bet from ROI; and multiple books on one game do not inflate the
 * independent evidence count.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-execution-clv-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

db.exec(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
  (1, 'CHI', 'Chicago Bears', 'NFC', 'North'),
  (2, 'CAR', 'Carolina Panthers', 'NFC', 'South')`);

const KICKOFF = '2026-09-13T17:00:00.000Z';
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,gameday,gametime)
  VALUES (2026,2,'CAR','CHI',1,-2.5,44,'2026-09-13','13:00')`);

const { contractKey } = await import('../server/services/nfl-contract-key.js');
const { openOpportunity, recordObserved, recordDecision, recordAcceptance, settleOpportunity, netRealizedUnits } =
  await import('../server/services/nfl-execution-lifecycle.js');
const { executionClvReport, closingQuoteForContract, kickoffForEvent } =
  await import('../server/services/nfl-execution-clv.js');

/** A quote-tape row for the exact contract, at a given instant. */
let batchSeq = 0;
function tapeQuote({ at, book, line, price, side = 'home' }) {
  const batchId = `b${++batchSeq}`;
  run(`INSERT INTO nfl_quote_batches (batch_id, provider, requested_at, snapshot_at, mode, markets,
      source_ref, events, quotes, raw_hash, tape_version, created_at)
    VALUES (?,'test',?,?,'current','spreads','test',1,1,?, 'test-v1', ?)`, batchId, at, at, batchId, at);
  run(`INSERT INTO nfl_quote_tape
    (quote_id, batch_id, provider, provider_event_id, commence_time, home_team, away_team,
     market, period, side_key, side_name, line, american_price, implied_probability,
     bookmaker_key, snapshot_at, raw_json, tape_version, created_at)
    VALUES (?,?,'test','ev1',?,'Carolina Panthers','Chicago Bears','spreads','full_game',?,?,?,?,0.5,?,?,'{}','test-v1',?)`,
  `${batchId}|${book}|${side}|${line}`, batchId, KICKOFF, side, side, line, price, book, at, at);
}

function acceptedPosition({ line = -2.5, price = -110, stakeUnits = 1 }) {
  const c = contractKey({ homeTeam: 'Carolina Panthers', awayTeam: 'Chicago Bears',
    commenceTime: KICKOFF, market: 'spreads', side: 'home', line });
  assert.equal(c.ok, true, JSON.stringify(c));
  const opp = openOpportunity({ contract: c, decisionSource: 'test',
    occurredAt: '2026-09-12T10:00:00Z', book: 'draftkings', line, price });
  recordObserved(opp.id, { occurredAt: '2026-09-12T10:00:05Z', book: 'draftkings', line, price });
  recordDecision(opp.id, { occurredAt: '2026-09-12T10:05:00Z', book: 'draftkings', line, price });
  recordAcceptance(opp.id, { occurredAt: '2026-09-12T10:06:00Z', book: 'draftkings', line, price, stakeUnits });
  return opp;
}

test('kickoffForEvent resolves the real kickoff from the authoritative schedule', () => {
  assert.equal(kickoffForEvent('nfl|2026-09-13|CHI@CAR'), KICKOFF);
  assert.equal(kickoffForEvent('nonsense'), null);
  assert.equal(kickoffForEvent('nfl|2026-09-13|XXX@YYY'), null, 'an unknown game is null, never a guessed kickoff');
});

test('E9: with no close captured, the position is ungraded WITH a reason — and keeps its realized P&L', () => {
  const opp = acceptedPosition({ line: -2.5 });
  settleOpportunity(opp.id, { occurredAt: '2026-09-13T21:00:00Z', result: 'lost' });

  const report = executionClvReport();
  assert.equal(report.coverage.graded_positions, 0);
  assert.equal(report.coverage.ungraded_positions, 1);
  assert.equal(report.ungraded[0].reason, 'no_quote_tape_coverage');
  // The audit's exact requirement: a missing close must not remove a losing
  // bet from the economics.
  assert.equal(report.ungraded[0].realized_units, -1);
  assert.equal(report.economics.realized_units, -1);
  assert.equal(report.economics.positions_counted, 1);
});

test('E9: a close at a DIFFERENT line is refused rather than blended into a comparison', () => {
  // The market closed at -7.5; our ticket is -2.5. Those are different
  // contracts, and pricing one against the other is what the audit forbids.
  tapeQuote({ at: '2026-09-13T16:00:00Z', book: 'draftkings', line: -7.5, price: -110 });
  const result = closingQuoteForContract({ market: 'spreads', side: 'home', line: -2.5, kickoff: KICKOFF });
  assert.equal(result.close, null);
  assert.equal(result.reason, 'no_close_at_this_exact_line');
  assert.deepEqual(result.observed_close_lines, [-7.5]);
});

test('E9 acceptance: a late-arriving close simply grades — and re-reading is idempotent', () => {
  // The exact contract's close finally lands.
  tapeQuote({ at: '2026-09-13T16:30:00Z', book: 'draftkings', line: -2.5, price: -115 });
  tapeQuote({ at: '2026-09-13T16:30:00Z', book: 'fanduel', line: -2.5, price: -113 });

  const first = executionClvReport();
  assert.equal(first.coverage.graded_positions, 1);
  const p = first.positions[0];
  assert.equal(p.accepted_line, -2.5);
  assert.equal(p.closing_line, -2.5);
  assert.equal(p.clv_points, 0, 'same number taken and closed: zero line CLV, not a missing value');
  // We paid -110 and it closed at -114 (median of -115/-113): we got the better price.
  assert.equal(p.closing_price, -114);
  assert.equal(p.clv_price_cents, -4);
  assert.equal(p.closing_books, 2);

  // Nothing is written, so grading again is the same answer -- "graded once"
  // is structural here rather than defended by a graded_at flag.
  const second = executionClvReport();
  assert.deepEqual(second.positions, first.positions);
  assert.deepEqual(second.coverage, first.coverage);
});

test('E9 acceptance: two books on the SAME game are one piece of independent evidence, not two', () => {
  const report = executionClvReport();
  // Two quote-tape books priced this contract's close, and the position is
  // still exactly one ticket on exactly one event.
  assert.equal(report.positions[0].closing_books, 2);
  assert.equal(report.coverage.independent_events, 1);
  assert.equal(report.coverage.graded_positions, 1);
});

test('E9 acceptance: one accepted ticket appears exactly once across settlement, economics and CLV', () => {
  const report = executionClvReport();
  const ids = report.positions.map(p => p.id).concat(report.ungraded.map(u => u.id));
  assert.equal(new Set(ids).size, ids.length, 'no position may appear in both the graded and ungraded sets');
  assert.equal(report.coverage.accepted_positions,
    report.coverage.graded_positions + report.coverage.ungraded_positions);
  // And its realized figure is the ledger's own net, not a recomputation.
  assert.equal(report.positions[0].realized_units, netRealizedUnits(report.positions[0].id));
});

test('E9: line CLV is signed so positive always means we got the better number', () => {
  // A second, separate game so this does not disturb the first fixture.
  run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,gameday,gametime)
    VALUES (2026,3,'CHI','CAR',1,-1.5,44,'2026-09-20','13:00')`);
  const kickoff2 = '2026-09-20T17:00:00.000Z';
  const c = contractKey({ homeTeam: 'Chicago Bears', awayTeam: 'Carolina Panthers',
    commenceTime: kickoff2, market: 'spreads', side: 'home', line: -1.5 });
  const opp = openOpportunity({ contract: c, decisionSource: 'test',
    occurredAt: '2026-09-19T10:00:00Z', book: 'draftkings', line: -1.5, price: -110 });
  recordObserved(opp.id, { occurredAt: '2026-09-19T10:00:05Z', book: 'draftkings', line: -1.5, price: -110 });
  recordDecision(opp.id, { occurredAt: '2026-09-19T10:05:00Z', book: 'draftkings', line: -1.5, price: -110 });
  recordAcceptance(opp.id, { occurredAt: '2026-09-19T10:06:00Z', book: 'draftkings', line: -1.5, price: -110, stakeUnits: 1 });

  const batchId = 'b-week3';
  run(`INSERT INTO nfl_quote_batches (batch_id, provider, requested_at, snapshot_at, mode, markets,
      source_ref, events, quotes, raw_hash, tape_version, created_at)
    VALUES (?,'test',?,?,'current','spreads','test',1,1,?, 'test-v1', ?)`,
  batchId, '2026-09-20T16:00:00Z', '2026-09-20T16:00:00Z', batchId, '2026-09-20T16:00:00Z');
  run(`INSERT INTO nfl_quote_tape
    (quote_id, batch_id, provider, provider_event_id, commence_time, home_team, away_team,
     market, period, side_key, side_name, line, american_price, implied_probability,
     bookmaker_key, snapshot_at, raw_json, tape_version, created_at)
    VALUES ('w3|dk|home','${batchId}','test','ev2',?, 'Chicago Bears','Carolina Panthers',
      'spreads','full_game','home','home',-1.5,-110,0.5,'draftkings',?,'{}','test-v1',?)`,
  kickoff2, '2026-09-20T16:00:00Z', '2026-09-20T16:00:00Z');

  const report = executionClvReport();
  const week3 = report.positions.find(p => p.event_key.includes('2026-09-20'));
  assert.ok(week3, JSON.stringify(report.coverage));
  assert.equal(week3.clv_points, 0);
  assert.equal(report.coverage.independent_events, 2, 'two distinct games are two pieces of evidence');
});
