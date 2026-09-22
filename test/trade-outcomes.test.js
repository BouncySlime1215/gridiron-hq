/**
 * trade-outcomes: the ledger that records what actually happened to a trade.
 *
 * WHY THIS EXISTS. Today accept/decline is not stored anywhere. It is recomputed
 * at read time from `league_transactions_raw` every time someone opens a page —
 * `counterparty-pricing.js:815-844` and `manager-signals.js:190-197` on
 * `654ff93` both do their own pass over the raw rows — and neither is ever
 * joined to a trade THIS APP proposed. So the two questions that matter cannot
 * be asked at all:
 *
 *   1. When the model said "he is 70% to take this", was he?
 *   2. What did the model consider and NOT propose, and why?
 *
 * The second is the selection-bias half and it is the one that silently poisons
 * a calibration. A ledger that records only what was sent is a ledger of the
 * model's own choices, and measuring it against outcomes measures nothing.
 *
 * NO REAL ROW EXISTS YET. Every row in this file is a fixture. The first real
 * observed row needs the ESPN cookie set and `scripts/collect-league-transactions.mjs`
 * run, and neither has happened. Nothing here invents one.
 *
 * Gates, pre-registered in docs/tdd/trade-outcomes.tdd.md before this file ran:
 *  G1 settle() turns raw ESPN rows into observed rows, and is idempotent: a
 *     second run over the same rows writes nothing new and changes nothing.
 *  G2 an answer is attributed to the proposal it answers, via related_tx_id,
 *     and an unanswered proposal stays 'proposed' rather than becoming a
 *     silent decline.
 *  G3 an app proposal writes exactly one row carrying the model's P(accept)
 *     AT THAT MOMENT and the model version, because a calibration needs the
 *     number the model actually gave, not one recomputed later.
 *  G4 a candidate the app considered and did NOT propose writes a
 *     considered_only row with its reason. This is the selection-bias fix.
 *  G5 a synthetic run writes only to the synthetic table, and nothing in the
 *     real table can be labelled synthetic or vice versa.
 *  G6 the table is absent-safe in the same way every current reader is: the
 *     writers no-op rather than throw when the raw table has never been
 *     created, because on this machine it never has.
 *  G7 the ledger never invents a party, a stamp, or an outcome: a raw row
 *     missing the fields an outcome needs is skipped with a reason, not
 *     written with a guess.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-trade-outcomes-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const {
  settleObservedOutcomes, recordProposedOutcome, recordConsideredOnly,
  recordSyntheticOutcome, outcomesFor, recordProposalSlate: slateRecorder,
} = await import('../server/services/trade-outcomes.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/* ------------------------------------------------------------- fixtures */

