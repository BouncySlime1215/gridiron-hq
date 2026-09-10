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

// modelLine/modelProbability/marketLineAtDecision are frozen on the
// opportunity itself now (Codex audit finding E4) -- attemptAcceptance reads
// them from the persisted opportunity, never from its own caller options, so
// any test that wants the corridor/suspect-price gates to have evidence to
// check must supply them here, at open time, not at accept time.
//
// Codex correction C15 adds one more piece of frozen evidence to that list:
// acceptance now re-checks expected return at the REFRESHED price, so an
// opportunity needs a probability for the gate to evaluate. 0.58 is an
// ordinary passing forecast at -110 (EV = 0.57 * 0.909 - 0.43 = +0.088 after
// the 0.01 haircut, comfortably over the 0.01 floor). Tests that care about a
// MISSING forecast override it to null and accept off-policy, which is the
// distinction the correction is about: a bet that was actually placed stays
// recordable, it just is not an authorized recommendation.
function decidedOpportunity({ commenceDate, price = -110, line = -3.5,
  modelLine = null, modelProbability = 0.58, marketLineAtDecision = null }) {
  const c = contractKey({ homeTeam: 'Kansas City Chiefs', awayTeam: 'Baltimore Ravens',
    commenceTime: `${commenceDate}T00:20:00Z`, market: 'spreads', side: 'home', line });
  // Codex correction C15: an integer handicap pushes, and the refreshed gate
  // refuses to authorize when that mass is unknown rather than assuming zero.
  // A real board must therefore freeze its push treatment at open time, and so
  // must a fixture that expects to be authorized.
  const halfPoint = Math.abs(Math.abs(line % 1) - 0.5) < 1e-9;
  const opp = openOpportunity({ contract: c, decisionSource: 'test',
    occurredAt: dayBefore(commenceDate, '10:00:00'), book: 'draftkings', line, price,
    modelLine, modelProbability, marketLineAtDecision,
    pushProbability: halfPoint ? 0 : 0.09,
    pushTreatment: halfPoint ? 'zero_by_arithmetic_half_point' : 'supplied_estimate' });
  recordObserved(opp.id, { occurredAt: dayBefore(commenceDate, '10:00:05'), book: 'draftkings', line, price });
  recordDecision(opp.id, { occurredAt: dayBefore(commenceDate, '10:05:00'), book: 'draftkings', line, price });
  return { opp, eventKey: c.event_key };
}

test('a normal acceptance within budget, with an ordinary price, is allowed', () => {
  const { opp, eventKey } = decidedOpportunity({ commenceDate: '2026-09-10' });
  const outcome = attemptAcceptance(opp.id, { line: getOpportunity(opp.id)?.events[0].line,
    occurredAt: '2026-09-09T10:05:30Z', book: 'draftkings', price: -110, stakeUnits: 1,
    eventKey, fairProbability: 0.5
  });
  assert.equal(outcome.accepted, true);
  assert.equal(getOpportunity(opp.id).status, 'accepted');
});

test('acceptance is blocked when it would breach the game exposure budget', () => {
  const first = decidedOpportunity({ commenceDate: '2026-09-17', line: -3.5 });
  const firstOutcome = attemptAcceptance(first.opp.id, { line: getOpportunity(first.opp.id)?.events[0].line,
    occurredAt: '2026-09-16T10:05:30Z', book: 'draftkings', price: -110, stakeUnits: 2.5,
    eventKey: first.eventKey
  });
  assert.equal(firstOutcome.accepted, true);

  const second = decidedOpportunity({ commenceDate: '2026-09-17', line: -3 });
  const secondOutcome = attemptAcceptance(second.opp.id, { line: getOpportunity(second.opp.id)?.events[0].line,
    occurredAt: '2026-09-16T10:06:00Z', book: 'fanduel', price: -110, stakeUnits: 1,
    eventKey: first.eventKey // same game
  });
  assert.equal(secondOutcome.accepted, false);
  assert.equal(secondOutcome.blocked_reason, 'exposure_budget');
  assert.equal(getOpportunity(second.opp.id).status, 'decision', 'a blocked acceptance must not advance the state');
});

