/**
 * LEDGER-BACKFILL: trade_outcomes' observed rows settle from the same pairing
 * E1 grades (decided-offers.js#rawOfferGroups), and a row written while its
 * offer was still pending is settled when the answer is later collected.
 *
 * Pre-registration: docs/tdd/2026-09-25-ledger-backfill.tdd.md.
 * Fixtures only: made-up teams 1-3 and made-up player ids.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ledger-backfill-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { settleObservedOutcomes, settleOfferLoop, outcomesFor } = await import('../server/services/trade-outcomes.js');
const { loadDecidedOffers } = await import('../server/services/eval/decided-offers.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const L = 9;
const S = 2025;

db.exec(`CREATE TABLE IF NOT EXISTS league_transactions_raw (
  league_id INTEGER NOT NULL, season INTEGER NOT NULL, tx_id TEXT NOT NULL,
  type TEXT, status TEXT, execution_type TEXT, proposed_at TEXT, processed_at TEXT,
  team_id INTEGER, member_id TEXT, related_tx_id TEXT, scoring_period INTEGER,
  bid_amount REAL, is_pending INTEGER, items_json TEXT, raw_json TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (league_id, season, tx_id))`);

const items = (from, to) => JSON.stringify([
  { fromTeamId: from, toTeamId: to, playerId: 501 },
  { fromTeamId: to, toTeamId: from, playerId: 602 },
]);

function raw(o) {
  run(`INSERT OR REPLACE INTO league_transactions_raw
       (league_id, season, tx_id, type, status, execution_type, proposed_at, processed_at,
        team_id, member_id, related_tx_id, scoring_period, bid_amount, is_pending,
        items_json, raw_json, first_seen_at, last_seen_at)
       VALUES (@league_id,@season,@tx_id,@type,@status,@execution_type,@proposed_at,@processed_at,
        @team_id,@member_id,@related_tx_id,@scoring_period,@bid_amount,@is_pending,
        @items_json,@raw_json,@first_seen_at,@last_seen_at)`, {
    league_id: L, season: S, type: 'TRADE_PROPOSAL', status: 'PENDING', execution_type: 'EXECUTE',
    processed_at: null, member_id: null, related_tx_id: null, scoring_period: 3,
    bid_amount: null, is_pending: 0, items_json: items(1, 2), raw_json: '{}',
    first_seen_at: '2025-10-01T00:00:00Z', last_seen_at: '2025-10-01T00:00:00Z',
    ...o,
  });
}
const byTx = () => Object.fromEntries(outcomesFor(L, S).filter(o => o.source === 'observed').map(o => [o.espn_tx_id, o]));
const e1Offers = () => loadDecidedOffers(db).offers.filter(o => o.league_id === L)
  .map(o => [o.offer_id, o.status, o.proposed_at, o.decided_at]).sort();

test('a row written while its offer was pending settles when the answer is collected later', () => {
  raw({ tx_id: 'p-late', team_id: 1, proposed_at: '2025-10-01T12:00:00Z' });
  raw({ tx_id: 'p-open', team_id: 1, proposed_at: '2025-10-01T13:00:00Z', items_json: items(1, 3) });
  const first = settleObservedOutcomes(L, S);
  assert.equal(first.written, 2);
  assert.equal(byTx()['p-late'].status, 'proposed', 'no answer yet');

  raw({ tx_id: 'a-late', type: 'TRADE_ACCEPT', team_id: 2, related_tx_id: 'p-late', proposed_at: '2025-10-02T09:00:00Z' });
  const second = settleObservedOutcomes(L, S);
  assert.equal(second.written, 0, 'the row exists, so nothing new is inserted');
  assert.equal(second.updated, 1, 'and the stale pending row is settled');
  const r = byTx()['p-late'];
  assert.equal(r.status, 'accepted');
  assert.equal(r.resolved_at, '2025-10-02T09:00:00Z', 'stamped with the answer time, not the run');
  assert.equal(r.proposed_at, '2025-10-01T12:00:00Z', 'proposed_at stays the proposal time (as-of correct)');
  assert.match(r.settle_reason, /^backfill_observed: /);
  assert.match(r.settle_reason, /TRADE_ACCEPT a-late/);
  assert.equal(r.model_p_accept, null, 'no prediction is invented for an ESPN-only offer');
  assert.equal(r.model_basis, null, 'and no clone basis is reused');
  assert.equal(byTx()['p-open'].status, 'proposed', 'an offer with no answer still stays proposed');
});

test('a second settle over the same rows writes and updates nothing', () => {
  const before = outcomesFor(L, S);
  const r = settleObservedOutcomes(L, S);
  assert.equal(r.written, 0);
  assert.equal(r.updated, 0);
  assert.deepEqual(outcomesFor(L, S), before);
});

test('closed with no answer: ESPN expiry and a proposer withdrawal both leave pending, and say which', () => {
  raw({ tx_id: 'p-exp', team_id: 1, proposed_at: '2025-10-03T12:00:00Z' });
  raw({ tx_id: 'c-exp', execution_type: 'CANCEL', status: 'CANCELED', team_id: 1, member_id: 'TradeTaskProcessor-1',
    related_tx_id: 'p-exp', proposed_at: '2025-10-05T12:00:00Z' });
  raw({ tx_id: 'p-wd', team_id: 1, proposed_at: '2025-10-03T14:00:00Z', items_json: items(1, 3) });
  raw({ tx_id: 'c-wd', execution_type: 'CANCEL', status: 'CANCELED', team_id: 1, member_id: 'member-x',
    related_tx_id: 'p-wd', proposed_at: '2025-10-03T20:00:00Z' });
  settleObservedOutcomes(L, S);
  const t = byTx();
  assert.equal(t['p-exp'].status, 'expired');
  assert.equal(t['p-exp'].resolved_at, '2025-10-05T12:00:00Z');
  assert.match(t['p-exp'].settle_reason, /expired/);
  assert.equal(t['p-wd'].status, 'expired', 'the ledger CHECK has no withdrawn status; the reason carries it');
  assert.match(t['p-wd'].settle_reason, /withdrawn/);
  assert.equal(t['c-exp'], undefined, 'a CANCEL row is a close, never an offer of its own');
});

test('accepted then vetoed stays accepted (as E1 counts it) and the reason names the veto', () => {
  raw({ tx_id: 'p-veto', team_id: 1, proposed_at: '2025-10-06T12:00:00Z' });
  raw({ tx_id: 'a-veto', type: 'TRADE_ACCEPT', team_id: 2, related_tx_id: 'p-veto', proposed_at: '2025-10-06T15:00:00Z' });
  raw({ tx_id: 'v-veto', type: 'TRADE_VETO', team_id: 3, related_tx_id: 'p-veto', proposed_at: '2025-10-07T15:00:00Z' });
  settleObservedOutcomes(L, S);
  const r = byTx()['p-veto'];
  assert.equal(r.status, 'accepted');
  assert.match(r.settle_reason, /vetoed/);
});

test("an ACCEPT row from the proposer's own team is not the counterparty's answer", () => {
  raw({ tx_id: 'p-self', team_id: 1, proposed_at: '2025-10-08T12:00:00Z' });
  raw({ tx_id: 'a-self', type: 'TRADE_ACCEPT', team_id: 1, related_tx_id: 'p-self', proposed_at: '2025-10-08T13:00:00Z' });
  settleObservedOutcomes(L, S);
  assert.equal(byTx()['p-self'].status, 'proposed');
});

test('a row already settled is never re-settled, and app rows are untouched', () => {
  raw({ tx_id: 'p-fixed', team_id: 1, proposed_at: '2025-10-09T12:00:00Z' });
  run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, proposed_at,
         status, espn_tx_id, resolved_at, created_at)
       VALUES (?, ?, 'observed', '1', '2', '2025-10-09T12:00:00Z', 'declined', 'p-fixed', '2025-10-09T13:00:00Z', 'x')`, L, S);
  run(`INSERT INTO trade_outcomes (league_id, season, source, proposer_team_id, counterparty_team_id, proposed_at,
         model_p_accept, model_basis, status, idea_id, created_at)
       VALUES (?, ?, 'app_proposed', '1', '2', '2025-10-09T12:00:00Z', 0.4, 'heuristic_anchored', 'proposed', 'idea-1', 'x')`, L, S);
  raw({ tx_id: 'a-fixed', type: 'TRADE_ACCEPT', team_id: 2, related_tx_id: 'p-fixed', proposed_at: '2025-10-10T13:00:00Z' });
  const before = outcomesFor(L, S).filter(o => o.espn_tx_id === 'p-fixed' || o.source === 'app_proposed');
  settleObservedOutcomes(L, S);
  assert.deepEqual(outcomesFor(L, S).filter(o => o.espn_tx_id === 'p-fixed' || o.source === 'app_proposed'), before);
});

test('the result reports settled offers by status, and E1 grades the same set before and after', () => {
  raw({ tx_id: 'p-e1', team_id: 1, proposed_at: '2025-10-11T12:00:00Z' });
  const e1Before = e1Offers();
  raw({ tx_id: 'd-e1', type: 'TRADE_DECLINE', team_id: 2, related_tx_id: 'p-e1', proposed_at: '2025-10-11T18:00:00Z' });
  const e1WithAnswer = e1Offers();
  const r = settleOfferLoop(L, S).observed;
  assert.deepEqual(e1Offers(), e1WithAnswer, 'the ledger writes change no offer E1 grades: raw already decides');
  assert.ok(e1WithAnswer.length === e1Before.length + 1);
  assert.equal(byTx()['p-e1'].status, 'declined');
  assert.equal(typeof r.by_status, 'object');
  const counted = Object.values(r.by_status).reduce((a, b) => a + b, 0);
  const observed = rows(`SELECT COUNT(*) AS n FROM trade_outcomes WHERE league_id = ? AND source = 'observed'`, L)[0].n;
  assert.equal(counted, observed, 'by_status covers every observed row in the league-season');
});