// The raw table is created BY HAND by scripts/collect-league-transactions.mjs
// (:21-27 on 654ff93), not by a migration, so a fixture has to create it the
// same way a real machine would. The column list is copied from that script.
function createRawTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
    league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
    type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
    team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
    bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    PRIMARY KEY (league_id, season, tx_id))`);
}

const items = (from, to) => JSON.stringify([
  { fromTeamId: from, toTeamId: to, playerId: 101 },
  { fromTeamId: to, toTeamId: from, playerId: 202 },
]);

function rawRow(o) {
  run(`INSERT OR REPLACE INTO league_transactions_raw
       (league_id, season, tx_id, type, status, execution_type, proposed_at, processed_at,
        team_id, member_id, related_tx_id, scoring_period, bid_amount, is_pending,
        items_json, raw_json, first_seen_at, last_seen_at)
       VALUES (@league_id,@season,@tx_id,@type,@status,@execution_type,@proposed_at,@processed_at,
        @team_id,@member_id,@related_tx_id,@scoring_period,@bid_amount,@is_pending,
        @items_json,@raw_json,@first_seen_at,@last_seen_at)`, {
    league_id: 7, season: 2025, status: 'EXECUTED', execution_type: 'EXECUTE',
    processed_at: null, member_id: null, related_tx_id: null, scoring_period: 3,
    bid_amount: null, is_pending: 0, items_json: items(1, 2), raw_json: '{}',
    first_seen_at: '2025-10-01T00:00:00Z', last_seen_at: '2025-10-01T00:00:00Z',
    ...o,
  });
}

/* ------------------------------------------------- G6 absent-safe first */

test('G6 settle no-ops when the raw table has never been created, which is this machine', () => {
  // Every current reader guards this way and continues; the writer must too, or
  // the first page load on a machine with no collector run throws instead of
  // saying there is nothing collected yet.
  const r = settleObservedOutcomes(7, 2025);
  assert.equal(r.written, 0);
  assert.equal(r.skipped, 0);
  assert.equal(r.state, 'raw_table_absent',
    'the absence names itself rather than reading as "no trades happened"');
  assert.match(r.reason, /league_transactions_raw/,
    'and names the table, since the fix is to run the collector');
  assert.match(r.reason, /scripts\/collect-league-transactions\.mjs/,
    'and names what creates it, so a reader knows what to run');
});

/* ------------------------------------------------ G1/G2 the observed writer */

test('G1 settle turns a proposal and its answer into one observed row', () => {
  createRawTable();
  rawRow({ tx_id: 'tx-accepted', type: 'TRADE_PROPOSAL', team_id: 1,
    proposed_at: '2025-10-01T12:00:00Z' });
  rawRow({ tx_id: 'tx-accepted-ans', type: 'TRADE_ACCEPT', team_id: 2,
    related_tx_id: 'tx-accepted', proposed_at: '2025-10-01T18:00:00Z' });

  const r = settleObservedOutcomes(7, 2025);
  assert.equal(r.state, 'settled');
  assert.equal(r.written, 1, 'one proposal is one outcome row, not one per raw row');

  const out = outcomesFor(7, 2025);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, 'observed');
  assert.equal(out[0].status, 'accepted');
  assert.equal(out[0].espn_tx_id, 'tx-accepted', 'the row carries its join key back to the raw table');
  assert.equal(out[0].proposer_team_id, '1');
  assert.equal(out[0].counterparty_team_id, '2');
  assert.equal(out[0].proposed_at, '2025-10-01T12:00:00Z');
  assert.equal(out[0].resolved_at, '2025-10-01T18:00:00Z',
    'the stamp of the ANSWER, not of the proposal and not of this run');
  assert.equal(out[0].model_p_accept, null,
    'the app did not propose this one, so there is no model number to carry');
  assert.equal(out[0].model_version, null);
});

test('G1 a second settle over the same rows writes nothing and changes nothing', () => {
  const before = outcomesFor(7, 2025);
  const r = settleObservedOutcomes(7, 2025);
  assert.equal(r.written, 0, 'idempotent: re-running the collector must not double every outcome');
  assert.deepEqual(outcomesFor(7, 2025), before, 'and must not rewrite the rows it already wrote');
});

test('G2 a declined proposal is declined, and an unanswered one stays proposed', () => {
  rawRow({ tx_id: 'tx-declined', type: 'TRADE_PROPOSAL', team_id: 1,
    proposed_at: '2025-10-02T12:00:00Z' });
  rawRow({ tx_id: 'tx-declined-ans', type: 'TRADE_DECLINE', team_id: 2,
    related_tx_id: 'tx-declined', proposed_at: '2025-10-02T13:00:00Z' });
  rawRow({ tx_id: 'tx-open', type: 'TRADE_PROPOSAL', team_id: 1,
    proposed_at: '2025-10-03T12:00:00Z' });

  settleObservedOutcomes(7, 2025);
  const byTx = Object.fromEntries(outcomesFor(7, 2025).map(o => [o.espn_tx_id, o]));

  assert.equal(byTx['tx-declined'].status, 'declined');
  assert.equal(byTx['tx-declined'].resolved_at, '2025-10-02T13:00:00Z');

  // THE ONE THAT MATTERS FOR A CALIBRATION. An offer nobody answered is not a
  // decline. Scoring it as one would tell the model every slow week was a
  // rejection, which is the cheapest way to make a P(accept) read low forever.
  assert.equal(byTx['tx-open'].status, 'proposed');
  assert.equal(byTx['tx-open'].resolved_at, null,
    'unresolved carries no stamp, rather than borrowing the run\'s own clock');
});

test('G2 an answer whose proposal is not in the raw rows is skipped with a reason, never guessed', () => {
  rawRow({ tx_id: 'tx-orphan-ans', type: 'TRADE_ACCEPT', team_id: 2,
    related_tx_id: 'tx-never-collected', proposed_at: '2025-10-04T13:00:00Z' });
  const r = settleObservedOutcomes(7, 2025);
  assert.equal(r.written, 0, 'an answer alone is not an outcome: there is no deal to attach it to');
  assert.ok(r.skipped >= 1, 'and it is counted as skipped rather than silently dropped');
  assert.ok(r.skips.some(s => /related_tx_id/.test(s.reason) && s.tx_id === 'tx-orphan-ans'),
    'with the reason naming what was missing');
});

test('G7 a proposal with no readable parties is skipped with its reason, not written with a guess', () => {
  rawRow({ tx_id: 'tx-noparties', type: 'TRADE_PROPOSAL', team_id: 1,
    proposed_at: '2025-10-05T12:00:00Z', items_json: '[]' });
  const r = settleObservedOutcomes(7, 2025);
  assert.equal(r.written, 0);
  assert.ok(r.skips.some(s => s.tx_id === 'tx-noparties' && /counterpart/i.test(s.reason)),
    'a deal with one side is not a deal, and inventing the other side is the failure this prevents');
  assert.equal(outcomesFor(7, 2025).find(o => o.espn_tx_id === 'tx-noparties'), undefined);
});

test('G1 a proposal in another league or season is not settled into this one', () => {
  rawRow({ league_id: 8, tx_id: 'tx-otherleague', type: 'TRADE_PROPOSAL', team_id: 1,
    proposed_at: '2025-10-06T12:00:00Z' });
  rawRow({ season: 2024, tx_id: 'tx-otheryear', type: 'TRADE_PROPOSAL', team_id: 1,
    proposed_at: '2024-10-06T12:00:00Z' });
  settleObservedOutcomes(7, 2025);
  const keys = outcomesFor(7, 2025).map(o => o.espn_tx_id);
  assert.ok(!keys.includes('tx-otherleague'));
  assert.ok(!keys.includes('tx-otheryear'));
  // The raw table's primary key is (league_id, season, tx_id), so a tx_id is NOT
  // unique on its own. Idempotency keyed on tx_id alone would collide across
  // leagues the first time two of them shared an id.
  assert.equal(settleObservedOutcomes(8, 2025).written, 1, 'the other league settles on its own');
});

/* ------------------------------------------- G3/G4 what the app itself did */

test('G3 an app proposal writes one row carrying the model number given at that moment', () => {
  const id = recordProposedOutcome({
    league_id: 7, season: 2025, proposer_team_id: '1', counterparty_team_id: '3',
    give: [{ player_id: 101 }], get: [{ player_id: 202 }],
    acceptance: { band: { low: 0.58, mid: 0.7, high: 0.82 }, basis: 'heuristic_anchored' },
    model_version: 'trade-acceptance-v1',
    proposed_at: '2025-10-07T12:00:00Z',
  });
  const row = outcomesFor(7, 2025).find(o => o.id === id);
  assert.equal(row.source, 'app_proposed');
  assert.equal(row.status, 'proposed');
  assert.equal(row.model_p_accept, 0.7,
    'the number the model actually gave; a calibration cannot use one recomputed later');
  assert.equal(row.model_version, 'trade-acceptance-v1',
    'and which model gave it, or two models\' predictions pool into one meaningless curve');
  assert.equal(row.espn_tx_id, null, 'nothing was sent to ESPN, so there is no ESPN id to claim');

  // THE BAND TRAVELS WITH THE MIDPOINT. trade-acceptance.js returns a band and
  // says in its own served sentence that it is "not a calibrated probability";
  // `fitted` is false on every path it has. A midpoint recorded alone would put
  // a precision in the ledger that the model never claimed, and a later reader
  // would have no way to tell a wide declared starting point from a narrow
  // anchored one.
  assert.equal(row.model_p_accept_low, 0.58);
  assert.equal(row.model_p_accept_high, 0.82);
  assert.equal(row.model_basis, 'heuristic_anchored',
    'which KIND of claim it was, because an anchored band and a declared starting point '
    + 'must never pool into one calibration curve');
});

test('G3 a midpoint with no band is refused: the model states a band, never a point', () => {
  assert.throws(() => recordProposedOutcome({
    league_id: 7, season: 2025, proposer_team_id: '1', counterparty_team_id: '3',
    give: [], get: [], model_p_accept: 0.7, model_basis: 'heuristic_anchored',
    model_version: 'trade-acceptance-v1', proposed_at: '2025-10-07T12:00:00Z',
  }), /model_p_accept_low/,
  'recording a bare point would be the invented precision this project keeps removing');
});

test('G3 a prediction with no basis is refused', () => {
  assert.throws(() => recordProposedOutcome({
    league_id: 7, season: 2025, proposer_team_id: '1', counterparty_team_id: '3',
    give: [], get: [],
    acceptance: { band: { low: 0.58, mid: 0.7, high: 0.82 }, basis: null },
    model_version: 'trade-acceptance-v1', proposed_at: '2025-10-07T12:00:00Z',
  }),
  // PINNED TO THIS LAYER'S OWN WORDS, and it has to be. The table holds the same
  // rule as a CHECK, and SQLite's failure message quotes the constraint — which
  // contains `model_basis` too. So /model_basis/ passed whether the service refused
  // the row or the database did, and removing the service's guard alone broke
  // nothing (sweep row M19). Two guards with one assertion that accepts either is
  // one guard with no test.
  e => /^trade-outcomes: model_basis is required/.test(e.message),
  'the service must refuse it in its own words, before the row reaches the table');
});

test('G3 the table itself refuses a midpoint outside its own band', () => {
  assert.throws(() => run(`INSERT INTO trade_outcomes
    (league_id, season, source, status, model_p_accept, model_p_accept_low,
     model_p_accept_high, model_basis, created_at)
    VALUES (7, 2025, 'app_proposed', 'proposed', 0.9, 0.1, 0.5, 'heuristic_anchored',
            '2025-10-08T12:00:00Z')`),
  /CHECK|constraint/i, 'a point outside the band it claims to summarise is not a summary of it');
});

test('G3 an app proposal without a model number is refused rather than written incomplete', () => {
  assert.throws(() => recordProposedOutcome({
    league_id: 7, season: 2025, proposer_team_id: '1', counterparty_team_id: '3',
    give: [], get: [], model_version: 'trade-acceptance-v1', proposed_at: '2025-10-07T12:00:00Z',
  }),
  // Pinned for the same reason as the basis test above: the table's
  // `CHECK (source <> 'app_proposed' OR model_p_accept IS NOT NULL)` also fires
  // here and its message also contains the column name, so the old pattern could
  // not tell which layer did the work (sweep row M31).
  e => /^trade-outcomes: model_p_accept is required and was not given$/.test(e.message),
  'a proposed row with no prediction is a row that can never be scored, so it is not a row');
});

test('G4 a candidate considered and not proposed is recorded with its reason', () => {
  const id = recordConsideredOnly({
    league_id: 7, season: 2025, proposer_team_id: '1', counterparty_team_id: '4',
    give: [{ player_id: 303 }], get: [{ player_id: 404 }],
    acceptance: { band: { low: 0.04, mid: 0.12, high: 0.24 }, basis: 'heuristic_anchored' },
    model_version: 'trade-acceptance-v1',
    not_proposed_reason: 'failed the edge test: perceived value delta below the bar',
    proposed_at: '2025-10-07T12:00:00Z',
  });
  const row = outcomesFor(7, 2025).find(o => o.id === id);
  assert.equal(row.source, 'considered_only');
  assert.equal(row.status, 'not_proposed');
  assert.match(row.not_proposed_reason, /edge test/,
    'without the reason this is a row saying nothing happened, which every non-event satisfies');
  assert.equal(row.model_p_accept, 0.12,
    'the low number IS the datum: a calibration that sees only what was sent is a calibration of the filter');
});

test('G4 a considered_only row without a reason is refused', () => {
  assert.throws(() => recordConsideredOnly({
    league_id: 7, season: 2025, proposer_team_id: '1', counterparty_team_id: '4',
    give: [], get: [],
    acceptance: { band: { low: 0.04, mid: 0.12, high: 0.24 }, basis: 'heuristic_anchored' },
    model_version: 'v1', proposed_at: '2025-10-07T12:00:00Z',
  }), /not_proposed_reason/);
});

/* ------------------------------------------------------- G5 synthetic apart */

test('G5 a synthetic run writes only to the synthetic table', () => {
  const before = outcomesFor(7, 2025).length;
  recordSyntheticOutcome({
    league_id: 7, season: 2025, sim_run_id: 'sim-1', proposer_team_id: '1',
    counterparty_team_id: '2', give: [], get: [],
    acceptance: { band: { low: 0.35, mid: 0.5, high: 0.65 }, basis: 'heuristic_unanchored' },
    model_version: 'v1', status: 'accepted', proposed_at: '2025-10-08T12:00:00Z',
  });
  assert.equal(outcomesFor(7, 2025).length, before,
    'a stress test is not evidence about a person and must never land in the real ledger');
  const syn = rows(`SELECT * FROM trade_outcomes_synthetic WHERE sim_run_id = 'sim-1'`);
  assert.equal(syn.length, 1);
  assert.equal(syn[0].label, 'synthetic');
});

test('G5 the real ledger cannot be labelled synthetic, and the synthetic one cannot be labelled real', () => {
  // Structural, not conventional: the guarantee has to survive a future writer
  // that has not read this file.
  assert.throws(() => run(`INSERT INTO trade_outcomes_synthetic
    (league_id, season, sim_run_id, label, source, status, created_at)
    VALUES (7, 2025, 'sim-2', 'observed', 'observed', 'accepted', '2025-10-08T12:00:00Z')`),
  /CHECK|constraint/i, 'a synthetic row that calls itself observed is the whole failure mode');

  const cols = rows(`PRAGMA table_info(trade_outcomes)`).map(c => c.name);
  assert.ok(!cols.includes('sim_run_id'),
    'the real table has no sim id, so a synthetic row has nowhere to hide in it');
  assert.ok(!cols.includes('label'));
});

test('G5 the two tables are never joined by the reader', () => {
  const src = fs.readFileSync(new URL('../server/services/trade-outcomes.js', import.meta.url), 'utf8');
  // Anchored on the table name, which occurs only where the synthetic writer
  // touches it; a JOIN between the two is the one query that would let a stress
  // test price a person.
  assert.doesNotMatch(src, /JOIN\s+trade_outcomes_synthetic/i);
  assert.doesNotMatch(src, /trade_outcomes_synthetic[\s\S]{0,200}?\bJOIN\b\s+trade_outcomes\b/i);
});

/* --------------------------------------------- the contract, stated in SQL */

// THE ROW HAS TO BE VALID IN EVERY OTHER RESPECT or this test does not test what
// it says. The first version of it left espn_tx_id out, so the row was refused by
// `CHECK (source <> 'observed' OR espn_tx_id IS NOT NULL)` and the test passed with
// the status CHECK stripped from the table entirely — found by the mutation sweep in
// docs/tdd/sweeps/, row M7. A /CHECK|constraint/ regex cannot tell one constraint
// from another, so the discrimination has to come from the row, not the pattern.
test('an outcome status outside the declared set is refused by the table itself', () => {
  assert.throws(() => run(`INSERT INTO trade_outcomes
    (league_id, season, source, status, espn_tx_id, created_at)
    VALUES (7, 2025, 'observed', 'maybe', 'status-vocab-1', '2025-10-08T12:00:00Z')`),
  /CHECK|constraint/i,
  'the status vocabulary is closed, and this row breaks no other rule in the table');
});

test('an outcome source outside the declared set is refused by the table itself', () => {
  assert.throws(() => run(`INSERT INTO trade_outcomes (league_id, season, source, status, created_at)
    VALUES (7, 2025, 'made_up', 'proposed', '2025-10-08T12:00:00Z')`), /CHECK|constraint/i);
});

test('a not_proposed row without a reason is refused by the table itself', () => {
  assert.throws(() => run(`INSERT INTO trade_outcomes (league_id, season, source, status, created_at)
    VALUES (7, 2025, 'considered_only', 'not_proposed', '2025-10-08T12:00:00Z')`),
  /CHECK|constraint/i, 'the reason is what makes a non-event a datum');
});

/*
 * THE FOUR CHECKS BELOW HAD NO TEST AT ALL, and the evidence file claimed the
 * contract was asserted against the table's own constraints. The mutation sweep
 * (docs/tdd/sweeps/, rows M1, M3, M4, M6) removed each one and all 25 tests stayed
 * green: two because nothing exercised them, two because the service refuses the
 * same row first and every assertion accepted either refusal.
 *
 * Each row below is valid in every respect EXCEPT the one rule it breaks, so the
 * constraint that fires is the constraint under test. They go through `run` rather
 * than a writer on purpose: a CHECK exists for the writer that has not been written
 * yet, and a test that goes through today's writer cannot see it.
 */
test('the table refuses a considered_only row that is not not_proposed', () => {
  assert.throws(() => run(`INSERT INTO trade_outcomes
    (league_id, season, source, status, not_proposed_reason, created_at)
    VALUES (77, 2025, 'considered_only', 'proposed', 'a reason', '2025-10-08T12:00:00Z')`),
  /CHECK|constraint/i,
  'a considered_only row IS the non-event; one marked proposed would be counted as a '
  + 'sent offer by every read that filters on status');
});

test('the table refuses an observed row with no ESPN id to trace it to', () => {
  assert.throws(() => run(`INSERT INTO trade_outcomes
    (league_id, season, source, status, created_at)
    VALUES (77, 2025, 'observed', 'proposed', '2025-10-08T12:00:00Z')`),
  /CHECK|constraint/i,
  'an observed row that cannot be traced back to the raw row is a claim about ESPN '
  + 'with nothing behind it, and it can never be re-derived or corrected');
});

test('the table refuses an app_proposed row with no prediction, independently of the writer', () => {
  assert.throws(() => run(`INSERT INTO trade_outcomes
    (league_id, season, source, status, created_at)
    VALUES (77, 2025, 'app_proposed', 'proposed', '2025-10-08T12:00:00Z')`),
  /CHECK|constraint/i,
  'a prediction not recorded when it was made cannot be recovered: re-running the '
  + 'model later scores a different model against an older decision');
});

test('the table refuses a recorded midpoint that does not say which kind of claim it was', () => {
  assert.throws(() => run(`INSERT INTO trade_outcomes
    (league_id, season, source, status, model_p_accept, model_p_accept_low,
     model_p_accept_high, created_at)
    VALUES (77, 2025, 'app_proposed', 'proposed', 0.5, 0.4, 0.6, '2025-10-08T12:00:00Z')`),
  /CHECK|constraint/i,
  'an anchored band and a declared starting point are different evidence, and a row '
  + 'that does not say which it is cannot be kept out of the wrong curve later');
});

test('the unique index, not the writer, is what stops one ESPN trade becoming two rows', () => {
  // settleObservedOutcomes checks for an existing row before it inserts, so with that
  // SELECT in place the index never fires and downgrading it to a plain index broke
  // no test (sweep row M9). The index is the guard that holds when a second writer
  // exists, and it is the reason idempotency is a property of the table rather than
  // a habit of one function.
  const ins = tx => run(`INSERT INTO trade_outcomes
    (league_id, season, source, status, espn_tx_id, created_at)
    VALUES (?, 2025, 'observed', 'proposed', ?, '2025-10-08T12:00:00Z')`, ...tx);
  ins([78, 'dup-1']);
  assert.throws(() => ins([78, 'dup-1']), /UNIQUE|constraint/i,
    'the same ESPN transaction in the same league-season is one outcome, not two');
  // And the same id in a DIFFERENT league is a different deal. league_transactions_raw
  // keys on (league_id, season, tx_id), so an id is not unique on its own, and a
  // single-column key would have merged two leagues' deals while looking like
  // successful de-duplication.
  ins([79, 'dup-1']);
  assert.equal(outcomesFor(79, 2025).filter(o => o.espn_tx_id === 'dup-1').length, 1);
});

/* ----------------- the slate recorder: what was sent AND what was not */

const idea = (id, o = {}) => ({
  id, counterparty: { roster_id: '9' },
  give: [{ player_id: 1 }], get: [{ player_id: 2 }],
  acceptance: { band: { low: 0.4, mid: 0.55, high: 0.7 }, basis: 'heuristic_anchored' },
  ...o,
});

test('slate: a run records what it sent AND what it considered and did not send', () => {
  const r = slateRecorder(11, 2025, {
    ideas: [idea('idea-a'), idea('idea-b'), idea('idea-c')],
    result: {
      source: 'model',
      proposals: [{ idea_id: 'idea-a' }],
      rejected: [{ idea_id: 'idea-b', reason: 'cited a player who is not in this league' }],
    },
    modelVersion: 'trade-proposals-v1', proposerTeamId: '1',
  });
  assert.equal(r.state, 'recorded');
  assert.equal(r.proposed, 1);
  assert.equal(r.considered, 2, 'the two that were not sent are the control group, and both are rows');

  const byIdea = Object.fromEntries(outcomesFor(11, 2025).map(o => [o.idea_id, o]));
  assert.equal(byIdea['idea-a'].source, 'app_proposed');
  assert.equal(byIdea['idea-a'].model_p_accept, 0.55);
  assert.equal(byIdea['idea-a'].model_basis, 'heuristic_anchored');
  assert.equal(byIdea['idea-a'].counterparty_team_id, '9');

  // The verifier's own words where it gave them.
  assert.equal(byIdea['idea-b'].source, 'considered_only');
  assert.match(byIdea['idea-b'].not_proposed_reason, /not in this league/);
  // And an honest sentence where it did not, rather than a reason invented for it.
  assert.match(byIdea['idea-c'].not_proposed_reason, /did not select it/);
  assert.match(byIdea['idea-c'].not_proposed_reason, /gave no reason of its own/);
  // The low number is the datum: a considered_only row still carries the prediction.
  assert.equal(byIdea['idea-c'].model_p_accept, 0.55);
});

test('slate: a cache hit records NOTHING, because no decision was made on that request', () => {
  const before = outcomesFor(11, 2025).length;
  const r = slateRecorder(11, 2025, {
    ideas: [idea('idea-d')],
    result: { source: 'cache', proposals: [{ idea_id: 'idea-d' }], rejected: [] },
    modelVersion: 'trade-proposals-v1',
  });
  assert.equal(r.state, 'no_decision_made');
  assert.equal(r.proposed, 0);
  assert.equal(r.considered, 0);
  assert.equal(outcomesFor(11, 2025).length, before,
    'GET /proposals is called on every page open; writing on a re-read would weight one '
    + 'decision by how often somebody refreshed');
  assert.match(r.reason, /cache/);
  assert.match(r.reason, /once per page open/);
});

test('slate: a second fresh run over the same slate adds nothing', () => {
  const before = outcomesFor(11, 2025).length;
  const r = slateRecorder(11, 2025, {
    ideas: [idea('idea-a'), idea('idea-b'), idea('idea-c')],
    result: { source: 'model', proposals: [{ idea_id: 'idea-a' }], rejected: [] },
    modelVersion: 'trade-proposals-v1', proposerTeamId: '1',
  });
  assert.equal(r.proposed, 0);
  assert.equal(r.considered, 0);
  assert.equal(r.skipped, 3, 'all three are already recorded for this source');
  assert.equal(outcomesFor(11, 2025).length, before);
});

test('slate: the same idea may be proposed in one slate and dropped in another', () => {
  // Deliberate: the unique index includes `source`. Collapsing these two would
  // delete the contrast the ledger exists to measure — the model changed its mind
  // about the same package, which is exactly what a calibration wants to see.
  const r = slateRecorder(11, 2025, {
    ideas: [idea('idea-b')],
    result: { source: 'model', proposals: [{ idea_id: 'idea-b' }], rejected: [] },
    modelVersion: 'trade-proposals-v1', proposerTeamId: '1',
  });
  assert.equal(r.proposed, 1, 'idea-b was considered_only before; as app_proposed it is a new fact');
  const both = outcomesFor(11, 2025).filter(o => o.idea_id === 'idea-b');
  assert.deepEqual(both.map(o => o.source).sort(), ['app_proposed', 'considered_only']);
});

test('slate: an idea with no acceptance band is skipped, never written unscoreable', () => {
  const r = slateRecorder(11, 2025, {
    ideas: [idea('idea-noband', { acceptance: null })],
    result: { source: 'model', proposals: [{ idea_id: 'idea-noband' }], rejected: [] },
    modelVersion: 'trade-proposals-v1', proposerTeamId: '1',
  });
  assert.equal(r.proposed, 0);
  assert.equal(r.skipped, 1,
    'the table requires the prediction on an app_proposed row, so an unscoreable one is not a row');
});

test('slate: an idea whose counterparty cannot be read stores null, never a guessed team', () => {
  // G7 on the app side. counterpartyOf reads four possible shapes off the engine's
  // idea; when none of them is there the answer is "we do not know", and a made-up
  // roster id would attach a real person to a deal they were never offered. Making
  // it return a team id instead of null broke no test before this one (sweep row M23).
  const r = slateRecorder(12, 2025, {
    ideas: [idea('idea-nocp', { counterparty: null })],
    result: { source: 'model', proposals: [{ idea_id: 'idea-nocp' }], rejected: [] },
    modelVersion: 'trade-proposals-v1', proposerTeamId: '1',
  });
  assert.equal(r.proposed, 1, 'the deal is still a real decision the model made');
  const stored = outcomesFor(12, 2025).find(o => o.idea_id === 'idea-nocp');
  assert.equal(stored.counterparty_team_id, null,
    'an unknown counterparty is stored as unknown; a guess here prices a person on a '
    + 'negotiation that never involved them');
});
