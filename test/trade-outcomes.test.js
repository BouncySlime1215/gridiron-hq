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
  recordSyntheticOutcome, outcomesFor,
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
    model_p_accept: 0.7, model_version: 'trade-acceptance-v1',
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
});

test('G3 an app proposal without a model number is refused rather than written incomplete', () => {
  assert.throws(() => recordProposedOutcome({
    league_id: 7, season: 2025, proposer_team_id: '1', counterparty_team_id: '3',
    give: [], get: [], model_version: 'trade-acceptance-v1', proposed_at: '2025-10-07T12:00:00Z',
  }), /model_p_accept/,
  'a proposed row with no prediction is a row that can never be scored, so it is not a row');
});

test('G4 a candidate considered and not proposed is recorded with its reason', () => {
  const id = recordConsideredOnly({
    league_id: 7, season: 2025, proposer_team_id: '1', counterparty_team_id: '4',
    give: [{ player_id: 303 }], get: [{ player_id: 404 }],
    model_p_accept: 0.12, model_version: 'trade-acceptance-v1',
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
    give: [], get: [], model_p_accept: 0.12, model_version: 'v1',
    proposed_at: '2025-10-07T12:00:00Z',
  }), /not_proposed_reason/);
});

/* ------------------------------------------------------- G5 synthetic apart */

test('G5 a synthetic run writes only to the synthetic table', () => {
  const before = outcomesFor(7, 2025).length;
  recordSyntheticOutcome({
    league_id: 7, season: 2025, sim_run_id: 'sim-1', proposer_team_id: '1',
    counterparty_team_id: '2', give: [], get: [], model_p_accept: 0.5,
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

test('an outcome status outside the declared set is refused by the table itself', () => {
  assert.throws(() => run(`INSERT INTO trade_outcomes (league_id, season, source, status, created_at)
    VALUES (7, 2025, 'observed', 'maybe', '2025-10-08T12:00:00Z')`), /CHECK|constraint/i);
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
