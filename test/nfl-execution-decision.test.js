import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-execution-decision-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

db.exec(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
  (1, 'KC', 'Kansas City Chiefs', 'AFC', 'West'),
  (2, 'BAL', 'Baltimore Ravens', 'AFC', 'North')`);

const { contractKey } = await import('../server/services/nfl-contract-key.js');
const { openOpportunity, recordObserved, recordDecision, getOpportunity } =
  await import('../server/services/nfl-execution-lifecycle.js');
const { attemptAcceptance } = await import('../server/services/nfl-execution-decision.js');
const { DEFAULT_EXPOSURE_BUDGET } = await import('../server/services/nfl-execution-exposure.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function dayBefore(isoDate, hhmmss) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.toISOString().slice(0, 10)}T${hhmmss}Z`;
}

function decidedOpportunity({ commenceDate, price = -110, line = -3.5 }) {
  const c = contractKey({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
    commenceTime: `${commenceDate}T00:20:00Z`, market: 'spreads', side: 'home', line });
  const opp = openOpportunity({ contract: c, decisionSource: 'test',
    occurredAt: dayBefore(commenceDate, '10:00:00'), book: 'draftkings', line, price });
  recordObserved(opp.id, { occurredAt: dayBefore(commenceDate, '10:00:05'), book: 'draftkings', line, price });
  recordDecision(opp.id, { occurredAt: dayBefore(commenceDate, '10:05:00'), book: 'draftkings', line, price });
  return { opp, eventKey: c.event_key };
}

test('a normal acceptance within budget, with an ordinary price, is allowed', () => {
  const { opp, eventKey } = decidedOpportunity({ commenceDate: '2026-09-10' });
  const outcome = attemptAcceptance(opp.id, {
    occurredAt: '2026-09-09T10:05:30Z', book: 'draftkings', price: -110, stakeUnits: 1,
    eventKey, fairProbability: 0.5
  });
  assert.equal(outcome.accepted, true);
  assert.equal(getOpportunity(opp.id).status, 'accepted');
});

test('acceptance is blocked when it would breach the game exposure budget', () => {
  const first = decidedOpportunity({ commenceDate: '2026-09-17', line: -3.5 });
  const firstOutcome = attemptAcceptance(first.opp.id, {
    occurredAt: '2026-09-16T10:05:30Z', book: 'draftkings', price: -110, stakeUnits: 2.5,
    eventKey: first.eventKey
  });
  assert.equal(firstOutcome.accepted, true);

  const second = decidedOpportunity({ commenceDate: '2026-09-17', line: -3 });
  const secondOutcome = attemptAcceptance(second.opp.id, {
    occurredAt: '2026-09-16T10:06:00Z', book: 'fanduel', price: -110, stakeUnits: 1,
    eventKey: first.eventKey // same game
  });
  assert.equal(secondOutcome.accepted, false);
  assert.equal(secondOutcome.blocked_reason, 'exposure_budget');
  assert.equal(getOpportunity(second.opp.id).status, 'decision', 'a blocked acceptance must not advance the state');
});

test('acceptance is blocked when the model line is outside the market line corridor, unless explicitly acknowledged', () => {
  const { opp, eventKey } = decidedOpportunity({ commenceDate: '2026-10-01' });
  const blocked = attemptAcceptance(opp.id, {
    occurredAt: '2026-09-30T10:05:30Z', book: 'draftkings', price: -110, stakeUnits: 1,
    eventKey, modelLine: -3.5, marketLine: -20 // 16.5 points off — well past the 11.5-point corridor
  });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.blocked_reason, 'market_line_corridor');
  assert.equal(blocked.corridor.verdict, 'needs_review');
  assert.equal(getOpportunity(opp.id).status, 'decision', 'a blocked acceptance must not advance the state');

  const acknowledged = attemptAcceptance(opp.id, {
    occurredAt: '2026-09-30T10:05:30Z', book: 'draftkings', price: -110, stakeUnits: 1,
    eventKey, modelLine: -3.5, marketLine: -20, acknowledgeCorridorBreach: true
  });
  assert.equal(acknowledged.accepted, true);
  assert.equal(acknowledged.corridor.verdict, 'needs_review');
});

test('a model line inside the market line corridor is reported but never blocks acceptance', () => {
  const { opp, eventKey } = decidedOpportunity({ commenceDate: '2026-10-08' });
  const outcome = attemptAcceptance(opp.id, {
    occurredAt: '2026-10-07T10:05:30Z', book: 'draftkings', price: -110, stakeUnits: 1,
    eventKey, modelLine: -3.5, marketLine: -4
  });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.corridor.verdict, 'inside_corridor');
});