test('acceptance is blocked when the model line is outside the market line corridor, unless explicitly acknowledged', () => {
  // 16.5 points off the frozen decision-time market line — well past the 11.5-point corridor.
  const { opp, eventKey } = decidedOpportunity({ commenceDate: '2026-10-01', modelLine: -3.5, marketLineAtDecision: -20 });
  const blocked = attemptAcceptance(opp.id, { line: getOpportunity(opp.id)?.events[0].line,
    occurredAt: '2026-09-30T10:05:30Z', book: 'draftkings', price: -110, stakeUnits: 1, eventKey
  });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.blocked_reason, 'market_line_corridor');
  assert.equal(blocked.corridor.verdict, 'needs_review');
  assert.equal(getOpportunity(opp.id).status, 'decision', 'a blocked acceptance must not advance the state');

  const acknowledged = attemptAcceptance(opp.id, { line: getOpportunity(opp.id)?.events[0].line,
    occurredAt: '2026-09-30T10:05:30Z', book: 'draftkings', price: -110, stakeUnits: 1,
    eventKey, acknowledgeCorridorBreach: true
  });
  assert.equal(acknowledged.accepted, true);
  assert.equal(acknowledged.corridor.verdict, 'needs_review');
});

test('a model line inside the market line corridor is reported but never blocks acceptance', () => {
  const { opp, eventKey } = decidedOpportunity({ commenceDate: '2026-10-08', modelLine: -3.5, marketLineAtDecision: -4 });
  const outcome = attemptAcceptance(opp.id, { line: getOpportunity(opp.id)?.events[0].line,
    occurredAt: '2026-10-07T10:05:30Z', book: 'draftkings', price: -110, stakeUnits: 1, eventKey
  });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.corridor.verdict, 'inside_corridor');
});

test('acceptance without a model/market line pair proceeds with the corridor reported as not evaluated, never as a silent pass', () => {
  const { opp, eventKey } = decidedOpportunity({ commenceDate: '2026-10-15' });
  const outcome = attemptAcceptance(opp.id, { line: getOpportunity(opp.id)?.events[0].line,
    occurredAt: '2026-10-14T10:05:30Z', book: 'draftkings', price: -110, stakeUnits: 1, eventKey
  });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.corridor, null, 'no lines supplied means no corridor check was attempted at all');
});

test('acceptance is blocked when the fair-price EV is suspiciously extreme, unless explicitly acknowledged', () => {
  const { opp, eventKey } = decidedOpportunity({ commenceDate: '2026-09-24', price: 900, modelProbability: 0.5 });
  const blocked = attemptAcceptance(opp.id, { line: getOpportunity(opp.id)?.events[0].line,
    occurredAt: '2026-09-23T10:05:30Z', book: 'draftkings', price: 900, stakeUnits: 1, eventKey
  });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.blocked_reason, 'suspect_price');
  assert.equal(blocked.suspect.suspect, true);

  const acknowledged = attemptAcceptance(opp.id, { line: getOpportunity(opp.id)?.events[0].line,
    occurredAt: '2026-09-23T10:05:30Z', book: 'draftkings', price: 900, stakeUnits: 1,
    eventKey, acknowledgeSuspectPrice: true
  });
  assert.equal(acknowledged.accepted, true);
});

