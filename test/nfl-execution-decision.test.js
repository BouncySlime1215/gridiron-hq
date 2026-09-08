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
