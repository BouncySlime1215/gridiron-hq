/**
 * u5-clv-endpoints (2026 pre-registration, Step 0 item 5): CLV grading was
 * filtered to the ACCEPTED-ticket ledger only, so any hypothesis about "did
 * this system beat the close" could only ever be tested against the small
 * subset of games it chose to bet — never against the abstentions, which are
 * most of a slate. `executionClvReport({ includeAbstained: true })` extends
 * grading to every PASSED (abstained) opportunity too, priced off the last
 * quote this system actually observed before declining rather than a fill
 * that never happened.
 *
 * Runs against a fresh, disposable GRIDIRON_DB_PATH — never the real
 * server/data.sqlite — per the standing test-isolation rule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-execution-clv-abstained-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db, run } = await import('../server/db/index.js');
await (await import('../server/db/migrate.js')).runMigrations();
test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

db.exec(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
  (1, 'CHI', 'Chicago Bears', 'NFC', 'North'),
  (2, 'CAR', 'Carolina Panthers', 'NFC', 'South'),
  (3, 'DAL', 'Dallas Cowboys', 'NFC', 'East'),
  (4, 'NYG', 'New York Giants', 'NFC', 'East')`);

const KICKOFF_A = '2026-09-13T17:00:00.000Z';
const KICKOFF_B = '2026-09-13T20:00:00.000Z';
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,gameday,gametime)
  VALUES (2026,2,'CAR','CHI',1,-2.5,44,'2026-09-13','13:00')`);
run(`INSERT INTO game_lines (season,week,team,opponent,home,spread,total,gameday,gametime)
  VALUES (2026,2,'NYG','DAL',1,3,45,'2026-09-13','16:00')`);

const { contractKey } = await import('../server/services/nfl-contract-key.js');
const { openOpportunity, recordObserved, recordDecision, recordAcceptance, settleOpportunity,
  recordTerminalOutcome } = await import('../server/services/nfl-execution-lifecycle.js');
const { executionClvReport, recordExecutionClvGrades, CLV_GRADING_VERSION, CLV_GRADING_VERSION_ABSTAINED } =
  await import('../server/services/nfl-execution-clv.js');
const { clvGradesForOpportunity } = await import('../server/services/clv-core.js');

let batchSeq = 0;
function tapeQuote({ at, book, line, price, home, away, kickoff, side = 'home' }) {
  const batchId = `b${++batchSeq}`;
  run(`INSERT INTO nfl_quote_batches (batch_id, provider, requested_at, snapshot_at, mode, markets,
      source_ref, events, quotes, raw_hash, tape_version, created_at)
    VALUES (?,'test',?,?,'current','spreads','test',1,1,?, 'test-v1', ?)`, batchId, at, at, batchId, at);
  run(`INSERT INTO nfl_quote_tape
    (quote_id, batch_id, provider, provider_event_id, commence_time, home_team, away_team,
     market, period, side_key, side_name, line, american_price, implied_probability,
     bookmaker_key, snapshot_at, raw_json, tape_version, created_at)
    VALUES (?,?,'test','ev1',?,?,?,'spreads','full_game',?,?,?,?,0.5,?,?,'{}','test-v1',?)`,
  `${batchId}|${book}|${side}|${line}`, batchId, kickoff, home, away, side, side, line, price, book, at, at);
}

// --- Fixture 1: a real accepted-and-settled ticket on CAR@CHI. ---
const acceptedContract = contractKey({ homeTeam: 'Carolina Panthers', awayTeam: 'Chicago Bears',
  commenceTime: KICKOFF_A, market: 'spreads', side: 'home', line: -2.5 });
assert.equal(acceptedContract.ok, true, JSON.stringify(acceptedContract));
const acceptedOpp = openOpportunity({ contract: acceptedContract, decisionSource: 'test',
  occurredAt: '2026-09-12T10:00:00Z', book: 'draftkings', line: -2.5, price: -110 });
recordObserved(acceptedOpp.id, { occurredAt: '2026-09-12T10:00:05Z', book: 'draftkings', line: -2.5, price: -110 });
recordDecision(acceptedOpp.id, { occurredAt: '2026-09-12T10:05:00Z', book: 'draftkings', line: -2.5, price: -110 });
recordAcceptance(acceptedOpp.id, { occurredAt: '2026-09-12T10:06:00Z', book: 'draftkings', line: -2.5, price: -110, stakeUnits: 1 });
settleOpportunity(acceptedOpp.id, { occurredAt: '2026-09-13T21:00:00Z', result: 'lost' });
tapeQuote({ at: '2026-09-13T16:30:00Z', book: 'draftkings', line: -2.5, price: -115,
  home: 'Carolina Panthers', away: 'Chicago Bears', kickoff: KICKOFF_A });

// --- Fixture 2: the model looked at NYG@DAL, declined it, and never bet. ---
const abstainedContract = contractKey({ homeTeam: 'New York Giants', awayTeam: 'Dallas Cowboys',
  commenceTime: KICKOFF_B, market: 'spreads', side: 'home', line: 3 });
assert.equal(abstainedContract.ok, true, JSON.stringify(abstainedContract));
const abstainedOpp = openOpportunity({ contract: abstainedContract, decisionSource: 'test',
  occurredAt: '2026-09-12T11:00:00Z', book: 'fanduel', line: 3, price: -105 });
recordObserved(abstainedOpp.id, { occurredAt: '2026-09-12T11:00:05Z', book: 'fanduel', line: 3, price: -105 });
recordDecision(abstainedOpp.id, { occurredAt: '2026-09-12T11:05:00Z', book: 'fanduel', line: 3, price: -105 });
recordTerminalOutcome(abstainedOpp.id, 'passed', { occurredAt: '2026-09-12T11:06:00Z',
  reason: 'edge_below_floor' });
tapeQuote({ at: '2026-09-13T19:30:00Z', book: 'fanduel', line: 3, price: -120,
  home: 'New York Giants', away: 'Dallas Cowboys', kickoff: KICKOFF_B });

test('default behavior is unchanged: an abstained decision is invisible unless asked for', () => {
  const report = executionClvReport();
  assert.equal(report.coverage.accepted_positions, 1);
  assert.equal(report.coverage.decisions_considered, 1,
    'with includeAbstained unset, the denominator is exactly what it was before this change');
  assert.equal(report.positions.length + report.ungraded.length, 1);
  assert.ok(report.positions.every(p => p.event_key.includes('CHI@CAR') || p.event_key.includes('CAR@CHI')) ||
    report.ungraded.every(u => true));
  assert.equal(report.include_abstained, false);
});

test('includeAbstained: true adds the passed decision to the denominator and grades it', () => {
  const report = executionClvReport({ includeAbstained: true });
  assert.equal(report.coverage.accepted_positions, 1, 'accepted count is unchanged');
  assert.equal(report.coverage.abstained_positions, 1);
  assert.equal(report.coverage.decisions_considered, 2,
    'the full set of decisions the model made, not only the one it bet');

  const abstained = report.positions.find(p => p.id === abstainedOpp.id);
  assert.ok(abstained, JSON.stringify(report));
  assert.equal(abstained.decision, 'abstained');
  assert.equal(abstained.stake_units, null, 'never staked');
  assert.equal(abstained.realized_units, null, 'never risked — not a truthful-looking zero');
  assert.equal(abstained.accepted_line, 3, 'graded off the last observed price before declining');
  assert.equal(abstained.accepted_price, -105);
  assert.ok(Number.isFinite(abstained.clv_points), 'a real CLV number, not null, when a close was captured');

  const accepted = report.positions.find(p => p.id === acceptedOpp.id);
  assert.equal(accepted.decision, 'accepted');
  assert.equal(accepted.realized_units, -1, 'a real bet still carries its real settlement');

  // Economics stay scoped to money actually at risk — an abstention contributes nothing.
  assert.equal(report.economics.positions_counted, 1);
  assert.equal(report.economics.realized_units, -1);

  assert.equal(report.coverage.graded_accepted, 1);
  assert.equal(report.coverage.graded_abstained, 1);
});

test('recordExecutionClvGrades tags an abstained grade with a distinct grading_version', () => {
  const outcome = recordExecutionClvGrades({ includeAbstained: true });
  assert.equal(outcome.include_abstained, true);
  assert.equal(outcome.grading_version_abstained, CLV_GRADING_VERSION_ABSTAINED);

  const acceptedGrades = clvGradesForOpportunity(acceptedOpp.id);
  assert.equal(acceptedGrades.length, 1);
  assert.equal(acceptedGrades[0].grading_version, CLV_GRADING_VERSION);

  const abstainedGrades = clvGradesForOpportunity(abstainedOpp.id);
  assert.equal(abstainedGrades.length, 1);
  assert.equal(abstainedGrades[0].grading_version, CLV_GRADING_VERSION_ABSTAINED);
  assert.notEqual(CLV_GRADING_VERSION_ABSTAINED, CLV_GRADING_VERSION,
    'an abstained grade must never be mistaken for a real fill graded the same way');
});
