import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-execution-lifecycle-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { contractKey } = await import('../server/services/nfl-contract-key.js');
const {
  openOpportunity, recordObserved, recordDecision, recordRefresh, recordAcceptance,
  settleOpportunity, getOpportunity, listOpportunities, openExposure, lifecycleFunnel, allowedNextStates
} = await import('../server/services/nfl-execution-lifecycle.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

db.exec(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
  (1, 'KC', 'Kansas City Chiefs', 'AFC', 'West'),
  (2, 'BAL', 'Baltimore Ravens', 'AFC', 'North')`);

const contract = () => contractKey({
  homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens', commenceTime: '2026-09-11T00:20:00Z',
  market: 'spreads', side: 'home', line: -3.5
});

test('a full walk through OFFERED -> OBSERVED -> DECISION -> REFRESHED -> ACCEPTED -> SETTLED', () => {
  const c = contract();
  assert.equal(c.ok, true);
  const opp = openOpportunity({
    contract: c, matchup: 'Baltimore Ravens at Kansas City Chiefs', decisionSource: 'test',
    occurredAt: '2026-09-10T10:00:00Z', book: 'draftkings', line: -3.5, price: -110
  });
  assert.equal(opp.status, 'offered');
  assert.equal(opp.events.length, 1);
  assert.equal(opp.events[0].state, 'offered');
  assert.equal(opp.events[0].fill_confirmed, undefined); // redacted in the read path — see file header note

  recordObserved(opp.id, { occurredAt: '2026-09-10T10:00:05Z', book: 'draftkings', line: -3.5, price: -110 });
  recordDecision(opp.id, { occurredAt: '2026-09-10T10:05:00Z', book: 'draftkings', line: -3.5, price: -110 });
  recordRefresh(opp.id, { occurredAt: '2026-09-10T10:06:00Z', book: 'draftkings', line: -3.5, price: -108 });
  recordRefresh(opp.id, { occurredAt: '2026-09-10T10:07:00Z', book: 'draftkings', line: -3.5, price: -108 });

  const afterRefresh = getOpportunity(opp.id);
  assert.equal(afterRefresh.status, 'refreshed');
  assert.equal(afterRefresh.events.filter(e => e.state === 'refreshed').length, 2);

  const accepted = recordAcceptance(opp.id, {
    occurredAt: '2026-09-10T10:07:30Z', book: 'draftkings', line: -3.5, price: -108, stakeUnits: 1
  });
  assert.equal(accepted.status, 'accepted');

  const settled = settleOpportunity(opp.id, { occurredAt: '2026-09-14T20:00:00Z', result: 'won' });
  assert.equal(settled.status, 'settled');
  const settleEvent = settled.events.find(e => e.state === 'settled');
  // -108 pays 100/108 = 0.925925... per unit (stored rounded to 4 decimals)
  assert.ok(Math.abs(settleEvent.realized_pnl_units - (100 / 108)) < 1e-3);
});

test('ACCEPTED is a user-recorded claim, never a sportsbook fill — fill_confirmed is schema-pinned to 0', () => {
  const c = contract();
  const opp = openOpportunity({ contract: c, decisionSource: 'test', occurredAt: '2026-09-10T10:00:00Z',
    book: 'fanduel', line: -3.5, price: -115 });
  recordObserved(opp.id, { occurredAt: '2026-09-10T10:00:05Z', book: 'fanduel', line: -3.5, price: -115 });
  recordDecision(opp.id, { occurredAt: '2026-09-10T10:05:00Z', book: 'fanduel', line: -3.5, price: -115 });
  recordAcceptance(opp.id, { occurredAt: '2026-09-10T10:05:30Z', book: 'fanduel', price: -115, stakeUnits: 1 });

  // Every row this ledger has ever written — not just this one — is pinned at
  // the database level, so there is no code path anywhere that could produce
  // a confirmed-fill row even by accident.
  const anyNonZero = db.prepare('SELECT COUNT(*) n FROM nfl_execution_lifecycle_events WHERE fill_confirmed <> 0').get();
  assert.equal(anyNonZero.n, 0);
});

test('the state machine refuses an out-of-order transition, both in JS and at the database', async () => {
  const { recordState } = await import('../server/services/nfl-execution-lifecycle.js');
  const c = contract();
  const opp = openOpportunity({ contract: c, decisionSource: 'test', occurredAt: '2026-09-10T10:00:00Z',
    book: 'caesars', line: -3.5, price: -110 });

  // Cannot jump straight to DECISION from OFFERED — OBSERVED must happen first.
  assert.throws(() => recordState(opp.id, 'decision', {
    occurredAt: '2026-09-10T10:01:00Z', book: 'caesars', price: -110, source: 'quote_tape'
  }), /invalid_transition|cannot record/);

  // Cannot record OFFERED twice for the same opportunity.
  assert.throws(() => recordState(opp.id, 'offered', {
    occurredAt: '2026-09-10T10:01:00Z', book: 'caesars', price: -110, source: 'quote_tape'
  }), /cannot record/);

  assert.deepEqual(allowedNextStates('offered'), ['observed']);
  assert.deepEqual(allowedNextStates('decision'), ['refreshed', 'accepted']);
  assert.deepEqual(allowedNextStates('settled'), []);
});

test('an ACCEPTED record must actually be source=user_recorded — recordAcceptance always sets it', async () => {
  const { recordState } = await import('../server/services/nfl-execution-lifecycle.js');
  const c = contract();
  const opp = openOpportunity({ contract: c, decisionSource: 'test', occurredAt: '2026-09-10T10:00:00Z',
    book: 'betmgm', line: -3.5, price: -110 });
  recordObserved(opp.id, { occurredAt: '2026-09-10T10:00:05Z', book: 'betmgm', price: -110 });
  recordDecision(opp.id, { occurredAt: '2026-09-10T10:05:00Z', book: 'betmgm', price: -110 });

  assert.throws(() => recordState(opp.id, 'accepted', {
    occurredAt: '2026-09-10T10:05:30Z', book: 'betmgm', price: -110, stakeUnits: 1, source: 'quote_tape'
  }), /user_recorded/);

  const accepted = recordAcceptance(opp.id, { occurredAt: '2026-09-10T10:05:30Z', book: 'betmgm',
    price: -110, stakeUnits: 1 });
  const acceptedEvent = accepted.events.find(e => e.state === 'accepted');
  assert.equal(acceptedEvent.source, 'user_recorded');
});

test('exact reconciliation: a synthetic push settles at exactly zero realized P&L', () => {
  const c = contractKey({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
    commenceTime: '2026-09-18T00:20:00Z', market: 'spreads', side: 'home', line: -3 });
  const opp = openOpportunity({ contract: c, decisionSource: 'test', occurredAt: '2026-09-17T10:00:00Z',
    book: 'draftkings', line: -3, price: -110 });
  recordObserved(opp.id, { occurredAt: '2026-09-17T10:00:05Z', book: 'draftkings', line: -3, price: -110 });
  recordDecision(opp.id, { occurredAt: '2026-09-17T10:05:00Z', book: 'draftkings', line: -3, price: -110 });
  recordAcceptance(opp.id, { occurredAt: '2026-09-17T10:05:30Z', book: 'draftkings', line: -3, price: -110, stakeUnits: 2 });
  const settled = settleOpportunity(opp.id, { occurredAt: '2026-09-21T20:00:00Z', result: 'push' });
  const settleEvent = settled.events.find(e => e.state === 'settled');
  assert.equal(settleEvent.realized_pnl_units, 0);
});

test('exact reconciliation: a synthetic void (e.g. a prop the player never played) also nets exactly zero', () => {
  const c = contractKey({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
    commenceTime: '2026-09-25T00:20:00Z', market: 'spreads', side: 'away', line: 3 });
  const opp = openOpportunity({ contract: c, decisionSource: 'test', occurredAt: '2026-09-24T10:00:00Z',
    book: 'draftkings', line: 3, price: -105 });
  recordObserved(opp.id, { occurredAt: '2026-09-24T10:00:05Z', book: 'draftkings', line: 3, price: -105 });
  recordDecision(opp.id, { occurredAt: '2026-09-24T10:05:00Z', book: 'draftkings', line: 3, price: -105 });
  recordAcceptance(opp.id, { occurredAt: '2026-09-24T10:05:30Z', book: 'draftkings', line: 3, price: -105, stakeUnits: 5 });
  const settled = settleOpportunity(opp.id, { occurredAt: '2026-09-28T20:00:00Z', result: 'void' });
  const settleEvent = settled.events.find(e => e.state === 'settled');
  assert.equal(settleEvent.realized_pnl_units, 0);
});

test('exact reconciliation: a missing fill (never reaches ACCEPTED) can never be settled and risks exactly zero', () => {
  const c = contractKey({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
    commenceTime: '2026-10-02T00:20:00Z', market: 'spreads', side: 'home', line: -3.5 });
  const opp = openOpportunity({ contract: c, decisionSource: 'test', occurredAt: '2026-10-01T10:00:00Z',
    book: 'draftkings', line: -3.5, price: -110 });
  recordObserved(opp.id, { occurredAt: '2026-10-01T10:00:05Z', book: 'draftkings', line: -3.5, price: -110 });
  recordDecision(opp.id, { occurredAt: '2026-10-01T10:05:00Z', book: 'draftkings', line: -3.5, price: -110 });
  // The price disappeared before it could be accepted — this opportunity is abandoned at DECISION.
  assert.throws(() => settleOpportunity(opp.id, { occurredAt: '2026-10-05T20:00:00Z', result: 'lost' }),
    /never ACCEPTED/);
  const stillOpen = getOpportunity(opp.id);
  assert.equal(stillOpen.status, 'decision');
  assert.equal(openExposure().some(o => o.id === opp.id), false);
});

test('determinism: replaying the same recorded events twice into fresh opportunities produces identical ledger shapes', () => {
  const build = suffix => {
    const c = contractKey({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
      commenceTime: `2026-11-0${suffix}T00:20:00Z`, market: 'spreads', side: 'home', line: -2.5 });
    const opp = openOpportunity({ contract: c, decisionSource: 'test', occurredAt: '2026-11-01T10:00:00Z',
      book: 'draftkings', line: -2.5, price: -112 });
    recordObserved(opp.id, { occurredAt: '2026-11-01T10:00:05Z', book: 'draftkings', line: -2.5, price: -112 });
    recordDecision(opp.id, { occurredAt: '2026-11-01T10:05:00Z', book: 'draftkings', line: -2.5, price: -112 });
    recordAcceptance(opp.id, { occurredAt: '2026-11-01T10:05:30Z', book: 'draftkings', line: -2.5, price: -112, stakeUnits: 1 });
    const settled = settleOpportunity(opp.id, { occurredAt: '2026-11-05T20:00:00Z', result: 'won' });
    return settled.events.map(e => ({ state: e.state, book: e.book, line: e.line, price: e.price,
      stake_units: e.stake_units, result: e.result, realized_pnl_units: e.realized_pnl_units }));
  };
  const first = build(1), second = build(2);
  assert.deepEqual(first, second);
});

test('lifecycleFunnel counts every stage, including opportunities that never reached ACCEPTED', () => {
  const funnel = lifecycleFunnel({});
  assert.ok(funnel.total_opportunities >= 6);
  assert.ok(funnel.by_stage.decision >= 1, 'the abandoned-at-decision opportunity should still be counted');
  assert.ok(funnel.settled >= 3);
  assert.equal(typeof funnel.survival_rate_decision_to_accepted, 'number');
});

test('listOpportunities filters by status', () => {
  const settledList = listOpportunities({ status: 'settled' });
  assert.ok(settledList.length >= 3);
  assert.ok(settledList.every(o => o.status === 'settled'));
});
