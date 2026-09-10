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

test('E9: a close at a DIFFERENT line is never PRICED against ours, but still measures the move', () => {
  // The market closed at -7.5; our ticket is -2.5. Those are different
  // contracts and their prices must never be compared.
  //
  // Codex correction C13 refines what "refused" means here. Refusing to
  // produce a close at all would also throw away the handicap movement, and
  // the plan is explicit that a method requiring the exact accepted line
  // "naturally returns zero point movement and cannot stand in for a moving
  // main-line benchmark." So the main line IS reported, the price at our line
  // is not, and the two can never be mistaken for each other.
  tapeQuote({ at: '2026-09-13T16:00:00Z', book: 'draftkings', line: -7.5, price: -110 });
  const result = closingQuoteForContract({ eventKey: 'nfl|2026-09-13|CHI@CAR',
    market: 'spreads', side: 'home', line: -2.5, kickoff: KICKOFF });

  assert.equal(result.reason, 'no_close_at_this_exact_line');
  assert.equal(result.close.books, 0, 'no book closed on our number');
  assert.equal(result.close.price, null, 'so there is no price to compare against');
  assert.deepEqual(result.close.quote_ids, []);
  assert.equal(result.close.main_line, -7.5, 'the market did move, and that is measurable');
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
  // We paid -110 and it closed at -114: we got the better price.
  //
  // -114 is the average of -115 and -113 taken in DECIMAL space, not a median
  // of the raw American numbers. Codex correction C14: American odds are
  // discontinuous across the -100/+100 boundary, so averaging them directly is
  // not an average of anything. Here the two agree; on a set spanning the
  // boundary they do not.
  assert.equal(p.closing_price, -114);
  assert.equal(p.closing_books, 2);

  // Positive is better, in probability space. implied(-114) = 0.5327,
  // implied(-110) = 0.5238, so taking -110 beat the close by +0.0089.
  assert.ok(p.clv_probability > 0,
    'we paid less than the close, so price CLV must be POSITIVE under this sign');
  assert.equal(p.clv_probability, 0.0089);
  assert.ok(p.clv_decimal_return > 0, 'and positive in decimal-return space too');

  // The legacy field is preserved with its original arithmetic and a name that
  // states what it is, so an older exported number still reconciles. Its sign
  // is NOT positive-is-better -- that was the defect.
  assert.equal(p.clv_price_cents_v1_raw_american_difference, -4);
  assert.equal(p.clv_price_cents, undefined, 'the misleadingly-named field is gone, not silently reused');

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

/* ======================================================================
 * Codex correction C13 — "Closing-line grading can use the wrong game and
 * period" — and C14 — "Price CLV sign and American-odds arithmetic are
 * misleading." One test per close-with clause.
 * ====================================================================== */

const { CLV_GRADING_VERSION } = await import('../server/services/nfl-execution-clv.js');
const { impliedProbability, decimalReturn, americanFromDecimal } =
  await import('../server/betting/nfl/contracts/spread-probabilities.js');

/** A quote for a DIFFERENT game that kicks off at the same instant. */
function otherGameQuote({ at, book, line, price, period = 'full_game' }) {
  const batchId = `other-${++batchSeq}`;
  run(`INSERT INTO nfl_quote_batches (batch_id, provider, requested_at, snapshot_at, mode, markets,
      source_ref, events, quotes, raw_hash, tape_version, created_at)
    VALUES (?,'test',?,?,'current','spreads','test',1,1,?, 'test-v1', ?)`, batchId, at, at, batchId, at);
  run(`INSERT INTO nfl_quote_tape
    (quote_id, batch_id, provider, provider_event_id, commence_time, home_team, away_team,
     market, period, side_key, side_name, line, american_price, implied_probability,
     bookmaker_key, snapshot_at, raw_json, tape_version, created_at)
    VALUES (?,?,'test','ev-other',?,'Seattle Seahawks','San Francisco 49ers','spreads',?,'home','home',?,?,0.5,?,?,'{}','test-v1',?)`,
  `${batchId}|${book}`, batchId, KICKOFF, period, line, price, book, at, at);
}

/** A quote for OUR game but a different period. */
function ourGameOtherPeriod({ at, book, line, price, period }) {
  const batchId = `period-${++batchSeq}`;
  run(`INSERT INTO nfl_quote_batches (batch_id, provider, requested_at, snapshot_at, mode, markets,
      source_ref, events, quotes, raw_hash, tape_version, created_at)
    VALUES (?,'test',?,?,'current','spreads','test',1,1,?, 'test-v1', ?)`, batchId, at, at, batchId, at);
  run(`INSERT INTO nfl_quote_tape
    (quote_id, batch_id, provider, provider_event_id, commence_time, home_team, away_team,
     market, period, side_key, side_name, line, american_price, implied_probability,
     bookmaker_key, snapshot_at, raw_json, tape_version, created_at)
    VALUES (?,?,'test','ev1',?,'Carolina Panthers','Chicago Bears','spreads',?,'home','home',?,?,0.5,?,?,'{}','test-v1',?)`,
  `${batchId}|${book}|${period}`, batchId, KICKOFF, period, line, price, book, at, at);
}

const closeFor = (line = -2.5, opts = {}) => closingQuoteForContract({
  eventKey: 'nfl|2026-09-13|CHI@CAR', market: 'spreads', side: 'home', line, kickoff: KICKOFF, ...opts });

test('C13: a simultaneous DIFFERENT game cannot supply our close', () => {
  db.exec(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
    (3, 'SF', 'San Francisco 49ers', 'NFC', 'West'),
    (4, 'SEA', 'Seattle Seahawks', 'NFC', 'West')`);
  // The audit's fixture: another game's quote, later than ours, at a very
  // different number and price. The old predicate matched it on kickoff day.
  otherGameQuote({ at: '2026-09-13T16:55:00Z', book: 'draftkings', line: -12.5, price: -400 });

  const result = closeFor(-2.5);
  assert.ok(!result.close.observed_lines.includes(-12.5),
    "another game's number must never appear among ours");
  assert.ok(result.close.main_line_quote_ids.every(id => !id.startsWith('other-')));
});

test('C13: a FIRST-HALF quote cannot close a full-game spread', () => {
  // The audit's exact counterexample shape: a first-half -2.5 at -200,
  // captured after our full-game quotes, matching on market and side.
  ourGameOtherPeriod({ at: '2026-09-13T16:58:00Z', book: 'draftkings', line: -2.5, price: -200, period: 'first_half' });

  const result = closeFor(-2.5);
  assert.ok(result.close.main_line_quote_ids.every(id => !id.includes('first_half')),
    'a first-half spread settles on different points; it is a different contract');
  assert.notEqual(result.close.price, -200);
});

test('C13: the close is the latest per BOOK, not every row sharing one instant', () => {
  // draftkings updates twice; fanduel updates once, earlier, and stops.
  // The old rule kept only rows at the single latest snapshot_at, which
  // dropped fanduel entirely and would have double-counted a book that posted
  // twice in the same second.
  tapeQuote({ at: '2026-09-13T16:40:00Z', book: 'caesars', line: -3, price: -110 });
  tapeQuote({ at: '2026-09-13T16:50:00Z', book: 'caesars', line: -3, price: -105 });
  tapeQuote({ at: '2026-09-13T16:45:00Z', book: 'betmgm', line: -3, price: -108 });

  const result = closeFor(-3);
  const books = result.close.books_contributing;
  assert.equal(new Set(books).size, books.length, 'each book contributes exactly once');
  assert.ok(books.includes('caesars') && books.includes('betmgm'),
    'a book that stopped updating earlier still contributes its last price');
});

test('C13: a declared bookmaker set is honoured, and an independent reference can exclude our book', () => {
  const all = closeFor(-3);
  const excluded = closeFor(-3, { books: ['betmgm'] });
  assert.ok(all.close.books_contributing.includes('caesars'));
  assert.deepEqual(excluded.close.books_contributing, ['betmgm'],
    'an independent reference must be able to exclude the book we bet at');
  assert.deepEqual(excluded.close.declared_books, ['betmgm']);
});

test('C13: closing quote IDs and a grading version are saved with the report', () => {
  const report = executionClvReport();
  assert.equal(report.grading_version, CLV_GRADING_VERSION);
  assert.ok(report.declared_books);
  for (const position of report.positions) {
    assert.ok(Array.isArray(position.closing_quote_ids),
      'a graded position must name the exact quotes that graded it');
  }
});

test('C13: an unresolvable or absent event refuses rather than matching everything', () => {
  assert.equal(closeFor(-2.5, { eventKey: 'garbage' }).reason, 'unparseable_event_key');
  assert.equal(closeFor(-2.5, { eventKey: 'nfl|2026-09-13|ZZZ@YYY' }).reason, 'unresolvable_canonical_event');
  assert.equal(closeFor(-2.5, { kickoff: null }).reason, 'no_kickoff_known');
});

test('C13: every accepted ticket stays in realized P&L even when CLV is missing', () => {
  const report = executionClvReport();
  assert.equal(report.economics.positions_counted,
    report.coverage.graded_positions + report.coverage.ungraded_positions,
    'economics counts every accepted position; CLV is a smaller denominator by construction');
  assert.ok(report.price_clv_coverage.positions_priced_at_our_line
    <= report.price_clv_coverage.positions_with_a_close);
});

test('C14: -110 taken against a -120 close is FAVOURABLE under the chosen sign', () => {
  const clv = impliedProbability(-120) - impliedProbability(-110);
  assert.ok(clv > 0, 'we risked less per unit won than the close did: that is beating the close');
});

test('C14: prices are averaged in decimal space, across the +100/-100 boundary', () => {
  // -105 and +105 are adjacent in value and 210 apart numerically. A raw mean
  // is +0 (meaningless, and not even a valid price); the decimal mean is a
  // real price just above even money.
  const decimalMean = (decimalReturn(-105) + decimalReturn(105)) / 2;
  const fair = americanFromDecimal(decimalMean);
  assert.ok(Math.abs(fair) >= 100, 'the average of two real prices is a real price');
  assert.ok(fair > -110 && fair < 110);
  assert.equal(americanFromDecimal((decimalReturn(-115) + decimalReturn(-113)) / 2), -114);
});

test('C14: positive American prices grade with the same sign convention', () => {
  // Taking +120 and watching it close at +100 means we got the better price.
  assert.ok(impliedProbability(100) - impliedProbability(120) > 0);
  // Taking +100 and watching it close at +120 means we did worse.
  assert.ok(impliedProbability(120) - impliedProbability(100) < 0);
});

test('C14: same-line price movement and handicap movement cannot be confused', () => {
  const report = executionClvReport();
  for (const position of report.positions) {
    // They are separate fields with separate denominators and separate units.
    assert.ok(!('clv_price_cents' in position), 'the misleading field name is retired');
    if (position.clv_probability != null) {
      assert.equal(position.closing_line, position.accepted_line,
        'a price comparison only exists at the identical handicap');
    }
    if (position.clv_points != null) {
      assert.ok(position.closing_main_line != null,
        'handicap movement is measured against the main line, which need not equal ours');
    }
  }
});