test('acceptance without a model/market line pair proceeds with the corridor reported as not evaluated, never as a silent pass', () => {
  const { opp, eventKey } = decidedOpportunity({ commenceDate: '2026-10-15' });
  const outcome = attemptAcceptance(opp.id, {
    occurredAt: '2026-10-14T10:05:30Z', book: 'draftkings', price: -110, stakeUnits: 1, eventKey
  });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.corridor, null, 'no lines supplied means no corridor check was attempted at all');
});

test('acceptance is blocked when the fair-price EV is suspiciously extreme, unless explicitly acknowledged', () => {
  const { opp, eventKey } = decidedOpportunity({ commenceDate: '2026-09-24', price: 900 });
  const blocked = attemptAcceptance(opp.id, {
    occurredAt: '2026-09-23T10:05:30Z', book: 'draftkings', price: 900, stakeUnits: 1,
    eventKey, fairProbability: 0.5
  });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.blocked_reason, 'suspect_price');
  assert.equal(blocked.suspect.suspect, true);

  const acknowledged = attemptAcceptance(opp.id, {
    occurredAt: '2026-09-23T10:05:30Z', book: 'draftkings', price: 900, stakeUnits: 1,
    eventKey, fairProbability: 0.5, acknowledgeSuspectPrice: true
  });
  assert.equal(acknowledged.accepted, true);
});

test('acceptance fails closed on an opportunity that does not exist, rather than running checks against a phantom identity', () => {
  const outcome = attemptAcceptance('00000000-0000-0000-0000-000000000000', {
    occurredAt: '2026-09-09T10:05:30Z', book: 'draftkings', price: -110, stakeUnits: 1
  });
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.blocked_reason, 'opportunity_not_found');
});

test('the exposure check is computed from the PERSISTED opportunity\'s identity, never a caller-supplied one — a wrong eventKey passed by the caller cannot mask or manufacture a budget breach', () => {
  // A generous, test-local budget -- earlier tests in this file leave their
  // own ACCEPTED (never settled) exposure sitting in the same shared temp
  // database, so this test's own aggregate total is not the only exposure
  // openExposure() sees. The per-game cap, which is what this test is
  // actually about, is left at the real default.
  const isolatedBudget = { ...DEFAULT_EXPOSURE_BUDGET, max_units_total: 1000 };

  // Two real games. The first opens the game exposure right up to the cap.
  const first = decidedOpportunity({ commenceDate: '2026-11-05', line: -3.5 });
  const firstOutcome = attemptAcceptance(first.opp.id, {
    occurredAt: '2026-11-04T10:05:30Z', book: 'draftkings', price: -110, stakeUnits: 2.5, eventKey: first.eventKey,
    budget: isolatedBudget
  });
  assert.equal(firstOutcome.accepted, true);

  // A second, genuinely UNRELATED game (different week, different teams via a
  // different commence date -- contractKey's event_key is derived from the
  // real matchup/date, so this is a real different event_key, not a copy).
  const second = decidedOpportunity({ commenceDate: '2026-11-12', line: -3 });
  // The caller passes the FIRST game's eventKey by mistake (a stale variable,
  // a copy/paste bug) instead of the second opportunity's own. If the
  // exposure check trusted this caller-supplied value, it would wrongly test
  // the second bet against the first game's already-near-capacity exposure
  // and could block a bet that has nothing to do with that game, or --
  // worse, in the opposite direction -- silently exempt a bet from its own
  // game's real exposure by attributing it elsewhere. Neither may happen:
  // the persisted opportunity's own event_key is what must be used.
  const secondOutcome = attemptAcceptance(second.opp.id, {
    occurredAt: '2026-11-11T10:06:00Z', book: 'fanduel', price: -110, stakeUnits: 1, eventKey: first.eventKey,
    budget: isolatedBudget
  });
  assert.equal(secondOutcome.accepted, true,
    'the caller-supplied (wrong) eventKey must have no effect -- the second bet is against its own, uncapped game');
  // If the wrong (first game's) eventKey had actually been used, game_units_after
  // would read 2.5 + 1 = 3.5 -- over the 3u cap -- and this bet would have been
  // blocked instead. Reading exactly 1 proves the second game's OWN, empty
  // exposure was used, which is only possible if event_key came from the
  // persisted opportunity and not from what the caller passed in.
  assert.equal(secondOutcome.exposure.game_units_after, 1);
});
