/**
 * PYES-ONE review fixes (#384 coordinator review, findings 1 and 2). Made-up offers only.
 *  1. Flag on, the offer ledger logs the CLONE band and basis (acceptance.challenger): the
 *     baseline's basis is not in trade_outcomes' CHECK, and logging it under the clone's
 *     model_version would pollute the clone's E1 grade.
 *  2. No decided offers (a loader reason, or none at all) serves the clone, not a 0.5 prior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-pyes-review-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

const { db, rows } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();
const { recordProposedOutcome } = await import('../server/services/trade-outcomes.js');
const { pYesFor, pYesTable, pYesTableFrom, PYES_BASIS } = await import('../server/services/p-yes.js');
const { acceptanceBand } = await import('../server/services/trade-acceptance.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const LEAGUE = '99';
const NOW = Date.UTC(2026, 9, 1);
const day = d => new Date(Date.UTC(2026, 8, d)).toISOString();
const OFFERS = [
  { league_id: LEAGUE, counterparty_team_id: '2', proposed_at: day(1), resolved_at: day(2), y: 1 },
  { league_id: LEAGUE, counterparty_team_id: '2', proposed_at: day(3), resolved_at: day(4), y: 0 },
  { league_id: LEAGUE, counterparty_team_id: '3', proposed_at: day(5), resolved_at: day(6), y: 0 },
];
const CP = { counterparty_data: true, receptiveness: 0.7, perception_delta: 0.05, accept_rate: 0.4, accept_rate_n: 10 };
const EDGE = { passes: true };

test('finding 1: flag on, "I sent this" logs the clone band and basis, not the baseline', () => {
  const table = pYesTableFrom(OFFERS, LEAGUE, ['2', '3'], { now: NOW });
  const served = pYesFor({ counterparty: CP, edge: EDGE, team: '2', table, on: true });
  assert.equal(served.basis, PYES_BASIS, 'precondition: the baseline is what is served');
  const clone = acceptanceBand({ counterparty: CP, edge: EDGE });
  const id = recordProposedOutcome({ league_id: 4, season: 2026, proposer_team_id: '1', counterparty_team_id: '2',
    give: [1], get: [2], acceptance: served, model_version: 'acceptanceBand/served-deal' });
  const [r] = rows('SELECT model_p_accept, model_p_accept_low, model_p_accept_high, model_basis FROM trade_outcomes WHERE id = ?', id);
  assert.equal(r.model_basis, clone.basis);
  assert.equal(r.model_p_accept, clone.band.mid);
  assert.equal(r.model_p_accept_low, clone.band.low);
  assert.equal(r.model_p_accept_high, clone.band.high);
});

test('finding 1: flag off, the ledger row is exactly as before', () => {
  const clone = acceptanceBand({ counterparty: CP, edge: EDGE });
  const id = recordProposedOutcome({ league_id: 4, season: 2026, proposer_team_id: '1', counterparty_team_id: '3',
    give: [1], get: [2], acceptance: pYesFor({ counterparty: CP, edge: EDGE, team: '3' }), model_version: 'v' });
  const [r] = rows('SELECT model_p_accept, model_basis FROM trade_outcomes WHERE id = ?', id);
  assert.equal(r.model_basis, clone.basis);
  assert.equal(r.model_p_accept, clone.band.mid);
});

test('finding 2: no decided offers at all serves the clone, with the reason, not 0.5', () => {
  const clone = acceptanceBand({ counterparty: CP, edge: EDGE });
  const empty = pYesTableFrom([], LEAGUE, ['2', '3'], { now: NOW });
  const a = pYesFor({ counterparty: CP, edge: EDGE, team: '2', table: empty, on: true });
  assert.deepEqual(a.band, clone.band);
  assert.equal(a.basis, clone.basis);
  assert.match(a.pyes_fallback, /no decided offers/);
});

test('finding 2: a loader reason (the real DB read, no ledger rows) serves the clone', () => {
  const t = pYesTable(db, 4, ['2', '3'], { now: NOW });
  const a = pYesFor({ counterparty: CP, edge: EDGE, team: '2', table: t, on: true });
  assert.notEqual(a.basis, PYES_BASIS);
  assert.deepEqual(a.band, acceptanceBand({ counterparty: CP, edge: EDGE }).band);
  assert.equal(typeof a.pyes_fallback, 'string');
});

test('finding 2: a table with decided offers still serves the baseline', () => {
  const table = pYesTableFrom(OFFERS, LEAGUE, ['2', '3'], { now: NOW });
  const a = pYesFor({ counterparty: CP, edge: EDGE, team: '2', table, on: true });
  assert.equal(a.basis, PYES_BASIS);
  assert.equal(a.pyes_fallback, undefined);
});