test('acceptance fails closed on an opportunity that does not exist, rather than running checks against a phantom identity', () => {
  const outcome = attemptAcceptance('00000000-0000-0000-0000-000000000000', { line: getOpportunity('00000000-0000-0000-0000-000000000000')?.events[0].line,
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
  const firstOutcome = attemptAcceptance(first.opp.id, { line: getOpportunity(first.opp.id)?.events[0].line,
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
  const secondOutcome = attemptAcceptance(second.opp.id, { line: getOpportunity(second.opp.id)?.events[0].line,
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

test('Codex audit finding E4: modelLine/marketLine/fairProbability passed to attemptAcceptance itself are IGNORED — only the frozen opportunity counts', () => {
  // The opportunity is opened with NO model forecast recorded at all. A
  // caller then tries to supply a wildly-off modelLine/marketLine and a
  // suspicious fairProbability directly to attemptAcceptance, exactly the
  // shape the request body used to forward from an untrusted client. If
  // these were still read from the call options, this would either block
  // the acceptance (corridor breach) or flag a suspect price -- it must do
  // neither, because the persisted opportunity itself has no forecast.
  // Placed last in this file and given a generous isolated budget so it does
  // not perturb the cumulative shared-database exposure any earlier test
  // in this file depends on (see the isolatedBudget comment above).
  const { opp, eventKey } = decidedOpportunity({ commenceDate: '2026-10-22', modelProbability: null });
  const outcome = attemptAcceptance(opp.id, { line: getOpportunity(opp.id)?.events[0].line,
    occurredAt: '2026-10-21T10:05:30Z', book: 'draftkings', price: 900, stakeUnits: 1, eventKey,
    modelLine: -3.5, marketLine: -50, fairProbability: 0.5,
    budget: { ...DEFAULT_EXPOSURE_BUDGET, max_units_total: 100000 },
    // Codex correction C15: with no frozen forecast there is nothing to
    // re-price at the refreshed price, so the policy cannot AUTHORIZE this.
    // It remains recordable as a ticket that was actually placed -- refusing
    // to write it down would remove a real position from the ledger, not
    // un-place the bet.
    offPolicy: true
  });
  assert.equal(outcome.accepted, true, 'caller-supplied analytical fields must have zero effect on the outcome');
  assert.equal(outcome.off_policy, true);
  assert.equal(outcome.policy_authorized, false,
    'recorded because it was placed, never because the policy approved it');
  assert.equal(outcome.corridor, null, 'the corridor check must still read not_evaluated -- the opportunity itself has no frozen market line');
  assert.equal(outcome.suspect, null, 'the suspect-price check must still read not_evaluated -- the opportunity itself has no frozen model probability');
});

/* ======================================================================
 * Codex correction C15 — "The new policy gate is incomplete at price
 * refresh." Close-with: "invalid/negative configuration rejection; integer
 * push effect; fixed forecast with worsened price fails the refreshed gate;
 * changed line invokes the exact new contract distribution; missing
 * provenance refuses recommendation; off-policy manual tickets still settle
 * and remain in the proper ledger."
 * ====================================================================== */

const { NFL_PRODUCTION_POLICY, normalizeNflPolicy, applyNflPolicy } =
  await import('../server/services/nfl-policy.js');
const { refreshedEconomics } = await import('../server/services/nfl-execution-decision.js');
const { netRealizedUnits, settleOpportunity } =
  await import('../server/services/nfl-execution-lifecycle.js');

test('C15: the policy identity was bumped, because its economics changed', () => {
  assert.equal(NFL_PRODUCTION_POLICY.version, '1.2.0',
    'a decision made under 1.1.0 was made under different rules and must not be compared as if it were not');
});

test('C15: an invalid or negative haircut is rejected, not quietly applied', () => {
  // A NEGATIVE haircut INCREASES the modelled win probability, which can turn
  // a rejection into a selection. A haircut that adds confidence is a
  // configuration error, not a preference.
  for (const bad of [-0.01, -1, Number.NaN, Infinity, 1, 2, 'x']) {
    assert.throws(() => normalizeNflPolicy({ probabilityHaircut: bad }),
      /probabilityHaircut/, `haircut ${bad} must be rejected`);
  }
  assert.equal(normalizeNflPolicy({ probabilityHaircut: 0 }).probabilityHaircut, 0);
  assert.equal(normalizeNflPolicy({ probabilityHaircut: 0.05 }).probabilityHaircut, 0.05);
});

test('C15: an integer line with an unknown push is ABSTAINED, never priced as push-free', () => {
  const candidate = (over = {}) => ({ market: 'spread', matchup: 'A at B', selection: 'B',
    line: -3, american_price: -110, edge_points: 4, disagreement: 1,
    model_probability: 0.62, calibration_eligible: true, ...over });

  const unknown = applyNflPolicy([candidate()], NFL_PRODUCTION_POLICY).decisions[0];
  assert.equal(unknown.eligible, false);
  assert.equal(unknown.abstention_reason, 'push_probability_unknown');
  assert.equal(unknown.push_probability, null);
  assert.equal(unknown.push_treatment, 'unknown_on_integer_line');

  // Supplying the estimate makes it priceable, and the push mass genuinely
  // changes the number rather than being cosmetic.
  const supplied = applyNflPolicy([candidate({ push_probability: 0.09 })],
    NFL_PRODUCTION_POLICY).decisions[0];
  assert.equal(supplied.push_treatment, 'supplied_estimate');
  assert.ok(Number.isFinite(supplied.expected_return));

  const asIfNoPush = applyNflPolicy([candidate({ push_probability: 0 })],
    NFL_PRODUCTION_POLICY).decisions[0];
  assert.notEqual(supplied.expected_return, asIfNoPush.expected_return,
    'a 9% push mass is not the same bet as a push-free one');

  // A half-point line needs no estimate: integer scores cannot land on a half.
  const half = applyNflPolicy([candidate({ line: -3.5 })], NFL_PRODUCTION_POLICY).decisions[0];
  assert.equal(half.push_probability, 0);
  assert.equal(half.push_treatment, 'zero_by_arithmetic_half_point');
});

test('C15: a fixed forecast with a WORSENED price fails the refreshed gate', () => {
  const { opp, eventKey } = decidedOpportunity({ commenceDate: '2026-12-03', modelProbability: 0.55 });
  const line = getOpportunity(opp.id)?.events[0].line;

  // At -110 this forecast is marginal but passes. The forecast does not change;
  // only the price the bettor is actually offered does.
  const worse = attemptAcceptance(opp.id, { line, occurredAt: '2026-12-02T10:05:30Z',
    book: 'draftkings', price: -260, stakeUnits: 1, eventKey,
    budget: { ...DEFAULT_EXPOSURE_BUDGET, max_units_total: 100000 } });

  assert.equal(worse.accepted, false);
  assert.equal(worse.blocked_reason, 'expected_return_below_threshold');
  assert.ok(worse.economics.expected_net_return < worse.economics.threshold);
  assert.equal(getOpportunity(opp.id).status, 'decision', 'a blocked acceptance does not advance the state');
});

test('C15: a CHANGED line refuses rather than reusing a probability for a different number', () => {
  const { opp } = decidedOpportunity({ commenceDate: '2026-12-10', line: -3.5, modelProbability: 0.6 });
  const economics = refreshedEconomics({
    opportunity: getOpportunity(opp.id), line: -2.5, price: -110 });

  assert.equal(economics.evaluated, false);
  assert.equal(economics.reason, 'line_changed_no_qualified_distribution');
  assert.equal(economics.frozen_line, -3.5);
  assert.equal(economics.accepted_line, -2.5);
});

test('C15: missing forecast provenance refuses the RECOMMENDATION', () => {
  const { opp, eventKey } = decidedOpportunity({ commenceDate: '2026-12-17', modelProbability: null });
  const blocked = attemptAcceptance(opp.id, { line: getOpportunity(opp.id)?.events[0].line,
    occurredAt: '2026-12-16T10:05:30Z', book: 'draftkings', price: -110, stakeUnits: 1, eventKey,
    budget: { ...DEFAULT_EXPOSURE_BUDGET, max_units_total: 100000 } });

  assert.equal(blocked.accepted, false);
  assert.equal(blocked.blocked_reason, 'no_frozen_forecast');
  assert.match(blocked.detail, /off-policy ticket/);
});

test('C15: an off-policy ticket that was actually placed still settles and stays in the ledger', () => {
  // The bet was bad AND unauthorized. Refusing to record it does not un-place
  // it; it removes a real loss from realized P&L and quietly improves the
  // record. So it is recorded, labelled, and settled normally.
  const { opp, eventKey } = decidedOpportunity({ commenceDate: '2026-12-24', modelProbability: 0.51 });
  const line = getOpportunity(opp.id)?.events[0].line;

  const placed = attemptAcceptance(opp.id, { line, occurredAt: '2026-12-23T10:05:30Z',
    book: 'draftkings', price: -300, stakeUnits: 1, eventKey, offPolicy: true,
    budget: { ...DEFAULT_EXPOSURE_BUDGET, max_units_total: 100000 } });

  assert.equal(placed.accepted, true, 'a bet that happened is a fact about the world');
  assert.equal(placed.off_policy, true);
  assert.equal(placed.policy_authorized, false);
  // recordAcceptance stores the note inside the event's detail payload, which
  // getOpportunity already parses into `detail`.
  const acceptedEvent = getOpportunity(opp.id).events.find(e => e.state === 'accepted');
  assert.match(acceptedEvent.detail?.note ?? '', /OFF-POLICY/,
    'the ledger says on its face that the policy did not authorize this');

  settleOpportunity(opp.id, { occurredAt: '2026-12-25T00:00:00Z', result: 'lost',
    realizedPnlUnits: -1, actor: 'test' });
  assert.equal(netRealizedUnits(opp.id), -1,
    'the loss counts in realized economics exactly as an authorized one would');
});
